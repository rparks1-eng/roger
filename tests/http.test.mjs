import test from 'node:test';
import assert from 'node:assert/strict';
import { request as nodeRequest } from 'node:http';
import { once } from 'node:events';
import { PassThrough } from 'node:stream';
import { createReaderServer } from '../src/server/http.mjs';
import { readJson } from '../src/server/security.mjs';

const secret = 'synthetic-owner-test-token';
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
function exchange(port, path, { method = 'GET', headers = {}, body, hold = false } = {}) {
  let req;
  const promise = new Promise((resolve, reject) => {
    req = nodeRequest({ hostname: '127.0.0.1', port, path, method, headers }, (response) => {
      const parts = [];
      response.on('data', (part) => parts.push(part));
      response.on('end', () =>
        resolve({
          status: response.statusCode,
          headers: response.headers,
          text: Buffer.concat(parts).toString('utf8'),
        }),
      );
      response.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(3_000, () => req.destroy(Error('test request timed out')));
    if (body !== undefined) req.write(body);
    if (!hold) req.end();
  });
  return {
    promise,
    get request() {
      return req;
    },
  };
}
async function fixture(t, overrides = {}) {
  const calls = [];
  const canvasAdapter = {
    async validateCanvasToken(token) {
      calls.push(['connect', token]);
      return { id: '1', name: 'Test Student' };
    },
    async listCanvasCourses(token) {
      calls.push(['courses', token]);
      return { courses: [{ id: '2', name: 'Test Course' }], coverage: { complete: true } };
    },
    async readCanvasCourse() {
      return { course: { id: '2' }, assignments: [], modules: [] };
    },
    async getCanvasReading() {
      return {
        name: 'Notes.txt',
        mime: 'text/plain',
        bytes: new TextEncoder().encode('Synthetic notes'),
      };
    },
    ...overrides.canvasAdapter,
  };
  const studyAdapter = {
    async providerStatus() {
      calls.push(['providers']);
      return { providers: [] };
    },
    async answerStudy() {
      return { reply: 'Synthetic answer', passages: [], question: 'Why?' };
    },
    ...overrides.studyAdapter,
  };
  const server = createReaderServer({
    canvasAdapter,
    studyAdapter,
    ...(overrides.documentAdapter ? { documentAdapter: overrides.documentAdapter } : {}),
    ...(overrides.clock ? { clock: overrides.clock } : {}),
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  const port = server.address().port;
  const origin = `http://127.0.0.1:${port}`;
  const send = (path, options) => exchange(port, path, options).promise;
  async function session() {
    const page = await send('/');
    assert.equal(page.status, 200);
    const cookie = page.headers['set-cookie'][0].split(';')[0];
    assert.match(page.headers['set-cookie'][0], /HttpOnly; SameSite=Strict/);
    const response = await send('/api/session', { headers: { cookie } });
    assert.equal(response.status, 200);
    const state = JSON.parse(response.text);
    return {
      cookie,
      csrf: state.csrf,
      headers: { cookie, origin, 'content-type': 'application/json', 'x-reader-csrf': state.csrf },
    };
  }
  return { server, port, origin, calls, send, session };
}
test('actual HTTP server exposes only mapped assets with protective headers', async (t) => {
  const app = await fixture(t);
  const page = await app.send('/');
  assert.equal(page.status, 200);
  assert.match(page.headers['content-type'], /text\/html/);
  assert.equal(page.headers['cache-control'], 'no-store');
  assert.equal(page.headers['x-content-type-options'], 'nosniff');
  assert.match(page.headers['content-security-policy'], /frame-ancestors 'none'/);
  assert.equal((await app.send('/styles.css')).status, 200);
  assert.equal((await app.send('/src/server/security.mjs')).status, 404);
  assert.equal((await app.send('/src/python/worker.py')).status, 404);
  assert.equal((await app.send('/core/retrieval.js')).status, 404);
  assert.equal((await app.send('/core/routing.js')).status, 404);
  assert.equal((await app.send('/../package.json')).status, 404);
  assert.equal((await app.send('/api/session', { headers: { Host: 'evil.example' } })).status, 421);
});
test('Python retrieval endpoint preserves source offsets behind session and CSRF checks', async (t) => {
  const app = await fixture(t);
  const s = await app.session();
  const text = '😀 chair and source evidence';
  const body = JSON.stringify({
    documents: [{ id: 'one', revision: '1', title: 'Fixture', text }],
    query: 'chair',
  });
  assert.equal(
    (
      await app.send('/api/retrieval', {
        method: 'POST',
        headers: { ...s.headers, 'x-reader-csrf': 'wrong' },
        body,
      })
    ).status,
    403,
  );
  const response = await app.send('/api/retrieval', { method: 'POST', headers: s.headers, body });
  assert.equal(response.status, 200);
  const result = JSON.parse(response.text);
  assert.equal(result.state, 'matched');
  assert.equal(result.passages[0].end, text.length);
  assert.equal(result.evidenceText, text);
  assert.equal(
    (
      await app.send('/api/retrieval', {
        method: 'POST',
        headers: s.headers,
        body: JSON.stringify({ documents: [], query: 'chair', path: '/private' }),
      })
    ).status,
    400,
  );
});
test('API needs a session; mutation additionally needs origin and csrf', async (t) => {
  const app = await fixture(t);
  assert.equal((await app.send('/api/session')).status, 401);
  const s = await app.session();
  assert.equal(
    (
      await app.send('/api/canvas/connect', {
        method: 'POST',
        headers: { ...s.headers, origin: 'https://evil.example' },
        body: JSON.stringify({ token: secret }),
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await app.send('/api/canvas/connect', {
        method: 'POST',
        headers: { ...s.headers, 'x-reader-csrf': 'wrong' },
        body: '{}',
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await app.send('/api/canvas/connect', {
        method: 'POST',
        headers: { ...s.headers, 'content-type': 'text/plain' },
        body: '{}',
      })
    ).status,
    415,
  );
  assert.equal(app.calls.length, 0);
});
test('connect and disconnect keep synthetic token out of every response', async (t) => {
  const app = await fixture(t);
  const s = await app.session();
  const connected = await app.send('/api/canvas/connect', {
    method: 'POST',
    headers: s.headers,
    body: JSON.stringify({ token: secret }),
  });
  assert.equal(connected.status, 200);
  assert.equal(connected.text.includes(secret), false);
  const state = await app.send('/api/session', { headers: { cookie: s.cookie } });
  assert.equal(state.text.includes(secret), false);
  const courses = await app.send('/api/canvas/courses', { headers: { cookie: s.cookie } });
  assert.equal(courses.status, 200);
  assert.deepEqual(app.calls, [
    ['connect', secret],
    ['courses', secret],
  ]);
  const disconnected = await app.send('/api/canvas/disconnect', {
    method: 'POST',
    headers: s.headers,
    body: '{}',
  });
  assert.equal(disconnected.status, 200);
  assert.equal(
    (await app.send('/api/canvas/courses', { headers: { cookie: s.cookie } })).status,
    409,
  );
});
test('input limits and malformed JSON reject without provider work', async (t) => {
  const app = await fixture(t);
  const s = await app.session();
  assert.equal(
    (
      await app.send('/api/canvas/connect', {
        method: 'POST',
        headers: s.headers,
        body: JSON.stringify({ token: 'x'.repeat(9_000) }),
      })
    ).status,
    413,
  );
  assert.equal(
    (await app.send('/api/canvas/connect', { method: 'POST', headers: s.headers, body: '{' }))
      .status,
    400,
  );
  assert.equal(
    (
      await app.send('/api/study', {
        method: 'POST',
        headers: s.headers,
        body: JSON.stringify({ text: 'x'.repeat(66_000) }),
      })
    ).status,
    413,
  );
  assert.equal(app.calls.length, 0);
});
test('unmapped submission action is denied and Canvas adapter errors are sanitized', async (t) => {
  const app = await fixture(t, {
    canvasAdapter: {
      async validateCanvasToken() {
        throw Error(`private failure ${secret}`);
      },
    },
  });
  const s = await app.session();
  const bad = await app.send('/api/canvas/connect', {
    method: 'POST',
    headers: s.headers,
    body: JSON.stringify({ token: secret }),
  });
  assert.equal(bad.text.includes(secret), false);
  assert.equal(bad.text.includes('private failure'), false);
  assert.equal(
    (await app.send('/api/submit', { method: 'POST', headers: s.headers, body: '{}' })).status,
    404,
  );
});
test('document binary routes retain session, origin, CSRF and content-type boundaries', async (t) => {
  let calls = 0;
  const app = await fixture(t, {
    documentAdapter: {
      async processPdfOcr(bytes, pages) {
        calls++;
        assert.equal(bytes.toString(), '%PDF-test');
        assert.deepEqual(pages, [2]);
        return { pages: [{ page: 2, text: 'Synthetic OCR' }] };
      },
    },
  });
  const s = await app.session();
  const headers = { ...s.headers, 'content-type': 'application/octet-stream' };
  assert.equal(
    (
      await app.send('/api/documents/ocr?pages=2', {
        method: 'POST',
        headers: { ...headers, 'x-reader-csrf': 'wrong' },
        body: '%PDF-test',
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await app.send('/api/documents/ocr?pages=2', {
        method: 'POST',
        headers: s.headers,
        body: '{}',
      })
    ).status,
    415,
  );
  const result = await app.send('/api/documents/ocr?pages=2', {
    method: 'POST',
    headers,
    body: '%PDF-test',
  });
  assert.equal(result.status, 200);
  assert.match(result.text, /Synthetic OCR/);
  assert.equal(calls, 1);
});
test('submission draft route unwraps Canvas detail and exposes no enabled live sends', async (t) => {
  const app = await fixture(t, {
    canvasAdapter: {
      async readCanvasAssignment() {
        return { assignment: { id: '9', name: 'Fixture', submissionTypes: ['online_text_entry'] } };
      },
    },
  });
  const s = await app.session();
  await app.send('/api/canvas/connect', {
    method: 'POST',
    headers: s.headers,
    body: JSON.stringify({ token: secret }),
  });
  const reviewed = await app.send('/api/canvas/submission/review', {
    method: 'POST',
    headers: s.headers,
    body: JSON.stringify({
      courseId: '7',
      assignmentId: '9',
      type: 'online_text_entry',
      content: 'My work',
    }),
  });
  assert.equal(reviewed.status, 200);
  assert.equal(JSON.parse(reviewed.text).liveEnabled, false);
  assert.ok(!reviewed.text.includes(secret));
  assert.equal(
    (
      await app.send('/api/canvas/submission/commit', {
        method: 'POST',
        headers: s.headers,
        body: JSON.stringify({ draftId: JSON.parse(reviewed.text).draftId, confirm: true }),
      })
    ).status,
    403,
  );
});
test('global study slot acquired after streamed bodies prevents cross-session race', async (t) => {
  const entered = deferred();
  const finish = deferred();
  let calls = 0;
  const app = await fixture(t, {
    studyAdapter: {
      async answerStudy() {
        calls++;
        entered.resolve();
        if (calls === 1) await finish.promise;
        return { reply: 'Answer' };
      },
    },
  });
  t.after(() => finish.resolve());
  const first = await app.session();
  const second = await app.session();
  const bodiesWaiting = deferred();
  let requests = 0;
  app.server.on('request', (req) => {
    if (req.url === '/api/study' && ++requests === 2) bodiesWaiting.resolve();
  });
  const a = exchange(app.port, '/api/study', {
    method: 'POST',
    headers: first.headers,
    body: '{',
    hold: true,
  });
  const b = exchange(app.port, '/api/study', {
    method: 'POST',
    headers: second.headers,
    body: '{',
    hold: true,
  });
  await bodiesWaiting.promise;
  a.request.end('}');
  await entered.promise;
  b.request.end('}');
  try {
    const rejected = await b.promise;
    assert.equal(rejected.status, 429);
    assert.equal(calls, 1);
  } finally {
    finish.resolve();
    await a.promise;
  }
  assert.equal(
    (await app.send('/api/study', { method: 'POST', headers: second.headers, body: '{}' })).status,
    200,
  );
});
test('provider status requests share normal admission rate limit', async (t) => {
  const app = await fixture(t);
  const s = await app.session();
  for (let count = 0; count < 20; count++)
    assert.equal((await app.send('/api/providers', { headers: { cookie: s.cookie } })).status, 200);
  assert.equal((await app.send('/api/providers', { headers: { cookie: s.cookie } })).status, 429);
  assert.equal(app.calls.filter((call) => call[0] === 'providers').length, 20);
});
test('closing a study request aborts its adapter and releases the slot', async (t) => {
  const entered = deferred();
  const aborted = deferred();
  let calls = 0;
  const app = await fixture(t, {
    studyAdapter: {
      async answerStudy(_body, signal) {
        calls++;
        if (calls > 1) return { reply: 'Next question works' };
        entered.resolve();
        await new Promise((resolve) =>
          signal.addEventListener(
            'abort',
            () => {
              aborted.resolve();
              resolve();
            },
            { once: true },
          ),
        );
        throw Error('aborted adapter');
      },
    },
  });
  const s = await app.session();
  const pending = exchange(app.port, '/api/study', {
    method: 'POST',
    headers: s.headers,
    body: '{}',
  });
  const caught = pending.promise.catch((error) => error);
  await entered.promise;
  pending.request.destroy(Error('synthetic user cancellation'));
  await caught;
  await aborted.promise;
  // Abort propagation resolves the adapter before the follow-up request arrives.
  const next = await app.send('/api/study', { method: 'POST', headers: s.headers, body: '{}' });
  assert.equal(next.status, 200);
});
test('expired sessions cannot retain Canvas access', async (t) => {
  let now = 0;
  const app = await fixture(t, { clock: () => now });
  const s = await app.session();
  await app.send('/api/canvas/connect', {
    method: 'POST',
    headers: s.headers,
    body: JSON.stringify({ token: secret }),
  });
  now = 31 * 60_000;
  assert.equal((await app.send('/api/session', { headers: { cookie: s.cookie } })).status, 401);
  assert.equal(
    (await app.send('/api/canvas/courses', { headers: { cookie: s.cookie } })).status,
    401,
  );
});
test('JSON body cancellation destroys the waiting stream instead of hanging', async () => {
  const input = new PassThrough();
  const controller = new AbortController();
  input.write('{');
  const pending = readJson(input, 1024, controller.signal);
  const rejected = assert.rejects(pending);
  controller.abort();
  await rejected;
  assert.equal(input.destroyed, true);
});

test('whole-course passage search keeps session and CSRF checks and uses bounded Python routing', async (t) => {
  const app = await fixture(t, {
    studyAdapter: {
      async retrieveStudyPassages(body) {
        return { passages: [{ sourceId: body.sources[0].id, quote: 'Exact source quote.' }] };
      },
    },
  });
  const session = await app.session();
  const body = JSON.stringify({
    mode: 'flashcards',
    engine: 'quick',
    sources: [{ id: 'source-99', kind: 'material', text: 'Exact source quote.' }],
  });
  const absent = await app.send('/api/study/passages', {
    method: 'POST',
    headers: { cookie: session.cookie, origin: app.origin, 'content-type': 'application/json' },
    body,
  });
  assert.equal(absent.status, 403);
  const result = await app.send('/api/study/passages', {
    method: 'POST',
    headers: session.headers,
    body,
  });
  assert.equal(result.status, 200);
  assert.equal(JSON.parse(result.text).passages[0].sourceId, 'source-99');
});

test('course indexing has its own finite rate bucket without blocking ordinary controls', async (t) => {
  const app = await fixture(t, {
    studyAdapter: {
      async retrieveStudyPassages() {
        return { passages: [] };
      },
    },
  });
  const session = await app.session();
  for (let index = 0; index < 180; index++) {
    const response = await app.send('/api/study/passages', {
      method: 'POST',
      headers: session.headers,
      body: '{}',
    });
    assert.equal(response.status, 200);
  }
  assert.equal(
    (
      await app.send('/api/study/passages', {
        method: 'POST',
        headers: session.headers,
        body: '{}',
      })
    ).status,
    429,
  );
  assert.equal(
    (await app.send('/api/providers', { headers: { cookie: session.cookie } })).status,
    200,
  );
});

test('HTML course files return inert source text, omit scripts and mark bounded input', async (t) => {
  let html =
    '<h1>Course overview</h1><script>SECRET_SCRIPT_TEXT</script><style>SECRET_STYLE_TEXT</style><p onclick="evil()">Use retrieval &amp; citations.</p><img src="https://untrusted.example/track"><a href="javascript:evil()">Reference label</a>';
  const app = await fixture(t, {
    canvasAdapter: {
      async getCanvasStudyFile() {
        return { name: 'overview.html', mime: 'text/html', bytes: new TextEncoder().encode(html) };
      },
      async getCanvasReading() {
        return { name: 'overview.html', mime: 'text/html', bytes: new TextEncoder().encode(html) };
      },
    },
  });
  const session = await app.session();
  await app.send('/api/canvas/connect', {
    method: 'POST',
    headers: session.headers,
    body: JSON.stringify({ token: secret }),
  });
  const request = (path = '/api/canvas/study-file') =>
    app.send(path, {
      method: 'POST',
      headers: session.headers,
      body: JSON.stringify({ courseId: '4', fileId: '7' }),
    });
  const response = await request();
  assert.equal(response.status, 200);
  assert.match(response.headers['content-type'], /application\/json/);
  const source = JSON.parse(response.text);
  assert.match(source.text, /Course overview/);
  assert.match(source.text, /Use retrieval & citations/);
  assert.doesNotMatch(response.text, /SECRET_|onclick|javascript:|untrusted.example|<script/);
  assert.deepEqual(Object.keys(source).sort(), ['note', 'text']);
  assert.equal((await request('/api/canvas/reading')).status, 422);
  html = '<p>Readable content.</p>' + ' '.repeat(120_000) + '<p>OUTSIDE_BUDGET</p>';
  const bounded = JSON.parse((await request()).text);
  assert.match(bounded.note, /120,000/);
  assert.doesNotMatch(bounded.text, /OUTSIDE_BUDGET/);
});
