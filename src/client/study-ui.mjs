import { disposeDocuments, readDocument } from '/client/documents.mjs';
import { isPreviewSession } from '/client/api.mjs';
import { skeleton } from '/client/loading-ui.mjs';
import { openSyllabusReading } from '/client/syllabus-ui.mjs';

const NOTE_LIMIT = 12_000;
const FILE_TEXT_LIMIT = 9_000;
const SOURCE_ONLY = ['multiple-choice', 'true-false', 'discussion', 'worksheet'];
const element = (tag, text, className) => {
  const node = document.createElement(tag);
  if (text) node.textContent = text;
  if (className) node.className = className;
  return node;
};
function button(label, handler, primary = false) {
  const control = element('button', label, `button button-${primary ? 'primary' : 'secondary'}`);
  control.type = 'button';
  control.addEventListener('click', handler);
  return control;
}
function canvasLink(url, label) {
  try {
    const target = new URL(url);
    if (target.origin !== 'https://babson.instructure.com' || target.username || target.password)
      return null;
    const link = element('a', label, 'inline-link');
    link.href = target.href;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    return link;
  } catch {
    return null;
  }
}
function sourceLabel(source) {
  return [
    source.label,
    source.page ? `${source.location || 'page'} ${source.page}` : '',
    source.timestamp,
    source.ocr ? 'OCR text' : '',
    source.provenance,
  ]
    .filter(Boolean)
    .join(' · ');
}
function downloadStudyFile(name, type, content) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}
function csvText(label, value) {
  // Prefix source strings so a spreadsheet cannot execute them as formulas.
  return '"' + (label + (value || '')).replaceAll('"', '""') + '"';
}
function renderWorksheet(worksheet, sourcesById, practice, renderCitation) {
  const { rows } = worksheet;
  const article = element('article', undefined, 'study-card study-worksheet');
  const table = element('table');
  table.append(element('caption', 'Compare percentages from one source'));
  const head = table.createTHead().insertRow();
  for (const name of ['Cell', 'Practice (%)', 'Source (%)']) {
    const header = element('th', name);
    header.scope = 'col';
    head.append(header);
  }
  const body = table.createTBody();
  const inputs = [];
  const excerpts = element('div', undefined, 'study-answer');
  const values = (practice.values ??= rows.map(({ value }) => String(value)));
  rows.forEach((row, index) => {
    const cellName = `B${index + 2}`;
    const line = body.insertRow();
    const heading = element('th', cellName);
    heading.scope = 'row';
    line.append(heading);
    const input = element('input');
    input.type = 'number';
    input.min = '0';
    input.max = '100';
    input.step = '0.01';
    input.required = true;
    input.value = values[index];
    input.setAttribute('aria-label', `Practice percentage in ${cellName}`);
    line.insertCell().append(input);
    line.insertCell().textContent = row.value + '%';
    inputs.push(input);
    const detail = element('details');
    detail.append(
      element('summary', `Source for ${cellName}`),
      renderCitation(sourcesById.get(row.sourceId)),
      element('blockquote', row.quote, 'study-excerpt'),
    );
    excerpts.append(detail);
  });
  const range = `B2:B${rows.length + 1}`;
  const averageFormula = `=ROUND(AVERAGE(${range}),2)`;
  const spreadFormula = `=ROUND(MAX(${range})-MIN(${range}),2)`;
  const feedback = element('p');
  feedback.setAttribute('role', 'status');
  const formulas = element('div', undefined, 'study-excerpt');
  formulas.append(
    element('p', `Average ${averageFormula}`),
    element('p', `Range ${spreadFormula}`),
  );
  const download = button('Download worksheet CSV', () => {
    if (inputs.some((input) => !input.validity.valid)) return;
    const data = ['Cell,Practice (%),Source (%),Source title and location,Canvas URL,Excerpt'];
    rows.forEach((row, index) => {
      const source = sourcesById.get(row.sourceId);
      data.push(
        [
          `B${index + 2}`,
          inputs[index].valueAsNumber,
          row.value,
          csvText('Source: ', sourceLabel(source)),
          csvText('URL: ', canvasLink(source.url, '')?.href),
          csvText('Quote: ', row.quote),
        ].join(','),
      );
    });
    data.push('Average,' + csvText('', averageFormula), 'Range,' + csvText('', spreadFormula));
    downloadStudyFile(
      'study-percentage-worksheet.csv',
      'text/csv;charset=utf-8',
      data.join('\r\n'),
    );
  });
  function recalculate() {
    download.disabled = inputs.some((input) => !input.validity.valid);
    if (download.disabled) {
      feedback.textContent =
        'Enter a value from 0 to 100 with up to two decimal places in each cell.';
      return;
    }
    const values = inputs.map((input) => Math.round(input.valueAsNumber * 100));
    const mean =
      Math.round(values.reduce((total, value) => total + value, 0) / values.length) / 100;
    const spread = (Math.max(...values) - Math.min(...values)) / 100;
    feedback.textContent = `Average ${mean}% · range ${spread} percentage points`;
  }
  inputs.forEach((input, index) =>
    input.addEventListener('input', () => {
      values[index] = input.value;
      recalculate();
    }),
  );
  article.append(
    element('h4', 'Percentage worksheet'),
    element(
      'p',
      'Edit the practice values to see how they change the average and range. The original values stay beside them.',
    ),
    table,
    feedback,
    formulas,
    excerpts,
    download,
  );
  recalculate();
  return article;
}
function addLimited(pages, budget, append) {
  for (const { page, text } of pages) {
    if (budget <= 0 || !text.trim()) continue;
    const excerpt = text.slice(0, budget);
    budget -= excerpt.length;
    append(page, excerpt);
  }
}
export function collectSources(assignment, instructions, syllabus, draft, materials) {
  const result = [];
  const add = (kind, label, text, detail = {}) => {
    // Chunk every readable page; the retrieval pass examines every chunk.
    for (let offset = 0; offset < (text?.length || 0); offset += 7_800) {
      const excerpt = text.slice(offset, offset + 8_000);
      if (excerpt.trim())
        result.push({ id: `source-${result.length + 1}`, kind, label, text: excerpt, ...detail });
    }
  };
  add('assignment', assignment.name, instructions, { url: assignment.url });
  for (const item of materials) {
    for (const { page, text, timestamp } of item.pages || [{ page: null, text: item.text }])
      add(item.kind, item.title, text, {
        page,
        timestamp,
        url: item.url,
        reader: item.reader,
        location: item.location,
        provenance: item.provenance,
        ocr: Boolean(item.ocr?.some((entry) => entry.page === page)),
      });
  }
  if (syllabus) {
    const { source, result: reading } = syllabus;
    for (const { page, text } of reading.pages || [{ page: null, text: reading.text || '' }])
      add('syllabus', source.title, text, {
        page,
        url: source.url,
        ocr: Boolean(reading.ocr?.some((entry) => entry.page === page)),
      });
  }
  add('notes', 'Pasted notes', draft.notes);
  for (const [index, file] of draft.files.entries())
    for (const { page, text } of file.pages)
      add('notes', file.name, text, { page, noteFile: index });
  return result;
}

export async function retrieveStudySources(
  sources,
  focus,
  api,
  signal,
  progress = () => {},
  mode = 'flashcards',
) {
  const byId = new Map(sources.map((source) => [source.id, source]));
  let candidates = [];
  let batch = [];
  let size = 0;
  let scanned = 0;
  async function rank() {
    signal.throwIfAborted();
    const combined = new Map();
    for (const source of [...candidates, ...batch]) {
      const previous = combined.get(source.id);
      combined.set(source.id, {
        id: source.id,
        kind: source.kind,
        text: previous ? previous.text + '\n' + source.text : source.text,
      });
    }
    const result = await api('/api/study/passages', {
      signal,
      body: { mode, engine: 'quick', focus, sources: [...combined.values()] },
    });
    const selected = new Map();
    for (const passage of result.passages) {
      const previous = selected.get(passage.sourceId);
      selected.set(passage.sourceId, {
        ...byId.get(passage.sourceId),
        text: previous ? previous.text + '\n' + passage.quote : passage.quote,
      });
    }
    candidates = [...selected.values()];
    scanned += batch.length;
    progress(scanned, sources.length);
    batch = [];
    size = 0;
  }
  for (const source of sources) {
    if (batch.length >= 24 || size + source.text.length > 55_000) await rank();
    batch.push(source);
    size += source.text.length;
  }
  if (batch.length) await rank();
  return candidates;
}

async function cacheKey(input) {
  const encoded = new TextEncoder().encode(JSON.stringify(input));
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', encoded));
  return Array.from(hash, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function mountAssignmentStudy({
  container,
  assignment,
  courseId,
  instructions,
  draft,
  loader,
  api,
  operation,
  importFile,
  courseStudy = false,
  loadMaterials,
}) {
  const section = element('section', undefined, 'assignment-study');
  section.id = 'assignment-study';
  section.setAttribute('aria-label', courseStudy ? 'Exam practice' : 'Study this assignment');
  const live = element('p', '', 'muted');
  live.setAttribute('role', 'status');
  const sourceSummary = element('div', undefined, 'study-sources');
  const assignmentSource = element('div', undefined, 'study-source');
  assignmentSource.append(
    element('strong', courseStudy ? 'Course sources' : 'Assignment'),
    element(
      'span',
      courseStudy
        ? 'Loading selected sources…'
        : instructions.trim()
          ? 'Instructions ready'
          : 'No written instructions',
      'muted',
    ),
  );
  const syllabusSource = element('div', undefined, 'study-source');
  const notesSource = element('div', undefined, 'study-source');
  const notesCount = element('span', '', 'muted');
  notesSource.append(element('strong', 'Notes'), notesCount);
  sourceSummary.append(assignmentSource, syllabusSource, notesSource);

  const noteArea = element('div', undefined, 'study-note-area');
  const noteLabel = element('label', 'Your notes');
  noteLabel.htmlFor = 'study-notes';
  const notes = element('textarea');
  notes.id = noteLabel.htmlFor;
  notes.rows = 4;
  notes.maxLength = NOTE_LIMIT;
  notes.placeholder = courseStudy
    ? 'Add your notes or a video transcript'
    : 'Paste notes for this assignment';
  notes.value = draft.notes;
  const fileLabel = element('label', 'Add a note file');
  fileLabel.htmlFor = 'study-note-file';
  const file = element('input');
  file.type = 'file';
  file.id = fileLabel.htmlFor;
  file.accept = '.pdf,.txt,.md,application/pdf,text/plain';
  const fileList = element('div', undefined, 'study-note-files');
  const fileHint = element('p', 'PDF, TXT or Markdown · up to two files', 'muted');
  noteArea.append(noteLabel, notes);
  if (!isPreviewSession()) noteArea.append(fileLabel, file, fileHint, fileList);

  const toolbar = element('div', undefined, 'study-actions');
  const modeLabel = element('label', 'Format');
  modeLabel.htmlFor = 'study-format';
  const mode = element('select');
  mode.id = modeLabel.htmlFor;
  for (const [value, label] of [
    ['flashcards', 'Flashcards'],
    ['practice', 'Practice questions'],
    ['multiple-choice', 'Multiple choice'],
    ['true-false', 'True or false'],
    ['discussion', 'Discussion prompts'],
    ['worksheet', 'Spreadsheet exercise'],
  ]) {
    const option = element('option', label);
    option.value = value;
    mode.append(option);
  }
  mode.value = draft.mode;
  const topic = element('input');
  topic.id = 'study-topic';
  topic.type = 'text';
  topic.maxLength = 200;
  topic.placeholder = 'e.g. retrieval and RAG';
  topic.value = draft.focus || '';
  if (courseStudy) {
    const label = element('label', 'Exam topic (optional)');
    label.htmlFor = topic.id;
    noteArea.prepend(label, topic);
  }
  const quick = button('Build set', () => void generate('quick'), true);
  const local = button('Build with local AI', () => void generate('local'));
  const cancel = button('Cancel', () => {
    generating?.cancel();
    loadingRequest?.cancel();
  });
  cancel.hidden = true;
  modeLabel.append(mode);
  toolbar.append(modeLabel, quick, local, cancel);
  const cards = element('div', undefined, 'study-cards');
  section.append(
    element('h3', courseStudy ? 'Exam practice' : 'Study this'),
    sourceSummary,
    noteArea,
    toolbar,
    live,
    cards,
  );
  container.append(section);

  let syllabus = null;
  let materials = [];
  let loading = true;
  let loadingRequest = null;
  let readingFile = false;
  let generating = null;
  const alive = () => section.isConnected;
  const controls = () => {
    const busy = loading || readingFile || Boolean(generating);
    quick.disabled = local.disabled = busy;
    local.hidden = isPreviewSession() || SOURCE_ONLY.includes(mode.value);
    notes.disabled = mode.disabled = Boolean(generating);
    topic.disabled = Boolean(generating);
    file.disabled = readingFile || Boolean(generating) || draft.files.length >= 2;
    cancel.hidden = !generating && !loading;
  };
  function notesChanged({ clear = true } = {}) {
    if (clear) {
      draft.decks.clear();
      draft.lastEngine = null;
    }
    notesCount.textContent = draft.notes.trim() || draft.files.length ? 'Ready to use' : 'Optional';
    cards.replaceChildren();
    live.textContent = '';
  }
  function renderFiles() {
    fileList.replaceChildren();
    for (const [index, item] of draft.files.entries()) {
      const row = element('div', undefined, 'study-note-file');
      const details = element('details');
      details.id = `study-note-source-${index}`;
      details.append(element('summary', item.name));
      for (const { page, text } of item.pages) {
        if (page) details.append(element('strong', `Page ${page}`));
        details.append(element('p', text, 'study-excerpt'));
      }
      row.append(
        details,
        button('Remove', () => {
          if (generating) return;
          draft.files.splice(index, 1);
          renderFiles();
          notesChanged();
          controls();
        }),
      );
      fileList.append(row);
    }
  }
  notes.addEventListener('input', () => {
    draft.notes = notes.value;
    notesChanged();
  });
  topic.addEventListener('input', () => {
    draft.focus = topic.value;
    cards.replaceChildren();
    live.textContent = '';
  });
  mode.addEventListener('change', () => {
    draft.mode = mode.value;
    cards.replaceChildren();
    live.textContent = '';
    controls();
  });
  file.addEventListener('change', async () => {
    const selected = file.files[0];
    if (!selected || draft.files.length >= 2 || readingFile) return;
    readingFile = true;
    controls();
    live.textContent = 'Reading your note file…';
    let document;
    try {
      document = await readDocument(selected);
      if (!alive()) return;
      const pages = [];
      addLimited(
        document.pages.map(({ page, start, end }) => ({
          page: document.isPdf ? page : null,
          text: document.text.slice(start, end),
        })),
        FILE_TEXT_LIMIT,
        (page, text) => pages.push({ page, text }),
      );
      if (!pages.length)
        throw new Error(
          'This note file has no readable text. Add text or use OCR in Reader first.',
        );
      draft.files.push({ name: document.title, pages });
      renderFiles();
      notesChanged();
      live.textContent =
        document.text.length > FILE_TEXT_LIMIT
          ? 'Added the first 9,000 characters of the note file.'
          : 'Note file added.';
    } catch (error) {
      if (alive()) live.textContent = error.message;
    } finally {
      if (document) disposeDocuments([document]);
      readingFile = false;
      file.value = '';
      controls();
    }
  });
  function renderCitation(source) {
    const citation = element('div', undefined, 'study-citation');
    const sourceName = sourceLabel(source);
    citation.append(element('strong', sourceName));
    if (source.kind === 'assignment' && !courseStudy) {
      citation.append(
        button('Go to instructions', () => {
          const target = container.parentElement?.querySelector('#assignment-instructions');
          target?.focus();
          target?.scrollIntoView({ block: 'start' });
        }),
      );
    } else if (source.kind === 'syllabus' && syllabus?.result.file?.type === 'application/pdf') {
      citation.append(
        button(`Read page ${source.page}`, () => {
          void openSyllabusReading(syllabus.source, syllabus.result, importFile, {
            page: source.page,
          });
        }),
      );
    } else if (source.reader && source.page) {
      citation.append(
        button(`Read ${source.location || 'page'} ${source.page}`, async () => {
          const request = operation();
          try {
            live.textContent = 'Opening the original source…';
            const reading = await loader.readMaterial(
              source.reader.source,
              courseId,
              request.signal,
            );
            if (!request.valid()) return;
            await openSyllabusReading(source.reader.source, reading, importFile, {
              page: source.page,
              signal: request.signal,
            });
          } catch (error) {
            if (request.valid()) live.textContent = error.message;
          }
        }),
      );
    } else if (source.kind === 'notes') {
      citation.append(
        button('Go to note', () => {
          const details = section.querySelector(`#study-note-source-${source.noteFile}`);
          if (details) {
            details.open = true;
            details.querySelector('summary').focus();
          } else notes.focus();
        }),
      );
    }
    const link = canvasLink(source.url, source.provenance ? 'Open Canvas item' : 'Canvas original');
    if (link) citation.append(link);
    return citation;
  }
  function renderDeck(result, sources, restored, practice) {
    const sourcesById = new Map(sources.map((source) => [source.id, source]));
    if (mode.value === 'worksheet') {
      cards.replaceChildren();
      if (!result.worksheet) {
        live.textContent =
          'Choose one short source excerpt with at least two explicit percentages, or paste one in your notes.';
        return;
      }
      cards.append(renderWorksheet(result.worksheet, sourcesById, practice, renderCitation));
      live.textContent = restored ? 'Reopened this worksheet with your edits.' : 'Worksheet ready.';
      return;
    }
    const discussion = mode.value === 'discussion';
    const responses = (practice.responses ??= []);
    let index = discussion ? practice.cardIndex || 0 : 0;
    const exportDiscussion = () => {
      const entries = result.cards.map((card, index) => {
        const source = sourcesById.get(card.sourceId);
        const url = canvasLink(source.url, '')?.href;
        return [
          `${index + 1}. ${card.prompt}`,
          'Source · ' + sourceLabel(source),
          ...(url ? [url] : []),
          card.quote,
          'Rubric · ' + card.answer,
          ...(responses[index]?.trim() ? ['Your response · ' + responses[index]] : []),
        ].join('\n');
      });
      downloadStudyFile(
        'study-discussion-prompts.txt',
        'text/plain;charset=utf-8',
        ['Discussion practice', ...entries].join('\n\n'),
      );
    };
    function renderCard() {
      const card = result.cards[index];
      const source = sourcesById.get(card.sourceId);
      const article = element('article', undefined, 'study-card');
      const header = element('header', undefined, 'study-card-header');
      header.append(
        element('span', `${index + 1} of ${result.cards.length}`, 'canvas-eyebrow'),
        element(
          'span',
          discussion ? 'Discussion prompt' : card.generated ? 'Local AI question' : 'Source recall',
          'muted',
        ),
      );
      const prompt = element('h4', card.prompt, 'study-prompt');
      prompt.tabIndex = -1;
      const answer = element('div', undefined, 'study-answer');
      answer.hidden = true;
      const options = element('fieldset', undefined, 'study-options');
      let picked = null;
      const feedback = element('p');
      if (card.options?.length) {
        options.append(element('legend', 'Choose your answer'));
        for (const option of card.options) {
          const label = element('label');
          const input = element('input');
          input.type = 'radio';
          input.name = 'study-answer-choice';
          input.addEventListener('change', () => {
            picked = option;
            if (!answer.hidden)
              feedback.textContent =
                option === card.answer ? 'Correct.' : 'Check the source below.';
          });
          label.append(input, element('span', option));
          options.append(label);
        }
      }
      const revealLabel = discussion ? 'rubric' : 'answer';
      const reveal = button(`Show ${revealLabel}`, () => {
        answer.hidden = !answer.hidden;
        feedback.textContent =
          picked === null ? '' : picked === card.answer ? 'Correct.' : 'Check the source below.';
        reveal.setAttribute('aria-expanded', String(!answer.hidden));
        reveal.textContent = (answer.hidden ? 'Show ' : 'Hide ') + revealLabel;
      });
      reveal.setAttribute('aria-expanded', 'false');
      reveal.setAttribute('aria-controls', 'study-answer');
      answer.id = 'study-answer';
      const citation = renderCitation(source);
      const excerpt = element('blockquote', card.quote, 'study-excerpt');
      answer.append(feedback, element('p', card.answer, 'study-excerpt'));
      if (!discussion) answer.append(citation, excerpt);
      const navigation = element('div', undefined, 'study-actions');
      const move = (step) => {
        index += step;
        if (discussion) practice.cardIndex = index;
        renderCard();
        cards.querySelector('.study-prompt')?.focus();
      };
      const previous = button('Previous', () => move(-1));
      const next = button('Next', () => move(1));
      previous.disabled = index === 0;
      next.disabled = index === result.cards.length - 1;
      navigation.append(previous, next);
      article.append(header, prompt);
      if (discussion) {
        const reflection = element('div', undefined, 'study-note-area');
        const label = element('label', 'Your response');
        const input = element('textarea');
        input.id = label.htmlFor = 'study-discussion-response';
        input.maxLength = 4_000;
        input.rows = 3;
        input.value = responses[index] || '';
        input.addEventListener('input', () => (responses[index] = input.value));
        reflection.append(label, input);
        article.append(citation, excerpt, reflection);
        navigation.append(button('Download discussion prompts', exportDiscussion));
      }
      if (card.options?.length) article.append(options);
      article.append(reveal, answer, navigation);
      cards.replaceChildren(article);
    }
    renderCard();
    live.textContent = restored
      ? 'Reopened this set from memory.'
      : discussion
        ? `${result.cards.length} discussion prompts ready.`
        : result.fallback
          ? 'Local AI did not return usable questions. Source-based practice is ready.'
          : `${result.cards.length} cards ready · a focused sample from the searched material. Change the exam topic to explore another part of the course.`;
  }
  async function generate(engine, { restore = false } = {}) {
    if (loading || generating || readingFile || !alive()) return;
    let sources = collectSources(assignment, instructions, syllabus, draft, materials);
    if (!sources.length) {
      if (!restore)
        live.textContent = 'Add readable notes or assignment instructions to build a set.';
      return;
    }
    let body = {
      mode: mode.value,
      engine,
      ...(courseStudy ? { focus: topic.value.trim() } : {}),
      sources: sources.map(({ id, kind, text }) => ({ id, kind, text })),
    };
    const request = operation();
    generating = request;
    controls();
    try {
      const key = await cacheKey({
        ...body,
        references: sources.map(({ label, url, page, ocr, timestamp, provenance }) => [
          label,
          url,
          page,
          ocr,
          timestamp,
          provenance,
        ]),
      });
      if (!request.valid() || !alive()) return;
      const cached = draft.decks.get(body.mode + ':' + engine);
      if (cached?.key === key) {
        renderDeck(cached.result, cached.sources || sources, true, cached.practice);
        return;
      }
      if (restore) return;
      sources = await retrieveStudySources(
        sources,
        topic.value.trim(),
        api,
        request.signal,
        (done, total) => {
          if (request.valid())
            live.textContent = `Searching course text · ${done} of ${total} passages checked…`;
        },
        body.mode === 'worksheet' ? 'worksheet' : 'flashcards',
      );
      if (!request.valid() || !alive()) return;
      if (body.mode === 'worksheet' && !sources.length) {
        live.textContent =
          'Choose one short source excerpt with at least two explicit percentages, or paste one in your notes.';
        return;
      }
      body = { ...body, sources: sources.map(({ id, kind, text }) => ({ id, kind, text })) };
      live.textContent =
        engine === 'local'
          ? 'Building questions with the local model…'
          : body.mode === 'worksheet'
            ? 'Building a worksheet from cited percentages…'
            : 'Building practice from your sources…';
      cards.setAttribute('aria-busy', 'true');
      cards.replaceChildren(skeleton('practice'));
      const result = await api('/api/study/set', { body, signal: request.signal });
      if (!request.valid() || !alive()) return;
      const practice = {};
      if (!result.fallback) {
        draft.decks.set(body.mode + ':' + engine, { key, result, sources, practice });
        draft.lastEngine = engine;
      }
      renderDeck(result, sources, false, practice);
    } catch (error) {
      if (alive() && request.valid()) {
        cards.replaceChildren();
        live.textContent =
          body.mode === 'multiple-choice' && error.message.startsWith('Choose a readable')
            ? 'Add another assignment, reading or note so Atlas can build distinct choices.'
            : error.message;
      }
    } finally {
      if (generating === request) {
        generating = null;
        cards.removeAttribute('aria-busy');
        if (request.signal.aborted && alive()) {
          cards.replaceChildren();
          live.textContent = 'Study generation cancelled.';
        }
        controls();
      }
    }
  }
  async function loadSyllabus(refresh = false) {
    const request = operation();
    loading = true;
    loadingRequest = request;
    syllabus = null;
    materials = [];
    controls();
    syllabusSource.replaceChildren(element('strong', 'Syllabus'), skeleton('source'));
    try {
      if (refresh) loader.clear(courseId);
      const choices = await loader.discover(courseId, request.signal);
      const source = choices.candidates[0];
      if (source)
        syllabus = { source, result: await loader.read(source, courseId, request.signal) };
    } catch {
      if (request.valid())
        live.textContent =
          'The syllabus could not be loaded. You can still use instructions and notes.';
    }
    if (loadMaterials && request.valid()) {
      try {
        const { entries, skipped } = await loadMaterials(
          request.signal,
          ({ processed, total, ready }) => {
            if (!request.valid() || !alive()) return;
            assignmentSource.replaceChildren(
              element('strong', 'Course sources'),
              element('span', `${processed} of ${total} checked · ${ready} ready`, 'muted'),
              skeleton('source'),
            );
          },
        );
        if (!request.valid()) throw new DOMException('Cancelled', 'AbortError');
        materials = entries;
        assignmentSource.replaceChildren(
          element('strong', 'Course sources'),
          element(
            'span',
            `${entries.length} ready · all extracted pages will be searched`,
            'muted',
          ),
        );
        const included = element('details');
        included.append(element('summary', `View ${entries.length} included sources`));
        const sourceList = element('ul');
        for (const entry of entries)
          sourceList.append(
            element('li', entry.title + (entry.foundIn ? ` · ${entry.foundIn}` : '')),
          );
        included.append(sourceList);
        assignmentSource.append(included);
        if (skipped.length) {
          const coverage = element('details');
          coverage.append(element('summary', `${skipped.length} coverage notes`));
          const notes = element('ul');
          for (const item of skipped) notes.append(element('li', item));
          coverage.append(notes);
          assignmentSource.append(coverage);
        }
      } catch {
        if (request.valid())
          assignmentSource.replaceChildren(
            element('strong', 'Course sources'),
            element('span', 'Unavailable', 'muted'),
          );
      }
    }
    if (!request.valid() || !alive()) {
      if (alive() && loadingRequest === request) {
        loading = false;
        loadingRequest = null;
        assignmentSource.replaceChildren(
          element('strong', 'Loading cancelled'),
          button('Try again', () => void loadSyllabus()),
        );
        controls();
      }
      return;
    }
    loading = false;
    loadingRequest = null;
    syllabusSource.replaceChildren(
      element('strong', 'Syllabus'),
      element('span', syllabus?.source.title || 'Unavailable', 'muted'),
      button('Refresh source', () => {
        if (generating || loading) return;
        draft.decks.clear();
        cards.replaceChildren();
        live.textContent = '';
        void loadSyllabus(true);
      }),
    );
    controls();
    if (draft.lastEngine && !refresh) void generate(draft.lastEngine, { restore: true });
  }
  renderFiles();
  notesChanged({ clear: false });
  void loadSyllabus();
  section.querySelector('h3').tabIndex = -1;
  section.querySelector('h3').focus();
}
