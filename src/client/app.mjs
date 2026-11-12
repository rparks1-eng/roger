import { initialize, api, isPreviewSession, uploadDocument } from '/client/api.mjs';
import { mountPDFWorkspace } from '/client/pdf-workspace.mjs';
import { readDocument, disposeDocuments, DOCUMENT_LIMITS } from '/client/documents.mjs';
import {
  readSpeech,
  pauseSpeech,
  stopSpeech,
  getSpeechPreferences,
  setSpeechPreferences,
  narrationChoice,
  watchLocalVoices,
  configureNaturalNarration,
} from '/client/speech.mjs';
import { createCanvasPanel } from '/client/canvas-ui.mjs';
import { createCustomization } from '/client/customization.mjs';
import { mountRogerWidget } from '/client/roger-widget.mjs';
import { createConnectionsUI } from '/client/connections-ui.mjs';
import { createBuilderUI, isBuildRequest } from '/client/builder-ui.mjs';
import { createAppChangesUI, isAppChangeRequest } from '/client/app-changes-ui.mjs';
import { createCustomizationDrawer } from '/client/customization-drawer.mjs';
import { createAppearancePreview, isAppearanceRequest } from '/client/appearance-preview.mjs';
import { renderChatText } from '/client/chat-format.mjs';
import { createMemoryUI } from '/client/memory-ui.mjs';
import { resolveNavigation } from '/client/roger-navigation.mjs';
import { createResourcesUI, renderNewsDirectory } from '/client/resources-ui.mjs';
import { createHomeworkPlanner } from '/client/homework-planner.mjs';
const $ = (id) => document.getElementById(id);
const state = {
  documents: [],
  current: null,
  page: 0,
  connected: false,
  recording: false,
  question: null,
  generation: 0,
  importing: false,
  importController: null,
};
let pdfWorkspace = null,
  pdfController = null,
  pdfDocument = null,
  pdfSelection = null,
  ocrController = null,
  originalMode = true,
  ocrAvailable = true,
  readingLibrary,
  readingReady,
  folderImport;
const node = (tag, text, className) => {
  const item = document.createElement(tag);
  if (text !== undefined) item.textContent = text;
  if (className) item.className = className;
  return item;
};
const status = (text) => {
  $('app-status').textContent = text;
};
function cancelQuestion() {
  state.generation++;
  state.question?.abort();
  state.question = null;
  $('ask-button').disabled = false;
  if ($('cancel-question')) $('cancel-question').hidden = true;
}
function resetQuestionContext() {
  const pending = Boolean(state.question);
  cancelQuestion();
  $('cloud-consent').checked = false;
  $('answer-output').replaceChildren();
  $('sources-list').replaceChildren();
  $('roger-widget-response')?.replaceChildren();
  $('roger-widget-sources')?.replaceChildren();
  if (pending) status('Question cancelled because the source context changed.');
}
const compactNav = window.matchMedia('(max-width: 760px)');
const canvasPanel = createCanvasPanel({
  state,
  api,
  importFile,
  status,
  onConnectionChange: (connected) => {
    $('canvas-setup').hidden = connected;
    if (!connected) {
      const transient = state.documents.filter((doc) => doc.canvasReading);
      if (transient.length) {
        if (state.current?.canvasReading) {
          closePDF();
          state.current = null;
          if (!$('reader-view').hidden) view('library');
        }
        disposeDocuments(transient);
        state.documents = state.documents.filter((doc) => !doc.canvasReading);
        renderLibrary();
      }
    }
  },
  onConnect: () => {
    if (!$('settings-view').hidden) view('courses');
  },
  onAssignmentsChange: () => {
    if (!$('planner-view').hidden) homeworkPlanner.render();
    else homeworkPlanner.refresh();
  },
});
const homeworkPlanner = createHomeworkPlanner({
  container: $('homework-planner'),
  getAssignments: () => {
    const { courses, assignments } = canvasPanel.getNavigationIndex();
    const titles = new Map(courses.map(({ id, name }) => [String(id), name]));
    return assignments.map((item) => ({
      ...item,
      course: { name: titles.get(String(item.courseId)) || 'Canvas course' },
    }));
  },
  onOpenAssignment: (courseId, assignmentId) => {
    view('courses', { load: false });
    void canvasPanel.navigate({ courseId, assignmentId }).catch((error) => status(error.message));
  },
});
const customizations = createCustomization({
  getVoicePreset: () => getSpeechPreferences().presetId,
  onNavigate: () => view('customize'),
  onBuild: (message) => {
    if (isAppChangeRequest(message)) {
      customizationDrawer.close();
      void appChangesUI.request(message);
      return;
    }
    if (isAppearanceRequest(message)) {
      void appearanceUI.request(message);
      return;
    }
    customizationDrawer.close();
    void builderUI.request(message);
  },
  onVoicePreset: (id) => {
    const select = $('narration-preset');
    if (!select || ![...select.options].some((option) => option.value === id)) return false;
    select.value = id;
    select.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  },
});
const connectionsUI = createConnectionsUI({
  container: $('connections-content'),
  api,
  onChange: (selection) => {
    $('roger-ai').textContent = selection ? `AI · ${selection.provider}` : 'Connect AI';
  },
});
const builderUI = createBuilderUI({
  container: $('builder-content'),
  api,
  getSelection: () => connectionsUI.getSelection(),
  onConnect: () => view('connections'),
  onNavigate: () => view('builder'),
});
const appChangesUI = createAppChangesUI({
  container: $('app-changes-content'),
  api,
  getSelection: () => connectionsUI.getSelection(),
  onConnect: () => view('connections'),
  onNavigate: () => view('app-changes'),
});
const appearanceUI = createAppearancePreview({
  container: $('appearance-content'),
  onPreview: () => customizationDrawer.close(),
  api,
  getSelection: () => connectionsUI.getSelection(),
  onConnect: () => {
    customizationDrawer.close();
    view('connections');
  },
});
const resourcesUI = createResourcesUI({
  container: $('resources-content'),
  api,
  isRecording: () => state.recording,
});
const customizationDrawer = createCustomizationDrawer({
  dialog: $('customize-drawer'),
  trigger: $('customize-toggle'),
  closeButton: $('customize-close'),
  render: () => {
    customizations.render($('customize-content'));
    appearanceUI.render();
  },
});
function conversationContext() {
  const context = !$('courses-view').hidden ? canvasPanel.getContext() : {};
  return { courseId: context.courseId || '', assignmentId: context.assignmentId || '' };
}
const memoryUI = createMemoryUI({
  container: $('memory-content'),
  api,
  getContext: () => canvasPanel.getContext(),
  onResume: async (thread) => {
    if (thread.documentId) {
      await readingReady;
      if (!state.documents.some((doc) => doc.id === thread.documentId && !doc.canvasReading))
        throw new Error('Open the original file in Readings to resume this conversation.');
      openDocument(thread.documentId);
      $('question-input').focus();
      status(`Resumed: ${thread.title}. Ask your next question about this reading.`);
      return;
    }
    if (thread.courseId) {
      view('courses');
      await canvasPanel.navigate({
        courseId: thread.courseId,
        assignmentId: thread.assignmentId || undefined,
      });
    } else view('library');
    $('roger-launch').click();
    $('roger-widget-response').textContent = `Resumed: ${thread.title}. Ask your next question.`;
  },
  onOpenCitation: async (citation) => {
    await readingReady;
    const doc = state.documents.find(
      (item) => item.id === citation.documentId && !item.canvasReading,
    );
    if (!doc) throw new Error('Open the original file in Readings to follow this citation.');
    const page = doc.pages.find((item) => item.page === citation.page);
    if (
      !page ||
      doc.revision !== citation.revision ||
      !doc.text.slice(page.start, page.end).includes(citation.quote)
    )
      throw new Error('This citation was saved from a different reading revision.');
    openDocument(doc.id, page.page);
  },
});
async function rememberExchange(
  message,
  reply,
  scope = conversationContext(),
  { citations, signal } = {},
) {
  if (isPreviewSession()) return;
  try {
    const result = await api('/api/memory/record', {
      body: { ...scope, threadId: memoryUI.activeThread(scope), message, reply, citations },
      signal,
    });
    if (result.threadId) memoryUI.setThread(scope, result.threadId);
  } catch (error) {
    if (!signal?.aborted) status(`Conversation was not saved: ${error.message}`);
  }
}
function stop() {
  stopSpeech();
  $('reading-status').textContent = 'Stopped';
  $('pause-button').textContent = 'Pause';
}
let navigationTouched = false;
function view(name, { automatic = false, load = true, overview = false, keepAnswer = false } = {}) {
  if (name === 'customize') {
    customizationDrawer.open();
    return;
  }
  if (!automatic) navigationTouched = true;
  if (compactNav.matches) $('rail-more').open = false;
  stop();
  if (!keepAnswer) resetQuestionContext();
  if (name !== 'builder') builderUI.leave();
  if (name !== 'app-changes') appChangesUI.leave();
  if (name !== 'reader') {
    closePDF();
    ocrController?.abort();
  }
  for (const candidate of [
    'library',
    'courses',
    'planner',
    'settings',
    'reader',
    'builder',
    'app-changes',
    'connections',
    'resources',
    'research',
    'tools',
    'memory',
  ])
    $(`${candidate}-view`).hidden = candidate !== name;
  document.querySelectorAll('.primary-nav [data-view]').forEach((button) => {
    button.classList.toggle('active', button.dataset.view === name);
    if (button.dataset.view === name) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  });
  if (name === 'courses') {
    updateTodayDate();
    if (load && state.connected) {
      if (overview) canvasPanel.showToday();
      else void canvasPanel.loadCourses({ reuse: true });
    }
  }
  if (name === 'planner') homeworkPlanner.render();
  if (name === 'resources') resourcesUI.render();
  if (name === 'research') renderNewsDirectory($('research-content'));
  if (name === 'memory') return memoryUI.render();
  if (name === 'builder') void builderUI.render();
  if (name === 'app-changes') void appChangesUI.render();
  if (name === 'connections') void connectionsUI.render().catch((error) => status(error.message));
}
function renderLibrary() {
  const query = $('library-search').value.toLowerCase();
  $('library-list').replaceChildren();
  const shown = state.documents.filter((doc) => doc.title.toLowerCase().includes(query));
  $('library-empty').hidden = state.documents.length > 0;
  for (const doc of shown) {
    const card = node('article', undefined, 'reading-card');
    const icon = node('span', doc.isPdf ? 'PDF' : 'TXT', 'reading-icon');
    const body = node('div', undefined, 'reading-body');
    body.append(
      node('h3', doc.title),
      node(
        'p',
        `${doc.pages.length} ${doc.isPdf ? (doc.pages.length === 1 ? 'page' : 'pages') : doc.pages.length === 1 ? 'section' : 'sections'} · ${doc.saved ? 'Saved in this browser' : 'This session'}`,
      ),
    );
    const actions = node('div', undefined, 'reading-actions');
    const open = node('button', 'Open', 'button button-secondary');
    open.addEventListener('click', () => openDocument(doc.id));
    const remove = node('button', 'Remove', 'button button-quiet');
    remove.setAttribute('aria-label', `Remove ${doc.title}`);
    remove.addEventListener('click', async () => {
      if (
        (doc.notes || doc.annotations?.length) &&
        !window.confirm('Remove this reading and its notes and highlights from Roger?')
      )
        return;
      remove.disabled = true;
      try {
        if (doc.saved) await readingLibrary.remove(doc.id);
      } catch {
        status('Could not remove the saved reading. Try again.');
        remove.disabled = false;
        return;
      }
      resetQuestionContext();
      if (state.current?.id === doc.id) {
        stop();
        state.current = null;
      }
      disposeDocuments([doc]);
      state.documents = state.documents.filter((item) => item.id !== doc.id);
      renderLibrary();
    });
    actions.append(open);
    if (doc.saved) {
      const downloadOriginal = node('button', 'Download original', 'button button-quiet');
      downloadOriginal.addEventListener('click', async () => {
        try {
          const file = await readingLibrary.original(doc.id);
          if (!file) throw new Error('Reading removed');
          download(file, file.name);
        } catch {
          status('The original is no longer available in this browser.');
        }
      });
      actions.append(downloadOriginal);
    }
    actions.append(remove);
    card.append(icon, body, actions);
    $('library-list').append(card);
  }
  if (state.documents.length && !shown.length)
    $('library-list').append(node('p', 'No readings match that name.'));
}
function updateReading(doc, patch) {
  if (!doc.saved) return;
  const editingNotes = typeof patch.notes === 'string';
  if (editingNotes) $('notes-status').textContent = 'Saving…';
  void readingLibrary.update(doc.id, patch).then(
    () => {
      if (editingNotes && state.current === doc && doc.notes === patch.notes)
        $('notes-status').textContent = 'Saved in this browser';
    },
    () => {
      if (editingNotes && state.current === doc && doc.notes === patch.notes)
        $('notes-status').textContent = 'Could not save · download your notes';
      else status('Could not save the latest reading changes in this browser.');
    },
  );
}
function closePDF() {
  pdfController?.abort();
  pdfController = null;
  pdfWorkspace?.dispose();
  pdfWorkspace = null;
  pdfDocument = null;
  pdfSelection = null;
}
function selectionControls(enabled) {
  for (const id of ['highlight-selection', 'quote-note', 'ask-selection'])
    $(id).disabled = !enabled;
}
function renderHighlights() {
  const doc = state.current;
  $('highlights-list').replaceChildren();
  for (const mark of doc?.annotations ?? []) {
    const item = node('article', undefined, 'marked-passage');
    const jump = node('button', `Page ${mark.page}`, 'inline-link');
    jump.addEventListener('click', () => {
      state.page = mark.page - 1;
      renderPage();
    });
    const remove = node('button', 'Remove', 'button button-quiet');
    remove.addEventListener('click', () => {
      if (pdfWorkspace) {
        pdfWorkspace.removeAnnotation(mark.id);
        return;
      }
      doc.annotations = doc.annotations.filter((item) => item.id !== mark.id);
      updateReading(doc, { annotations: doc.annotations });
      renderHighlights();
    });
    item.append(jump, node('blockquote', mark.quote), remove);
    $('highlights-list').append(item);
  }
}
async function showOriginal() {
  const doc = state.current;
  if (!doc?.url || !originalMode) return;
  if (pdfWorkspace && pdfDocument === doc.id) {
    await pdfWorkspace.renderPage(state.page + 1);
    return;
  }
  closePDF();
  const controller = new AbortController();
  pdfController = controller;
  const pageNumber = state.page + 1;
  try {
    const bytes = await fetch(doc.url, { signal: controller.signal }).then((response) =>
      response.arrayBuffer(),
    );
    const workspace = await mountPDFWorkspace({
      container: $('pdf-workspace'),
      bytes,
      pageNumber,
      signal: controller.signal,
      annotations: doc.annotations ?? [],
      onSelection: (selection) => {
        pdfSelection = selection;
        resetQuestionContext();
        selectionControls(true);
      },
      onStatus: (message) => {
        if (!controller.signal.aborted) $('reading-status').textContent = message;
      },
      onAnnotationsChange: (items) => {
        doc.annotations = items;
        updateReading(doc, { annotations: items });
        if (state.current === doc) renderHighlights();
      },
    });
    if (controller.signal.aborted) {
      workspace.dispose();
      return;
    }
    pdfWorkspace = workspace;
    pdfDocument = doc.id;
    if (state.page + 1 !== pageNumber) await workspace.renderPage(state.page + 1);
  } catch (error) {
    if (!controller.signal.aborted) {
      status(error.message);
      $('reading-paper').hidden = false;
    }
  }
}
function openDocument(id, pageNumber) {
  const doc = state.documents.find((item) => item.id === id);
  if (!doc) return;
  if (state.current !== doc) closePDF();
  ocrController?.abort();
  state.current = doc;
  state.page = Math.max(0, Math.min(doc.pages.length - 1, (pageNumber ?? doc.lastPage ?? 1) - 1));
  originalMode = Boolean(doc.isPdf);
  view('reader');
  $('notes-input').value = doc.notes;
  $('answer-output').replaceChildren();
  $('sources-list').replaceChildren();
  $('notes-status').textContent = doc.saved
    ? 'Saved in this browser'
    : 'Session only · download to keep';
  renderPage();
}
function renderPage() {
  stop();
  resetQuestionContext();
  const doc = state.current;
  if (!doc) return;
  const page = doc.pages[state.page];
  if (doc.lastPage !== state.page + 1) {
    doc.lastPage = state.page + 1;
    updateReading(doc, { lastPage: doc.lastPage });
  }
  ocrController?.abort();
  pdfSelection = null;
  selectionControls(false);
  $('document-title').textContent = doc.title;
  const sourceLink = $('document-canvas-source');
  sourceLink.hidden = !doc.source;
  if (doc.source) sourceLink.href = doc.source.url;
  else sourceLink.removeAttribute('href');
  $('document-meta').textContent =
    `${doc.isPdf ? 'PDF' : doc.kind === 'pptx' ? 'PowerPoint · text only' : 'Text document'} · ${doc.pages.length} ${doc.kind === 'pptx' ? 'slides' : doc.isPdf ? (doc.pages.length === 1 ? 'page' : 'pages') : doc.pages.length === 1 ? 'section' : 'sections'}`;
  $('document-text').textContent =
    doc.text.slice(page.start, page.end).trim() ||
    'This page is a scan. Use OCR page to extract its text locally, then read, listen, or ask about it.';
  $('page-indicator').textContent =
    `${doc.isPdf ? 'Page' : 'Section'} ${state.page + 1} of ${doc.pages.length}`;
  $('page-prev').disabled = state.page === 0;
  $('page-next').disabled = state.page >= doc.pages.length - 1;
  $('read-button').disabled = !doc.text.slice(page.start, page.end).trim();
  $('toggle-original').hidden = !doc.url;
  $('reader-original').hidden = !doc.isPdf || !originalMode;
  $('reading-paper').hidden = doc.isPdf && originalMode;
  $('toggle-original').textContent = originalMode ? 'Reading text' : 'Original page';
  $('ocr-page').hidden = !doc.isPdf;
  $('ocr-page').disabled = !ocrAvailable;
  $('ocr-page').title = ocrAvailable
    ? 'Extract this page with local Apple Vision'
    : 'Local OCR helper is not installed on this computer';
  $('reading-status').textContent =
    doc.kind === 'pptx'
      ? 'Slide text · original layout and images are not included'
      : 'Ready · check extracted text against the original';
  renderHighlights();
  if (doc.isPdf && originalMode) void showOriginal().catch((error) => status(error.message));
}
function replacePageText(doc, replacements) {
  let text = '';
  const byPage = new Map(replacements.map(({ page, text }) => [page, text]));
  const pages = doc.pages.map(({ page, start, end }) => {
    const position = text.length;
    text += (byPage.get(page) ?? doc.text.slice(start, end)).trim() + '\n\n';
    return { page, start: position, end: text.length };
  });
  return { text, pages };
}
async function textDigest(text) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(bytes), (n) => n.toString(16).padStart(2, '0')).join('');
}
async function importFile(
  file,
  { signal, initialPage, source, ocr = [], open = true, saveLocally = false } = {},
) {
  if (state.importing) return;
  state.importing = true;
  const controller = new AbortController();
  state.importController = controller;
  if ($('cancel-import')) $('cancel-import').hidden = false;
  status('Opening document…');
  const abortImport = () => controller.abort();
  if (signal?.aborted) controller.abort();
  else signal?.addEventListener('abort', abortImport, { once: true });
  try {
    await readingReady;
    let doc;
    if (/\.pptx$/i.test(file.name)) {
      if (file.size > DOCUMENT_LIMITS.bytes) throw new Error('Choose a presentation under 12 MB.');
      const bytes = await file.arrayBuffer(),
        result = await uploadDocument('/api/documents/presentation', bytes, {
          signal: controller.signal,
        });
      let text = '';
      const pages = result.pages.map((item) => {
        const start = text.length;
        text += item.text + '\n\n';
        return { page: item.page, start, end: text.length };
      });
      const revision = Array.from(
        new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)),
        (n) => n.toString(16).padStart(2, '0'),
      ).join('');
      doc = {
        id: revision,
        revision,
        title: file.name,
        text,
        pages,
        isPdf: false,
        url: null,
        notes: '',
        kind: 'pptx',
      };
    } else doc = await readDocument(file, { signal: controller.signal });
    if (source) {
      doc.source = source;
      doc.title = source.title;
      doc.id = await textDigest(doc.id + '\n' + source.url);
    }
    if (ocr.length && doc.isPdf) {
      const replacement = replacePageText(doc, ocr);
      if (replacement.text.length > DOCUMENT_LIMITS.characters) {
        disposeDocuments([doc]);
        throw new Error('OCR text exceeds this reading’s text limit.');
      }
      Object.assign(doc, replacement);
      doc.revision = await textDigest(doc.text);
    }
    if (controller.signal.aborted) {
      disposeDocuments([doc]);
      throw new Error('Document opening cancelled.');
    }
    const existing = state.documents.find((item) => item.id === doc.id);
    if (existing) {
      disposeDocuments([doc]);
      if (open) openDocument(existing.id, initialPage);
      status('Opened the existing reading.');
      return;
    }
    if (state.documents.length >= DOCUMENT_LIMITS.files) {
      disposeDocuments([doc]);
      throw new Error('The library holds eight open readings. Remove one before adding another.');
    }
    if (
      state.documents.reduce((sum, item) => sum + item.text.length, 0) + doc.text.length >
      480_000
    ) {
      disposeDocuments([doc]);
      throw new Error('The reading library is full. Remove a document first.');
    }
    doc.canvasReading = !saveLocally;
    if (saveLocally && readingLibrary) {
      try {
        await readingLibrary.save(doc, file);
        doc.saved = true;
      } catch {
        doc.saveFailed = true;
      }
    }
    state.documents.push(doc);
    renderLibrary();
    if (open) openDocument(doc.id, initialPage);
    status(
      doc.saveFailed
        ? 'Reading opened for this session. This browser could not save it.'
        : doc.saved
          ? 'Reading saved in this browser.'
          : doc.kind === 'pptx'
            ? 'PowerPoint slide text opened. Original layout and images are not included.'
            : doc.text.trim()
              ? 'Document opened. Nothing was uploaded to an AI service.'
              : 'Original scan opened. Use OCR page to read its text locally.',
    );
    return true;
  } catch (error) {
    status(
      controller.signal.aborted
        ? 'Document opening cancelled.'
        : error.message || 'This document could not be opened.',
    );
  } finally {
    signal?.removeEventListener('abort', abortImport);
    state.importing = false;
    state.importController = null;
    if ($('cancel-import')) $('cancel-import').hidden = true;
    $('upload-input').value = '';
  }
}
function renderEvidence(passages, target = $('sources-list'), openSource) {
  target.replaceChildren();
  if (!passages.length) return;
  const details = node('details');
  details.open = Boolean(openSource);
  details.append(node('summary', 'Source text used for this question'));
  for (const [index, passage] of passages.entries()) {
    const article = node('article');
    const doc = state.documents.find((item) => item.id === passage.documentId);
    const location =
      passage.sourceUrl || (doc?.source && !doc.isPdf)
        ? `text section ${passage.page ?? 1}`
        : passage.page
          ? `page ${passage.page}`
          : `characters ${passage.start + 1}–${passage.end}`;
    const button = node(
      passage.sourceUrl ? 'a' : 'button',
      openSource
        ? `[${index + 1}] ${passage.title} · ${passage.section}`
        : `${passage.title} · ${location}`,
      'inline-link',
    );
    if (passage.sourceUrl) {
      button.href = passage.sourceUrl;
      button.target = '_blank';
      button.rel = 'noopener noreferrer';
    } else button.type = 'button';
    button.addEventListener('click', () => {
      if (openSource) return void openSource(passage.destination);
      if (passage.sourceUrl) return;
      const index = doc?.pages.findIndex(
        (page) => passage.start >= page.start && passage.start < page.end,
      );
      openDocument(passage.documentId, (index ?? -1) + 1);
    });
    article.append(button);
    if (doc?.source) {
      const source = node('a', 'Canvas source', 'inline-link');
      source.href = doc.source.url;
      source.target = '_blank';
      source.rel = 'noopener noreferrer';
      article.append(source);
    }
    article.append(node('blockquote', passage.text));
    details.append(article);
  }
  target.append(details);
}
async function askDemo(message, widget, response) {
  if (state.question) return;
  const controller = new AbortController();
  state.question = controller;
  const generation = ++state.generation;
  const sources = $('roger-widget-sources');
  const send = $('roger-send');
  send.disabled = true;
  widget.dataset.state = 'thinking';
  response.textContent = 'Looking through demo materials…';
  sources.replaceChildren();
  try {
    const result = await api('/api/demo/ask', {
      body: { ...conversationContext(), message },
      signal: controller.signal,
    });
    if (generation !== state.generation) return;
    renderChatText(response, result.text);
    renderEvidence(result.passages, sources, async (destination) => {
      try {
        if ($('courses-view').hidden) view('courses', { load: false, keepAnswer: true });
        await canvasPanel.navigate(destination);
      } catch (error) {
        status(error.message);
      }
    });
  } catch (error) {
    if (generation === state.generation) response.textContent = error.message;
  } finally {
    if (state.question === controller) state.question = null;
    send.disabled = false;
    widget.dataset.state = 'idle';
  }
}
async function ask(event, context = {}) {
  event.preventDefault();
  const doc = context.doc || state.current;
  if (!doc || state.question) return;
  const output = context.output || $('answer-output');
  const notify = context.notify || status;
  const message = (context.message ?? $('question-input').value).trim();
  if (!message) return;
  const provider = context.provider || $('provider-select').value;
  const allowCloud = context.allowCloud ?? $('cloud-consent').checked;
  if (provider === 'codex' && !allowCloud) {
    notify(
      'Allow this question’s source text to be shared with Codex, or choose the local helper.',
    );
    return;
  }
  const controller = new AbortController();
  state.question = controller;
  const generation = ++state.generation;
  $('ask-button').disabled = true;
  if ($('cancel-question')) $('cancel-question').hidden = false;
  try {
    const page = doc.pages[doc.id === state.current?.id ? state.page : 0];
    const questionScope = context.scope || $('question-scope')?.value;
    let passages;
    if (['library', 'document'].includes(questionScope)) {
      const result = await api('/api/retrieval', {
        body: {
          documents: (questionScope === 'document' ? [doc] : state.documents).map((item) => ({
            id: item.id,
            revision: item.revision,
            title: item.title,
            text: item.text,
            pages: item.pages,
          })),
          query: message,
        },
        signal: controller.signal,
      });
      if (generation !== state.generation || controller.signal.aborted) return;
      if (result.state === 'no-match')
        throw new Error(
          'No matching source passages found. Try words from your readings, or choose Current page. No AI request was sent.',
        );
      passages = result.passages;
    } else {
      const selection = context.output ? null : window.getSelection(),
        source = $('document-text');
      const inside = selection?.anchorNode && source.contains(selection.anchorNode);
      if (inside && (!selection.focusNode || !source.contains(selection.focusNode)))
        throw new Error('Select text entirely inside the reading. No AI request was sent.');
      const selected = inside
        ? selection.toString().trim()
        : !context.output && pdfSelection?.page === page.page
          ? pdfSelection.quote
          : '';
      const sourceText = doc.text.slice(page.start, page.end),
        text = selected || sourceText.trim();
      if (!text) throw new Error('This page has no extracted text. Open a readable page first.');
      let offset = sourceText.indexOf(text);
      if (selected && inside && selection.rangeCount) {
        const range = selection.getRangeAt(0),
          prefix = document.createRange();
        prefix.selectNodeContents(source);
        prefix.setEnd(range.startContainer, range.startOffset);
        const renderedStart = sourceText.indexOf(source.textContent),
          raw = range.toString();
        offset = renderedStart + prefix.toString().length + (raw.length - raw.trimStart().length);
      } else if (selected && pdfSelection) offset = pdfSelection.start;
      if (offset < 0 || sourceText.slice(offset, offset + text.length) !== text)
        throw new Error('That selection does not match this source page. Select it again.');
      const start = page.start + offset;
      passages = [
        {
          documentId: doc.id,
          revision: doc.revision,
          title: doc.title,
          page: page.page,
          start,
          end: start + Math.min(text.length, 12000),
          text: text.slice(0, 12000),
        },
      ];
    }
    renderEvidence(passages, context.evidence);
    output.replaceChildren(node('p', 'Roger is looking through your sources…'));
    notify(
      provider === 'codex'
        ? 'Sending the displayed source context to Codex…'
        : 'Asking the local helper…',
    );
    const result = await api('/api/study', {
      body: {
        provider,
        allowCloud: provider === 'codex' && allowCloud,
        text: passages.map((passage) => passage.text).join('\n\n'),
        message,
      },
      signal: controller.signal,
    });
    if (generation !== state.generation) return;
    output.replaceChildren(node('p', result.reply));
    for (const quote of result.passages)
      output.append(node('blockquote', quote.quote), node('p', quote.note));
    output.append(node('p', result.question));
    notify('Answer ready. Check it against the source text.');
    const local = new Map(
      state.documents.filter((item) => !item.canvasReading).map((item) => [item.id, item]),
    );
    const localSources = passages.every((passage) => local.has(passage.documentId));
    if (!doc.canvasReading && localSources) {
      const cited = new Map();
      for (const { quote } of result.passages) {
        const matches = passages.filter((passage) => passage.text.includes(quote));
        if (matches.length === 1) cited.set(matches[0], quote);
      }
      const evidence = cited.size
        ? [...cited]
        : passages.slice(0, 4).map((passage) => [passage, passage.text.slice(0, 1000)]);
      await rememberExchange(
        message,
        [
          result.reply,
          ...result.passages.flatMap(({ quote, note }) => [quote, note]),
          result.question,
        ].join('\n\n'),
        { documentId: doc.id },
        {
          signal: controller.signal,
          citations: evidence.map(([passage, quote]) => {
            const source = local.get(passage.documentId);
            return {
              documentId: passage.documentId,
              revision: passage.revision,
              title: passage.title.slice(0, 300),
              page: passage.page,
              location: source.isPdf ? 'page' : source.kind === 'pptx' ? 'slide' : 'section',
              quote,
            };
          }),
        },
      );
    }
  } catch (error) {
    if (generation === state.generation) {
      output.replaceChildren();
      notify(controller.signal.aborted ? 'Question cancelled.' : error.message);
    }
  } finally {
    if (generation === state.generation) {
      state.question = null;
      $('ask-button').disabled = false;
      if ($('cancel-question')) $('cancel-question').hidden = true;
    }
  }
}
function updateTodayDate() {
  $('today-date').textContent = new Date().toLocaleDateString(undefined, {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  });
}
async function start() {
  const sessionRequest = initialize();
  readingReady = sessionRequest.then(
    async (session) => {
      if (session.preview) return;
      try {
        const { openReadingLibrary } = await import('/client/reading-library.mjs');
        readingLibrary = await openReadingLibrary();
        state.documents = await readingLibrary.load();
        renderLibrary();
      } catch {
        readingLibrary = undefined;
        $('library-storage-status').textContent =
          'Saved readings are unavailable. Opened files will stay in this session.';
      }
      $('folder-button').hidden = !('webkitdirectory' in $('folder-input'));
    },
    () => {},
  );
  updateTodayDate();
  void import('/client/student-tools.mjs')
    .then(({ mountStudentTools }) =>
      mountStudentTools({
        finance: $('finance-calculator'),
        grades: $('weighted-calculator'),
        items: $('grade-items'),
        add: $('add-grade-item'),
      }),
    )
    .catch(() => {
      $('calculator-status').textContent = 'Restart Roger to load the calculators.';
      $('calculator-grid').hidden = true;
    });
  const syncRail = () => {
    $('rail-more').open = !compactNav.matches;
  };
  compactNav.addEventListener('change', syncRail);
  syncRail();
  document
    .querySelectorAll('[data-view]')
    .forEach((button) =>
      button.addEventListener('click', () =>
        view(button.dataset.view, { overview: button.dataset.view === 'courses' }),
      ),
    );
  for (const id of ['upload-button', 'upload-inline'])
    $(id).addEventListener('click', () => $('upload-input').click());
  $('upload-input').addEventListener('change', () => {
    const file = $('upload-input').files[0];
    if (file) void importFile(file, { saveLocally: true });
  });
  $('folder-button').addEventListener('click', () => $('folder-input').click());
  $('folder-input').addEventListener('change', async (event) => {
    if (state.importing || folderImport) return;
    const input = event.target;
    const total = input.files.length;
    const controller = new AbortController();
    folderImport = controller;
    $('folder-button').disabled = true;
    let added = 0;
    try {
      await readingReady;
      for (let index = 0; index < Math.min(total, 200); index++) {
        if (controller.signal.aborted || state.documents.length >= DOCUMENT_LIMITS.files) break;
        const file = input.files[index];
        if (!/\.(pdf|pptx|txt|md)$/i.test(file.name) || file.size > DOCUMENT_LIMITS.bytes) continue;
        if (await importFile(file, { open: false, signal: controller.signal, saveLocally: true }))
          added++;
      }
      status(
        `Added ${added} of ${total} selected files${controller.signal.aborted ? ' before cancellation' : ''}.`,
      );
    } finally {
      folderImport = undefined;
      $('folder-button').disabled = false;
      input.value = '';
    }
  });
  $('library-search').addEventListener('input', renderLibrary);
  const rogerWidget = $('roger-widget');
  const rogerResponse = $('roger-widget-response');
  const companion = mountRogerWidget({
    root: rogerWidget,
    getBottomInset: () =>
      compactNav.matches ? document.querySelector('.app-rail').getBoundingClientRect().height : 0,
    onOpen: ({ alreadyOpen }) => {
      const source = $('roger-source');
      const previous = source.value;
      source.replaceChildren();
      const all = node('option', 'Search open readings');
      all.value = 'library';
      source.append(all);
      for (const doc of state.documents) {
        const option = node('option', doc.title);
        option.value = doc.id;
        source.append(option);
      }
      if ([...source.options].some((option) => option.value === previous)) source.value = previous;
      source.hidden = state.recording || !state.documents.length || $('roger-mode').value !== 'ask';
      if (!alreadyOpen) rogerResponse.replaceChildren();
    },
    onClose: () => {
      if (rogerWidget.dataset.state === 'thinking') cancelQuestion();
    },
  });
  $('roger-ai').addEventListener('click', () => {
    companion.close({ focus: false });
    view('connections');
  });
  $('roger-mode').addEventListener('change', () => {
    $('roger-message').placeholder =
      $('roger-mode').value === 'change-app'
        ? 'What should Roger change about the app?'
        : $('roger-mode').value === 'build'
          ? 'What standalone tool should Roger build?'
          : 'Ask Roger…';
    $('roger-source').hidden = !state.documents.length || $('roger-mode').value !== 'ask';
  });
  $('roger-source').addEventListener('change', () => {
    cancelQuestion();
    rogerResponse.replaceChildren();
    $('roger-widget-sources').replaceChildren();
  });
  $('roger-composer').addEventListener('submit', async (event) => {
    event.preventDefault();
    const message = $('roger-message').value.trim();
    if (!message) {
      $('roger-message').focus();
      return;
    }
    if (state.recording) {
      await askDemo(message, rogerWidget, rogerResponse);
      return;
    }
    if (
      /\b(what|where)\b.*\b(working on|worked on|last time|before|earlier)\b|\b(recent work|previous conversations|chat history)\b/i.test(
        message,
      )
    ) {
      try {
        const found = await api('/api/memory/retrieve', {
          body: { ...conversationContext(), query: message, recentWork: true },
        });
        rogerResponse.replaceChildren(
          node(
            'p',
            found.paused
              ? 'Memory is paused. Resume it in Conversations.'
              : found.threads.length
                ? 'Here is your recent work:'
                : 'No saved conversations yet.',
          ),
        );
        for (const thread of found.threads) {
          const button = node('button', thread.title, 'button button-secondary');
          button.type = 'button';
          button.addEventListener('click', async () => {
            await view('memory');
            await memoryUI.openThread(thread.id);
          });
          rogerResponse.append(button);
        }
      } catch (error) {
        rogerResponse.textContent = error.message;
      }
      return;
    }
    if (/^remember(?: that)?\s+/i.test(message)) {
      try {
        await api('/api/memory/pin', {
          body: {
            content: message.replace(/^remember(?: globally)?(?: that)?\s+/i, ''),
            scope:
              conversationContext().courseId && !/^remember globally\b/i.test(message)
                ? 'course'
                : 'global',
            courseId: conversationContext().courseId,
          },
        });
        rogerResponse.textContent = `Remembered for ${conversationContext().courseId && !/^remember globally\b/i.test(message) ? 'this course' : 'all conversations'}. You can inspect or forget it in Conversations.`;
      } catch (error) {
        rogerResponse.textContent = error.message;
      }
      return;
    }
    if (
      $('roger-mode').value === 'change-app' ||
      ($('roger-mode').value !== 'build' && isAppChangeRequest(message))
    ) {
      companion.close({ focus: false });
      const previewed = await appChangesUI.request(message);
      const changeState = appChangesUI.getState();
      await rememberExchange(
        message,
        previewed && changeState.draft
          ? `Created a whole-app preview: ${changeState.draft.title}. No app files have been applied. Open the preview and review the change before applying it.`
          : 'Opened app changes for this request. No successful new preview was recorded.',
        {},
      );
      return;
    }
    if (isAppearanceRequest(message)) {
      customizationDrawer.open();
      const previewed = await appearanceUI.request(message);
      if (previewed)
        await rememberExchange(
          message,
          'Created an appearance preview. Use Keep this look to apply it, or Restore to discard it.',
          {},
        );
      return;
    }
    const change =
      $('roger-mode').value === 'build' ? { handled: false } : customizations.handle(message);
    if (change.handled) {
      cancelQuestion();
      rogerResponse.textContent = change.reply;
      await rememberExchange(message, change.reply);
      $('roger-widget-sources').replaceChildren();
      return;
    }
    if ($('roger-mode').value === 'build' || isBuildRequest(message)) {
      companion.close({ focus: false });
      await builderUI.request(message);
      const built = builderUI.getState();
      await rememberExchange(
        message,
        built.draft
          ? `Created a tool preview: ${built.draft.title || 'new tool'}. Keeping the feature is a separate action in Your tools.`
          : 'Opened the tool builder for this request. No successful preview was recorded.',
        {},
      );
      return;
    }
    if (state.connected) {
      try {
        await canvasPanel.loadCourses({ reuse: true });
        const route = resolveNavigation(
          message,
          canvasPanel.getNavigationIndex(),
          canvasPanel.getContext(),
        );
        if (route?.choices) {
          rogerResponse.replaceChildren(node('p', 'Which one did you mean?'));
          for (const choice of route.choices) {
            const button = node('button', choice.label, 'button button-secondary');
            button.type = 'button';
            button.addEventListener('click', async () => {
              try {
                view('courses');
                await canvasPanel.navigate(choice.target);
                rogerResponse.textContent = `Opened ${choice.label}. Ask your question here.`;
              } catch (error) {
                rogerResponse.textContent = error.message;
              }
            });
            rogerResponse.append(button);
          }
          return;
        }
        if (route?.target) {
          view('courses');
          await canvasPanel.navigate(route.target);
          rogerResponse.textContent = `Opened ${route.label}.`;
          if (route.explicit && !/[?]|\b(why|when|what|how|explain|help)\b/i.test(message)) {
            await rememberExchange(message, `Opened ${route.label}.`);
            return;
          }
        }
      } catch (error) {
        rogerResponse.textContent = error.message;
        return;
      }
    }
    if (!connectionsUI.getSelection()) await connectionsUI.render().catch(() => {});
    const selection = connectionsUI.getSelection();
    if (selection) {
      if (state.question) return;
      const controller = new AbortController();
      state.question = controller;
      const generation = ++state.generation;
      rogerWidget.dataset.state = 'thinking';
      $('roger-send').disabled = true;
      rogerResponse.textContent = `Asking ${selection.provider}…`;
      $('roger-widget-sources').replaceChildren();
      try {
        const scope = $('roger-source').value;
        const courseSources = !$('courses-view').hidden
          ? (canvasPanel.getSourceContext?.() || []).filter((source) => source.text?.trim())
          : [];
        const docs = courseSources.length
          ? await Promise.all(
              courseSources.map(async (source, index) => ({
                id: `course-${index}`,
                revision: await textDigest(source.text),
                title: source.title,
                text: source.text,
                pages: [{ page: 1, start: 0, end: source.text.length }],
                sourceUrl: source.url,
              })),
            )
          : scope === 'library'
            ? state.documents
            : state.documents.filter((doc) => doc.id === scope);
        let passages = [];
        if (docs.length) {
          const found = await api('/api/retrieval', {
            body: {
              documents: docs.map((doc) => ({
                id: doc.id,
                revision: doc.revision,
                title: doc.title,
                text: doc.text,
                pages: doc.pages,
              })),
              query: message,
            },
            signal: controller.signal,
          });
          if (
            found.state === 'no-match' &&
            !courseSources.length &&
            !memoryUI.activeThread(conversationContext())
          )
            throw new Error(
              'No matching passages in the open sources. Open the relevant syllabus, assignment, or reading, then ask again.',
            );
          let selectedPassages = found.passages || [];
          if (!selectedPassages.length && courseSources.length) {
            let remaining = 22000;
            selectedPassages = docs.flatMap((doc) => {
              if (!remaining) return [];
              const text = doc.text.slice(0, Math.min(8000, remaining));
              remaining -= text.length;
              return [
                { documentId: doc.id, title: doc.title, text, start: 0, end: text.length, page: 1 },
              ];
            });
          }
          passages = selectedPassages.map((passage) => ({
            ...passage,
            sourceUrl: docs.find((doc) => doc.id === passage.documentId)?.sourceUrl,
          }));
          renderEvidence(passages, $('roger-widget-sources'));
        }
        const result = await api('/api/connections/ask', {
          body: {
            ...selection,
            message,
            context: conversationContext(),
            threadId: memoryUI.activeThread(conversationContext()),
            citations: passages.slice(0, 20).map((passage) => ({
              title: passage.title,
              page: passage.sourceUrl ? undefined : passage.page,
              sourceUrl: passage.sourceUrl,
              quote: passage.text.slice(0, 1000),
            })),
            source: passages
              .map(
                (passage, index) =>
                  `[${index + 1}] ${passage.title} · ${passage.sourceUrl ? 'Canvas text section' : 'page ' + passage.page}${passage.sourceUrl ? '\n' + passage.sourceUrl : ''}\n${passage.text}`,
              )
              .join('\n\n')
              .slice(0, 24000),
          },
          signal: controller.signal,
        });
        if (generation === state.generation) {
          renderChatText(rogerResponse, result.text);
          memoryUI.setThread(conversationContext(), result.threadId);
          if (result.memoryWarning)
            rogerResponse.append(
              node('p', `This answer was not fully saved: ${result.memoryWarning}`, 'field-hint'),
            );
          if (result.memorySources?.length) {
            const used = node(
              'button',
              `Recalled ${result.memorySources.length} saved excerpts`,
              'inline-link',
            );
            used.type = 'button';
            used.addEventListener('click', () => view('memory'));
            $('roger-widget-sources').append(used);
          }
        }
      } catch (error) {
        if (generation === state.generation)
          rogerResponse.textContent = controller.signal.aborted
            ? 'Question cancelled.'
            : error.message;
      } finally {
        if (generation === state.generation) state.question = null;
        $('roger-send').disabled = false;
        rogerWidget.dataset.state = 'idle';
      }
      return;
    }
    const scope = $('roger-source').value;
    const doc =
      scope === 'library'
        ? state.current || state.documents[0]
        : state.documents.find((item) => item.id === scope);
    if (!doc) {
      rogerResponse.textContent =
        'I need a source first. Open a course reading or add one to your Library.';
      return;
    }
    if (state.question) {
      rogerResponse.textContent =
        'One question at a time. Wait for the answer or close Roger to cancel.';
      return;
    }
    $('roger-send').disabled = true;
    $('roger-widget-sources').replaceChildren();
    rogerResponse.textContent = 'Looking through your reading…';
    rogerWidget.dataset.state = 'thinking';
    try {
      await ask(event, {
        doc,
        scope: scope === 'library' ? 'library' : 'document',
        message,
        provider: 'ollama',
        allowCloud: false,
        output: rogerResponse,
        evidence: $('roger-widget-sources'),
        notify: (text) => {
          if (!rogerResponse.textContent) rogerResponse.textContent = text;
          status(text);
        },
      });
    } finally {
      $('roger-send').disabled = false;
      rogerWidget.dataset.state = 'idle';
    }
  });
  $('cancel-import')?.addEventListener('click', () => {
    folderImport?.abort();
    state.importController?.abort();
    status('Cancelling document opening…');
  });
  $('back-library').addEventListener('click', () => view('library'));
  $('page-prev').addEventListener('click', () => {
    if (state.page > 0) {
      state.page--;
      renderPage();
    }
  });
  $('page-next').addEventListener('click', () => {
    if (state.page < state.current.pages.length - 1) {
      state.page++;
      renderPage();
    }
  });
  $('toggle-original').addEventListener('click', () => {
    originalMode = !originalMode;
    renderPage();
  });
  $('highlight-selection').addEventListener('click', () => {
    try {
      if (originalMode && pdfWorkspace) pdfWorkspace.highlightSelection();
      else addQuoteNote();
    } catch (error) {
      status(error.message);
    }
  });
  function addQuoteNote() {
    const quote = pdfSelection?.quote || window.getSelection()?.toString().trim();
    if (!quote || !state.current) return;
    const notes = state.current.notes + `\n\n> ${quote}\n\n— Page ${state.page + 1}\n`;
    if (notes.length > $('notes-input').maxLength) {
      status('Download your notes before adding more. This reading has reached the notes limit.');
      return;
    }
    state.current.notes = notes;
    $('notes-input').value = state.current.notes;
    $('notes-status').textContent = 'Not downloaded · session only';
    updateReading(state.current, { notes });
    status('Selected passage added to your notes with its page number.');
  }
  $('quote-note').addEventListener('click', addQuoteNote);
  $('ask-selection').addEventListener('click', () => {
    $('question-input').value = 'Explain this passage.';
    $('question-scope').value = 'page';
    $('question-input').focus();
    status('Selected passage is ready. Choose your helper and ask.');
  });
  $('export-highlights').addEventListener('click', () => {
    if (!state.current) return;
    const doc = state.current;
    download(
      new Blob(
        [
          JSON.stringify(
            {
              format: 'atlas-page-annotations-v1',
              documentId: doc.id,
              title: doc.title,
              annotations: doc.annotations ?? [],
            },
            null,
            2,
          ),
        ],
        { type: 'application/json' },
      ),
      doc.title + '-annotations.json',
    );
  });
  $('cancel-ocr').addEventListener('click', () => ocrController?.abort());
  $('ocr-page').addEventListener('click', async () => {
    const doc = state.current;
    if (!doc?.url || ocrController) return;
    const pageIndex = state.page,
      controller = new AbortController();
    ocrController = controller;
    $('ocr-page').disabled = true;
    $('cancel-ocr').hidden = false;
    status('Reading this page with local Apple Vision OCR…');
    try {
      const bytes = await fetch(doc.url, { signal: controller.signal }).then((response) =>
        response.arrayBuffer(),
      );
      const result = await uploadDocument(`/api/documents/ocr?pages=${pageIndex + 1}`, bytes, {
        signal: controller.signal,
      });
      if (controller.signal.aborted || state.current !== doc || state.page !== pageIndex) return;
      if (!result.pages[0]?.text.trim())
        throw new Error('OCR found no readable text on this page.');
      const { text, pages } = replacePageText(doc, result.pages);
      if (
        text.length > DOCUMENT_LIMITS.characters ||
        state.documents.reduce(
          (sum, item) => sum + (item === doc ? text.length : item.text.length),
          0,
        ) > 480000
      )
        throw new Error('OCR would exceed this session’s text limit. Open a shorter document.');
      doc.text = text;
      doc.pages = pages;
      doc.revision = await textDigest(text);
      updateReading(doc, { text, pages, revision: doc.revision });
      originalMode = false;
      renderPage();
      status(
        'OCR text ready. Check recognition before quoting or asking AI. The original PDF is unchanged.',
      );
    } catch (error) {
      status(controller.signal.aborted ? 'OCR cancelled.' : error.message);
    } finally {
      if (ocrController === controller) ocrController = null;
      $('ocr-page').disabled = false;
      $('cancel-ocr').hidden = true;
    }
  });
  let naturalVoices = [];
  const voiceEngine = $('narration-engine');
  voiceEngine.value = 'device';
  const voicePreset = $('narration-preset');
  const voicePicker = $('narration-voice');
  voicePreset.value = getSpeechPreferences().presetId;
  function updateVoiceDetails() {
    const choice = narrationChoice();
    const useNatural = voiceEngine.value === 'natural';
    voicePicker.hidden = useNatural;
    document.querySelector('label[for="narration-voice"]').hidden = useNatural;
    $('voice-details').textContent = useNatural
      ? `${naturalVoices.find((item) => item.id === voicePreset.value)?.name || voicePreset.value} · natural local narration. First audio may take a moment to prepare.`
      : $('voice-details').textContent;
    if (useNatural) {
      $('preview-voice').disabled = !naturalVoices.length;
      return;
    }
    $('voice-details').textContent = choice.voice
      ? `${choice.preset.label} · ${choice.voice.name} · ${choice.voice.lang} · ${choice.count} local English ${choice.count === 1 ? 'voice' : 'voices'} available.${choice.count === 1 ? ' All four styles use this same voice.' : ''}${choice.fallback ? ' Saved voice unavailable; using the recommended voice.' : ''}`
      : 'No local English voice is exposed by this browser. Enable a device voice or try another browser; no cloud fallback will be used.';
    $('preview-voice').disabled = !choice.voice;
  }
  const unwatchVoices = watchLocalVoices((voices) => {
    voicePicker.replaceChildren();
    const recommended = node('option', 'Recommended for this style');
    recommended.value = '';
    voicePicker.append(recommended);
    for (const voice of voices) {
      const option = node('option', `${voice.name} · ${voice.lang}`);
      option.value = voice.id;
      voicePicker.append(option);
    }
    const saved = getSpeechPreferences().voiceId;
    if (saved && !voices.some((voice) => voice.id === saved)) {
      const unavailable = node('option', 'Saved voice unavailable · recommended fallback');
      unavailable.value = saved;
      voicePicker.append(unavailable);
    }
    voicePicker.value = saved;
    updateVoiceDetails();
  });
  window.addEventListener('beforeunload', unwatchVoices, { once: true });
  voiceEngine.addEventListener('change', () => {
    stop();
    setSpeechPreferences({ engineId: voiceEngine.value });
    updateVoiceDetails();
  });
  const checkNarration = () =>
    api('/api/narration/status')
      .then((result) => {
        const naturalOption = voiceEngine.querySelector('[value="natural"]');
        naturalOption.disabled = !result.available;
        naturalOption.textContent = result.available
          ? 'Natural local · Kokoro'
          : 'Natural local · unavailable';
        naturalVoices = result.available ? result.voices : [];
        configureNaturalNarration(
          result.available
            ? (text, preset, signal) =>
                api('/api/narration', { body: { text, preset }, signal, binary: true })
            : null,
        );
        const savedEngine = getSpeechPreferences().engineId;
        voiceEngine.value = savedEngine === 'device' || !result.available ? 'device' : 'natural';
        updateVoiceDetails();
      })
      .catch(() => {
        configureNaturalNarration(null);
        voiceEngine.querySelector('[value="natural"]').textContent = 'Natural local · unavailable';
        updateVoiceDetails();
      });
  voicePreset.addEventListener('change', () => {
    stop();
    setSpeechPreferences({ presetId: voicePreset.value });
    updateVoiceDetails();
  });
  voicePicker.addEventListener('change', () => {
    stop();
    setSpeechPreferences({ voiceId: voicePicker.value });
    updateVoiceDetails();
  });
  $('preview-voice').addEventListener('click', async () => {
    try {
      $('pause-button').textContent = 'Pause';
      await readSpeech(
        'Let’s take this one idea at a time. I’ll read your course material clearly, so you can focus on what matters.',
        (text) => ($('reading-status').textContent = text),
        { sample: true, engineId: voiceEngine.value },
      );
    } catch (error) {
      status(error.message);
    }
  });
  $('read-button').addEventListener('click', async () => {
    try {
      $('pause-button').textContent = 'Pause';
      const page = state.current.pages[state.page];
      await readSpeech(
        state.current.text.slice(page.start, page.end),
        (text) => ($('reading-status').textContent = text),
        { engineId: voiceEngine.value },
      );
    } catch (error) {
      status(error.message);
    }
  });
  $('pause-button').addEventListener('click', () => {
    $('pause-button').textContent = pauseSpeech() ? 'Resume' : 'Pause';
  });
  $('stop-button').addEventListener('click', stop);
  $('notes-input').addEventListener('input', () => {
    if (!state.current) return;
    state.current.notes = $('notes-input').value;
    $('notes-status').textContent = 'Not downloaded · session only';
    updateReading(state.current, { notes: state.current.notes });
  });
  $('save-notes').addEventListener('click', () => {
    if (!state.current) return;
    const doc = state.current;
    download(
      new Blob(
        [
          `# ${doc.title}\n\n${doc.notes}\n\n${(doc.annotations ?? []).map((mark) => `> ${mark.quote}\n\nPage ${mark.page}\n`).join('\n')}`,
        ],
        { type: 'text/markdown' },
      ),
      doc.title.replace(/\.[^.]+$/, '') + '-notes.md',
    );
    $('notes-status').textContent = 'Download requested · check your downloads';
  });
  $('provider-select').addEventListener('change', () => {
    resetQuestionContext();
    $('cloud-consent-row').hidden = $('provider-select').value !== 'codex';
  });
  $('question-form').addEventListener('submit', ask);
  $('cancel-question')?.addEventListener('click', () => {
    cancelQuestion();
    status('Question cancelled.');
  });
  $('question-scope')?.addEventListener('change', resetQuestionContext);
  $('question-input').addEventListener('input', resetQuestionContext);
  $('cloud-consent').addEventListener('change', () => {
    if (!$('cloud-consent').checked) {
      cancelQuestion();
      $('answer-output').replaceChildren();
      $('sources-list').replaceChildren();
    }
  });
  let sourceSelection = '';
  document.addEventListener('selectionchange', () => {
    const selection = window.getSelection(),
      source = $('document-text');
    const next =
      selection?.anchorNode && source.contains(selection.anchorNode)
        ? `${selection.anchorOffset}:${selection.focusOffset}:${selection.toString()}`
        : '';
    if (next) {
      pdfSelection = null;
      selectionControls(Boolean(selection.toString().trim()));
    }
    if (next !== sourceSelection) {
      sourceSelection = next;
      resetQuestionContext();
    }
  });
  canvasPanel.bind();
  renderLibrary();
  const session = await sessionRequest;
  if (session.preview)
    $('library-save-note').textContent = 'Readings opened here stay in this preview session.';
  state.recording = session.recording === true;
  if (state.recording) {
    $('roger-mode').hidden = true;
    $('roger-ai').hidden = true;
    $('roger-message').placeholder = 'Ask about a demo course…';
    $('tool-builder-entry').hidden = true;
  }
  const demoSettings = $('demo-settings');
  if (demoSettings) demoSettings.hidden = !session.recordingAvailable;
  canvasPanel.restore(session.canvas);
  if (session.canvas && !navigationTouched) {
    view('courses', { automatic: true, load: false });
    await canvasPanel.loadCourses({ reuse: true });
  }
  try {
    const result = await api('/api/providers');
    for (const provider of result.providers) {
      const option = $('provider-select').querySelector(`option[value="${provider.id}"]`);
      if (option) {
        option.disabled = provider.state !== 'available';
        option.textContent =
          provider.label + (provider.state === 'available' ? '' : ` · ${provider.state}`);
      }
    }
  } catch {
    status('AI connections could not be checked. You can still read and take notes.');
  }
  try {
    const capabilities = await api('/api/documents/status');
    ocrAvailable = capabilities.ocr.available;
  } catch {
    ocrAvailable = false;
  }
  await checkNarration();
  await connectionsUI.render().catch(() => {});
}

function download(blob, name) {
  const url = URL.createObjectURL(blob),
    link = node('a');
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
window.addEventListener('beforeunload', () => {
  homeworkPlanner.destroy();
  stop();
  closePDF();
  ocrController?.abort();
  state.question?.abort();
  state.importController?.abort();
  folderImport?.abort();
  disposeDocuments(state.documents);
});
start().catch((error) => status(error.message || 'Reload Atlas Reader to start again.'));
