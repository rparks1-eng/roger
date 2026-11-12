import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';

const MAX_ASSETS = 128;
const MAX_BYTES = 32 * 1024 * 1024;
const MAX_LIFETIME = 20 * 60_000;
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
const BANNER = `<aside role="status" aria-label="App preview notice" style="position:fixed;z-index:2147483647;bottom:8px;left:50%;transform:translateX(-50%);padding:10px 18px;border:1px solid #335d48;border-radius:24px;background:#173f32;color:#fff;font:600 12px/1.5 system-ui;max-width:90vw;text-align:center;pointer-events:none">Preview · sample courses · changes not applied</aside>`;
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

function sampleData() {
  const now = new Date();
  const date = (offset) => {
    const value = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset, 23, 59);
    return value.toISOString();
  };
  const courses = [
    ['AI Development', 'DEMO101'],
    ['Financial Modeling', 'DEMO102'],
    ['Literature', 'DEMO103'],
    ['Creative Writing', 'DEMO104'],
  ].map(([name, code], index) => ({ id: String(index + 1), name, code, termId: 'preview' }));
  const assignments = (courseId) => [
    {
      id: `${courseId}01`,
      name: 'Practice assignment',
      dueAt: date(0),
      status: 'unsubmitted',
      submitted: false,
      locked: false,
      points: 20,
    },
    {
      id: `${courseId}02`,
      name: 'Previous exercise',
      dueAt: date(-2),
      status: 'missing',
      submitted: false,
      locked: false,
      points: 10,
    },
    {
      id: `${courseId}03`,
      name: 'Exam review',
      dueAt: date(7),
      status: 'unsubmitted',
      submitted: false,
      locked: false,
      points: 30,
    },
    {
      id: `${courseId}04`,
      name: 'Completed exercise',
      dueAt: date(-1),
      status: 'submitted',
      submitted: true,
      locked: false,
      points: 10,
    },
  ];
  const instructions = (record) => ({
    ...record,
    descriptionHtml:
      '<p>This is a sample assignment for testing app changes. Read the instructions, compare examples, and explain your reasoning.</p>',
    submissionTypes: [],
    canSubmit: false,
  });
  return { courses, assignments, instructions };
}

/** Serves captured browser code, never a workspace or a live account adapter. */
export async function createAppPreview({
  files,
  onOpen = () => {},
  lifetimeMs = MAX_LIFETIME,
} = {}) {
  const assets = snapshotAssets(files);
  if (!Number.isSafeInteger(lifetimeMs) || lifetimeMs < 1 || lifetimeMs > MAX_LIFETIME)
    throw new Error('Preview lifetime must be within twenty minutes.');
  const entryToken = randomBytes(32).toString('hex');
  const cookieToken = randomBytes(32).toString('hex');
  const cookieName = COOKIE_NAME;
  const csrf = randomBytes(24).toString('hex');
  const { courses, assignments, instructions } = sampleData();
  let origin = '',
    windowStart = Date.now(),
    requests = 0,
    closing,
    expiry;
  const server = createServer({ maxHeaderSize: 16_384 }, (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Security-Policy', CSP);
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
    if (req.method !== 'GET' && req.method !== 'HEAD')
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
        const html = asset.bytes.toString('utf8');
        res.end(
          /<\/body\s*>/i.test(html)
            ? html.replace(/<\/body\s*>/i, BANNER + '</body>')
            : html + BANNER,
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
      '/api/session': { csrf, canvas: { name: 'Sample student' }, ephemeral: true, preview: true },
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
            items: [
              { title: 'Review notes', type: 'Page', pageUrl: 'review-notes', locked: false },
            ],
          },
        ],
      });
    if (url.pathname === '/api/canvas/assignment') {
      const record = assignments(courseId).find(
        (item) => item.id === url.searchParams.get('assignmentId'),
      );
      return record
        ? json({ assignment: instructions(record) })
        : fail(404, 'Sample assignment not found.');
    }
    if (url.pathname === '/api/canvas/study-assignments') {
      const ids = url.searchParams.getAll('assignmentId');
      return json({
        assignments: assignments(courseId)
          .filter((item) => ids.includes(item.id))
          .map(instructions),
        unavailable: [],
      });
    }
    if (url.pathname === '/api/canvas/syllabus')
      return json({
        candidates: [],
        issues: ['Syllabus files are not connected in this sample preview.'],
      });
    if (url.pathname === '/api/canvas/page')
      return json({
        page: {
          title: 'Review notes',
          bodyHtml:
            '<p>Sample reading notes. This preview contains no personal course material.</p>',
          url: '',
        },
      });
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
    expiry = setTimeout(() => void close(), lifetimeMs);
    expiry.unref();
    return { url: `${origin}/?preview=${entryToken}`, close };
  } catch (error) {
    await close();
    throw error;
  }
}
