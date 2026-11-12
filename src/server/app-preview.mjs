import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { answerDemo, demoAssignment, demoCourse, demoCourses, demoPages } from './demo-answers.mjs';
import { assertMutation, HttpError, readJson } from './security.mjs';

const MAX_ASSETS = 128;
const MAX_BYTES = 32 * 1024 * 1024;
const MAX_LIFETIME = 20 * 60_000;
const RECORDING_LIFETIME = 2 * 60 * 60_000;
// Reuse the name within this process so repeated previews cannot fill the cookie jar.
const COOKIE_NAME = `roger_preview_${randomBytes(8).toString('hex')}`;
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' blob: data:",
  "media-src 'self' blob:",
  "connect-src 'self' blob:",
  "font-src 'self' blob: data:",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-src 'none'",
  "frame-ancestors 'none'",
  'sandbox allow-scripts allow-same-origin',
].join('; ');
function banner(recording) {
  const label = recording
    ? 'Demo mode · fictional courses and assignments'
    : 'Preview · sample courses · changes not applied';
  return `<aside role="status" aria-label="App preview notice" style="position:fixed;z-index:2147483647;bottom:8px;left:50%;transform:translateX(-50%);padding:10px 18px;border:1px solid #335d48;border-radius:24px;background:#173f32;color:#fff;font:600 12px/1.5 system-ui;max-width:90vw;text-align:center;pointer-events:none">${label}</aside>`;
}
const equal = (left, right) =>
  typeof left === 'string' &&
  Buffer.byteLength(left) === Buffer.byteLength(right) &&
  timingSafeEqual(Buffer.from(left), Buffer.from(right));

function snapshotAssets(input) {
  if (!(input instanceof Map) || !input.has('/') || input.size > MAX_ASSETS)
    throw new Error('A bounded captured app is required for preview.');
  const result = new Map();
  let bytes = 0;
  for (const [url, asset] of input) {
    if (
      typeof url !== 'string' ||
      !/^\/(?:[\w.-]+\/)*[\w.-]*$/.test(url) ||
      url.split('/').some((part) => part === '.' || part === '..') ||
      url.startsWith('/api/') ||
      !asset ||
      !(asset.bytes instanceof Uint8Array) ||
      typeof asset.mime !== 'string' ||
      !/^(?:text\/(?:html|css|javascript|plain)|application\/(?:javascript|json)|image\/(?:png|jpeg|webp|svg\+xml)|font\/(?:woff2?|ttf))(?:; charset=utf-8)?$/.test(
        asset.mime,
      )
    )
      throw new Error('Preview assets must be captured public files with fixed URLs and types.');
    bytes += asset.bytes.byteLength;
    if (bytes > MAX_BYTES) throw new Error('The captured preview exceeds its size limit.');
    result.set(url, { bytes: Buffer.from(asset.bytes), mime: asset.mime });
  }
  if (!result.get('/').mime.startsWith('text/html'))
    throw new Error('Preview needs an HTML entry.');
  return result;
}

function sampleData(recording) {
  const now = new Date();
  const date = (offset) => {
    const value = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset, 23, 59);
    return value.toISOString();
  };
  const previewCourses = [
    ['AI Development', 'DEMO101'],
    ['Financial Modeling', 'DEMO102'],
    ['Literature', 'DEMO103'],
    ['Creative Writing', 'DEMO104'],
  ];
  const courseList = recording ? demoCourses.map(({ name, code }) => [name, code]) : previewCourses;
  const courses = courseList.map(([name, code], index) => ({
    id: String(index + 1),
    name,
    code,
    termId: 'preview',
  }));
  const assignments = (courseId) => [
    {
      id: `${courseId}01`,
      name: recording ? demoAssignment(courseId, 1)[0] : 'Practice assignment',
      dueAt: date(recording ? Number(courseId) - 1 : 0),
      status: 'unsubmitted',
      submitted: false,
      locked: false,
      points: 20,
    },
    {
      id: `${courseId}02`,
      name: recording ? demoAssignment(courseId, 2)[0] : 'Previous exercise',
      dueAt: date(-2),
      status: recording ? 'submitted' : 'missing',
      submitted: recording,
      locked: false,
      points: 10,
    },
    {
      id: `${courseId}03`,
      name: recording ? demoAssignment(courseId, 3)[0] : 'Exam review',
      dueAt: date(7),
      status: 'unsubmitted',
      submitted: false,
      locked: false,
      points: 30,
    },
    {
      id: `${courseId}04`,
      name: recording ? demoAssignment(courseId, 4)[0] : 'Completed exercise',
      dueAt: date(-1),
      status: 'submitted',
      submitted: true,
      locked: false,
      points: 10,
    },
  ];
  const instructions = (record, courseId) => ({
    ...record,
    descriptionHtml: `<p>${
      recording
        ? demoAssignment(courseId, Number(record.id.at(-1)))[1]
        : 'This is a sample assignment. Read the instructions, compare examples, and explain your reasoning.'
    }</p>`,
    submissionTypes: [],
    canSubmit: false,
  });
  return { courses, assignments, instructions };
}

/** Serves captured browser code, never a workspace or a live account adapter. */
export async function createAppPreview({
  files,
  onOpen = () => {},
  recording = false,
  lifetimeMs = recording ? RECORDING_LIFETIME : MAX_LIFETIME,
} = {}) {
  const assets = snapshotAssets(files);
  const maximum = recording ? RECORDING_LIFETIME : MAX_LIFETIME;
  if (!Number.isSafeInteger(lifetimeMs) || lifetimeMs < 1 || lifetimeMs > maximum)
    throw new Error(
      recording
        ? 'Recording sessions can last up to two hours.'
        : 'Preview lifetime must be within twenty minutes.',
    );
  const entryToken = randomBytes(32).toString('hex');
  const cookieToken = randomBytes(32).toString('hex');
  const cookieName = recording ? `${COOKIE_NAME}_demo` : COOKIE_NAME;
  const csrf = randomBytes(24).toString('hex');
  const { courses, assignments, instructions } = sampleData(recording);
  const notice = banner(recording);
  let origin = '',
    windowStart = Date.now(),
    requests = 0,
    closing,
    expiry;
  const server = createServer({ maxHeaderSize: 16_384 }, async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    // Demo forms can dispatch submit events. The form-action rule still blocks browser navigation.
    res.setHeader('Content-Security-Policy', recording ? CSP + ' allow-forms' : CSP);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
    const json = (value, code = 200) => {
      res.statusCode = code;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(value));
    };
    const fail = (code, message) => {
      res.shouldKeepAlive = false;
      json({ error: message, preview: true }, code);
      req.resume();
    };
    if (req.headers.host !== origin.slice(7)) return fail(421, 'Unrecognized preview address.');
    if (
      req.url.length > 2048 ||
      /[\\]|%2e|%2f|%5c/i.test(req.url) ||
      [...req.url].some((char) => char.charCodeAt(0) <= 32)
    )
      return fail(400, 'Invalid preview path.');
    const url = new URL(req.url, origin);
    if (url.origin !== origin) return fail(400, 'Invalid preview path.');
    if (Date.now() - windowStart >= 60_000) {
      windowStart = Date.now();
      requests = 0;
    }
    if (++requests > 360) return fail(429, 'Preview request limit reached. Reload in a minute.');
    const asking = recording && req.method === 'POST' && url.pathname === '/api/demo/ask';
    if (!asking && req.method !== 'GET' && req.method !== 'HEAD')
      return fail(
        403,
        'This preview cannot connect accounts, use AI, submit work, or modify files.',
      );
    if (req.headers.origin && req.headers.origin !== origin)
      return fail(403, 'Open this preview in its own tab.');
    const cookie = (req.headers.cookie || '')
      .split(';')
      .map((part) => part.trim())
      .find((part) => part.startsWith(`${cookieName}=`))
      ?.slice(cookieName.length + 1);
    const entry = url.pathname === '/' && equal(url.searchParams.get('preview'), entryToken);
    if (!entry && !equal(cookie, cookieToken))
      return fail(401, 'Open the current app preview link.');
    if (asking) {
      try {
        assertMutation(req, { csrf });
        const body = await readJson(req, 8192);
        const { message, courseId = '', assignmentId = '' } = body ?? {};
        if (
          typeof message !== 'string' ||
          !message.trim() ||
          message.length > 2000 ||
          typeof courseId !== 'string' ||
          !/^[1-4]?$/.test(courseId) ||
          typeof assignmentId !== 'string' ||
          !/^(?:[1-4]0[1-4])?$/.test(assignmentId)
        )
          return fail(400, 'Ask a short question about the demo materials.');
        return json(answerDemo({ message, courseId, assignmentId }, assignments));
      } catch (error) {
        return fail(
          error instanceof HttpError ? error.status : 500,
          'Demo question could not be read.',
        );
      }
    }
    if (entry)
      res.setHeader(
        'Set-Cookie',
        `${cookieName}=${cookieToken}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.ceil(lifetimeMs / 1000)}`,
      );
    if (assets.has(url.pathname)) {
      const asset = assets.get(url.pathname);
      res.setHeader('Content-Type', asset.mime);
      if (req.method === 'HEAD') return res.end();
      if (url.pathname === '/') {
        let html = asset.bytes.toString('utf8');
        if (recording)
          html = html.replace(/<title>[^<]*<\/title>/i, '<title>Roger Demo mode</title>');
        if (recording && entry) res.setHeader('Clear-Site-Data', '"storage"');
        res.end(
          /<\/body\s*>/i.test(html)
            ? html.replace(/<\/body\s*>/i, notice + '</body>')
            : html + notice,
        );
        try {
          onOpen();
        } catch {
          // Preview rendering must not expose a callback failure to generated code.
        }
      } else res.end(asset.bytes);
      return;
    }
    if (url.pathname === '/favicon.ico') {
      res.statusCode = 204;
      res.end();
      return;
    }
    const fixed = {
      '/api/session': {
        csrf,
        canvas: { name: 'Sample student' },
        ephemeral: true,
        preview: true,
        ...(recording ? { recording: true } : {}),
      },
      '/api/connections': { selected: null, providers: [] },
      '/api/providers': { providers: [] },
      '/api/documents/status': { ocr: { available: false } },
      '/api/narration/status': { available: false, voices: [] },
      '/api/memory/settings': { paused: true, preview: true, threadCount: 0, storageBytes: 0 },
      '/api/memory/threads': { threads: [], total: 0, hasMore: false, nextOffset: null },
      '/api/memory/pins': { pins: [] },
      '/api/features': { features: [] },
      '/api/app-changes': { draft: null, canUndo: false },
      '/api/canvas/courses': {
        courses,
        terms: [{ id: 'preview', name: 'Sample semester' }],
        currentTermId: 'preview',
      },
    };
    if (Object.hasOwn(fixed, url.pathname)) return json(fixed[url.pathname]);
    const courseId = url.searchParams.get('courseId') || url.searchParams.get('id');
    const course = courses.find((item) => item.id === courseId);
    if (url.pathname === '/api/canvas/assignments') {
      const ids = url.searchParams.getAll('courseId');
      return json({
        courses: courses
          .filter((item) => !ids.length || ids.includes(item.id))
          .map((item) => ({ courseId: item.id, assignments: assignments(item.id) })),
      });
    }
    if (url.pathname.startsWith('/api/canvas/') && !course)
      return fail(404, 'This sample course is not available in the preview.');
    if (url.pathname === '/api/canvas/course')
      return json({
        course,
        assignments: assignments(courseId),
        modules: [
          {
            id: `module-${courseId}`,
            name: 'Sample materials',
            locked: false,
            items: (recording
              ? demoPages(demoCourse(courseId))
              : [{ title: 'Review notes', pageUrl: 'review-notes' }]
            ).map(({ title, pageUrl }) => ({ title, type: 'Page', pageUrl, locked: false })),
          },
        ],
      });
    if (url.pathname === '/api/canvas/assignment') {
      const record = assignments(courseId).find(
        (item) => item.id === url.searchParams.get('assignmentId'),
      );
      return record
        ? json({ assignment: instructions(record, courseId) })
        : fail(404, 'Sample assignment not found.');
    }
    if (['/api/canvas/community', '/api/canvas/topic'].includes(url.pathname)) {
      const section = url.searchParams.get('section');
      const groupId = url.searchParams.get('groupId');
      const group = {
        id: `71${courseId}`,
        name: 'Studio team',
        description: 'A fictional student project group.',
        memberCount: 4,
      };
      if (section === 'groups' && groupId === null && url.pathname === '/api/canvas/community')
        return json({ groups: [group] });
      if (!['announcements', 'discussions'].includes(section) || (groupId && groupId !== group.id))
        return fail(404, 'Sample course section not found.');
      const announcement = section === 'announcements';
      const topic = {
        id: `${courseId}${groupId ? '2' : '1'}${announcement ? '1' : '2'}`,
        title: announcement ? 'Materials for the next class' : 'Share a first observation',
        author: 'Sample instructor',
        postedAt: new Date().toISOString(),
      };
      if (url.pathname === '/api/canvas/community')
        return json({ group: groupId ? group : null, topics: [topic] });
      if (url.searchParams.get('topicId') !== topic.id) return fail(404, 'Sample topic not found.');
      return json({
        topic: {
          ...topic,
          bodyHtml: announcement
            ? '<p>Read the review notes in this week’s module before class.</p>'
            : '<p>Choose one detail from the course materials and explain what it helps you understand.</p>',
          attachments: [],
        },
        replies: announcement
          ? []
          : [
              {
                id: '1',
                author: 'Sample student',
                bodyHtml: '<p>I compared the first example with my notes.</p>',
                replies: [
                  {
                    id: '2',
                    author: 'Sample teammate',
                    bodyHtml: '<p>Which detail helped you see the difference?</p>',
                    replies: [],
                  },
                ],
              },
            ],
      });
    }
    if (url.pathname === '/api/canvas/study-assignments') {
      const ids = url.searchParams.getAll('assignmentId');
      return json({
        assignments: assignments(courseId)
          .filter((item) => ids.includes(item.id))
          .map((record) => instructions(record, courseId)),
        unavailable: [],
      });
    }
    if (url.pathname === '/api/canvas/syllabus')
      return json({
        candidates: [],
        issues: ['Syllabus files are not connected in this sample preview.'],
      });
    if (url.pathname === '/api/canvas/page') {
      if (recording) {
        const page = demoPages(demoCourse(courseId)).find(
          ({ pageUrl }) => pageUrl === url.searchParams.get('pageUrl'),
        );
        if (!page) return fail(404, 'Sample course page not found.');
        return json({
          page: {
            title: page.title,
            bodyHtml: page.paragraphs.map((text) => `<p>${text}</p>`).join(''),
            url: '',
          },
        });
      }
      return json({
        page: {
          title: 'Review notes',
          bodyHtml:
            '<p>Sample reading notes. This preview contains no personal course material.</p>',
          url: '',
        },
      });
    }
    fail(
      403,
      'This action needs the real app. The preview only uses sample courses and has no account access.',
    );
  });
  server.maxConnections = 32;
  server.maxRequestsPerSocket = 120;
  server.headersTimeout = 5_000;
  server.requestTimeout = 10_000;
  server.keepAliveTimeout = 2_000;
  server.setTimeout(10_000, (socket) => socket.destroy());
  const close = () => {
    if (closing) return closing;
    clearTimeout(expiry);
    closing = new Promise((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
      assets.clear();
    });
    return closing;
  };
  try {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    // A distinct hostname keeps parent 127.0.0.1 cookies out of the preview.
    origin = `http://localhost:${server.address().port}`;
    const expiresAt = Date.now() + lifetimeMs;
    expiry = setTimeout(() => void close(), lifetimeMs);
    expiry.unref();
    return { url: `${origin}/?preview=${entryToken}`, close, expiresAt };
  } catch (error) {
    await close();
    throw error;
  }
}
