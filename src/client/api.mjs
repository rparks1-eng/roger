let session;
let pending = Promise.resolve();
// The local server admits one expensive request per session. Serialize browser
// calls here so navigation and boot checks cannot race each other into a 429.
function enqueue(operation, signal) {
  const next = pending.then(() => {
    signal?.throwIfAborted();
    return operation();
  });
  pending = next.catch(() => {});
  return next;
}
export async function initialize() {
  const result = await fetch('/api/session', { credentials: 'same-origin', cache: 'no-store' });
  if (!result.ok) throw new Error('Reload Atlas Reader to reconnect.');
  session = await result.json();
  return session;
}
export function isPreviewSession() {
  return session?.preview === true;
}
export function api(url, options = {}) {
  // These bounded local reads have a separate server admission lane. A model
  // response or optional account check must not block opening saved work.
  if (
    options.body === undefined &&
    /^\/api\/memory\/(?:settings|threads|thread|pins)(?:\?|$)/.test(url)
  )
    return request(url, options);
  return enqueue(() => request(url, options), options.signal);
}
async function request(url, { body, signal, binary = false } = {}, attempt = 0) {
  signal?.throwIfAborted();
  const response = await fetch(url, {
    method: body === undefined ? 'GET' : 'POST',
    headers:
      body === undefined
        ? {}
        : { 'Content-Type': 'application/json', 'X-Reader-CSRF': session?.csrf ?? '' },
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: 'same-origin',
    cache: 'no-store',
    redirect: 'error',
    signal,
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    if (
      response.status === 429 &&
      error.error === 'Wait for the current request or cancel it.' &&
      attempt < 5
    ) {
      // This exact server admission rejection happens before body processing or
      // any mutation, so retrying it cannot repeat an accepted operation.
      await new Promise((resolve) => setTimeout(resolve, 100 * (attempt + 1)));
      signal?.throwIfAborted();
      return request(url, { body, signal, binary }, attempt + 1);
    }
    throw new Error(error.error ?? 'The request did not complete.');
  }
  return binary
    ? {
        bytes: await response.arrayBuffer(),
        mime: response.headers.get('content-type'),
        name: decodeURIComponent(response.headers.get('x-reader-filename') ?? 'Course file'),
      }
    : response.json();
}
export function uploadDocument(url, bytes, { signal } = {}) {
  return enqueue(() => upload(url, bytes, signal), signal);
}
async function upload(url, bytes, signal) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream', 'X-Reader-CSRF': session?.csrf ?? '' },
    body: bytes,
    credentials: 'same-origin',
    redirect: 'error',
    signal,
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? 'Document processing failed.');
  return result;
}
