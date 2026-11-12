/** Read-only file transport. Babson's observed chain (2026-10-15) is Canvas ->
 * per-file cluster1 user-content host -> IAD file storage -> IAD CDN.
 * Three redirects are required by the observed provider workflow. Never wildcard CDNs.
 * Provider reference: https://community.instructure.com/en/kb/articles/485223-canvas-domain-email-and-server-management
 * Canvas Files API: https://developerdocs.instructure.com/services/canvas/resources/files
 * Signed redirect URLs are credentials: never log them or forward them to clients.
 */
const ORIGIN = 'https://babson.instructure.com';
const LIMIT = 12 * 1024 * 1024;
export const ARCHIVE_FILE_EXTENSIONS = Object.freeze({
  'application/pdf': 'pdf',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'text/plain': 'txt',
  'text/markdown': 'md',
  'text/csv': 'csv',
  'image/jpeg': 'jpg',
  'image/png': 'png',
});
class DownloadError extends Error {
  constructor(code, message, status = 502) {
    super(message);
    this.name = 'CanvasError';
    this.code = code;
    this.status = status;
  }
}
const invalid = () =>
  new DownloadError(
    'unsafe_url',
    'Canvas returned a download host that this reader does not trust.',
    422,
  );
function checkURL(value, base) {
  let url;
  try {
    url = new URL(value, base);
  } catch {
    throw invalid();
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash)
    throw invalid();
  return url;
}
function bounded(operation, signal) {
  return new Promise((resolve, reject) => {
    const abort = () =>
      reject(new DownloadError('aborted', 'Canvas download cancelled or timed out.', 504));
    if (signal.aborted) {
      abort();
      return;
    }
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve()
      .then(operation)
      .then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', abort));
  });
}
export async function downloadCanvasFile(
  token,
  initialURL,
  { courseId, fileId, fetcher = fetch, signal, accept } = {},
) {
  const cid = String(courseId ?? ''),
    fid = String(fileId ?? '');
  if (!/^[1-9]\d{0,15}$/.test(cid) || !/^[1-9]\d{0,15}$/.test(fid)) throw invalid();
  if (
    typeof token !== 'string' ||
    token.length < 10 ||
    token.length > 4096 ||
    !/^[\x21-\x7e]+$/.test(token)
  )
    throw new DownloadError('invalid_token', 'Connect Canvas again.', 400);
  let url = checkURL(initialURL, ORIGIN);
  const filePath = new RegExp(`^/(?:courses/${cid}/)?files/${fid}/download/?$`);
  if (url.origin !== ORIGIN || !filePath.test(url.pathname)) throw invalid();
  const timer = AbortSignal.timeout(12_000),
    combined = signal ? AbortSignal.any([signal, timer]) : timer;
  const seen = new Set();
  try {
    for (let hop = 0; hop <= 3; hop++) {
      if (seen.has(url.href)) throw invalid();
      seen.add(url.href);
      const headers = {
        Accept:
          accept ||
          'application/pdf,application/vnd.openxmlformats-officedocument.presentationml.presentation,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain,application/octet-stream',
      };
      if (hop === 0) headers.Authorization = `Bearer ${token}`;
      const response = await bounded(
        () =>
          fetcher(url.href, {
            method: 'GET',
            headers,
            redirect: 'manual',
            credentials: 'omit',
            referrerPolicy: 'no-referrer',
            signal: combined,
          }),
        combined,
      );
      if (response.url && checkURL(response.url).href !== url.href) {
        void response.body?.cancel().catch(() => {});
        throw invalid();
      }
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location');
        void response.body?.cancel().catch(() => {});
        if (hop === 3 || !location) throw invalid();
        const next = checkURL(location, url);
        const userContent =
          next.hostname === `a1-${fid}.cluster1.canvas-user-content.com` &&
          filePath.test(next.pathname);
        const fileStorage =
          next.hostname === 'inst-fs-iad-prod.inscloudgate.net' &&
          /^\/files\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/[^/]+$/i.test(
            next.pathname,
          );
        const finalCDN =
          next.hostname === 'cdn.inst-fs-iad-prod.inscloudgate.net' &&
          /^\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/[^/]+$/i.test(
            next.pathname,
          );
        // Storage is reachable only after the validated per-file CDN, never from
        // arbitrary initial metadata or via another course/user-content host.
        if (
          !(hop === 0
            ? userContent
            : hop === 1
              ? fileStorage && url.hostname === `a1-${fid}.cluster1.canvas-user-content.com`
              : finalCDN && url.hostname === 'inst-fs-iad-prod.inscloudgate.net')
        )
          throw invalid();
        url = next;
        continue;
      }
      if (!response.ok) {
        void response.body?.cancel().catch(() => {});
        throw new DownloadError(
          'unavailable',
          'Canvas could not provide this course file.',
          response.status === 401 || response.status === 403 ? 403 : 502,
        );
      }
      const length = response.headers.get('content-length');
      if (length && (!/^\d+$/.test(length) || Number(length) > LIMIT)) {
        void response.body?.cancel().catch(() => {});
        throw new DownloadError('too_large', 'This reading exceeds the 12 MiB limit.', 413);
      }
      const reader = response.body?.getReader();
      if (!reader)
        throw new DownloadError('invalid_response', 'Canvas returned an empty course file.');
      let count = 0;
      const chunks = [];
      try {
        while (true) {
          const { done, value } = await bounded(() => reader.read(), combined);
          if (done) break;
          count += value.byteLength;
          if (count > LIMIT)
            throw new DownloadError('too_large', 'This reading exceeds the 12 MiB limit.', 413);
          chunks.push(value);
        }
      } finally {
        void reader.cancel().catch(() => {});
      }
      const bytes = new Uint8Array(count);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return { bytes, response };
    }
    throw invalid();
  } catch (error) {
    if (error instanceof DownloadError) throw error;
    throw new DownloadError(
      combined.aborted ? 'aborted' : 'transport',
      combined.aborted
        ? 'Canvas download cancelled or timed out.'
        : 'The Canvas course file could not be downloaded.',
      combined.aborted ? 504 : 502,
    );
  }
}
