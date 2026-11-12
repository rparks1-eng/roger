import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createReaderServer } from '../src/server/http.mjs';
test('Roger answers with scoped recall, persists citations, and respects paused memory', async (t) => {
  const prompts = [];
  const server = createReaderServer({
    connectionFactory: () => ({
      generate: async ({ prompt }) => {
        prompts.push(prompt);
        return { text: 'We practiced time value of money. [1]', provider: 'codex' };
      },
      dispose() {},
    }),
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const page = await fetch(origin);
  await page.text();
  const cookie = page.headers.get('set-cookie').split(';')[0];
  const session = await fetch(origin + '/api/session', { headers: { cookie } }).then((r) =>
    r.json(),
  );
  async function request(route, body) {
    const response = await fetch(origin + route, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        cookie,
        origin,
        'content-type': 'application/json',
        'x-reader-csrf': session.csrf,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, data: await response.json() };
  }
  const first = await request('/api/connections/ask', {
    provider: 'codex',
    message: 'Practice time value of money',
    context: { courseId: '1' },
    source: '[1] Cash flows have dates.',
    citations: [{ title: 'Finance notes', page: 2, url: 'https://example.edu/notes' }],
  });
  assert.equal(first.status, 200);
  assert.ok(first.data.threadId);
  const second = await request('/api/connections/ask', {
    provider: 'codex',
    message: 'Why?',
    context: { courseId: '1' },
    threadId: first.data.threadId,
  });
  assert.equal(second.status, 200);
  assert.match(prompts[1], /time value of money/);
  const read = await request('/api/memory/thread?id=' + first.data.threadId);
  assert.equal(read.data.turns.length, 4);
  assert.equal(read.data.turns[1].citations[0].page, 2);
  const wrong = await request('/api/connections/ask', {
    provider: 'codex',
    message: 'Why?',
    context: { courseId: '2' },
    threadId: first.data.threadId,
  });
  assert.equal(wrong.status, 403);
  await request('/api/memory/settings', { paused: true });
  await request('/api/connections/ask', {
    provider: 'codex',
    message: 'Explain something new',
    context: { courseId: '1' },
  });
  assert.doesNotMatch(prompts.at(-1), /MEMORY/);
  const after = await request('/api/memory/thread?id=' + first.data.threadId);
  assert.equal(after.data.turns.length, 4);
  const blocked = await fetch(origin + '/api/memory/delete', {
    method: 'POST',
    headers: { cookie, origin, 'content-type': 'application/json' },
    body: JSON.stringify({ threadId: first.data.threadId }),
  });
  assert.equal(blocked.status, 403);
  await blocked.text();
  await request('/api/memory/delete', { threadId: first.data.threadId });
  assert.equal((await request('/api/memory/threads')).data.total, 0);
});
