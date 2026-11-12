import { uploadDocument } from '/client/api.mjs';
import { disposeDocuments, readDocument } from '/client/documents.mjs';
import { skeleton } from '/client/loading-ui.mjs';

const TABLE_REFERENCE =
  /\b(?:grading|assessment|evaluation)\b[\s\S]{0,440}\b(?:weights?|percentages?)\b[\s\S]{0,100}\btable\b/i;
const element = (tag, text, className) => {
  const node = document.createElement(tag);
  if (text) node.textContent = text;
  if (className) node.className = className;
  return node;
};
function sourceLink(source, label) {
  if (!source.url)
    return element('span', label === 'Open original in Canvas' ? 'Masked Canvas source' : label);
  const link = element('a', label, 'inline-link');
  const url = new URL(source.url);
  if (url.origin !== 'https://babson.instructure.com' || url.username || url.password)
    throw new Error('This Canvas source link is unavailable.');
  link.href = url.href;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  return link;
}
function button(label, click) {
  const action = element('button', label, 'button button-secondary');
  action.type = 'button';
  action.addEventListener('click', click);
  return action;
}

async function readSource(source, courseId, api, signal, material = false) {
  if (source.kind === 'page')
    return { text: source.text, evidence: source.evidence, note: source.note };
  const result = await api(material ? '/api/canvas/study-file' : '/api/canvas/syllabus-file', {
    body: { courseId, fileId: source.fileId },
    binary: true,
    signal,
  });
  if (result.mime?.startsWith('application/json'))
    return JSON.parse(new TextDecoder().decode(result.bytes));
  const file = new File([result.bytes], result.name, { type: result.mime });
  if (material && /\.pptx$/i.test(file.name)) {
    const { pages } = await uploadDocument('/api/documents/presentation', result.bytes, { signal });
    return { file, pages, location: 'slide' };
  }
  const document = await readDocument(file, { signal });
  try {
    const pages = document.pages.map(({ page, start, end }) => ({
      page: document.isPdf ? page : null,
      text: document.text.slice(start, end),
    }));
    const scanned = document.isPdf
      ? pages
          .filter(({ text }) => text.trim().length < 40 || TABLE_REFERENCE.test(text))
          .map(({ page }) => page)
      : [];
    let note = '';
    const ocr = [];
    if (scanned.length) {
      try {
        for (let offset = 0; offset < scanned.length; offset += 12) {
          const recognized = await uploadDocument(
            `/api/documents/ocr?pages=${scanned.slice(offset, offset + 12).join(',')}`,
            result.bytes,
            { signal },
          );
          for (const { page, text } of recognized.pages) {
            if (!text.trim()) continue;
            pages[page - 1].text = text;
            ocr.push({ page, text });
          }
        }
        if (ocr.length)
          note = 'Marked excerpts were recovered with OCR. Compare them with the original page.';
        if (ocr.length < scanned.length)
          note += ' Some scanned pages could not be read automatically.';
      } catch (error) {
        if (signal.aborted) throw error;
        note = 'Automatic OCR was unavailable for this document. You can still open the original.';
      }
    }
    let remaining = 120_000;
    const excerpts = pages.map(({ page, text }) => {
      const bounded = text.slice(0, remaining);
      remaining -= bounded.length;
      return { page, text: bounded };
    });
    if (pages.reduce((total, page) => total + page.text.length, 0) > 120_000)
      note += ' Text beyond 120,000 characters was omitted; use a shorter document section.';
    const evidence = material
      ? {}
      : await api('/api/documents/syllabus-excerpts', {
          body: { pages: excerpts },
          signal,
        });
    return { file, pages: excerpts, evidence, ocr, note };
  } finally {
    disposeDocuments([document]);
  }
}

export function createSyllabusLoader(api) {
  const cache = new Map();
  const ttl = 5 * 60_000;
  const budget = 32 * 1024 * 1024;
  let generation = 0;
  async function load(key, signal, fetchValue, sizeOf) {
    signal.throwIfAborted();
    const now = Date.now();
    for (const [id, entry] of cache) if (entry.expires <= now) cache.delete(id);
    const entry = cache.get(key);
    if (entry) {
      cache.delete(key);
      cache.set(key, entry);
      return entry.value;
    }
    const activeGeneration = generation;
    const value = await fetchValue();
    signal.throwIfAborted();
    if (activeGeneration !== generation) return value;
    const bytes = sizeOf(value);
    if (
      bytes <= budget &&
      !value.note?.includes('unavailable') &&
      !value.note?.includes('could not be read')
    ) {
      cache.set(key, { value, bytes, expires: Date.now() + ttl });
      let total = [...cache.values()].reduce((sum, item) => sum + item.bytes, 0);
      while (cache.size > 128 || total > budget) {
        const oldest = cache.keys().next().value;
        total -= cache.get(oldest).bytes;
        cache.delete(oldest);
      }
    }
    return value;
  }
  return {
    discover(courseId, signal) {
      return load(
        `${courseId}:discovery`,
        signal,
        () => api(`/api/canvas/syllabus?id=${encodeURIComponent(courseId)}`, { signal }),
        (value) => (value.candidates.length ? JSON.stringify(value).length * 2 : Infinity),
      );
    },
    read(source, courseId, signal) {
      return load(
        `${courseId}:source:${source.url}`,
        signal,
        () => readSource(source, courseId, api, signal),
        ({ file, ...data }) => (file?.size || 0) + JSON.stringify(data).length * 2,
      );
    },
    readText(key, courseId, signal, fetchValue) {
      return load(`${courseId}:text:${key}`, signal, fetchValue, (value) =>
        value.unavailable?.length ? Infinity : JSON.stringify(value).length * 2,
      );
    },
    readMaterial(source, courseId, signal) {
      return load(
        `${courseId}:material:${source.url}`,
        signal,
        () => readSource(source, courseId, api, signal, true),
        ({ file, ...data }) => (file?.size || 0) + JSON.stringify(data).length * 2,
      );
    },
    clear(courseId) {
      generation++;
      for (const key of cache.keys())
        if (!courseId || key.startsWith(`${courseId}:`)) cache.delete(key);
    },
  };
}

export function openSyllabusReading(source, result, importFile, { page = 1, signal } = {}) {
  const file =
    result.file || new File([result.text], source.title + '.txt', { type: 'text/plain' });
  return importFile(file, {
    signal,
    initialPage: page,
    source: { title: source.title, url: source.url },
    ocr: result.ocr,
  });
}

export async function mountSyllabus({ content, courseId, loader, operation, importFile }) {
  const panel = element('section', undefined, 'syllabus-panel');
  const status = element('p', 'Finding the syllabus in Canvas…', 'muted');
  status.setAttribute('role', 'status');
  const body = element('div');
  body.append(skeleton('syllabus'), skeleton('passage'));
  panel.append(element('h3', 'Syllabus'), status, body);
  content.append(panel);
  let choices;
  const discovery = operation();
  try {
    choices = await loader.discover(courseId, discovery.signal);
  } catch (error) {
    if (discovery.valid()) {
      body.replaceChildren();
      status.textContent = error.message;
    }
    return;
  }
  if (!discovery.valid()) return;
  const candidates = choices.candidates;
  if (!candidates.length) {
    body.replaceChildren();
    status.textContent = [
      'No syllabus was found in the Canvas areas Atlas could check.',
      ...choices.coverage.reasons,
    ].join(' ');
    return;
  }
  const coverage = choices.coverage?.reasons || [];
  if (coverage.length) {
    const details = element('details', undefined, 'syllabus-coverage');
    details.append(element('summary', 'Canvas search coverage'), element('p', coverage.join(' ')));
    panel.append(details);
  }
  async function show(source) {
    const request = operation();
    status.textContent = 'Reading the syllabus…';
    body.replaceChildren();
    const original = element('header', undefined, 'syllabus-source');
    original.append(
      element('p', source.via, 'canvas-eyebrow'),
      element('h4', source.title),
      sourceLink(source, 'Open original in Canvas'),
    );
    body.append(original);
    const placeholder = skeleton('passage');
    body.append(placeholder);
    if (candidates.length > 1) {
      const other = element('details', undefined, 'syllabus-coverage');
      other.append(element('summary', 'Other syllabus matches'));
      for (const candidate of candidates.filter((match) => match !== source)) {
        const row = element('p');
        row.append(button(candidate.title, () => void show(candidate)));
        other.append(row);
      }
      body.append(other);
    }
    try {
      const result = await loader.read(source, courseId, request.signal);
      if (!request.valid()) return;
      status.textContent = result.note?.trim() || '';
      const open = (page = 1) =>
        openSyllabusReading(source, result, importFile, { page, signal: request.signal });
      original.append(
        button(
          result.file?.type === 'application/pdf' ? 'Read PDF' : 'Study syllabus text',
          () => void open(),
        ),
      );
      for (const [topic, label] of [
        ['grading', 'Grading'],
        ['officeHours', 'Office hours'],
      ]) {
        const section = element('section', undefined, 'syllabus-topic');
        section.append(element('h4', label));
        const matches = result.evidence[topic] || [];
        if (!matches.length)
          section.append(element('p', 'No matching passage found in this source.', 'muted'));
        for (const { page, excerpt } of matches) {
          const citation = element('article', undefined, 'syllabus-citation');
          const loc = element('div', undefined, 'syllabus-location');
          if (page && result.file?.type === 'application/pdf')
            loc.append(button(`Read page ${page}`, () => void open(page)));
          loc.append(sourceLink(source, page ? `Canvas source · page ${page}` : 'Canvas source'));
          if (result.ocr?.some((item) => item.page === page))
            loc.append(element('span', 'OCR text', 'muted'));
          citation.append(loc, element('blockquote', excerpt));
          section.append(citation);
        }
        body.append(section);
      }
    } catch (error) {
      if (request.valid()) status.textContent = error.message || 'The original could not be read.';
    } finally {
      placeholder.remove();
    }
  }
  await show(candidates[0]);
}
