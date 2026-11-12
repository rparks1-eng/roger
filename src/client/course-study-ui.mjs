import { mountAssignmentStudy } from '/client/study-ui.mjs';
import { openSyllabusReading } from '/client/syllabus-ui.mjs';

const CORPUS_CHARACTERS = 8_000_000;
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
  const candidates = new Map();
  for (const [group, entries] of groups)
    for (const entry of entries) if (selectable(entry, group)) candidates.set(entry.key, entry);
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
      'Includes the assignments and module materials listed below. External links and videos need notes or a transcript. Oversized or unreadable documents are reported.',
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
          'Add the files or paste your notes in Exam practice below. External videos need a transcript; an inaccessible file is not treated as read.',
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
      if (candidates.has(entry.key)) {
        const checkbox = element('input');
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
      if (!candidates.has(entry.key))
        row.append(
          element(
            'small',
            entry.locked
              ? 'Locked in Canvas'
              : 'Open in Canvas · add relevant notes or a transcript to study it',
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
      if (item.fileId) {
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
