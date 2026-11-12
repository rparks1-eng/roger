import { mountAssignmentStudy } from '/client/study-ui.mjs';
import { openSyllabusReading } from '/client/syllabus-ui.mjs';

const CORPUS_CHARACTERS = 8_000_000;
const ATTACHMENT_CHARACTERS = 24_000;
const COURSE_ATTACHMENT_CHARACTERS = 120_000;
const ATTACHMENT_LIMIT = 12;
const GROUPS = ['Past assignments', 'Documents', 'Pages', 'Links', 'Videos', 'Other materials'];

function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function catalogue(course) {
  const groups = new Map(GROUPS.map((name) => [name, []]));
  for (const assignment of course.assignments) {
    if (assignment.submitted || !assignment.dueAt || Date.parse(assignment.dueAt) <= Date.now()) {
      groups.get('Past assignments').push({
        key: `assignment:${assignment.id}`,
        assignmentId: assignment.id,
        title: assignment.name,
        url: assignment.url,
        locked: assignment.locked,
        dueAt: assignment.dueAt,
      });
    }
  }
  groups
    .get('Past assignments')
    .sort((a, b) => (Date.parse(b.dueAt) || 0) - (Date.parse(a.dueAt) || 0));
  const used = new Set();
  for (const module of course.modules) {
    for (const item of module.items) {
      if (item.type === 'Assignment') continue;
      const key = item.fileId
        ? `file:${item.fileId}`
        : item.pageUrl
          ? `page:${item.pageUrl}`
          : `item:${item.id}`;
      if (used.has(key)) continue;
      used.add(key);
      const category =
        item.studyCategory ||
        (item.fileId ? 'Documents' : item.pageUrl ? 'Pages' : 'Other materials');
      groups.get(category).push({
        ...item,
        key,
        module: module.name,
        locked: item.locked || module.locked,
      });
    }
  }
  return groups;
}

function selectable(entry, group) {
  if (group === 'Past assignments') return true;
  if (entry.locked) return false;
  if (group === 'Pages') return true;
  return (
    group === 'Documents' &&
    Boolean(entry.fileId) &&
    !/\.(?:xlsx?|doc|ppt|zip|png|jpe?g)$/i.test(entry.title)
  );
}

function attachmentLabel(entry, group) {
  if (entry.locked) return '';
  if (group === 'Videos') return 'transcript';
  if (group === 'Links') return 'reading text';
  return '';
}

function transcriptPages(text) {
  const cue = /^\[?((?:\d{1,3}:)?\d{1,3}:[0-5]\d(?:[.,]\d{3})?)\]?(?:\s+|$)/;
  if (/^WEBVTT(?:\s|$)/.test(text))
    return text
      .split(/\n[ \t]*\n+/)
      .slice(1)
      .flatMap((block) => {
        if (/^(?:NOTE|STYLE|REGION)(?:\s|$)/.test(block)) return [];
        const lines = block.split('\n');
        for (const [index, line] of lines.slice(0, 2).entries()) {
          const marker = cue.exec(line.trim());
          if (!marker || !line.trim().slice(marker[0].length).startsWith('-->')) continue;
          const passage = lines
            .slice(index + 1)
            .join('\n')
            .trim();
          return passage ? [{ page: null, timestamp: marker[1], text: passage }] : [];
        }
        return [];
      });
  const pages = [];
  let timestamp = '';
  let lines = [];
  function save() {
    const passage = lines.join('\n').trim();
    if (passage) pages.push({ page: null, timestamp, text: passage });
  }
  const transcript = text.split('\n');
  for (const [index, line] of transcript.entries()) {
    const value = line.trim();
    if (/^\d+$/.test(value) && cue.test(transcript[index + 1]?.trim() || '')) continue;
    const marker = cue.exec(value);
    if (!marker) {
      lines.push(line);
      continue;
    }
    save();
    timestamp = marker[1];
    const rest = value.slice(marker[0].length);
    lines = rest.startsWith('-->') ? [] : [rest];
  }
  save();
  return pages;
}

export function mountCourseStudy({
  content,
  course,
  draft,
  loader,
  api,
  operation,
  invalidate,
  importFile,
  external,
  plainText,
}) {
  const courseId = course.course.id;
  const groups = catalogue(course);
  const attachments = (draft.externalText ??= new Map());
  const candidates = new Map();
  for (const [group, entries] of groups) {
    for (const entry of entries) {
      if (selectable(entry, group)) candidates.set(entry.key, entry);
      const attachment = attachments.get(entry.key);
      if (attachment && attachmentLabel(entry, group))
        candidates.set(entry.key, { ...entry, attachment });
    }
  }
  draft.selected ??= [...candidates.keys()];
  const selected = new Set(draft.selected.filter((key) => candidates.has(key)));
  const panel = element('section', undefined, 'course-study-library');
  const message = element('p', '', 'muted');
  message.setAttribute('role', 'status');
  const study = element('div');
  panel.append(
    element('h3', 'Study the course'),
    element(
      'p',
      'Study across your course. Include all available readings and past work, or choose a focus.',
    ),
    element(
      'p',
      'Attach reading text or a transcript directly to a link or video to use it in practice. Roger keeps the Canvas reference and uses only the text you supply.',
      'muted',
    ),
    message,
  );
  const controls = [];
  function updateSelection() {
    draft.selected = [...selected];
    message.textContent = `${selected.size} of ${candidates.size} available course sources selected · syllabus and your notes are included separately`;
    for (const control of controls) control.checked = selected.has(control.dataset.key);
  }
  function clearPractice() {
    invalidate();
    study.replaceChildren();
    draft.decks?.clear();
    draft.lastEngine = null;
    if (draft.examPlan) {
      draft.examPlan = null;
      planResult.replaceChildren();
      planStatus.textContent = 'Source availability changed. Run the syllabus plan again.';
    }
    updateSelection();
  }
  function attachEditor(entry, kind, checkbox) {
    const editor = element('details', undefined, 'course-study-attachment');
    const title = element('summary');
    const label = element(
      'label',
      `${kind === 'transcript' ? 'Transcript' : 'Reading text'} for ${entry.title}`,
    );
    const input = element('textarea');
    input.rows = 4;
    input.maxLength = ATTACHMENT_CHARACTERS;
    input.value = attachments.get(entry.key)?.text || '';
    input.placeholder =
      kind === 'transcript'
        ? 'Paste text with timestamps, if available'
        : 'Paste the reading text here';
    label.append(input);
    const fileLabel = element('label', 'Load local text file');
    const file = element('input');
    file.type = 'file';
    file.accept = kind === 'transcript' ? '.txt,.md,.vtt,.srt' : '.txt,.md';
    fileLabel.append(file);
    const save = element('button', 'Use attached text', 'button button-secondary');
    const remove = element('button', 'Remove attached text', 'button button-quiet');
    save.type = remove.type = 'button';
    const feedback = element('p', '', 'muted');
    feedback.setAttribute('role', 'status');
    function showAttachment() {
      const attached = attachments.has(entry.key);
      title.textContent = attached ? `Edit attached ${kind}` : `Attach ${kind}`;
      checkbox.hidden = !attached;
      remove.hidden = !attached;
      feedback.textContent = attached
        ? 'Attached for this study session.'
        : 'Unavailable for practice until text is attached.';
    }
    function clean(value) {
      const text = value.replace(/\r\n?/g, '\n').trim();
      if (!text || text.includes('\0')) throw new Error('Choose readable plain text.');
      if (text.length > ATTACHMENT_CHARACTERS)
        throw new Error('Use up to 24,000 characters from this source.');
      return text;
    }
    file.addEventListener('change', async () => {
      const selectedFile = file.files[0];
      if (!selectedFile) return;
      const name = selectedFile.name.toLowerCase();
      if (
        selectedFile.size > ATTACHMENT_CHARACTERS * 4 ||
        !(kind === 'transcript' ? /\.(?:txt|md|srt|vtt)$/ : /\.(?:txt|md)$/).test(name)
      ) {
        feedback.textContent = 'Choose a supported text file no larger than 96 KB.';
        file.value = '';
        return;
      }
      file.disabled = input.disabled = save.disabled = remove.disabled = true;
      try {
        input.value = clean(
          new TextDecoder('utf-8', { fatal: true }).decode(await selectedFile.arrayBuffer()),
        );
        feedback.textContent = 'Text loaded. Choose Use attached text to include it.';
      } catch (error) {
        feedback.textContent =
          error instanceof TypeError ? 'Choose a UTF-8 text file.' : error.message;
      } finally {
        file.value = '';
        file.disabled = input.disabled = save.disabled = remove.disabled = false;
      }
    });
    save.addEventListener('click', () => {
      try {
        const text = clean(input.value);
        const old = attachments.get(entry.key);
        const total = [...attachments.values()].reduce((sum, item) => sum + item.text.length, 0);
        if (
          (!old && attachments.size >= ATTACHMENT_LIMIT) ||
          total - (old?.text.length || 0) + text.length > COURSE_ATTACHMENT_CHARACTERS
        )
          throw new Error('Remove an attachment before adding more text to this study session.');
        if (kind === 'transcript' && !transcriptPages(text).length)
          throw new Error('The transcript needs readable text as well as any timestamps.');
        const attachment = { kind, text };
        attachments.set(entry.key, attachment);
        candidates.set(entry.key, { ...entry, attachment });
        selected.add(entry.key);
        showAttachment();
        clearPractice();
      } catch (error) {
        feedback.textContent = error.message;
      }
    });
    remove.addEventListener('click', () => {
      attachments.delete(entry.key);
      candidates.delete(entry.key);
      selected.delete(entry.key);
      input.value = '';
      showAttachment();
      clearPractice();
    });
    editor.append(title, label, fileLabel, save, remove, feedback);
    showAttachment();
    return editor;
  }
  const selectionActions = element('div', undefined, 'study-actions');
  for (const [label, include] of [
    ['Select all', true],
    ['Clear selection', false],
  ]) {
    const action = element('button', label, 'button button-secondary');
    action.type = 'button';
    action.addEventListener('click', () => {
      selected.clear();
      if (include) for (const key of candidates.keys()) selected.add(key);
      invalidate();
      study.replaceChildren();
      updateSelection();
    });
    selectionActions.append(action);
  }
  const planning = element('section', undefined, 'exam-source-plan');
  const planStatus = element('p', '', 'muted');
  planStatus.setAttribute('role', 'status');
  const planResult = element('div');
  const planButton = element('button', 'Plan from the syllabus', 'button button-primary');
  planButton.type = 'button';
  const examLabel = element('label', 'Exam');
  const examChoice = element('select');
  examChoice.setAttribute('aria-label', 'Exam from syllabus');
  examLabel.append(examChoice);
  examLabel.hidden = true;
  let planningSource = null;
  let planningBusy = false;
  planning.append(
    element('h3', 'Start with what the exam covers'),
    element(
      'p',
      'Roger checks the syllabus, explains which course materials match, and names missing readings. You can still include any source.',
    ),
    planButton,
    examLabel,
    planStatus,
    planResult,
  );
  const renderCitation = (citation) => {
    const quote = element('blockquote', citation.quote, 'study-excerpt');
    const location = element(
      'p',
      `${citation.title}${citation.page ? ` · page ${citation.page}` : ''}`,
      'muted',
    );
    const original = external('View syllabus in Canvas', citation.url);
    location.append(document.createTextNode(' · '), original);
    if (planningSource && citation.page) {
      const read = element('button', `Read page ${citation.page}`, 'button button-quiet');
      read.type = 'button';
      read.addEventListener('click', async () => {
        const request = operation();
        try {
          await openSyllabusReading(planningSource.source, planningSource.result, importFile, {
            page: citation.page,
            signal: request.signal,
          });
        } catch (error) {
          if (request.valid()) planStatus.textContent = error.message;
        }
      });
      location.append(read);
    }
    quote.append(location);
    return quote;
  };
  function showPlan(result) {
    planResult.replaceChildren();
    examChoice.replaceChildren();
    const placeholder = element('option', 'Choose an exam');
    placeholder.value = '';
    examChoice.append(placeholder);
    for (const choice of result.choices) {
      const option = element('option', choice.label);
      option.value = choice.label;
      examChoice.append(option);
    }
    examChoice.value = result.exam;
    examLabel.hidden = !result.choices.length;
    for (const citation of result.scopeCitations) planResult.append(renderCitation(citation));
    if (result.exam) {
      const apply = element(
        'button',
        `Use these ${result.selectedKeys.length} readable sources`,
        'button button-primary',
      );
      apply.type = 'button';
      apply.disabled = !result.selectedKeys.length;
      apply.addEventListener('click', () => {
        selected.clear();
        for (const key of result.selectedKeys) if (candidates.has(key)) selected.add(key);
        draft.focus = result.exam;
        draft.decks?.clear();
        invalidate();
        study.replaceChildren();
        updateSelection();
        planStatus.textContent = `Source plan applied for ${result.exam}. Open exam practice below, or adjust the selection.`;
      });
      planResult.append(apply);
      const details = element('details');
      details.append(element('summary', `Why these materials · ${result.reasons.length}`));
      for (const item of result.reasons) {
        const row = element('div', undefined, 'exam-plan-source');
        row.append(element('strong', item.title), element('p', item.reason));
        for (const cite of item.citations) row.append(renderCitation(cite));
        details.append(row);
      }
      planResult.append(details);
    }
    if (result.courseTopics?.length) {
      const topics = element('details');
      topics.append(element('summary', 'Course topics in the syllabus · exam scope may differ'));
      for (const topic of result.courseTopics) {
        const row = element('div', undefined, 'exam-plan-source');
        row.append(
          element('strong', topic.name),
          element(
            'p',
            topic.matchedKeys.length
              ? `${topic.matchedKeys.length} course material titles match this topic.`
              : 'No matching material title found. Add the reading or your notes if this is part of your exam.',
          ),
        );
        row.append(renderCitation(topic.citation));
        topics.append(row);
      }
      planResult.append(topics);
    }
    if (result.gaps.length) {
      const missing = element('section');
      missing.append(element('h4', 'Bring these missing materials'));
      const list = element('ul');
      for (const gap of result.gaps) list.append(element('li', gap.request));
      missing.append(
        list,
        element(
          'p',
          'Attach reading text or a transcript to its link or video in the list below. Add other files or notes in Exam practice.',
        ),
      );
      planResult.append(missing);
    }
    for (const item of result.unknowns) planResult.append(element('p', item, 'muted'));
  }
  async function planExam(exam = '') {
    if (planningBusy) return;
    planningBusy = true;
    planButton.disabled = examChoice.disabled = true;
    const request = operation();
    planStatus.textContent = 'Finding and reading the syllabus, including OCR when needed…';
    try {
      if (!planningSource) {
        const discovered = await loader.discover(courseId, request.signal);
        const source = discovered.candidates[0];
        if (!source)
          throw new Error(
            'No syllabus was found. Add the syllabus or exam guide as notes in Exam practice, or check the Syllabus tab.',
          );
        planningSource = { source, result: await loader.read(source, courseId, request.signal) };
      }
      const { source, result: reading } = planningSource;
      const materials = [...groups.values()].flat().map((entry) => ({
        key: entry.key,
        title: entry.title,
        module: entry.module || '',
        url: entry.url || '',
        available: candidates.has(entry.key),
      }));
      const result = await api('/api/study/exam-plan', {
        signal: request.signal,
        body: {
          exam,
          syllabus: {
            title: source.title,
            url: source.url,
            pages: reading.pages || [{ page: null, text: reading.text || '' }],
          },
          materials,
        },
      });
      if (!request.valid() || !panel.isConnected) return;
      draft.examPlan = result;
      showPlan(result);
      planStatus.textContent = `${source.title} checked. ${result.exam ? 'Review the scope and sources before applying the plan.' : 'Choose an exam to match its materials.'}`;
      if (reading.note) planStatus.textContent += ` ${reading.note}`;
    } catch (error) {
      if (request.valid() && panel.isConnected) planStatus.textContent = error.message;
    } finally {
      planningBusy = false;
      planButton.disabled = examChoice.disabled = false;
    }
  }
  planButton.addEventListener('click', () => void planExam(examChoice.value));
  examChoice.addEventListener('change', () => {
    if (examChoice.value) void planExam(examChoice.value);
  });
  panel.append(planning, selectionActions);
  if (draft.examPlan) showPlan(draft.examPlan);
  for (const [group, entries] of groups) {
    if (!entries.length) continue;
    const section = element('details', undefined, 'course-study-group');
    section.open = group === 'Past assignments';
    section.append(element('summary', `${group} · ${entries.length}`));
    const list = element('ul');
    for (const entry of entries) {
      const row = element('li', undefined, 'course-study-item');
      const label = element('label');
      const attach = attachmentLabel(entry, group);
      let checkbox;
      if (candidates.has(entry.key) || attach) {
        checkbox = element('input');
        checkbox.type = 'checkbox';
        checkbox.dataset.key = entry.key;
        checkbox.checked = selected.has(entry.key);
        checkbox.addEventListener('change', () => {
          if (checkbox.checked) selected.add(entry.key);
          else selected.delete(entry.key);
          if (study.childElementCount) {
            invalidate();
            study.replaceChildren();
          }
          updateSelection();
        });
        controls.push(checkbox);
        label.append(checkbox);
      }
      label.append(element('span', entry.title));
      row.append(label, external('Open in Canvas', entry.url));
      if (entry.module) row.append(element('small', entry.module, 'muted'));
      if (attach) row.append(attachEditor(entry, attach, checkbox));
      else if (!candidates.has(entry.key))
        row.append(
          element(
            'small',
            entry.locked ? 'Locked in Canvas' : 'Open in Canvas · add relevant notes to study it',
            'muted',
          ),
        );
      list.append(row);
    }
    section.append(list);
    panel.append(section);
  }
  const start = element('button', 'Open exam practice', 'button button-primary');
  start.type = 'button';
  start.addEventListener('click', () => {
    const sources = [...selected].map((key) => candidates.get(key));
    study.replaceChildren();
    mountAssignmentStudy({
      container: study,
      assignment: course.course,
      courseId,
      instructions: '',
      courseStudy: true,
      loadMaterials: (signal, onProgress) =>
        readMaterials(sources, { courseId, api, loader, plainText, signal, onProgress }),
      draft,
      loader,
      api,
      operation,
      importFile,
    });
  });
  panel.append(start);
  content.append(panel, study);
  updateSelection();
}

export function extractCourseFileLinks(html, courseId, onExternal = () => {}) {
  if (!/^[1-9]\d{0,15}$/.test(String(courseId)) || typeof html !== 'string') return [];
  // A detached template never executes scripts or loads embedded images. Only
  // verified course-scoped Canvas file addresses leave this parser.
  const template = document.createElement('template');
  template.innerHTML = html.slice(0, 120_000);
  const found = new Map();
  for (const anchor of template.content.querySelectorAll('a[href]')) {
    for (const raw of [anchor.getAttribute('href'), anchor.getAttribute('data-api-endpoint')]) {
      if (!raw) continue;
      let url;
      try {
        url = new URL(raw, 'https://babson.instructure.com');
      } catch {
        continue;
      }
      if (url.username || url.password) continue;
      if (url.origin !== 'https://babson.instructure.com') {
        if (['https:', 'http:'].includes(url.protocol))
          onExternal({
            title: (
              anchor.textContent?.trim() ||
              anchor.querySelector('img')?.alt ||
              url.hostname
            ).trim(),
            url: url.href,
          });
        continue;
      }
      const match =
        /^\/(?:api\/v1\/)?courses\/([1-9]\d{0,15})\/files\/([1-9]\d{0,15})(?:\/(?:download|preview))?\/?$/.exec(
          url.pathname,
        );
      if (!match || match[1] !== String(courseId)) continue;
      if (!found.has(match[2]))
        found.set(match[2], {
          kind: 'file',
          fileId: match[2],
          title: (
            anchor.getAttribute('title') ||
            anchor.textContent?.trim() ||
            anchor.querySelector('img')?.alt ||
            'Linked course document'
          )
            .trim()
            .slice(0, 200),
          url: `https://babson.instructure.com/courses/${courseId}/files/${match[2]}`,
        });
    }
  }
  return [...found.values()];
}

export async function readMaterials(
  sources,
  { courseId, api, loader, plainText, signal, onProgress = () => {} },
) {
  const entries = [];
  const skipped = [];
  let processed = 0;
  let characters = 0;
  const linkedFiles = new Map();
  const listedFiles = new Set(
    sources.filter((item) => item.fileId).map((item) => String(item.fileId)),
  );
  function discoverFiles(html, parent) {
    const externalLinks = new Map();
    const files = extractCourseFileLinks(html, courseId, (link) =>
      externalLinks.set(link.url, link),
    );
    for (const link of externalLinks.values())
      skipped.push(
        `${parent.title}: external resource “${link.title}” was not downloaded. Add its reading, notes, or transcript to include it.`,
      );
    for (const source of files) {
      if (listedFiles.has(source.fileId) || linkedFiles.has(source.fileId)) continue;
      if (linkedFiles.size >= 300) {
        skipped.push(
          `${parent.title}: additional document links exceed this reading session's discovery budget; open this page separately.`,
        );
        break;
      }
      linkedFiles.set(source.fileId, { ...source, foundIn: parent.title, parentUrl: parent.url });
    }
  }
  const append = (entry) => {
    const size =
      entry.text?.length || entry.pages?.reduce((total, page) => total + page.text.length, 0) || 0;
    if (!size) skipped.push(`${entry.title}: no readable text`);
    else if (characters + size > CORPUS_CHARACTERS)
      skipped.push(
        `${entry.title}: this session's text memory budget is full; select it in a focused set`,
      );
    else {
      characters += size;
      entries.push(entry);
    }
  };
  const progress = (count) => {
    processed += count;
    onProgress({ processed, total: sources.length, ready: entries.length });
  };
  const assignments = sources.filter((item) => item.assignmentId);
  // Five is a network batch size, never a selection or retrieval limit.
  for (let offset = 0; offset < assignments.length; offset += 5) {
    signal.throwIfAborted();
    const batch = assignments.slice(offset, offset + 5);
    const params = new URLSearchParams({ courseId });
    for (const item of batch) params.append('assignmentId', item.assignmentId);
    try {
      const result = await loader.readText(
        `assignments:${batch.map((item) => item.assignmentId).join(',')}`,
        courseId,
        signal,
        () => api(`/api/canvas/study-assignments?${params}`, { signal }),
      );
      for (const assignment of result.assignments) {
        discoverFiles(assignment.descriptionHtml, { title: assignment.name, url: assignment.url });
        append({
          kind: 'assignment',
          title: assignment.name,
          url: assignment.url,
          text: plainText(assignment.descriptionHtml).trim(),
        });
      }
      for (const id of result.unavailable)
        skipped.push(
          `${batch.find((item) => item.assignmentId === id)?.title || id}: unavailable in Canvas`,
        );
    } catch (error) {
      if (signal.aborted) throw error;
      skipped.push(...batch.map((item) => `${item.title}: ${error.message}`));
    }
    progress(batch.length);
  }
  // One document at a time keeps PDF/OCR memory and Canvas traffic bounded.
  for (const item of sources.filter((entry) => !entry.assignmentId)) {
    signal.throwIfAborted();
    try {
      if (item.attachment) {
        const { kind, text } = item.attachment;
        append({
          kind: 'material',
          title: item.title,
          url: item.url,
          foundIn: `Your attached ${kind}`,
          provenance: `Your attached ${kind}`,
          ...(kind === 'transcript' ? { pages: transcriptPages(text) } : { text }),
        });
      } else if (item.fileId) {
        const source = { kind: 'file', fileId: item.fileId, title: item.title, url: item.url };
        const reading = await loader.readMaterial(source, courseId, signal);
        append({
          kind: 'material',
          title: item.title,
          url: item.url,
          ...reading,
          reader: { source, lazy: true },
          file: undefined,
        });
        if (reading.note) skipped.push(`${item.title}: ${reading.note}`);
      } else if (item.pageUrl) {
        const params = new URLSearchParams({ courseId, pageUrl: item.pageUrl });
        const { page } = await loader.readText(`page:${item.pageUrl}`, courseId, signal, () =>
          api(`/api/canvas/page?${params}`, { signal }),
        );
        discoverFiles(page.bodyHtml, item);
        append({
          kind: 'material',
          title: item.title,
          url: item.url,
          text: plainText(page.bodyHtml).trim(),
        });
      }
    } catch (error) {
      if (signal.aborted) throw error;
      skipped.push(`${item.title}: ${error.message}`);
    }
    progress(1);
  }
  for (const source of linkedFiles.values()) {
    signal.throwIfAborted();
    if (characters >= CORPUS_CHARACTERS) {
      skipped.push(
        `${source.title}: the session text budget is full; open it separately from ${source.foundIn}.`,
      );
      continue;
    }
    onProgress({ processed, total: sources.length + linkedFiles.size, ready: entries.length });
    try {
      const reading = await loader.readMaterial(source, courseId, signal);
      append({
        kind: 'material',
        title: reading.file?.name || source.title,
        url: source.url,
        ...reading,
        foundIn: `Linked from ${source.foundIn}`,
        parentUrl: source.parentUrl,
        reader: { source, lazy: true },
        file: undefined,
      });
      if (reading.note) skipped.push(`${source.title}: ${reading.note}`);
    } catch (error) {
      if (signal.aborted) throw error;
      skipped.push(`${source.title} (linked from ${source.foundIn}): ${error.message}`);
    }
    processed++;
    onProgress({ processed, total: sources.length + linkedFiles.size, ready: entries.length });
  }
  return { entries, skipped: skipped.filter(Boolean) };
}
