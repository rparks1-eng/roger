import { mountSubmissionForm } from '/client/submission-ui.mjs';
import { createSyllabusLoader, mountSyllabus } from '/client/syllabus-ui.mjs';
import { mountAssignmentStudy } from '/client/study-ui.mjs';
import { skeleton } from '/client/loading-ui.mjs';
import { mountCourseStudy } from '/client/course-study-ui.mjs';
import {
  assignmentPresentation,
  createCanvasReadCache,
  agendaGroup,
  calendarDays,
  deadlinePresentation,
  nextUnfinishedAssignment,
} from '/client/canvas-display.mjs';
/** Canvas connection and course presentation only; no reader or AI state ownership. */
export function createCanvasPanel({
  state,
  api,
  importFile,
  status,
  onAssignmentsChange = () => {},
  onConnectionChange = () => {},
  onConnect = () => {},
}) {
  const $ = (id) => document.getElementById(id);
  const node = (tag, text, className) => {
    const element = document.createElement(tag);
    if (text !== undefined) element.textContent = text;
    if (className) element.className = className;
    return element;
  };
  const courseTitle = (value) => {
    const name = (value || 'Course').replace(/^\d{4}[A-Za-z]-\d+\s*:\s*/, '').trim();
    if (name !== name.toUpperCase()) return name;
    const acronyms = new Set([
      'AI',
      'API',
      'LLM',
      'IT',
      'II',
      'III',
      'IV',
      'UML',
      'PDF',
      'STEM',
      'US',
      'USA',
    ]);
    return name
      .split(/(\s+)/)
      .map((word, index) =>
        acronyms.has(word)
          ? word
          : index > 0 && ['AND', 'OF', 'THE', 'IN', 'TO', 'FOR', 'WITH'].includes(word)
            ? word.toLowerCase()
            : word.charAt(0).toUpperCase() + word.slice(1).toLowerCase(),
      )
      .join('');
  };
  let generation = 0;
  let pending = null;
  let profile = null;
  let bound = false;
  let activeCourse = null;
  let activeAssignment = null;
  let activeAssignmentSource = null;
  let activeCommunitySource = null;
  let activeTab = 'assignments';
  const communitySections = new Map([
    ['announcements', 'Announcements'],
    ['discussions', 'Discussions'],
    ['groups', 'Groups'],
  ]);
  let semester = null;
  let assignments = null;
  let assignmentIssue = '';
  let fullAgenda = false;
  let calendarMode = false;
  let calendarMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
  let loadingAgenda = false;
  let semesterLoadedAt = 0;
  let assignmentsLoadedAt = 0;
  let coursesLoading = null;
  let deadlineTimer = null;
  let deadlineNodes = null;
  let deadlineItem = null;
  let agendaDeadlineNodes = [];
  let agendaGroupNodes = [];
  const readCache = createCanvasReadCache();
  const cachedRead = (url, signal, { ttl = 60_000, force = false } = {}) =>
    readCache.read(url, () => api(url, { signal }), { ttl, force, signal });
  const discoveredSources = new Map();
  const baseSyllabusLoader = createSyllabusLoader(api);
  const syllabusLoader = {
    ...baseSyllabusLoader,
    async read(source, courseId, signal) {
      const result = await baseSyllabusLoader.read(source, courseId, signal);
      if (!signal.aborted) {
        const entries = result.pages || [{ text: result.text || '', page: null }];
        const readable = [];
        let remaining = 100_000;
        for (const entry of entries) {
          const text = String(entry.text || '').slice(0, Math.min(8000, remaining));
          if (!text.trim()) continue;
          readable.push({
            title: `${source.title || source.name || 'Course syllabus'}${entry.page ? ` · page ${entry.page}` : ''}`,
            url: source.url,
            text,
          });
          remaining -= text.length;
          if (!remaining) break;
        }
        discoveredSources.delete(String(courseId));
        discoveredSources.set(String(courseId), readable);
        if (discoveredSources.size > 8)
          discoveredSources.delete(discoveredSources.keys().next().value);
      }
      return result;
    },
  };
  const studyDrafts = new Map();
  function clearStudy() {
    syllabusLoader.clear();
    discoveredSources.clear();
    studyDrafts.clear();
  }
  function draftFor(courseId, assignmentId) {
    const key = `${courseId}:${assignmentId}`;
    const draft = studyDrafts.get(key) || {
      notes: '',
      files: [],
      mode: 'flashcards',
      decks: new Map(),
    };
    studyDrafts.delete(key);
    studyDrafts.set(key, draft);
    if (studyDrafts.size > 6) studyDrafts.delete(studyDrafts.keys().next().value);
    return draft;
  }
  const assignmentLabels = {
    submitted: 'Submitted',
    missing: 'Missing',
    locked: 'Locked',
    excused: 'Excused',
    redo: 'Resubmission requested',
    unsubmitted: 'Not submitted',
    unknown: 'Status unavailable',
  };
  const invalidate = () => {
    generation++;
    pending?.abort();
    pending = null;
  };
  function operation() {
    invalidate();
    const controller = new AbortController();
    pending = controller;
    const current = generation;
    return {
      signal: controller.signal,
      valid: () => current === generation && !controller.signal.aborted,
      cancel: () => controller.abort(),
    };
  }
  function labels() {
    $('canvas-connect')
      .closest('.connection-panel')
      ?.classList.toggle('canvas-connected', state.connected);
    $('canvas-connect').hidden = state.connected;
    $('canvas-disconnect').hidden = !state.connected;
    $('canvas-status').textContent = state.connected
      ? `Connected read-only · ${profile?.name || 'Canvas account'}`
      : 'Not connected';
    $('connection-status').textContent = state.connected ? 'Canvas · read only' : 'Local workspace';
    onConnectionChange(state.connected);
  }
  function clearCourses() {
    clearTimeout(deadlineTimer);
    deadlineTimer = null;
    deadlineNodes = null;
    deadlineItem = null;
    agendaDeadlineNodes = [];
    agendaGroupNodes = [];
    activeCourse = null;
    activeAssignment = null;
    activeAssignmentSource = null;
    semester = assignments = null;
    assignmentIssue = '';
    loadingAgenda = false;
    assignmentsLoadedAt = 0;
    semesterLoadedAt = 0;
    $('semester-home').hidden = true;
    $('semester-rows').replaceChildren();
    $('course-list').hidden = false;
    $('course-list').replaceChildren();
    $('course-detail').replaceChildren();
    onAssignmentsChange();
  }
  function restore(value) {
    invalidate();
    clearStudy();
    readCache.clear();
    clearCourses();
    profile = value || null;
    state.connected = Boolean(value);
    labels();
    if (!state.connected) clearCourses();
  }
  function external(label, href) {
    try {
      const url = new URL(href);
      if (url.origin !== 'https://babson.instructure.com' || url.username || url.password)
        throw Error('Unsupported link');
      const link = node('a', label, 'inline-link');
      link.href = url.href;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      return link;
    } catch {
      return node('span', label);
    }
  }
  const noteCoverage = (target, coverage) => {
    if (coverage?.partial) target.append(node('p', (coverage.reasons || []).join(' '), 'muted'));
  };
  function selectedCourses() {
    const term = $('semester-term').value;
    return semester.courses.filter((course) => term === 'all' || course.termId === term);
  }
  function option(value, label) {
    const result = node('option', label);
    result.value = value;
    return result;
  }
  function courseCode(course) {
    return (course.code || course.name).match(/[A-Za-z]+\s?\d{3,}/)?.[0] || 'Course';
  }
  function renderAgenda() {
    const rows = $('semester-rows');
    const message = $('semester-assignment-status');
    rows.replaceChildren();
    agendaDeadlineNodes = [];
    agendaGroupNodes = [];
    rows.hidden = true;
    message.textContent =
      assignmentIssue ||
      (loadingAgenda && assignments
        ? 'Refreshing assignments from Canvas…'
        : assignmentsLoadedAt
          ? `Updated ${new Date(assignmentsLoadedAt).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })} · Refresh to check Canvas again.`
          : '');
    rows.setAttribute('aria-busy', String(loadingAgenda));
    if (!assignments) {
      if (!assignmentIssue) {
        message.textContent = 'Loading assignments…';
        rows.append(skeleton('agenda'));
        rows.hidden = false;
      }
      return;
    }
    const courseId = $('semester-course').value;
    const filter = fullAgenda ? $('semester-status').value : 'upcoming';
    const now = Date.now();
    const due = (item) => {
      const time = Date.parse(item.dueAt);
      return Number.isFinite(time) ? time : Infinity;
    };
    const upcoming = (item) =>
      Number.isFinite(due(item)) &&
      due(item) >= now &&
      !['submitted', 'excused', 'locked'].includes(item.status);
    const matching = assignments.filter(
      (item) =>
        (!fullAgenda || courseId === 'all' || item.course.id === courseId) &&
        (filter === 'all' || (filter === 'upcoming' ? upcoming(item) : item.status === filter)),
    );
    matching.sort((a, b) => due(a) - due(b) || a.name.localeCompare(b.name));
    if (calendarMode && fullAgenda) {
      rows.hidden = false;
      renderCalendar(rows, matching);
      return;
    }
    if (!matching.length) {
      if (!assignmentIssue)
        message.textContent = fullAgenda ? 'No matching assignments.' : 'Nothing upcoming.';
      return;
    }
    rows.hidden = false;
    let lastGroup;
    for (const item of fullAgenda ? matching : matching.slice(0, 5)) {
      if (!fullAgenda) {
        const group = agendaGroup(item.dueAt, now);
        if (group !== lastGroup) {
          const heading = node('h3', group, 'agenda-date-group');
          rows.append(heading);
          agendaGroupNodes.push({ heading, dueAt: item.dueAt });
        }
        lastGroup = group;
      }
      const row = action(
        '',
        () => void openAssignment(item.course.id, item.id),
        'canvas-assignment-row',
      );
      const copy = node('span', undefined, 'canvas-assignment-copy');
      copy.append(node('strong', item.name), node('span', courseTitle(item.course.name), 'muted'));
      const deadline = deadlinePresentation(item.dueAt, now);
      const date = node(item.dueAt ? 'time' : 'span', deadline.named, 'canvas-assignment-due');
      date.title = deadline.exact;
      if (item.dueAt) date.dateTime = item.dueAt;
      const appearance = assignmentPresentation(item, now);
      row.dataset.status = appearance.status;
      row.dataset.tone = appearance.tone;
      date.dataset.urgency = appearance.soon || appearance.overdue ? appearance.tone : 'neutral';
      const badge = statusBadge(item, now);
      row.append(copy, date, badge);
      agendaDeadlineNodes.push({ item, row, date, badge });
      rows.append(row);
    }
  }
  function renderCalendar(target, items) {
    const monthLabel = calendarMonth.toLocaleDateString(undefined, {
      month: 'long',
      year: 'numeric',
    });
    const toolbar = node('div', undefined, 'assignment-calendar-toolbar');
    const previous = action(
      '‹',
      () => {
        calendarMonth = new Date(calendarMonth.getFullYear(), calendarMonth.getMonth() - 1, 1);
        renderAgenda();
      },
      'button button-quiet',
    );
    previous.setAttribute('aria-label', 'Previous month');
    const next = action(
      '›',
      () => {
        calendarMonth = new Date(calendarMonth.getFullYear(), calendarMonth.getMonth() + 1, 1);
        renderAgenda();
      },
      'button button-quiet',
    );
    next.setAttribute('aria-label', 'Next month');
    toolbar.append(
      previous,
      node('h3', monthLabel),
      next,
      action(
        'Today',
        () => {
          const now = new Date();
          calendarMonth = new Date(now.getFullYear(), now.getMonth(), 1);
          renderAgenda();
        },
        'button button-quiet',
      ),
    );
    const scroller = node('div', undefined, 'assignment-calendar-scroll');
    const grid = node('div', undefined, 'assignment-calendar');
    grid.setAttribute('role', 'group');
    grid.setAttribute('aria-label', `${monthLabel} assignment calendar`);
    for (const name of ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'])
      grid.append(node('div', name, 'calendar-weekday'));
    const key = (date) => `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
    const byDay = new Map();
    for (const item of items) {
      if (!Number.isFinite(Date.parse(item.dueAt))) continue;
      const dayKey = key(new Date(item.dueAt));
      if (!byDay.has(dayKey)) byDay.set(dayKey, []);
      byDay.get(dayKey).push(item);
    }
    const today = key(new Date());
    for (const date of calendarDays(calendarMonth)) {
      const cell = node('section', undefined, 'calendar-day');
      const dayKey = key(date);
      cell.dataset.outside = String(date.getMonth() !== calendarMonth.getMonth());
      cell.dataset.today = String(dayKey === today);
      cell.setAttribute(
        'aria-label',
        date.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' }),
      );
      cell.append(node('h4', String(date.getDate()), 'calendar-date'));
      for (const item of byDay.get(dayKey) || []) {
        const appearance = assignmentPresentation(item);
        const event = action(
          '',
          () => void openAssignment(item.course.id, item.id),
          'calendar-assignment',
        );
        event.dataset.tone = appearance.tone;
        event.setAttribute(
          'aria-label',
          `${item.name}, ${courseTitle(item.course.name)}, ${dateText(item.dueAt)}, ${appearance.label}`,
        );
        event.append(
          node('span', courseCode(item.course), 'calendar-course'),
          node('strong', item.name),
          node(
            'span',
            new Date(item.dueAt).toLocaleTimeString(undefined, {
              hour: 'numeric',
              minute: '2-digit',
            }),
          ),
        );
        cell.append(event);
      }
      grid.append(cell);
    }
    scroller.append(grid);
    target.append(toolbar, scroller);
    const undated = items.filter((item) => !Number.isFinite(Date.parse(item.dueAt))).length;
    if (undated)
      target.append(
        node(
          'p',
          `${undated} assignment${undated === 1 ? '' : 's'} without a due date appear in List view.`,
          'calendar-undated',
        ),
      );
  }
  function setText(target, value) {
    if (target.textContent !== value) target.textContent = value;
  }
  function refreshDeadlines() {
    const now = Date.now();
    if (deadlineNodes) {
      deadlineItem = nextUnfinishedAssignment(assignments || [], now);
      const { hero, badge } = deadlineNodes;
      hero.hidden = !deadlineItem;
      if (deadlineItem) {
        const deadline = deadlinePresentation(deadlineItem.dueAt, now);
        const appearance = assignmentPresentation(deadlineItem, now);
        setText(deadlineNodes.heading, deadline.overdue ? 'Needs attention' : 'Next deadline');
        setText(deadlineNodes.title, deadlineItem.name);
        setText(deadlineNodes.course, courseTitle(deadlineItem.course.name));
        setText(deadlineNodes.relative, deadline.relative);
        setText(deadlineNodes.when, deadline.named);
        setText(deadlineNodes.exact, deadline.exact);
        deadlineNodes.exact.dateTime = deadlineItem.dueAt;
        setText(badge, appearance.label);
        badge.dataset.tone = appearance.tone;
        hero.dataset.tone = appearance.tone;
        hero.setAttribute(
          'aria-label',
          `${deadlineItem.name}. ${deadline.relative}. ${deadline.named}. ${appearance.label}. Open assignment.`,
        );
      }
    }
    for (const { heading, dueAt } of agendaGroupNodes) setText(heading, agendaGroup(dueAt, now));
    for (const { item, row, date, badge } of agendaDeadlineNodes) {
      const deadline = deadlinePresentation(item.dueAt, now);
      const appearance = assignmentPresentation(item, now);
      setText(date, deadline.named);
      date.title = deadline.exact;
      row.dataset.status = appearance.status;
      row.dataset.tone = appearance.tone;
      date.dataset.urgency = appearance.soon || appearance.overdue ? appearance.tone : 'neutral';
      setText(badge, appearance.label);
      badge.dataset.tone = appearance.tone;
    }
  }
  function scheduleDeadlineUpdate() {
    clearTimeout(deadlineTimer);
    if (!state.connected || !semester) return;
    const visible = !document.hidden && !$('courses-view').hidden && !$('semester-home').hidden;
    const near = deadlineItem && Math.abs(Date.parse(deadlineItem.dueAt) - Date.now()) < 120_000;
    deadlineTimer = setTimeout(
      () => {
        if (!document.hidden && !$('courses-view').hidden && !$('semester-home').hidden)
          refreshDeadlines();
        scheduleDeadlineUpdate();
      },
      visible && near ? 1000 : 15_000,
    );
  }
  function renderSemester() {
    const courses = selectedCourses();
    $('semester-home').hidden = false;
    $('semester-overview').setAttribute('aria-pressed', String(!fullAgenda));
    $('semester-assignments').setAttribute('aria-pressed', String(fullAgenda));
    $('semester-agenda-heading').textContent = fullAgenda ? 'All Assignments' : 'Coming up';
    $('semester-filters').hidden = !fullAgenda;
    let mode = $('semester-display-mode');
    if (!mode) {
      mode = node('div', undefined, 'semester-display-mode');
      mode.id = 'semester-display-mode';
      mode.setAttribute('role', 'group');
      mode.setAttribute('aria-label', 'Assignment display');
      for (const [value, text] of [
        [false, 'List'],
        [true, 'Calendar'],
      ]) {
        const button = action(
          text,
          () => {
            calendarMode = value;
            renderSemester();
          },
          'button button-quiet',
        );
        button.dataset.calendar = String(value);
        mode.append(button);
      }
      $('semester-filters').append(mode);
    }
    for (const button of mode.children)
      button.setAttribute('aria-pressed', String(button.dataset.calendar === String(calendarMode)));
    let attention = $('semester-attention');
    if (!attention) {
      attention = node('div', undefined, 'semester-attention');
      attention.id = 'semester-attention';
      $('semester-agenda-heading').after(attention);
    }
    attention.replaceChildren();
    deadlineNodes = null;
    if (assignments && !fullAgenda) {
      const hero = action(
        '',
        () => {
          if (deadlineItem) void openAssignment(deadlineItem.course.id, deadlineItem.id);
        },
        'semester-deadline',
      );
      const fields = Object.fromEntries(
        ['heading', 'title', 'course', 'relative', 'when', 'exact'].map((name) => [
          name,
          node(
            name === 'title' ? 'strong' : name === 'exact' ? 'time' : 'span',
            '',
            `semester-deadline-${name}`,
          ),
        ]),
      );
      const badge = node('span', '', 'canvas-badge');
      hero.append(
        ...Object.values(fields),
        badge,
        node('span', 'Open assignment →', 'semester-deadline-open'),
      );
      deadlineNodes = { hero, badge, ...fields };
      attention.append(hero);
      const missing = assignments.filter(
        (item) => assignmentPresentation(item).status === 'missing',
      ).length;
      if (missing)
        attention.append(
          action(
            `${missing} marked missing · Review`,
            () => {
              fullAgenda = true;
              $('semester-status').value = 'missing';
              $('semester-course').value = 'all';
              renderSemester();
            },
            'semester-missing-link',
          ),
        );
      refreshDeadlines();
    }
    attention.hidden =
      !attention.childElementCount || (!deadlineItem && attention.childElementCount === 1);
    $('semester-term').disabled = loadingAgenda;
    $('semester-refresh').disabled = loadingAgenda;
    const list = $('course-list');
    list.hidden = fullAgenda;
    list.replaceChildren();
    if (!fullAgenda) {
      for (const course of courses) {
        const button = action(
          '',
          () => void loadCourse(course.id),
          'course-card canvas-course-card',
        );
        // Courses are usable immediately; assignment loading never blocks opening a class.
        button.append(
          node('span', courseCode(course), 'canvas-course-code'),
          node('h3', courseTitle(course.name)),
          node('span', 'Assignments & readings →', 'canvas-course-open'),
        );
        list.append(button);
      }
      if (!courses.length) list.append(node('p', 'Canvas returned no courses for this term.'));
    }
    renderAgenda();
    scheduleDeadlineUpdate();
    onAssignmentsChange();
  }
  async function loadSemesterAssignments({ preserve = false, force = false } = {}) {
    const request = operation();
    const courses = selectedCourses();
    if (!preserve) assignments = null;
    assignmentIssue = '';
    loadingAgenda = true;
    renderSemester();
    const collected = [];
    const issues = [];
    try {
      const byId = new Map(courses.map((course) => [course.id, course]));
      for (let offset = 0; offset < courses.length; offset += 12) {
        const query = new URLSearchParams();
        for (const course of courses.slice(offset, offset + 12))
          query.append('courseId', course.id);
        const result = await cachedRead(`/api/canvas/assignments?${query}`, request.signal, {
          force,
        });
        if (!request.valid() || !state.connected) return;
        for (const { courseId, assignments: items, issue } of result.courses) {
          const course = byId.get(courseId);
          if (!course) continue;
          if (issue) issues.push(`${courseCode(course)}: ${issue}`);
          collected.push(...items.map((item) => ({ ...item, course })));
        }
      }
      assignments = collected;
      assignmentsLoadedAt = Date.now();
      assignmentIssue = issues.join(' ');
    } catch (error) {
      if (!request.valid()) return;
      if (!preserve || collected.length) assignments = collected;
      assignmentIssue = [
        ...issues,
        preserve ? 'Showing the previous results.' : '',
        error.message || 'Assignments could not be loaded.',
      ].join(' ');
    } finally {
      if (request.valid()) {
        loadingAgenda = false;
        renderSemester();
      }
    }
  }
  function returnToSemester({ focus = true } = {}) {
    invalidate();
    activeCourse = null;
    activeAssignment = null;
    $('course-detail').replaceChildren();
    if (assignments === null || Date.now() - assignmentsLoadedAt >= 60_000)
      void loadSemesterAssignments({ preserve: assignments !== null });
    else renderSemester();
    if (focus) $(fullAgenda ? 'semester-assignments' : 'semester-overview').focus();
  }
  function showToday() {
    fullAgenda = false;
    if (
      activeCourse ||
      activeAssignment ||
      (semester && $('semester-home').hidden && !coursesLoading)
    ) {
      returnToSemester({ focus: false });
      return;
    }
    if (semester) renderSemester();
    void loadCourses({ reuse: true });
  }
  function loadCourses({ reuse = false } = {}) {
    if (!state.connected) return Promise.resolve();
    if (reuse && coursesLoading) return coursesLoading;
    if (reuse && semester && Date.now() - semesterLoadedAt < 5 * 60_000) {
      if (!activeCourse && !loadingAgenda && Date.now() - assignmentsLoadedAt >= 60_000)
        return loadSemesterAssignments({ preserve: assignments !== null });
      return Promise.resolve();
    }
    const force = !reuse;
    if (force) readCache.clear();
    const previousTerm = semester ? $('semester-term').value : null;
    const request = operation();
    const hadCourses = Boolean(semester);
    $('semester-refresh').disabled = true;
    $('semester-term').disabled = true;
    if (!hadCourses) {
      clearCourses();
      const placeholders = node('div', undefined, 'semester-course-skeletons');
      for (let i = 0; i < 4; i++) placeholders.append(skeleton('course'));
      $('course-detail').replaceChildren(
        node('p', 'Loading your semester…', 'muted'),
        placeholders,
      );
    } else status('Refreshing your semester from Canvas…');
    const load = (async () => {
      try {
        const result = await cachedRead('/api/canvas/courses', request.signal, {
          ttl: 5 * 60_000,
          force,
        });
        if (!request.valid() || !state.connected) return;
        semester = result;
        semesterLoadedAt = Date.now();
        activeCourse = null;
        if (!hadCourses) fullAgenda = false;
        const term = $('semester-term');
        term.replaceChildren(
          ...(result.terms || []).map(({ id, name }) =>
            option(id, name.replace(/^(\d{4})([A-Za-z]+)$/, '$2 $1')),
          ),
          option('all', 'All courses'),
        );
        term.value = [...term.options].some((item) => item.value === previousTerm)
          ? previousTerm
          : result.currentTermId || 'all';
        $('semester-coverage').hidden = !result.coverage?.partial;
        $('semester-coverage').textContent = (result.coverage?.reasons || []).join(' ');
        $('course-detail').replaceChildren();
        await selectTerm({ preserve: hadCourses, force });
      } catch (error) {
        if (!request.valid() || !state.connected) return;
        if (hadCourses)
          status(
            `Could not refresh Canvas. Showing your previous semester. ${error.message || ''}`,
          );
        else
          $('course-detail').replaceChildren(
            node('p', error.message || 'Courses could not be loaded.'),
            action('Retry', () => void loadCourses()),
          );
      }
    })();
    coursesLoading = load;
    void load.finally(() => {
      if (coursesLoading === load) {
        coursesLoading = null;
        $('semester-refresh').disabled = false;
        $('semester-term').disabled = false;
      }
    });
    return load;
  }
  function selectTerm({ preserve = false, force = false } = {}) {
    $('semester-course').replaceChildren(
      option('all', 'All courses'),
      ...selectedCourses().map((course) => option(course.id, courseTitle(course.name))),
    );
    $('semester-status').value = 'all';
    return loadSemesterAssignments({ preserve, force });
  }
  async function openReading(courseId, fileId, button) {
    if (!state.connected || state.importing) return;
    const request = operation();
    button.disabled = true;
    status('Opening course reading…');
    try {
      const result = await api('/api/canvas/reading', {
        body: { courseId, fileId },
        binary: true,
        signal: request.signal,
      });
      if (!request.valid() || !state.connected) return;
      await importFile(new File([result.bytes], result.name, { type: result.mime }), {
        signal: request.signal,
      });
    } catch (error) {
      if (request.valid() && state.connected)
        status(error.message || 'This course reading could not be opened.');
    } finally {
      button.disabled = false;
    }
  }
  async function loadCourse(id) {
    if (!state.connected) return;
    const request = operation();
    $('course-detail').replaceChildren(node('p', 'Opening course…'), skeleton('passage'));
    try {
      const result = await cachedRead(
        `/api/canvas/course?id=${encodeURIComponent(id)}`,
        request.signal,
      );
      if (!request.valid() || !state.connected) return;
      activeCourse = result;
      activeAssignment = null;
      activeTab = 'assignments';
      $('semester-home').hidden = true;
      renderCourse();
      $('course-detail').scrollIntoView({
        block: 'start',
        behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches
          ? 'instant'
          : 'smooth',
      });
      return true;
    } catch (error) {
      if (request.valid() && state.connected)
        $('course-detail').replaceChildren(
          node('p', error.message || 'This course could not be opened.'),
        );
      return false;
    }
  }
  function action(text, handler, className = 'button button-secondary') {
    const button = node('button', text, className);
    button.type = 'button';
    button.addEventListener('click', handler);
    return button;
  }
  function dateText(value, fallback = 'No due date') {
    return value && Number.isFinite(Date.parse(value))
      ? new Date(value).toLocaleString(undefined, {
          month: 'short',
          day: 'numeric',
          hour: 'numeric',
          minute: '2-digit',
        })
      : fallback;
  }
  function statusBadge(item, now = Date.now()) {
    const appearance = assignmentPresentation(item, now);
    const badge = node('span', appearance.label, 'canvas-badge');
    badge.dataset.tone = appearance.tone;
    return badge;
  }
  function courseHeader() {
    const header = node('header', undefined, 'canvas-course-header');
    header.append(action('← This Semester', returnToSemester, 'back-link'));
    header.append(
      node('p', activeCourse.course.code, 'canvas-eyebrow'),
      node('h2', courseTitle(activeCourse.course.name)),
    );
    const exportControls = node('div', undefined, 'canvas-export-controls');
    const exportFormat = node('select');
    exportFormat.setAttribute('aria-label', 'Course snapshot format');
    exportFormat.append(
      option('markdown', 'Readable notes'),
      option('json', 'Structured data'),
      option('zip', 'ZIP with original files'),
    );
    const exportButton = action(
      'Download course snapshot',
      async () => {
        const request = operation();
        const courseId = activeCourse.course.id;
        exportButton.disabled = true;
        exportFormat.disabled = true;
        const archived = exportFormat.value === 'zip';
        status(archived ? 'Preparing your course archive…' : 'Preparing your course snapshot…');
        try {
          const result = await api(
            `/api/canvas/export?courseId=${encodeURIComponent(courseId)}&format=${exportFormat.value}`,
            { signal: request.signal, binary: archived },
          );
          if (!request.valid() || !state.connected) return;
          const { content, mime, fileName } = archived
            ? { content: result.bytes, mime: result.mime, fileName: result.name }
            : result;
          const url = URL.createObjectURL(new Blob([content], { type: mime }));
          const link = node('a');
          link.href = url;
          link.download = fileName;
          link.click();
          setTimeout(() => URL.revokeObjectURL(url), 1000);
          status(
            archived
              ? 'Course archive downloaded. See course.json for included and unavailable files.'
              : 'Course snapshot downloaded: assignments, modules, syllabus evidence and file links. Original files stay in Canvas.',
          );
        } catch (error) {
          if (request.valid())
            status(error.message || 'The course snapshot could not be downloaded.');
        } finally {
          exportButton.disabled = false;
          exportFormat.disabled = false;
        }
      },
      'button button-quiet',
    );
    exportControls.append(exportFormat, exportButton);
    if (!state.recording) header.append(exportControls);
    const tabs = node('div', undefined, 'canvas-tabs');
    tabs.setAttribute('role', 'group');
    tabs.setAttribute('aria-label', 'Course sections');
    for (const [key, label, count] of [
      ['assignments', 'Assignments', activeCourse.assignments.length],
      ['materials', 'Readings & modules', activeCourse.modules.length],
      ['study', 'Study', null],
      ['syllabus', 'Syllabus', null],
      ...[...communitySections].map(([key, label]) => [key, label, null]),
    ]) {
      const button = action(
        count === null ? label : `${label} · ${count}`,
        () => {
          invalidate();
          activeAssignment = null;
          activeTab = key;
          renderCourse();
        },
        'canvas-tab',
      );
      button.setAttribute('aria-pressed', String(activeTab === key));
      tabs.append(button);
    }
    header.append(tabs);
    return header;
  }
  function renderCourse() {
    if (!activeCourse) return;
    const detail = $('course-detail');
    detail.replaceChildren(courseHeader());
    noteCoverage(detail, activeCourse.coverage);
    const content = node('div', undefined, 'canvas-course-content');
    detail.append(content);
    if (communitySections.has(activeTab)) {
      void renderCommunity(content, activeCourse.course.id, activeTab);
      return;
    }
    if (activeTab === 'study') {
      const courseId = activeCourse.course.id;
      mountCourseStudy({
        content,
        course: activeCourse,
        draft: draftFor(courseId, 'course'),
        loader: syllabusLoader,
        api,
        operation,
        invalidate,
        importFile,
        external,
        plainText: (html) => {
          const instructions = richInstructions(html, courseId);
          for (const block of instructions.querySelectorAll('p, li, h2, h3, h4, tr'))
            block.append('\n');
          return html?.trim() ? instructions.textContent : '';
        },
      });
      return;
    }
    if (activeTab === 'syllabus') {
      void mountSyllabus({
        content,
        courseId: activeCourse.course.id,
        loader: syllabusLoader,
        operation,
        importFile,
      });
      return;
    }
    if (activeTab === 'assignments') {
      const toolbar = node('div', undefined, 'canvas-course-toolbar');
      const filter = node('input');
      filter.type = 'search';
      filter.placeholder = 'Find an assignment';
      filter.setAttribute('aria-label', 'Find an assignment');
      toolbar.append(node('p', 'Open an assignment to read instructions here.', 'muted'), filter);
      content.append(toolbar);
      const rows = node('div', undefined, 'canvas-assignment-list');
      content.append(rows);
      const render = () => {
        rows.replaceChildren();
        const query = filter.value?.trim().toLowerCase() || '';
        for (const assignment of activeCourse.assignments.filter((item) =>
          item.name.toLowerCase().includes(query),
        )) {
          const row = action(
            '',
            () => void openAssignment(activeCourse.course.id, assignment.id),
            'canvas-assignment-row',
          );
          const copy = node('div', undefined, 'canvas-assignment-copy');
          copy.append(
            node('strong', assignment.name),
            node('span', dateText(assignment.dueAt), 'canvas-assignment-due'),
          );
          row.append(
            copy,
            node(
              'span',
              assignment.points == null ? '—' : `${assignment.points} pts`,
              'canvas-points',
            ),
            statusBadge(assignment),
            node('span', '→', 'canvas-row-arrow'),
          );
          const appearance = assignmentPresentation(assignment);
          row.dataset.status = appearance.status;
          row.dataset.tone = appearance.tone;
          rows.append(row);
        }
        if (!rows.childElementCount)
          rows.append(node('p', 'No assignments match this search.', 'canvas-empty'));
      };
      filter.addEventListener('input', render);
      render();
    } else {
      content.append(
        node(
          'p',
          'Open a file in the reader. Course pages and assignment instructions stay here.',
          'muted',
        ),
      );
      for (const module of activeCourse.modules) {
        const section = node('details', undefined, 'canvas-module');
        section.open = !module.locked;
        section.append(node('summary', `${module.name}${module.locked ? ' · Locked' : ''}`));
        for (const item of module.items) {
          const row = node('div', undefined, 'canvas-material-row');
          const copy = node('div');
          copy.append(node('strong', item.title), node('span', item.type, 'canvas-material-kind'));
          row.append(copy);
          if (item.locked || module.locked) row.append(node('span', 'Locked', 'canvas-badge'));
          else if (item.fileId) {
            const button = action(
              'Open reading',
              () => void openReading(activeCourse.course.id, item.fileId, button),
            );
            row.append(button);
          } else if (item.assignmentId)
            row.append(
              action(
                'Read instructions',
                () => void openAssignment(activeCourse.course.id, item.assignmentId),
              ),
            );
          else if (item.pageUrl)
            row.append(
              action('Read page', () => void openPage(activeCourse.course.id, item.pageUrl)),
            );
          else row.append(external('External activity ↗', item.url));
          section.append(row);
        }
        content.append(section);
      }
      if (!activeCourse.modules.length)
        content.append(node('p', 'No modules are available for this course.', 'canvas-empty'));
    }
  }
  function communityRequest(endpoint, courseId, section, groupId, topicId) {
    const query = new URLSearchParams({ courseId, section });
    if (groupId) query.set('groupId', groupId);
    if (topicId) query.set('topicId', topicId);
    return `/api/canvas/${endpoint}?${query}`;
  }
  async function renderCommunity(content, courseId, section, groupId = null) {
    const request = operation();
    const label = communitySections.get(section);
    content.replaceChildren(node('p', `Loading ${label.toLowerCase()}…`), skeleton('passage'));
    try {
      const result = await cachedRead(
        communityRequest('community', courseId, section, groupId),
        request.signal,
      );
      if (!request.valid() || !content.isConnected) return;
      content.replaceChildren();
      if (result.group) {
        const group = result.group;
        content.append(
          action('← Groups', () => void renderCommunity(content, courseId, 'groups'), 'back-link'),
          node('h3', group.name),
        );
        if (group.description) content.append(node('p', group.description, 'muted'));
        if (group.url) content.append(external('Open group in Canvas ↗', group.url));
        const sections = node('div', undefined, 'canvas-tabs');
        sections.setAttribute('role', 'group');
        sections.setAttribute('aria-label', 'Group sections');
        for (const key of ['discussions', 'announcements']) {
          const button = action(
            communitySections.get(key),
            () => void renderCommunity(content, courseId, key, group.id),
            'canvas-tab',
          );
          button.setAttribute('aria-pressed', String(section === key));
          sections.append(button);
        }
        content.append(sections);
      } else content.append(node('h3', label));
      noteCoverage(content, result.coverage);
      const entries = result.groups || result.topics;
      if (!entries.length) {
        content.append(
          node(
            'p',
            section === 'groups'
              ? 'Canvas lists no groups you belong to for this course.'
              : `No ${label.toLowerCase()} are available.`,
            'canvas-empty',
          ),
        );
        return;
      }
      const list = node('ul', undefined, 'canvas-community-list');
      const back = () => void renderCommunity(content, courseId, section, groupId);
      for (const entry of entries) {
        const item = node('li');
        const groupEntry = section === 'groups';
        const select = groupEntry
          ? () => void renderCommunity(content, courseId, 'discussions', entry.id)
          : () => void openCommunityTopic(content, courseId, section, groupId, entry.id, back);
        item.append(action(entry.name || entry.title, select, 'inline-link'));
        const metadata = groupEntry
          ? [
              entry.memberCount == null
                ? ''
                : `${entry.memberCount} ${entry.memberCount === 1 ? 'member' : 'members'}`,
            ]
          : [entry.author, dateText(entry.postedAt, ''), entry.locked ? 'Locked' : ''];
        if (metadata.some(Boolean))
          item.append(node('p', metadata.filter(Boolean).join(' · '), 'muted'));
        if (groupEntry && entry.description) item.append(node('p', entry.description));
        list.append(item);
      }
      content.append(list);
    } catch (error) {
      if (!request.valid() || !content.isConnected) return;
      content.replaceChildren(
        node('h3', label),
        node(
          'p',
          error.message || `Canvas could not load ${label.toLowerCase()}.`,
          'canvas-notice',
        ),
        action('Try again', () => void renderCommunity(content, courseId, section, groupId)),
      );
      if (groupId)
        content.append(
          action('Back to groups', () => void renderCommunity(content, courseId, 'groups')),
        );
    }
  }
  function communityAttachments(target, attachments = []) {
    if (!attachments.length) return;
    const list = node('ul', undefined, 'canvas-community-attachments');
    for (const file of attachments) {
      const row = node('li');
      row.append(external(`${file.name} ↗`, file.url));
      list.append(row);
    }
    target.append(list);
  }
  async function openCommunityTopic(content, courseId, section, groupId, topicId, back) {
    const request = operation();
    const backButton = action(`← ${communitySections.get(section)}`, back, 'back-link');
    content.replaceChildren(backButton, node('p', 'Opening topic…'), skeleton('passage'));
    try {
      const { topic, replies, groupTopic, replyIssue } = await api(
        communityRequest('topic', courseId, section, groupId, topicId),
        { signal: request.signal },
      );
      if (!request.valid() || !content.isConnected) return;
      const article = node('article', undefined, 'canvas-community-topic');
      article.append(node('h3', topic.title));
      const metadata = [topic.author, dateText(topic.postedAt, '')].filter(Boolean);
      if (metadata.length) article.append(node('p', metadata.join(' · '), 'muted'));
      if (topic.url) article.append(external('Open original in Canvas ↗', topic.url));
      content.replaceChildren(backButton, article);
      if (topic.locked) {
        article.append(
          node('p', topic.lockExplanation || 'This topic is locked in Canvas.', 'canvas-notice'),
        );
        return;
      }
      const evidence = [];
      const addBody = (target, html) => {
        if (!html?.trim()) return;
        const body = richInstructions(html, courseId);
        evidence.push(body.textContent);
        target.append(body);
      };
      addBody(article, topic.bodyHtml);
      communityAttachments(article, topic.attachments);
      if (topic.bodyTruncated || replyIssue)
        article.append(
          node(
            'p',
            [topic.bodyTruncated ? 'The post was shortened.' : '', replyIssue]
              .filter(Boolean)
              .join(' '),
            'canvas-notice',
          ),
        );
      if (groupTopic) {
        article.append(
          action(
            `Open ${groupTopic.name} discussion`,
            () =>
              void openCommunityTopic(
                content,
                courseId,
                section,
                groupTopic.groupId,
                groupTopic.topicId,
                back,
              ),
          ),
        );
      }
      const replyList = (entries) => {
        const list = node('ol', undefined, 'canvas-community-replies');
        for (const entry of entries) {
          const item = node('li');
          const detail = [
            entry.deleted ? 'Deleted reply' : entry.author || 'Participant',
            dateText(entry.postedAt, ''),
          ].filter(Boolean);
          item.append(node('p', detail.join(' · '), 'muted'));
          addBody(item, entry.bodyHtml);
          communityAttachments(item, entry.attachments);
          if (entry.replies.length) item.append(replyList(entry.replies));
          list.append(item);
        }
        return list;
      };
      if (replies.length) article.append(node('h4', 'Replies'), replyList(replies));
      if (topic.url && evidence.length)
        activeCommunitySource = {
          element: article,
          title: topic.title,
          url: topic.url,
          text: evidence.join('\n\n').slice(0, 8000),
        };
    } catch (error) {
      if (request.valid() && content.isConnected)
        content.replaceChildren(
          backButton,
          node('p', error.message || 'Canvas could not load this topic.', 'canvas-notice'),
        );
    }
  }
  // Parse inside an inert template, then rebuild a small allowlist. Never insert Canvas HTML.
  function richInstructions(html, courseId) {
    const template = document.createElement('template');
    template.innerHTML = html;
    const output = node('div', undefined, 'canvas-instructions');
    let remaining = 6000;
    const tags = new Set([
      'P',
      'BR',
      'H1',
      'H2',
      'H3',
      'H4',
      'H5',
      'H6',
      'UL',
      'OL',
      'LI',
      'STRONG',
      'B',
      'EM',
      'I',
      'U',
      'S',
      'BLOCKQUOTE',
      'PRE',
      'CODE',
      'TABLE',
      'THEAD',
      'TBODY',
      'TR',
      'TH',
      'TD',
      'HR',
      'SUP',
      'SUB',
    ]);
    const blocked = new Set([
      'SCRIPT',
      'STYLE',
      'IFRAME',
      'OBJECT',
      'EMBED',
      'FORM',
      'INPUT',
      'BUTTON',
      'SVG',
      'MATH',
      'TEMPLATE',
      'LINK',
      'META',
    ]);
    function append(source, target, depth = 0) {
      if (--remaining < 0 || depth > 35) return;
      if (source.nodeType === 3) {
        target.append(document.createTextNode(source.textContent));
        return;
      }
      if (source.nodeType !== 1 || blocked.has(source.tagName)) return;
      if (source.tagName === 'A' || source.tagName === 'IMG') {
        const label =
          source.tagName === 'IMG'
            ? source.getAttribute('alt') || 'Course image'
            : source.textContent?.trim() || 'Course resource';
        let url;
        try {
          url = new URL(
            source.getAttribute(source.tagName === 'IMG' ? 'src' : 'href'),
            'https://babson.instructure.com',
          );
        } catch {
          target.append(node('span', label));
          return;
        }
        if (url.username || url.password || !['https:', 'http:'].includes(url.protocol)) {
          target.append(node('span', label));
          return;
        }
        if (url.origin !== 'https://babson.instructure.com') {
          const link = node('a', `${label} ↗`, 'inline-link');
          link.href = url.href;
          link.target = '_blank';
          link.rel = 'noopener noreferrer';
          target.append(link);
          return;
        }
        const file = url.pathname.match(/^\/(?:courses\/\d+\/)?files\/(\d+)(?:\/|$)/);
        const assignment = url.pathname.match(/^\/courses\/(\d+)\/assignments\/(\d+)\/?$/);
        const page = url.pathname.match(/^\/courses\/(\d+)\/pages\/([A-Za-z0-9_-]+)\/?$/);
        if (file && source.tagName !== 'IMG') {
          const button = action(
            label,
            () => void openReading(courseId, file[1], button),
            'inline-link canvas-resource-link',
          );
          target.append(button);
        } else if (assignment && assignment[1] === String(courseId))
          target.append(
            action(label, () => void openAssignment(courseId, assignment[2]), 'inline-link'),
          );
        else if (page && page[1] === String(courseId))
          target.append(action(label, () => void openPage(courseId, page[2]), 'inline-link'));
        else
          target.append(
            external(source.tagName === 'IMG' ? `View image: ${label} ↗` : `${label} ↗`, url.href),
          );
        return;
      }
      const next = tags.has(source.tagName)
        ? node(source.tagName.toLowerCase())
        : document.createDocumentFragment();
      for (const child of source.childNodes) append(child, next, depth + 1);
      target.append(next);
    }
    for (const child of template.content.childNodes) append(child, output);
    if (!output.textContent.trim())
      output.append(node('p', 'No written instructions were provided for this item.'));
    return output;
  }
  function detailShell(title, subtitle) {
    const detail = $('course-detail');
    $('semester-home').hidden = true;
    detail.replaceChildren(...(activeCourse ? [courseHeader()] : []));
    const article = node('article', undefined, 'canvas-assignment-detail');
    article.append(
      action(
        activeCourse ? '← Back to course' : '← All Assignments',
        () => {
          invalidate();
          activeAssignment = null;
          if (activeCourse) renderCourse();
          else returnToSemester();
        },
        'back-link',
      ),
      node('p', subtitle, 'canvas-eyebrow'),
      node('h2', title),
    );
    detail.append(article);
    return article;
  }
  async function openAssignment(courseId, assignmentId) {
    if (!state.connected) return;
    const request = operation();
    activeAssignment = null;
    activeAssignmentSource = null;
    const article = detailShell('Opening assignment…', 'Assignment');
    article.setAttribute('aria-busy', 'true');
    const placeholder = node('div');
    placeholder.append(skeleton('metadata'), skeleton('action'), skeleton('passage'));
    article.append(placeholder);
    try {
      const result = await cachedRead(
        `/api/canvas/assignment?courseId=${encodeURIComponent(courseId)}&assignmentId=${encodeURIComponent(assignmentId)}`,
        request.signal,
      );
      if (!request.valid() || !state.connected) return;
      const assignment = result.assignment;
      activeAssignment = {
        courseId: String(courseId),
        courseTitle: courseTitle(
          semester?.courses.find((item) => item.id === String(courseId))?.name ||
            activeCourse?.course.name,
        ),
        assignmentId: String(assignment.id || assignmentId),
        assignmentTitle: assignment.name,
      };
      const card = detailShell(assignment.name, 'Assignment');
      card.classList.add('loading-enter');
      const meta = node('dl', undefined, 'canvas-assignment-meta');
      for (const [label, value] of [
        ['Due', dateText(assignment.dueAt)],
        ['Points', assignment.points == null ? 'Not specified' : String(assignment.points)],
        [
          'Status',
          assignmentLabels[assignment.status] ||
            (assignment.submitted ? 'Submitted' : assignment.locked ? 'Locked' : 'Not submitted'),
        ],
        [
          'Accepts',
          assignment.submissionTypes
            .map(
              (type) =>
                ({
                  online_upload: 'File upload',
                  online_text_entry: 'Text entry',
                  online_url: 'Website URL',
                  discussion_topic: 'Discussion',
                  external_tool: 'External tool',
                  none: 'No submission',
                })[type] || type.replaceAll('_', ' '),
            )
            .join(' · ') || 'Not specified',
        ],
      ]) {
        const pair = node('div');
        pair.append(node('dt', label), node('dd', value));
        meta.append(pair);
      }
      card.dataset.tone = assignmentPresentation(assignment).tone;
      card.append(meta);
      if (assignment.locked)
        card.append(
          node(
            'p',
            assignment.lockExplanation || 'This assignment is locked in Canvas.',
            'canvas-notice',
          ),
        );
      if (assignment.descriptionTruncated)
        card.append(
          node(
            'p',
            'Very long instructions were shortened. Check Canvas for the complete original.',
            'canvas-notice',
          ),
        );
      const instructions = richInstructions(assignment.descriptionHtml, courseId);
      activeAssignmentSource = {
        title: assignment.name,
        url:
          assignment.url ||
          `https://babson.instructure.com/courses/${courseId}/assignments/${assignmentId}`,
        text: `Due: ${dateText(assignment.dueAt)}\nStatus: ${assignmentPresentation(assignment).label}\nPoints: ${assignment.points ?? 'Not specified'}\n\n${instructions.textContent}`.slice(
          0,
          12_000,
        ),
      };
      instructions.id = 'assignment-instructions';
      instructions.tabIndex = -1;
      const study = node('div', undefined, 'assignment-study-slot');
      study.id = 'assignment-study-slot';
      const studyButton = action(
        'Study this',
        () => {
          if (study.childElementCount) {
            invalidate();
            study.replaceChildren();
            studyButton.setAttribute('aria-expanded', 'false');
            return;
          }
          studyButton.setAttribute('aria-expanded', 'true');
          mountAssignmentStudy({
            container: study,
            assignment,
            courseId,
            instructions: assignment.descriptionHtml?.trim() ? instructions.innerText.trim() : '',
            draft: draftFor(courseId, assignmentId),
            loader: syllabusLoader,
            api,
            operation,
            importFile,
          });
        },
        'button button-primary assignment-study-toggle',
      );
      studyButton.setAttribute('aria-expanded', 'false');
      studyButton.setAttribute('aria-controls', study.id);
      card.append(studyButton, study, instructions);
      const submission = node('section', undefined, 'canvas-submission-area');
      submission.id = 'canvas-submission-area';
      submission.dataset.courseId = String(courseId);
      submission.dataset.assignmentId = String(assignmentId);
      card.append(submission);
      mountSubmissionForm({
        container: submission,
        assignment: {
          ...assignment,
          title: assignment.name,
          submission_types: assignment.submissionTypes,
          locked_for_user: assignment.locked,
          can_submit: assignment.canSubmit,
          academic_integrity_pledge: assignment.requiresPledge,
        },
        courseId,
        api,
        status,
      });
      return true;
    } catch (error) {
      if (request.valid())
        placeholder.replaceChildren(
          node('p', error.message || 'This assignment could not be opened.'),
          action('Retry assignment', () => void openAssignment(courseId, assignmentId)),
        );
      return false;
    } finally {
      article.removeAttribute('aria-busy');
    }
  }
  async function openPage(courseId, pageUrl) {
    if (!state.connected) return;
    const request = operation();
    activeAssignment = null;
    const article = detailShell('Opening page…', 'Course page');
    try {
      const { page } = await cachedRead(
        `/api/canvas/page?courseId=${encodeURIComponent(courseId)}&pageUrl=${encodeURIComponent(pageUrl)}`,
        request.signal,
        { ttl: 120_000 },
      );
      if (!request.valid() || !state.connected) return;
      const card = detailShell(page.title, 'Course page');
      card.append(richInstructions(page.bodyHtml, courseId));
      if (page.truncated)
        card.append(node('p', 'Very long page content was shortened.', 'canvas-notice'));
    } catch (error) {
      if (request.valid())
        article.replaceChildren(node('p', error.message || 'This page could not be opened.'));
    }
  }
  async function connect(event) {
    event.preventDefault();
    const button = $('canvas-connect').querySelector('button');
    if (button.disabled) return;
    const token = $('canvas-token').value;
    const request = operation();
    button.disabled = true;
    try {
      const result = await api('/api/canvas/connect', { body: { token }, signal: request.signal });
      if (!request.valid()) return;
      clearStudy();
      readCache.clear();
      clearCourses();
      profile = result.profile;
      state.connected = true;
      labels();
      await loadCourses();
      if (state.connected) onConnect();
    } catch (error) {
      if (request.valid()) status(error.message || 'Canvas could not connect.');
    } finally {
      $('canvas-token').value = '';
      button.disabled = false;
    }
  }
  async function disconnect() {
    const button = $('canvas-disconnect');
    if (button.disabled) return;
    const oldProfile = profile;
    const request = operation();
    // Clear immediately; a late course response cannot repopulate a disconnected view.
    state.connected = false;
    profile = null;
    clearStudy();
    readCache.clear();
    clearCourses();
    labels();
    button.disabled = true;
    const connectButton = $('canvas-connect').querySelector('button');
    connectButton.disabled = true;
    try {
      await api('/api/canvas/disconnect', { body: {}, signal: request.signal });
      if (request.valid()) status('Canvas disconnected.');
    } catch (error) {
      if (request.valid()) {
        profile = oldProfile;
        state.connected = Boolean(oldProfile);
        labels();
        status(`Canvas disconnect was not confirmed. ${error.message || 'Try again.'}`);
      }
    } finally {
      button.disabled = false;
      connectButton.disabled = false;
    }
  }
  function bind() {
    if (bound) return;
    bound = true;
    $('canvas-connect').addEventListener('submit', connect);
    $('canvas-disconnect').addEventListener('click', () => void disconnect());
    $('semester-term').addEventListener('change', selectTerm);
    $('semester-refresh').addEventListener('click', () => void loadCourses());
    $('semester-course').addEventListener('change', renderAgenda);
    $('semester-status').addEventListener('change', renderAgenda);
    $('semester-overview').addEventListener('click', () => {
      fullAgenda = false;
      renderSemester();
    });
    $('semester-assignments').addEventListener('click', () => {
      fullAgenda = true;
      renderSemester();
    });
    window.addEventListener(
      'beforeunload',
      () => {
        clearTimeout(deadlineTimer);
        invalidate();
      },
      { once: true },
    );
  }
  function getContext() {
    return {
      courseId: activeAssignment?.courseId || activeCourse?.course.id || null,
      courseTitle:
        activeAssignment?.courseTitle ||
        (activeCourse ? courseTitle(activeCourse.course.name) : null),
      assignmentId: activeAssignment?.assignmentId || null,
      assignmentTitle: activeAssignment?.assignmentTitle || null,
      section: activeAssignment
        ? 'assignment'
        : activeCourse
          ? activeTab
          : fullAgenda
            ? 'assignments'
            : 'semester',
    };
  }
  function getNavigationIndex() {
    return {
      courses: (semester ? selectedCourses() : []).map((course) => ({
        id: course.id,
        name: courseTitle(course.name),
        code: course.code,
      })),
      assignments: (assignments || []).map((item) => ({
        id: item.id,
        name: item.name,
        courseId: item.course.id,
        dueAt: item.dueAt,
        status: item.status,
        locked: item.locked,
        submitted: item.submitted,
      })),
    };
  }
  function getSourceContext() {
    const context = getContext();
    if (!context.courseId) return [];
    const result = [];
    if (activeAssignment && activeAssignmentSource) result.push({ ...activeAssignmentSource });
    if (activeCommunitySource?.element.isConnected) {
      const { title, url, text } = activeCommunitySource;
      result.push({ title, url, text });
    }
    if (activeCourse && String(activeCourse.course.id) === String(context.courseId)) {
      result.push({
        title: `${context.courseTitle} · course assignments`,
        url: `https://babson.instructure.com/courses/${context.courseId}/assignments`,
        text: activeCourse.assignments
          .map(
            (item) =>
              `${item.name} | Due: ${dateText(item.dueAt)} | ${assignmentPresentation(item).label}`,
          )
          .join('\n')
          .slice(0, 8000),
      });
    }
    let remaining = 32_000 - result.reduce((total, source) => total + source.text.length, 0);
    for (const source of discoveredSources.get(String(context.courseId)) || []) {
      if (!remaining) break;
      const text = source.text.slice(0, remaining);
      result.push({ ...source, text });
      remaining -= text.length;
    }
    return result;
  }
  async function navigate({ courseId, assignmentId, pageUrl, section = 'assignments' }) {
    if (!state.connected) throw new Error('Connect Canvas to open a class.');
    if (!semester) await loadCourses({ reuse: true });
    if (!semester?.courses.some((course) => String(course.id) === String(courseId)))
      throw new Error('That course is not in the connected Canvas account.');
    if (assignmentId) {
      if (String(activeCourse?.course.id) !== String(courseId)) activeCourse = null;
      if (!(await openAssignment(String(courseId), String(assignmentId))))
        throw new Error('The assignment could not be opened. Try again.');
    } else {
      if (
        !['assignments', 'materials', 'study', 'syllabus'].includes(section) &&
        !communitySections.has(section)
      )
        throw new Error('Choose a course section.');
      if (!(await loadCourse(String(courseId))))
        throw new Error('The course could not be opened. Try again.');
      if (activeCourse && String(activeCourse.course.id) === String(courseId)) {
        activeTab = pageUrl ? 'materials' : section;
        renderCourse();
        if (pageUrl) await openPage(String(courseId), pageUrl);
      }
    }
    return getContext();
  }
  return {
    bind,
    loadCourses,
    showToday,
    restore,
    getContext,
    getNavigationIndex,
    getSourceContext,
    navigate,
  };
}
