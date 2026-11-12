import { randomBytes, timingSafeEqual } from 'node:crypto';
export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const exact = (a, b) =>
  typeof a === 'string' &&
  typeof b === 'string' &&
  Buffer.byteLength(a) === Buffer.byteLength(b) &&
  timingSafeEqual(Buffer.from(a), Buffer.from(b));
export function createSessions({ clock = Date.now, onDispose = () => {} } = {}) {
  const sessions = new Map();
  function sweep() {
    for (const [id, s] of sessions) {
      if (clock() - s.touched > 30 * 60_000) {
        sessions.delete(id);
        onDispose(s);
      }
    }
  }
  const expiry = setInterval(sweep, 30_000);
  expiry.unref();
  return {
    get(req, res, create = false) {
      sweep();
      const id = /(?:^|;\s*)reader_session=([a-f0-9]{64})(?:;|$)/.exec(
        req.headers.cookie ?? '',
      )?.[1];
      let value = id && sessions.get(id);
      if (!value && create) {
        if (sessions.size >= 8)
          throw new HttpError(
            429,
            'Too many local sessions. Close unused windows and retry later.',
          );
        const next = randomBytes(32).toString('hex');
        value = {
          csrf: randomBytes(24).toString('hex'),
          token: null,
          profile: null,
          touched: clock(),
          requests: [],
          active: false,
        };
        sessions.set(next, value);
        res.setHeader(
          'Set-Cookie',
          `reader_session=${next}; HttpOnly; SameSite=Strict; Path=/; Max-Age=1800`,
        );
      }
      if (!value) throw new HttpError(401, 'Reload Atlas Reader to start a local session.');
      value.touched = clock();
      return value;
    },
    clear() {
      clearInterval(expiry);
      for (const session of sessions.values()) onDispose(session);
      sessions.clear();
    },
  };
}
export function assertHost(req) {
  const port = req.socket.localPort;
  if (![`127.0.0.1:${port}`, `localhost:${port}`].includes(req.headers.host))
    throw new HttpError(421, 'Unrecognized local address.');
}
export function assertMutation(req, session, { binary = false } = {}) {
  if (
    req.headers.origin !== `http://${req.headers.host}` ||
    !exact(req.headers['x-reader-csrf'], session.csrf)
  )
    throw new HttpError(403, 'Reload this page before making that request.');
  if (
    !(binary ? /^application\/octet-stream(?:\s*;|$)/i : /^application\/json(?:\s*;|$)/i).test(
      req.headers['content-type'] ?? '',
    )
  )
    throw new HttpError(415, binary ? 'Use a document upload request.' : 'Use a JSON request.');
}
export async function readBinary(req, limit = 12 * 1024 * 1024, signal) {
  if (signal?.aborted) throw new HttpError(408, 'The request timed out.');
  const bodySignal = signal
    ? AbortSignal.any([signal, AbortSignal.timeout(10_000)])
    : AbortSignal.timeout(10_000);
  const abort = () => req.destroy();
  bodySignal.addEventListener('abort', abort, { once: true });
  let size = 0;
  const parts = [];
  try {
    for await (const part of req) {
      size += part.length;
      if (size > limit) throw new HttpError(413, 'Choose a document under 12 MB.');
      parts.push(part);
    }
  } finally {
    bodySignal.removeEventListener('abort', abort);
  }
  return Buffer.concat(parts);
}
export async function readJson(req, limit = 65_536, signal) {
  if (signal?.aborted) throw new HttpError(408, 'The request timed out.');
  const bodySignal = signal
    ? AbortSignal.any([signal, AbortSignal.timeout(10_000)])
    : AbortSignal.timeout(10_000);
  const abort = () => req.destroy();
  bodySignal.addEventListener('abort', abort, { once: true });
  let size = 0;
  const parts = [];
  try {
    for await (const part of req) {
      size += part.length;
      if (size > limit) throw new HttpError(413, 'This request is too large.');
      parts.push(part);
    }
  } finally {
    bodySignal.removeEventListener('abort', abort);
  }
  try {
    return JSON.parse(Buffer.concat(parts).toString('utf8'));
  } catch {
    throw new HttpError(400, 'This request could not be read.');
  }
}
export function admit(session, clock = Date.now, bucket = 'default') {
  const exclusive = !['featureRead', 'memoryRead'].includes(bucket);
  if (exclusive && session.active)
    throw new HttpError(429, 'Wait for the current request or cancel it.');
  const key =
    bucket === 'courseRead'
      ? 'courseRequests'
      : bucket === 'memoryRead'
        ? 'memoryReads'
        : bucket === 'generation'
          ? 'generationRequests'
          : bucket === 'ui'
            ? 'uiRequests'
            : 'requests';
  session[key] = (session[key] || []).filter((at) => at > clock() - 60_000);
  if (
    session[key].length >=
    (['courseRead', 'memoryRead'].includes(bucket) ? 180 : bucket === 'ui' ? 60 : 20)
  )
    throw new HttpError(429, 'Too many requests. Wait a minute.');
  session[key].push(clock());
  if (exclusive) session.active = true;
  return () => {
    if (exclusive) session.active = false;
  };
}
