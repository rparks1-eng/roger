import test from 'node:test';
import assert from 'node:assert/strict';
import { api, initialize, uploadDocument } from '../src/client/api.mjs';
test('API queue serializes navigation with boot work, drops aborted waiting calls and recovers after failure', async () => {
  const original = globalThis.fetch;
  const seen = [];
  let release;
  globalThis.fetch = async (url, options) => {
    seen.push(url);
    if (url === '/api/session') return Response.json({ csrf: 'fixture' });
    if (url === '/slow')
      await new Promise((resolve) => {
        release = resolve;
      });
    if (url === '/fail') return Response.json({ error: 'Expected failure' }, { status: 503 });
    if (url === '/upload') assert.equal(options.headers['X-Reader-CSRF'], 'fixture');
    return Response.json({ url });
  };
  try {
    await initialize();
    const slow = api('/slow');
    await new Promise((resolve) => setTimeout(resolve, 0));
    const controller = new AbortController();
    const skipped = api('/skip', { signal: controller.signal });
    const navigation = api('/navigation');
    controller.abort();
    assert.deepEqual(seen, ['/api/session', '/slow']);
    const rejected = assert.rejects(skipped, { name: 'AbortError' });
    release();
    await slow;
    await rejected;
    assert.deepEqual(await navigation, { url: '/navigation' });
    await assert.rejects(api('/fail'), /Expected failure/);
    assert.deepEqual(await uploadDocument('/upload', new Uint8Array([1])), { url: '/upload' });
    assert.ok(!seen.includes('/skip'));
  } finally {
    globalThis.fetch = original;
  }
});

test('API retries only rejected busy admission, never rate limits or accepted mutations', async () => {
  const original = globalThis.fetch;
  let busyCalls = 0,
    rateCalls = 0;
  globalThis.fetch = async (url) => {
    if (url === '/busy' && ++busyCalls === 1)
      return Response.json(
        { error: 'Wait for the current request or cancel it.' },
        { status: 429 },
      );
    if (url === '/rate') {
      rateCalls++;
      return Response.json({ error: 'Too many requests. Wait a minute.' }, { status: 429 });
    }
    return Response.json({ saved: true });
  };
  try {
    assert.deepEqual(await api('/busy', { body: { action: 'keep' } }), { saved: true });
    assert.equal(busyCalls, 2);
    await assert.rejects(api('/rate'), /Too many requests/);
    assert.equal(rateCalls, 1);
  } finally {
    globalThis.fetch = original;
  }
});

test('local memory inspection stays responsive while a provider request is waiting', async () => {
  const original = globalThis.fetch;
  let release;
  globalThis.fetch = async (url) => {
    if (url === '/waiting-provider')
      await new Promise((resolve) => {
        release = resolve;
      });
    return Response.json({ url });
  };
  try {
    const slow = api('/waiting-provider');
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(await api('/api/memory/threads'), { url: '/api/memory/threads' });
    release();
    await slow;
  } finally {
    release?.();
    globalThis.fetch = original;
  }
});
