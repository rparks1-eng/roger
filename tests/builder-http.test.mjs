import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import { createFeatureBuilder } from '../src/server/builder.mjs';
import { createReaderServer } from '../src/server/http.mjs';
import { ConnectionError } from '../src/server/connections.mjs';
import { qaScratch } from '../scripts/quality/scratch.mjs';

let scratch;
before(async () => {
  scratch = await qaScratch();
});
after(async () => {
  await scratch.close();
});
async function fixture(t) {
  let now = Date.now(),
    generations = 0;
  const services = [];
  const storagePath = path.join(
    await mkdtemp(path.join(scratch.work, 'feature-http-')),
    'library.json',
  );
  const featureBuilder = createFeatureBuilder({ storagePath, clock: () => now });
  const server = createReaderServer({
    featureBuilder,
    clock: () => now,
    connectionFactory() {
      const record = { connected: false, disposed: false };
      services.push(record);
      return {
        async status() {
          return {
            selected: record.connected ? { provider: 'codex', model: 'account-default' } : null,
            providers: [],
          };
        },
        async connect(value) {
          if (!value.consent) throw new ConnectionError('consent', 'Choose this provider first.');
          record.connected = true;
          return { connected: true };
        },
        disconnect() {
          record.connected = false;
          return { disconnected: true };
        },
        async generate() {
          if (!record.connected)
            throw new ConnectionError('consent', 'Connect this provider first.');
          return {
            text: JSON.stringify({
              title: `Timer ${++generations}`,
              summary: 'A working timer.',
              html: '<!doctype html><html><body><button>Start</button><script>document.querySelector("button").onclick=()=>document.querySelector("button").textContent="Running";</script></body></html>',
            }),
            provider: 'codex',
            model: 'account-default',
          };
        },
        dispose() {
          record.connected = false;
          record.disposed = true;
        },
      };
    },
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  async function send(url, { session, method = 'GET', body, headers = {} } = {}) {
    const response = await fetch(origin + url, {
      method,
      headers: {
        ...(session ? { cookie: session.cookie } : {}),
        ...(method === 'POST'
          ? { origin, 'content-type': 'application/json', 'x-reader-csrf': session?.csrf ?? '' }
          : {}),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    return {
      status: response.status,
      headers: response.headers,
      text,
      json: () => JSON.parse(text),
    };
  }
  async function session() {
    const page = await send('/');
    const cookie = page.headers.get('set-cookie').split(';')[0];
    const value = (await send('/api/session', { session: { cookie } })).json();
    return { cookie, csrf: value.csrf };
  }
  const post = (url, value, body) => send(url, { session: value, method: 'POST', body });
  return {
    send,
    post,
    session,
    services,
    advance: (ms) => {
      now += ms;
    },
  };
}
const request = { request: 'Build an interactive timer', provider: 'codex' };

test('real HTTP build, frame preview, keep, revision and undo preserve session and CSP boundaries', async (t) => {
  const app = await fixture(t),
    session = await app.session(),
    other = await app.session();
  assert.equal((await app.send('/api/features')).status, 401);
  assert.equal((await app.post('/api/features/build', session, request)).status, 403);
  assert.equal(
    (await app.post('/api/connections/connect', session, { provider: 'codex', consent: true }))
      .status,
    200,
  );
  const denied = await app.send('/api/features/build', {
    session,
    method: 'POST',
    body: request,
    headers: { 'x-reader-csrf': 'wrong' },
  });
  assert.equal(denied.status, 403);
  const draft = await app.post('/api/features/build', session, request);
  assert.equal(draft.status, 200);
  const artifact = draft.json();
  const previewUrl = `/api/features/preview?draftId=${artifact.draftId}`;
  assert.equal(
    (await app.send(previewUrl, { session: other, headers: { 'sec-fetch-dest': 'iframe' } }))
      .status,
    404,
  );
  assert.equal((await app.send(previewUrl, { session })).status, 403);
  const preview = await app.send(previewUrl, { session, headers: { 'sec-fetch-dest': 'iframe' } });
  assert.equal(preview.status, 200);
  assert.match(preview.headers.get('content-security-policy'), /sandbox allow-scripts/);
  assert.match(preview.headers.get('content-security-policy'), /connect-src 'none'/);
  assert.match(preview.headers.get('content-security-policy'), /form-action 'none'/);
  assert.doesNotMatch(preview.headers.get('content-security-policy'), /allow-same-origin/);
  assert.equal(preview.headers.get('cache-control'), 'no-store');
  assert.equal(preview.headers.get('x-dns-prefetch-control'), 'off');
  assert.match(preview.text, /onclick/);
  assert.equal(
    (await app.post('/api/features/keep', other, { draftId: artifact.draftId })).status,
    404,
  );
  const saved = (
    await app.post('/api/features/keep', session, { draftId: artifact.draftId })
  ).json();
  assert.equal(saved.version, 1);
  assert.equal((await app.send('/api/features', { session })).json().features.length, 1);
  assert.equal(
    (
      await app.send(`/api/features/view?id=${saved.id}`, {
        session,
        headers: { 'sec-fetch-dest': 'iframe' },
      })
    ).status,
    200,
  );
  const changed = (
    await app.post('/api/features/build', session, {
      ...request,
      featureId: saved.id,
      baseVersion: 1,
    })
  ).json();
  const second = (
    await app.post('/api/features/keep', session, { draftId: changed.draftId })
  ).json();
  assert.equal(second.version, 2);
  const restored = (
    await app.post('/api/features/undo', session, { id: saved.id, baseVersion: 2 })
  ).json();
  assert.equal(restored.title, saved.title);
  assert.equal(restored.version, 3);
});

test('provider connection and disconnect are isolated to the browser session', async (t) => {
  const app = await fixture(t),
    a = await app.session(),
    b = await app.session();
  await app.post('/api/connections/connect', a, { provider: 'codex', consent: true });
  assert.equal((await app.post('/api/features/build', b, request)).status, 403);
  assert.equal((await app.post('/api/features/build', a, request)).status, 200);
  await app.post('/api/connections/disconnect', a, { provider: 'codex' });
  const result = await app.post('/api/features/build', a, request);
  assert.equal(result.status, 403);
  assert.match(result.json().error, /Connect/);
});

test('expired sessions dispose provider access and cannot reopen private previews', async (t) => {
  const app = await fixture(t),
    session = await app.session();
  await app.post('/api/connections/connect', session, { provider: 'codex', consent: true });
  const draft = (await app.post('/api/features/build', session, request)).json();
  app.advance(31 * 60_000);
  assert.equal((await app.send('/api/connections', { session })).status, 401);
  assert.equal(app.services[0].disposed, true);
  assert.equal(app.services[0].connected, false);
  const fresh = await app.session();
  assert.equal(
    (
      await app.send(`/api/features/preview?draftId=${draft.draftId}`, {
        session: fresh,
        headers: { 'sec-fetch-dest': 'iframe' },
      })
    ).status,
    404,
  );
});
