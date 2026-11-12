export const DOCUMENT_LIMITS = {
  files: 8,
  bytes: 12 * 1024 * 1024,
  pages: 150,
  characters: 120_000,
};
export async function readDocument(file, { signal } = {}) {
  if (file.size > DOCUMENT_LIMITS.bytes) throw new Error('Choose a document under 12 MB.');
  const cancellation = () => {
    const error = new Error('Document opening cancelled.');
    error.name = 'AbortError';
    return error;
  };
  if (signal?.aborted) throw cancellation();
  let cancelled = false,
    task = null,
    page = null,
    rejectPending,
    destroyed = false;
  const pending = new Promise((_, reject) => {
    rejectPending = reject;
  });
  const destroy = () => {
    if (!task || destroyed) return Promise.resolve();
    destroyed = true;
    try {
      return Promise.resolve(task.destroy()).catch(() => {});
    } catch {
      return Promise.resolve();
    }
  };
  const abort = (error) => {
    if (cancelled) return;
    cancelled = true;
    rejectPending(error);
    void destroy();
  };
  const onAbort = () => abort(cancellation());
  const timer = setTimeout(
    () => abort(new Error('Document opening timed out. Try a shorter document.')),
    30_000,
  );
  signal?.addEventListener('abort', onAbort, { once: true });
  const bounded = (operation) =>
    Promise.race([
      Promise.resolve().then(() => {
        if (cancelled) throw cancellation();
        return operation();
      }),
      pending,
    ]);
  try {
    const bytes = await bounded(() => file.arrayBuffer());
    const revision = Array.from(
      new Uint8Array(await bounded(() => crypto.subtle.digest('SHA-256', bytes))),
      (n) => n.toString(16).padStart(2, '0'),
    ).join('');
    const isPdf = new TextDecoder().decode(bytes.slice(0, 5)) === '%PDF-';
    let text = '',
      pages = [];
    if (isPdf) {
      const pdfjs = await bounded(() => import('/vendor/pdf.mjs'));
      pdfjs.GlobalWorkerOptions.workerSrc = '/vendor/pdf.worker.mjs';
      task = pdfjs.getDocument({
        data: new Uint8Array(bytes.slice(0)),
        isEvalSupported: false,
        disableFontFace: true,
        useSystemFonts: true,
      });
      const pdf = await bounded(() => task.promise);
      if (pdf.numPages > DOCUMENT_LIMITS.pages)
        throw new Error('Choose a PDF with 150 pages or fewer.');
      for (let number = 1; number <= pdf.numPages; number++) {
        page = await bounded(() =>
          Promise.resolve(pdf.getPage(number)).then((value) => {
            if (cancelled) {
              value.cleanup();
              throw cancellation();
            }
            return value;
          }),
        );
        try {
          const content = await bounded(() => page.getTextContent());
          const pageText = content.items
            .map((item) => ('str' in item ? item.str + (item.hasEOL ? '\n' : ' ') : ''))
            .join('')
            .trim();
          const start = text.length;
          text += pageText + '\n\n';
          pages.push({ page: number, start, end: text.length });
        } finally {
          const currentPage = page;
          page = null;
          currentPage.cleanup();
        }
        if (text.length > DOCUMENT_LIMITS.characters)
          throw new Error('This document has too much text. Open a shorter section.');
      }
      await bounded(destroy);
    } else {
      if (!/\.(txt|md)$/i.test(file.name) && file.type !== 'text/plain')
        throw new Error('Choose a PDF, TXT or Markdown document.');
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      if (text.length > DOCUMENT_LIMITS.characters)
        throw new Error('Choose a text file under 120,000 characters.');
      for (let start = 0; start < text.length; start += 6_000)
        pages.push({ page: pages.length + 1, start, end: Math.min(text.length, start + 6_000) });
      if (!pages.length) pages = [{ page: 1, start: 0, end: 0 }];
    }
    return {
      id: revision,
      revision,
      title: file.name,
      text,
      pages,
      isPdf,
      url: isPdf ? URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' })) : null,
      notes: '',
    };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
    if (page) {
      try {
        page.cleanup();
      } catch {
        // Best-effort cleanup must not mask the original failure or cancellation.
      }
    }
    void destroy();
  }
}
export function disposeDocuments(documents) {
  for (const doc of documents) if (doc.url) URL.revokeObjectURL(doc.url);
}
