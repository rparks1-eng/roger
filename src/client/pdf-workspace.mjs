// Original-page rendering follows Atlas CanvasLivingMargin's PDF.js canvas
// workflow. This isolated workspace adds selectable text and page-bound marks;
// it never reads personal Atlas notebooks or sends a document to a provider.
export function normalizeSelectionRects(rectangles, bounds) {
  if (!bounds || bounds.width <= 0 || bounds.height <= 0) return [];
  return Array.from(rectangles)
    .slice(0, 200)
    .flatMap((rect) => {
      const left = Math.max(bounds.left, rect.left),
        top = Math.max(bounds.top, rect.top);
      const right = Math.min(bounds.left + bounds.width, rect.right);
      const bottom = Math.min(bounds.top + bounds.height, rect.bottom);
      if (![left, top, right, bottom].every(Number.isFinite) || right <= left || bottom <= top)
        return [];
      return [
        {
          x: (left - bounds.left) / bounds.width,
          y: (top - bounds.top) / bounds.height,
          width: (right - left) / bounds.width,
          height: (bottom - top) / bounds.height,
        },
      ];
    });
}

export async function mountPDFWorkspace({
  container,
  bytes,
  pageNumber = 1,
  annotations = [],
  onSelection = () => {},
  onStatus = () => {},
  onAnnotationsChange = () => {},
  onPageChange = () => {},
  signal,
  pdfjs: injectedPdfjs,
} = {}) {
  if (!container || !bytes || bytes.byteLength > 12 * 1024 * 1024)
    throw new Error('Choose a PDF under 12 MB.');
  let disposed = false,
    generation = 0,
    renderTask,
    textLayer,
    currentPage,
    currentSelection,
    loadingTask;
  let page = pageNumber,
    resizeTimer,
    observer,
    destroyed = false;
  const marks = annotations.slice(0, 500).map((item) => structuredClone(item));
  const pending = new Set();
  const cancelError = () =>
    Object.assign(new Error('PDF workspace closed.'), { name: 'AbortError' });
  const bounded = (operation, milliseconds = 25_000) =>
    new Promise((resolve, reject) => {
      const entry = (error) => {
        clearTimeout(timer);
        pending.delete(entry);
        reject(error);
      };
      const timer = setTimeout(
        () => entry(new Error('PDF page took too long to open. Try another page.')),
        milliseconds,
      );
      pending.add(entry);
      Promise.resolve()
        .then(() => {
          if (disposed) throw cancelError();
          return operation();
        })
        .then((value) => {
          clearTimeout(timer);
          pending.delete(entry);
          resolve(value);
        }, entry);
    });
  const destroy = () => {
    if (!loadingTask || destroyed) return;
    destroyed = true;
    try {
      void Promise.resolve(loadingTask.destroy()).catch(() => {});
    } catch {
      // Best-effort cleanup must not mask the original failure or cancellation.
    }
  };
  const stopRender = () => {
    try {
      renderTask?.cancel();
    } catch {
      // Best-effort cleanup must not mask the original failure or cancellation.
    }
    try {
      textLayer?.cancel();
    } catch {
      // Best-effort cleanup must not mask the original failure or cancellation.
    }
    renderTask = null;
    textLayer = null;
    try {
      currentPage?.cleanup();
    } catch {
      // Best-effort cleanup must not mask the original failure or cancellation.
    }
    currentPage = null;
  };
  const abort = () => dispose();
  function dispose() {
    if (disposed) return;
    disposed = true;
    generation++;
    stopRender();
    destroy();
    clearTimeout(resizeTimer);
    observer?.disconnect();
    signal?.removeEventListener('abort', abort);
    container.removeEventListener('mouseup', select);
    container.removeEventListener('keyup', select);
    container.removeEventListener('touchend', select);
    for (const reject of [...pending]) reject(cancelError());
    container.replaceChildren();
  }
  if (signal?.aborted) {
    dispose();
    throw cancelError();
  }
  signal?.addEventListener('abort', abort, { once: true });
  let pdfjs,
    pdf,
    sheet,
    textSurface,
    highlightSurface,
    pageText = '',
    textOffsets = [];
  function paintHighlights() {
    if (!highlightSurface) return;
    highlightSurface.replaceChildren();
    for (const mark of marks.filter((item) => item.page === page)) {
      for (const rect of mark.rects ?? []) {
        const element = document.createElement('span');
        element.className = 'pdf-highlight';
        element.title = mark.note || mark.quote;
        Object.assign(element.style, {
          position: 'absolute',
          left: `${rect.x * 100}%`,
          top: `${rect.y * 100}%`,
          width: `${rect.width * 100}%`,
          height: `${rect.height * 100}%`,
          background: '#ffe36d99',
          pointerEvents: 'none',
        });
        highlightSurface.append(element);
      }
    }
  }
  function select() {
    if (disposed || !sheet || !textSurface) return;
    const selection = window.getSelection();
    if (
      !selection?.rangeCount ||
      !selection.anchorNode ||
      !selection.focusNode ||
      !textSurface.contains(selection.anchorNode) ||
      !textSurface.contains(selection.focusNode)
    )
      return;
    const range = selection.getRangeAt(0);
    const position = (node, offset) => {
      const item = textOffsets.find((item) => item.element === node || item.element.contains(node));
      if (!item) return null;
      const prefix = document.createRange();
      prefix.selectNodeContents(item.element);
      prefix.setEnd(node, offset);
      return item.start + Math.min(item.length, prefix.toString().length);
    };
    let start = position(range.startContainer, range.startOffset),
      end = position(range.endContainer, range.endOffset);
    if (start === null || end === null || end <= start) return;
    const chosen = pageText.slice(start, end),
      quote = chosen.trim();
    start += chosen.length - chosen.trimStart().length;
    end = start + quote.length;
    if (!quote || quote.length > 12_000) return;
    const rects = normalizeSelectionRects(range.getClientRects(), sheet.getBoundingClientRect());
    if (!rects.length) return;
    currentSelection = { page, quote, start, end, rects };
    onSelection(structuredClone(currentSelection));
  }
  async function renderPage(number) {
    if (disposed) throw cancelError();
    if (!Number.isInteger(number) || number < 1 || number > pdf.numPages)
      throw new Error('Choose an available PDF page.');
    const run = ++generation;
    stopRender();
    currentSelection = null;
    textOffsets = [];
    pageText = '';
    page = number;
    onStatus(`Opening page ${number}…`);
    const isCurrent = () => !disposed && run === generation;
    try {
      const openedPage = await bounded(() =>
        Promise.resolve(pdf.getPage(number)).then((value) => {
          if (!isCurrent()) value.cleanup();
          return value;
        }),
      );
      if (!isCurrent()) {
        openedPage.cleanup();
        return;
      }
      currentPage = openedPage;
      const base = openedPage.getViewport({ scale: 1 });
      const width = Math.max(160, Math.min(1100, container.clientWidth - 2 || 700));
      const viewport = openedPage.getViewport({ scale: width / base.width });
      const pixelRatio = Math.min(2, window.devicePixelRatio || 1);
      sheet = document.createElement('section');
      sheet.className = 'pdf-workspace-page';
      sheet.setAttribute('aria-label', `PDF page ${number}`);
      Object.assign(sheet.style, {
        position: 'relative',
        width: `${viewport.width}px`,
        height: `${viewport.height}px`,
        margin: '0 auto',
        background: '#fff',
      });
      const canvas = document.createElement('canvas');
      canvas.width = Math.ceil(viewport.width * pixelRatio);
      canvas.height = Math.ceil(viewport.height * pixelRatio);
      canvas.style.width = `${viewport.width}px`;
      canvas.style.height = `${viewport.height}px`;
      canvas.style.display = 'block';
      canvas.setAttribute('aria-hidden', 'true');
      textSurface = document.createElement('div');
      textSurface.className = 'pdf-workspace-text textLayer';
      Object.assign(textSurface.style, {
        position: 'absolute',
        inset: '0',
        overflow: 'hidden',
        lineHeight: '1',
        textAlign: 'initial',
      });
      textSurface.style.setProperty('--total-scale-factor', String(viewport.scale));
      textSurface.style.setProperty('--scale-round-x', '1px');
      textSurface.style.setProperty('--scale-round-y', '1px');
      highlightSurface = document.createElement('div');
      highlightSurface.className = 'pdf-workspace-highlights';
      Object.assign(highlightSurface.style, {
        position: 'absolute',
        inset: '0',
        pointerEvents: 'none',
      });
      sheet.append(canvas, highlightSurface, textSurface);
      container.replaceChildren(sheet);
      const task = openedPage.render({
        canvas,
        canvasContext: canvas.getContext('2d', { alpha: false }),
        viewport,
        transform: pixelRatio === 1 ? null : [pixelRatio, 0, 0, pixelRatio, 0, 0],
      });
      renderTask = task;
      await bounded(() => task.promise);
      if (!isCurrent()) return;
      const content = await bounded(() => openedPage.getTextContent());
      if (!isCurrent()) return;
      const layer = new pdfjs.TextLayer({
        textContentSource: content,
        container: textSurface,
        viewport,
      });
      textLayer = layer;
      await bounded(() => layer.render());
      if (!isCurrent()) return;
      const items = content.items.filter((item) => typeof item.str === 'string');
      const rawText = items.map((item) => item.str + (item.hasEOL ? '\n' : ' ')).join('');
      const trim = rawText.length - rawText.trimStart().length;
      pageText = rawText.trim();
      let offset = -trim;
      textOffsets = items
        .map((item, index) => {
          const entry = { element: layer.textDivs[index], start: offset, length: item.str.length };
          offset += item.str.length + 1;
          return entry;
        })
        .filter((item) => item.element);
      for (const span of textSurface.querySelectorAll('span[role="presentation"]')) {
        Object.assign(span.style, {
          position: 'absolute',
          color: 'transparent',
          whiteSpace: 'pre',
          transformOrigin: '0 0',
          cursor: 'text',
          fontSize: `calc(${span.style.getPropertyValue('--font-height')} * ${viewport.scale})`,
          transform: 'rotate(var(--rotate, 0deg)) scaleX(var(--scale-x, 1))',
        });
      }
      paintHighlights();
      onPageChange(number);
      onStatus(
        content.items.some((item) => item.str?.trim())
          ? `Page ${number} · Select text to highlight, ask, or add a note.`
          : `Page ${number} is an image. Run OCR to select its text.`,
      );
    } catch (error) {
      if (
        !isCurrent() ||
        error?.name === 'RenderingCancelledException' ||
        error?.name === 'AbortError'
      )
        return;
      stopRender();
      onStatus(error.message || 'The original PDF page could not be opened.');
      throw error;
    }
  }
  try {
    pdfjs = injectedPdfjs ?? (await bounded(() => import('/vendor/pdf.mjs')));
    pdfjs.GlobalWorkerOptions.workerSrc = '/vendor/pdf.worker.mjs';
    loadingTask = pdfjs.getDocument({
      data: new Uint8Array(bytes.slice(0)),
      isEvalSupported: false,
      useSystemFonts: true,
    });
    pdf = await bounded(() => loadingTask.promise);
    if (disposed) {
      destroy();
      throw cancelError();
    }
    if (pdf.numPages > 150) throw new Error('Choose a PDF with 150 pages or fewer.');
    container.addEventListener('mouseup', select);
    container.addEventListener('keyup', select);
    container.addEventListener('touchend', select);
    await renderPage(Math.min(pageNumber, pdf.numPages));
    let lastWidth = container.clientWidth;
    if (typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(() => {
        if (Math.abs(container.clientWidth - lastWidth) < 4) return;
        lastWidth = container.clientWidth;
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(() => {
          void renderPage(page).catch(() => {});
        }, 150);
      });
      observer.observe(container);
    }
    return {
      renderPage,
      highlightSelection(note = '') {
        if (!currentSelection || disposed) return null;
        if (marks.length >= 500)
          throw new Error('Export your notes before adding more than 500 highlights.');
        const mark = {
          id: crypto.randomUUID(),
          ...structuredClone(currentSelection),
          note: String(note).slice(0, 4000),
          createdAt: new Date().toISOString(),
        };
        marks.push(mark);
        paintHighlights();
        onAnnotationsChange(structuredClone(marks));
        return structuredClone(mark);
      },
      removeAnnotation(id) {
        const index = marks.findIndex((item) => item.id === id);
        if (index >= 0) {
          marks.splice(index, 1);
          paintHighlights();
          onAnnotationsChange(structuredClone(marks));
        }
      },
      getAnnotations: () => structuredClone(marks),
      exportAnnotations: () => ({
        format: 'atlas-page-annotations-v1',
        annotations: structuredClone(marks),
      }),
      dispose,
    };
  } catch (error) {
    dispose();
    throw error;
  }
}
