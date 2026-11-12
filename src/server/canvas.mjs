/** Read-only Babson Canvas transport. No credentials are persisted or logged. */
import { ARCHIVE_FILE_EXTENSIONS, downloadCanvasFile } from './canvas-download.mjs';
import { pythonDomain } from './python-domain.mjs';
export const CANVAS_ORIGIN = 'https://babson.instructure.com';
const JSON_LIMIT = 1024 * 1024;
const FILE_LIMIT = 12 * 1024 * 1024;
const PAGE_LIMIT = 3;
const ITEM_LIMIT = 300;
const plain = (value, limit = 500) =>
  typeof value === 'string'
    ? value
        .replace(/<[^>]*>/g, '')
        // eslint-disable-next-line no-control-regex -- Remove disallowed control characters from provider text.
        .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
        .slice(0, limit)
    : '';
const id = (value) => {
  const result = String(value ?? '');
  if (!/^[1-9]\d{0,15}$/.test(result))
    throw new CanvasError('invalid_id', 'A valid Canvas identifier is required.', 400);
  return result;
};
export class CanvasError extends Error {
  constructor(code, message, status = 502) {
    super(message);
    this.name = 'CanvasError';
    this.code = code;
    this.status = status;
  }
}
function abortable(operation, signal) {
  return new Promise((resolve, reject) => {
    const fail = () =>
      reject(new CanvasError('aborted', 'Canvas request cancelled or timed out.', 504));
    if (signal.aborted) return fail();
    signal.addEventListener('abort', fail, { once: true });
    Promise.resolve()
      .then(operation)
      .then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', fail));
  });
}
function checkToken(token) {
  if (
    typeof token !== 'string' ||
    token.length < 10 ||
    token.length > 4096 ||
    !/^[\x21-\x7e]+$/.test(token)
  )
    throw new CanvasError('invalid_token', 'Enter a valid Canvas access token.', 400);
}
function trustedURL(value) {
  let url;
  try {
    url = new URL(value, CANVAS_ORIGIN);
  } catch {
    throw new CanvasError('unsafe_url', 'Canvas returned an unsupported URL.');
  }
  if (url.origin !== CANVAS_ORIGIN || url.username || url.password || url.hash)
    throw new CanvasError('unsafe_url', 'This resource must be opened directly in Canvas.');
  return url;
}
async function request(token, url, { fetcher = fetch, signal } = {}) {
  checkToken(token);
  const safe = trustedURL(url);
  const timer = AbortSignal.timeout(12_000);
  const combined = signal ? AbortSignal.any([signal, timer]) : timer;
  let response;
  try {
    response = await abortable(
      () =>
        fetcher(safe.href, {
          method: 'GET',
          headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
          redirect: 'manual',
          signal: combined,
        }),
      combined,
    );
    if (response.status >= 300 && response.status < 400)
      throw new CanvasError(
        'unsupported_redirect',
        'Canvas uses a separate download host for this file. Download it in Canvas, then upload it here.',
        422,
      );
    if (response.status === 401)
      throw new CanvasError(
        'unauthorized',
        'Canvas did not accept this token. Reconnect with a valid token.',
        401,
      );
    if (response.status === 403 || response.status === 404)
      throw new CanvasError(
        'unavailable',
        'Canvas has restricted this resource or it is no longer available.',
        403,
      );
    if (!response.ok)
      throw new CanvasError(
        response.status === 503 ? 'pending' : 'upstream',
        'Canvas could not complete this request. Try again later.',
      );
    if (response.url && trustedURL(response.url).href !== safe.href)
      throw new CanvasError(
        'unsupported_redirect',
        'Canvas redirected this resource. Open it directly in Canvas.',
        422,
      );
    const length = response.headers.get('content-length');
    if (length && (!/^\d+$/.test(length) || Number(length) > JSON_LIMIT))
      throw new CanvasError(
        'too_large',
        'This Canvas resource exceeds the reading size limit.',
        413,
      );
    const reader = response.body?.getReader();
    if (!reader) throw new CanvasError('invalid_response', 'Canvas returned an empty response.');
    const parts = [];
    let count = 0;
    try {
      while (true) {
        // Race the read too: a test adapter or stalled body must not bypass timeout.
        const next = await abortable(() => reader.read(), combined);
        if (next.done) break;
        count += next.value.byteLength;
        if (count > JSON_LIMIT)
          throw new CanvasError(
            'too_large',
            'This Canvas resource exceeds the reading size limit.',
            413,
          );
        parts.push(next.value);
      }
    } finally {
      reader.cancel().catch(() => {});
    }
    const bytes = new Uint8Array(count);
    let offset = 0;
    for (const part of parts) {
      bytes.set(part, offset);
      offset += part.byteLength;
    }
    let data;
    try {
      data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    } catch {
      throw new CanvasError('invalid_response', 'Canvas returned unreadable data.');
    }
    return { data, response };
  } catch (error) {
    if (error instanceof CanvasError) throw error;
    throw new CanvasError(
      combined.aborted ? 'aborted' : 'transport',
      combined.aborted
        ? 'Canvas request cancelled or timed out.'
        : 'Unable to reach Canvas. Check your connection.',
      combined.aborted ? 504 : 502,
    );
  }
}
function nextURL(link, initial) {
  if (!link) return null;
  const matches = [...link.matchAll(/<([^>]+)>\s*;\s*rel="?([^",;\s]+)"?/g)].filter(
    (entry) => entry[2] === 'next',
  );
  if (matches.length > 1)
    throw new CanvasError('unsafe_pagination', 'Canvas returned an invalid page sequence.');
  if (!matches.length) return null;
  const next = trustedURL(matches[0][1]);
  if (next.pathname !== initial.pathname)
    throw new CanvasError('unsafe_pagination', 'Canvas returned an invalid page sequence.');
  const baseline = [...initial.searchParams]
    .filter(([key]) => key !== 'page')
    .sort()
    .map(JSON.stringify)
    .join();
  const candidate = [...next.searchParams]
    .filter(([key]) => key !== 'page')
    .sort()
    .map(JSON.stringify)
    .join();
  if (
    baseline !== candidate ||
    next.searchParams.getAll('page').length !== 1 ||
    !/^\d+$/.test(next.searchParams.get('page'))
  )
    throw new CanvasError('unsafe_pagination', 'Canvas changed the requested collection filters.');
  return next;
}
async function collection(token, path, options) {
  const initial = trustedURL(path);
  initial.searchParams.set('per_page', '100');
  let url = initial;
  const seen = new Set();
  const items = [];
  for (let page = 0; page < PAGE_LIMIT; page++) {
    if (seen.has(url.href))
      throw new CanvasError('unsafe_pagination', 'Canvas repeated a collection page.');
    seen.add(url.href);
    const { data, response } = await request(token, url, options);
    if (!Array.isArray(data))
      throw new CanvasError('invalid_response', 'Canvas returned an invalid collection.');
    const remaining = ITEM_LIMIT - items.length;
    items.push(...data.slice(0, remaining));
    const next = nextURL(response.headers.get('link'), initial);
    if (
      data.length > remaining ||
      (next && (items.length === ITEM_LIMIT || page === PAGE_LIMIT - 1))
    )
      return { items, complete: false };
    if (!next) return { items, complete: true };
    url = next;
  }
  return { items, complete: false };
}
async function normalize(operation, value, options) {
  try {
    return await pythonDomain('canvas.' + operation, value, { signal: options.signal });
  } catch (error) {
    const messages = {
      invalid_id: 'A valid Canvas identifier is required.',
      invalid_response: 'Canvas returned a different or invalid resource.',
      locked: 'This page is locked in Canvas.',
    };
    throw new CanvasError(
      error.code ?? 'invalid_response',
      messages[error.code] ??
        'Canvas data processing is unavailable. Reading local files still works.',
      error.status ?? 502,
    );
  }
}
const coverage = (reasons) => ({
  complete: reasons.length === 0,
  partial: reasons.length > 0,
  reasons,
});
export async function validateCanvasToken(token, options = {}) {
  const { data } = await request(token, '/api/v1/users/self/profile', options);
  return normalize('profile', { raw: data }, options);
}
export async function listCanvasCourses(token, options = {}) {
  const result = await collection(
    token,
    '/api/v1/courses?enrollment_type=student&include[]=term',
    options,
  );
  return {
    ...(await normalize(
      'courses',
      { raw: result.items, now: new Date(options.now ?? Date.now()).toISOString() },
      options,
    )),
    coverage: coverage(
      result.complete ? [] : ['Only the first 300 courses or three pages were loaded.'],
    ),
  };
}
export async function listCanvasAssignments(token, courseIds, options = {}) {
  const ids = [...new Set(courseIds.map(id))];
  if (!ids.length || ids.length > 12)
    throw new CanvasError('invalid_courses', 'Select between 1 and 12 courses.', 400);

  const courses = [];
  for (const courseId of ids) {
    try {
      const result = await collection(
        token,
        `/api/v1/courses/${courseId}/assignments?include[]=submission&override_assignment_dates=true`,
        options,
      );
      const assignments = await normalize('assignments', { raw: result.items, courseId }, options);
      courses.push({
        courseId,
        assignments,
        issue: result.complete
          ? null
          : 'Only the first 300 assignments or three pages were loaded.',
      });
    } catch (error) {
      if (options.signal?.aborted || error.code === 'unauthorized') throw error;
      courses.push({
        courseId,
        assignments: [],
        issue:
          error.code === 'unavailable'
            ? 'Canvas did not grant access to assignments.'
            : 'Assignments could not be loaded. Try refreshing.',
      });
    }
  }
  return { courses };
}
function optionalCollection(token, options, reasons) {
  return async (path, label) => {
    try {
      const result = await collection(token, path, options);
      if (!result.complete) reasons.push(`${label} were capped at 300 items or three pages.`);
      return result.items;
    } catch (error) {
      if (error.code !== 'unavailable') throw error;
      reasons.push(`${label} are not accessible with this Canvas account.`);
      return [];
    }
  };
}
async function courseModules(base, optional, reasons) {
  const rawModules = await optional(`${base}/modules?include[]=items`, 'Modules');
  const modules = [];
  let fallbackCount = 0;
  let totalItems = 0;
  for (const module of rawModules) {
    const mid = id(module.id);
    let items = Array.isArray(module.items) ? module.items : [];
    if (
      Number(module.items_count) > items.length ||
      (!Array.isArray(module.items) && Number(module.items_count) > 0)
    ) {
      if (fallbackCount < 4 && totalItems < ITEM_LIMIT) {
        fallbackCount++;
        items = await optional(
          `${base}/modules/${mid}/items`,
          `Items for ${plain(module.name, 80)}`,
        );
      } else
        reasons.push(
          'Some module items require opening Canvas; the bounded lookup budget was reached.',
        );
    }
    if (items.length > ITEM_LIMIT - totalItems)
      reasons.push('Module item results were capped at 300 items.');
    items = items.slice(0, ITEM_LIMIT - totalItems);
    totalItems += items.length;
    modules.push({ ...module, items });
  }
  return modules;
}
export async function readCanvasCourse(token, courseId, options = {}) {
  const cid = id(courseId);
  const base = `/api/v1/courses/${cid}`;
  const { data } = await request(token, base, options);
  const reasons = [];
  const optional = optionalCollection(token, options, reasons);
  const [assignments, modules] = await Promise.all([
    optional(`${base}/assignments?include[]=submission`, 'Assignments'),
    courseModules(base, optional, reasons),
  ]);
  return {
    ...(await normalize('course', { raw: data, courseId: cid, assignments, modules }, options)),
    coverage: coverage([...new Set(reasons)]),
  };
}
/** HTML is bounded, untrusted source data. Client rebuilds only allowed elements. */
export async function readCanvasAssignment(token, courseId, assignmentId, options = {}) {
  const cid = id(courseId);
  const aid = id(assignmentId);
  const { data } = await request(
    token,
    `/api/v1/courses/${cid}/assignments/${aid}?include[]=submission`,
    options,
  );
  return normalize('assignment', { raw: data, courseId: cid, assignmentId: aid }, options);
}
export async function readCanvasStudyAssignments(token, courseId, assignmentIds, options = {}) {
  const cid = id(courseId);
  const ids = [...new Set(assignmentIds.map(id))];
  if (!ids.length || ids.length > 5)
    throw new CanvasError(
      'invalid_assignments',
      'Each assignment read batch must contain between one and five IDs.',
      400,
    );
  const assignments = [];
  const unavailable = [];
  for (const assignmentId of ids) {
    try {
      const { assignment } = await readCanvasAssignment(token, cid, assignmentId, options);
      if (!assignment.descriptionHtml.trim()) unavailable.push(assignmentId);
      else
        assignments.push({
          ...assignment,
          descriptionHtml: assignment.descriptionHtml,
        });
    } catch (error) {
      if (options.signal?.aborted || error.code === 'unauthorized') throw error;
      unavailable.push(assignmentId);
    }
  }
  return { assignments, unavailable };
}
export async function readCanvasPage(token, courseId, pageUrl, options = {}) {
  const cid = id(courseId);
  if (typeof pageUrl !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(pageUrl))
    throw new CanvasError('invalid_page', 'A valid course page is required.', 400);
  const { data } = await request(
    token,
    `/api/v1/courses/${cid}/pages/${encodeURIComponent(pageUrl)}`,
    options,
  );
  return normalize('page', { raw: data, courseId: cid }, options);
}

async function readOwnCanvasGroups(token, courseId, options) {
  const result = await collection(
    token,
    `/api/v1/courses/${courseId}/groups?only_own_groups=true`,
    options,
  );
  return {
    groups: await normalize('groups', { raw: result.items, courseId }, options),
    complete: result.complete,
  };
}

async function canvasCommunityContext(token, courseId, groupId, options) {
  if (groupId == null) return { path: `/api/v1/courses/${courseId}`, group: null };
  const gid = id(groupId);
  const { groups } = await readOwnCanvasGroups(token, courseId, options);
  const group = groups.find((item) => item.id === gid);
  if (!group)
    throw new CanvasError(
      'unavailable',
      'Canvas did not confirm that you belong to this group for the selected course.',
      403,
    );
  return { path: `/api/v1/groups/${gid}`, group };
}

function communitySection(section) {
  if (!['announcements', 'discussions'].includes(section))
    throw new CanvasError('invalid_section', 'Choose announcements or discussions.', 400);
  return section === 'announcements';
}

export async function listCanvasCommunity(
  token,
  courseId,
  { section, groupId } = {},
  options = {},
) {
  const cid = id(courseId);
  if (section === 'groups' && groupId == null) {
    const { groups, complete } = await readOwnCanvasGroups(token, cid, options);
    return {
      groups,
      coverage: coverage(complete ? [] : ['Only the first 300 groups or three pages were loaded.']),
    };
  }
  const announcement = communitySection(section);
  const { path, group } = await canvasCommunityContext(token, cid, groupId, options);
  const result = await collection(
    token,
    `${path}/discussion_topics${announcement ? '?only_announcements=true' : ''}`,
    options,
  );
  return {
    group,
    topics: await normalize(
      'topics',
      { raw: result.items, courseId: cid, groupId: group?.id, announcement },
      options,
    ),
    coverage: coverage(
      result.complete ? [] : ['Only the first 300 topics or three pages were loaded.'],
    ),
  };
}

export async function readCanvasCommunityTopic(
  token,
  courseId,
  topicId,
  { section, groupId } = {},
  options = {},
) {
  const cid = id(courseId);
  const tid = id(topicId);
  const announcement = communitySection(section);
  const { path, group } = await canvasCommunityContext(token, cid, groupId, options);
  const base = `${path}/discussion_topics/${tid}`;
  const { data } = await request(token, base, options);
  const { groupChildren, ...topic } = await normalize(
    'topic',
    { raw: data, courseId: cid, groupId: group?.id, topicId: tid, announcement },
    options,
  );
  const result = { topic, replies: [], groupTopic: null, replyIssue: null };
  if (topic.locked) return result;
  if (!group && topic.groupDiscussion) {
    const { groups } = await readOwnCanvasGroups(token, cid, options);
    const membership = new Set(groups.map((item) => item.id));
    const matches = groupChildren.filter((child) => membership.has(child.groupId));
    if (matches.length === 1)
      result.groupTopic = {
        ...matches[0],
        name: groups.find((item) => item.id === matches[0].groupId).name,
      };
    else result.replyIssue = 'Open this topic in Canvas to view your group discussion.';
    return result;
  }
  if (topic.repliesRestricted) {
    result.replyIssue = topic.initialPostRequired
      ? 'Canvas requires an initial post before it shows replies. Open the original topic to participate.'
      : 'Canvas has restricted the replies. Open the original topic for access details.';
    return result;
  }
  try {
    const { data: thread } = await request(token, `${base}/view?include_new_entries=1`, options);
    const { replies, partial } = await normalize(
      'thread',
      { raw: thread, courseId: cid, groupId: group?.id },
      options,
    );
    result.replies = replies;
    if (partial)
      result.replyIssue =
        'Some replies were shortened or omitted. Open Canvas for the complete thread.';
  } catch (error) {
    if (options.signal?.aborted || !['unavailable', 'too_large', 'pending'].includes(error.code))
      throw error;
    result.replyIssue =
      error.code === 'too_large'
        ? 'This thread exceeds the reading size limit. Open it in Canvas for the replies.'
        : error.code === 'pending'
          ? 'Canvas is still preparing replies. Try reopening the topic or view it in Canvas.'
          : 'Canvas has restricted the replies. Open the original topic for access details.';
  }
  return result;
}
export const CANVAS_WORD_MIME =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const syllabusName = (value) =>
  /\b(?:syllab(?:us|i)|course outline)\b/i.test(String(value ?? '').replace(/_/g, ' '));
const pageSlug = (value) => typeof value === 'string' && /^[A-Za-z0-9_-]{1,200}$/.test(value);

function linkedFile(href, cid) {
  try {
    const { pathname } = trustedURL(href);
    return pathname.match(
      new RegExp(`^/courses/${cid}/files/([1-9]\\d{0,15})(?:/download)?/?$`),
    )?.[1];
  } catch {
    return null;
  }
}
async function syllabusPage(html, options) {
  return pythonDomain('syllabus.html', { html: String(html ?? '').slice(0, 120_000) }, options);
}
export async function readCanvasSyllabus(token, courseId, options = {}) {
  const cid = id(courseId);
  const base = `/api/v1/courses/${cid}`;
  const web = `${CANVAS_ORIGIN}/courses/${cid}`;
  const reasons = [];
  const optional = optionalCollection(token, options, reasons);
  async function optionalPage(path, label) {
    try {
      return (await request(token, path, options)).data;
    } catch (error) {
      if (error.code !== 'unavailable') throw error;
      reasons.push(`${label} could not be opened in Canvas.`);
      return null;
    }
  }
  const [{ data: course }, modules, files, pages] = await Promise.all([
    request(token, `${base}?include[]=syllabus_body`, options),
    courseModules(base, optional, reasons),
    optional(`${base}/files?search_term=syllabus`, 'Course file search'),
    optional(`${base}/pages?search_term=syllabus`, 'Course page search'),
  ]);
  const candidates = new Map();
  const add = (key, item) => {
    if (!candidates.has(key) || candidates.get(key).priority < item.priority)
      candidates.set(key, item);
  };
  const year = String(course.course_code ?? '').match(/20\d{2}/)?.[0];
  function addFile(fileId, title, via, priority, linked = false) {
    const fid = id(fileId);
    title = plain(title, 220) || 'Syllabus file';
    if (/\.(?:pdf|docx|txt)$/i.test(title) === false && /\.[a-z0-9]{2,5}$/i.test(title)) return;
    const fileYear = title.match(/20\d{2}/)?.[0];
    if (fileYear && year && fileYear !== year) priority -= 100;
    add(`file:${fid}`, {
      kind: 'file',
      fileId: fid,
      title,
      url: `${web}/files/${fid}`,
      via,
      priority,
      linked,
    });
  }
  async function addPage(title, html, url, via, priority) {
    const result = await syllabusPage(html, options);
    const fileLinks = result.links.flatMap(({ href, title, label }) => {
      const file = linkedFile(href, cid);
      return file && (syllabusName(title) || syllabusName(label))
        ? [{ file, title: title || label }]
        : [];
    });
    for (const link of fileLinks) addFile(link.file, link.title, via, priority + 5, true);
    const hasEvidence = Object.values(result.evidence).some((matches) => matches.length);
    if (
      hasEvidence ||
      (!fileLinks.length && syllabusName(title) && result.text.trim().length > 400)
    )
      add(`page:${url}`, {
        kind: 'page',
        title,
        url,
        via,
        priority,
        text: result.text,
        evidence: result.evidence,
      });
  }
  if (course.syllabus_body)
    await addPage(
      'Canvas Syllabus',
      course.syllabus_body,
      web + '/assignments/syllabus',
      'Canvas Syllabus',
      120,
    );
  const slugs = new Map();
  for (const module of modules) {
    if (module.state === 'locked' || module.locked_for_user || module.published === false) continue;
    for (const item of module.items) {
      if (item.published === false || item.locked_for_user || item.content_details?.locked_for_user)
        continue;
      const via = 'Module: ' + plain(module.name, 120);
      if (item.type === 'File' && item.content_id && syllabusName(item.title))
        addFile(item.content_id, item.title, via, 110, true);
      if (
        item.type === 'Page' &&
        pageSlug(item.page_url) &&
        (syllabusName(item.title) ||
          /^(?:start here|course (?:resources|information|overview))\b/i.test(item.title))
      )
        slugs.set(item.page_url, { via, priority: syllabusName(item.title) ? 105 : 75 });
    }
  }
  for (const entry of pages) {
    if (
      entry.published !== false &&
      pageSlug(entry.url) &&
      syllabusName(entry.title) &&
      !slugs.has(entry.url)
    )
      slugs.set(entry.url, { via: 'Canvas Pages', priority: 80 });
  }
  for (const [slug, info] of [...slugs.entries()]
    .sort((a, b) => b[1].priority - a[1].priority)
    .slice(0, 5)) {
    const page = await optionalPage(`${base}/pages/${slug}`, 'A possible syllabus page');
    if (page && page.published !== false && !page.locked_for_user)
      await addPage(
        plain(page.title, 220),
        page.body,
        `${web}/pages/${slug}`,
        info.via,
        info.priority,
      );
  }
  if (!candidates.size) {
    const front = await optionalPage(`${base}/front_page`, 'Course home page');
    if (front && front.published !== false && !front.locked_for_user && pageSlug(front.url))
      await addPage(
        plain(front.title, 220),
        front.body,
        `${web}/pages/${front.url}`,
        'Course home page',
        65,
      );
  }
  for (const file of files) {
    const title = file.display_name || file.filename;
    if (file.id && !file.hidden_for_user && !file.locked_for_user && syllabusName(title))
      addFile(file.id, title, 'Course Files', 55);
  }
  return {
    candidates: [...candidates.values()].sort((a, b) => b.priority - a.priority).slice(0, 6),
    coverage: coverage([...new Set(reasons)]),
  };
}
export async function getCanvasReading(token, courseId, fileId, options = {}) {
  return readCourseFile(token, courseId, fileId, options, 'reading');
}
export async function getCanvasSyllabusFile(token, courseId, fileId, options = {}) {
  return readCourseFile(token, courseId, fileId, options, 'syllabus');
}
export async function getCanvasStudyFile(token, courseId, fileId, options = {}) {
  return readCourseFile(token, courseId, fileId, options, 'study');
}
export async function listCanvasExportFiles(token, courseId, options = {}) {
  const cid = id(courseId);
  const reasons = [];
  const files = await optionalCollection(
    token,
    options,
    reasons,
  )(`/api/v1/courses/${cid}/files`, 'Course files');
  return {
    files: files.map((file) => {
      const fid = id(file.id);
      return {
        fileId: fid,
        title: plain(file.display_name || file.filename, 200),
        url: `${CANVAS_ORIGIN}/courses/${cid}/files/${fid}`,
        locked: Boolean(file.locked_for_user || file.locked || file.hidden_for_user || file.hidden),
      };
    }),
    coverage: coverage(reasons),
  };
}
export async function getCanvasExportFile(token, courseId, fileId, options = {}) {
  return readCourseFile(token, courseId, fileId, options, 'export');
}
async function readCourseFile(token, courseId, fileId, options, purpose) {
  const syllabus = purpose === 'syllabus';
  const exporting = purpose === 'export';
  const cid = id(courseId);
  const fid = id(fileId);
  const { data } = await request(token, `/api/v1/courses/${cid}/files/${fid}`, options);
  if (exporting && String(data.id) !== fid)
    throw new CanvasError('invalid_response', 'Canvas returned a different file.', 422);
  if (
    data.locked_for_user ||
    data.locked ||
    (!syllabus && data.hidden_for_user) ||
    (exporting && data.hidden)
  )
    throw new CanvasError('locked', 'This file is locked or hidden in Canvas.', 403);
  if (syllabus && data.hidden_for_user) {
    // A hidden-in-Files item must have a fresh student-visible syllabus link in this course.
    const { candidates } = await readCanvasSyllabus(token, cid, options);
    if (!candidates.some((source) => source.fileId === fid && source.linked))
      throw new CanvasError('locked', 'Canvas did not expose a syllabus link to this file.', 403);
  }
  const mime = plain(data['content-type'] || data.content_type, 100)
    .split(';')[0]
    .trim()
    .toLowerCase();
  if (
    !(exporting
      ? Object.hasOwn(ARCHIVE_FILE_EXTENSIONS, mime)
      : [
          'application/pdf',
          'text/plain',
          'application/vnd.openxmlformats-officedocument.presentationml.presentation',
          ...(purpose !== 'reading' ? [CANVAS_WORD_MIME] : []),
          ...(purpose === 'study' ? ['text/html'] : []),
        ].includes(mime))
  )
    throw new CanvasError(
      'unsupported_type',
      exporting
        ? 'This file type is available as a Canvas reference.'
        : 'This reader supports PDF, PowerPoint (.pptx) and plain-text files. Other formats need their original application.',
      422,
    );
  if (
    Number(data.size) > FILE_LIMIT ||
    (!exporting && mime === CANVAS_WORD_MIME && Number(data.size) > 2 * 1024 * 1024)
  )
    throw new CanvasError('too_large', 'This reading exceeds the 12 MiB limit.', 413);
  if (typeof data.url !== 'string')
    throw new CanvasError('unavailable', 'Canvas did not provide a download for this file.', 422);
  const url = trustedURL(data.url);
  if (!new RegExp(`^/(?:courses/${cid}/)?files/${fid}/download/?$`).test(url.pathname))
    throw new CanvasError('unsafe_url', 'This download must be opened directly in Canvas.', 422);
  const { bytes, response } = await downloadCanvasFile(token, url, {
    ...options,
    courseId: cid,
    fileId: fid,
    ...(exporting ? { accept: `${mime},application/octet-stream` } : {}),
  });
  const actual = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (actual && actual !== mime && actual !== 'application/octet-stream')
    throw new CanvasError('unsupported_type', 'Canvas returned an unexpected file type.', 422);
  if (mime === 'application/pdf' && new TextDecoder().decode(bytes.subarray(0, 5)) !== '%PDF-')
    throw new CanvasError('invalid_file', 'Canvas did not return a valid PDF.', 422);
  if (
    (mime === 'application/vnd.openxmlformats-officedocument.presentationml.presentation' ||
      (exporting && mime.startsWith('application/vnd.openxmlformats-officedocument.'))) &&
    (bytes.length < 4 ||
      bytes[0] !== 0x50 ||
      bytes[1] !== 0x4b ||
      bytes[2] !== 0x03 ||
      bytes[3] !== 0x04)
  )
    throw new CanvasError(
      'invalid_file',
      exporting
        ? 'Canvas did not return a valid Office archive.'
        : 'Canvas did not return a valid PowerPoint archive.',
      422,
    );
  return { name: plain(data.display_name || data.filename || 'Reading', 200), mime, bytes };
}
