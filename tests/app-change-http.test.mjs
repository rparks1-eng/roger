import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createReaderServer } from '../src/server/http.mjs';

test('app source changes require the owning session and CSRF; recovery is independent', async () => {
  const calls = [];
  const service = {
    async get(options) {
      calls.push(['get', options]);
      return { draft: null, canUndo: true };
    },
    async build(input, options) {
      calls.push(['build', input, options.owner]);
      return { id: 'test-draft' };
    },
    async apply(input, options) {
      calls.push(['apply', input, options.owner]);
      return { applied: true };
    },
    async undo(input, options) {
      calls.push(['undo', input, options.owner]);
      return { undone: true };
    },
    async discard() {
      return { discarded: true };
    },
    disposeOwner() {},
    dispose() {},
  };
  const server = createReaderServer({ appChangeService: service });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    const canonical = await fetch(origin.replace('127.0.0.1', 'localhost'), { redirect: 'manual' });
    assert.equal(canonical.status, 307);
    assert.equal(canonical.headers.get('location'), `${origin}/`);
    assert.equal(canonical.headers.get('set-cookie'), null);
    assert.equal((await fetch(`${origin}/api/app-changes`)).status, 401);
    const page = await fetch(`${origin}/app-recovery`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /independently of the app/);
    const cookie = page.headers.get('set-cookie').split(';')[0];
    const session = await (
      await fetch(`${origin}/api/session`, { headers: { Cookie: cookie } })
    ).json();
    const post = (action, csrf = session.csrf, extra = {}) =>
      fetch(`${origin}/api/app-changes/${action}`, {
        method: 'POST',
        headers: {
          Cookie: cookie,
          Origin: origin,
          'Content-Type': 'application/json',
          'X-Reader-CSRF': csrf,
        },
        body: JSON.stringify({ id: 'test-draft', confirmation: true, ...extra }),
      });
    assert.equal((await post('apply', 'wrong')).status, 403);
    assert.equal(calls.length, 0);
    assert.equal((await post('build', session.csrf, { owner: 'attacker' })).status, 200);
    assert.equal(calls[0][2], session.csrf, 'HTTP body cannot choose ownership');
    assert.equal((await post('apply')).status, 200);
    assert.equal((await post('undo')).status, 200);
    assert.equal(
      (await fetch(`${origin}/api/app-changes`, { headers: { Cookie: cookie } })).status,
      200,
    );
    assert.equal((await post('delete-everything')).status, 404);
    const recoveryScript = await fetch(`${origin}/app-recovery.js`);
    assert.match(await recoveryScript.text(), /\/api\/app-changes\/undo/);
    assert.equal((await fetch(`${origin}/.roger-changes/rollback.json`)).status, 404);
    assert.equal((await fetch(`${origin}/src/python/app_changes.py`)).status, 404);
  } finally {
    server.close();
    server.closeAllConnections();
    await once(server, 'close');
  }
});
