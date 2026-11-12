import assert from 'node:assert/strict';
import test from 'node:test';
import { request } from 'node:http';
import { createAppPreview } from '../src/server/app-preview.mjs';

const assets = () =>
  new Map([
    [
      '/',
      {
        bytes: Buffer.from('<!doctype html><html><body><h1>Roger preview</h1></body></html>'),
        mime: 'text/html; charset=utf-8',
      },
    ],
    ['/app.js', { bytes: Buffer.from('export const preview = true;'), mime: 'text/javascript' }],
  ]);
const raw = (url, { path, method = 'GET', headers = {} } = {}) =>
  new Promise((resolve, reject) => {
    const address = new URL(url);
    const req = request(
      {
        agent: false,
        hostname: address.hostname,
        port: address.port,
        path: path || address.pathname + address.search,
        method,
        headers,
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          body += chunk;
        });
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
      },
    );
    req.on('error', reject);
    req.end();
  });
const open = async (preview) => {
  const response = await raw(preview.url);
  assert.equal(response.status, 200);
  return { response, cookie: response.headers['set-cookie'][0].split(';')[0] };
};

test('preview snapshots whole-app assets and serves only sample courses behind its own session', async () => {
  let opened = 0;
  const files = assets();
  const preview = await createAppPreview({ files, onOpen: () => opened++ });
  try {
    files.get('/app.js').bytes.fill(120);
    const { response, cookie } = await open(preview);
    assert.equal(new URL(preview.url).hostname, 'localhost');
    assert.equal(opened, 1);
    assert.match(response.body, /Preview · sample courses · changes not applied/);
    assert.match(response.headers['set-cookie'][0], /HttpOnly; SameSite=Strict/);
    assert.match(
      response.headers['content-security-policy'],
      /sandbox allow-scripts allow-same-origin/,
    );
    assert.match(response.headers['content-security-policy'], /connect-src 'self' blob:/);
    assert.match(response.headers['content-security-policy'], /frame-ancestors 'none'/);
    assert.equal(response.headers['access-control-allow-origin'], undefined);
    const script = await raw(preview.url, { path: '/app.js', headers: { Cookie: cookie } });
    assert.equal(script.body, 'export const preview = true;');
    const session = JSON.parse(
      (
        await raw(preview.url, {
          path: '/api/session',
          headers: { Cookie: cookie + '; reader_session=do-not-reflect-me' },
        })
      ).body,
    );
    assert.deepEqual(session.canvas, { name: 'Sample student' });
    assert.equal(session.preview, true);
    assert.doesNotMatch(JSON.stringify(session), /do-not-reflect-me|token/i);
    const courses = JSON.parse(
      (await raw(preview.url, { path: '/api/canvas/courses', headers: { Cookie: cookie } })).body,
    );
    assert.equal(courses.courses.length, 4);
    const detail = JSON.parse(
      (await raw(preview.url, { path: '/api/canvas/course?id=1', headers: { Cookie: cookie } }))
        .body,
    );
    assert.equal(detail.course.id, '1');
    assert.equal(detail.assignments.length, 4);
    const assignment = JSON.parse(
      (
        await raw(preview.url, {
          path: '/api/canvas/assignment?courseId=1&assignmentId=101',
          headers: { Cookie: cookie },
        })
      ).body,
    );
    assert.equal(assignment.assignment.canSubmit, false);
    assert.match(assignment.assignment.descriptionHtml, /sample assignment/);
  } finally {
    await preview.close();
  }
});

test('preview denies parent cookies, mutations, cross-origin requests, arbitrary paths and hostile Host', async () => {
  let opened = 0;
  const preview = await createAppPreview({ files: assets(), onOpen: () => opened++ });
  try {
    assert.equal((await raw(preview.url, { path: '/app.js' })).status, 401);
    assert.equal(
      (
        await raw(preview.url, {
          path: '/api/session',
          headers: { Cookie: 'reader_session=owner-session' },
        })
      ).status,
      401,
    );
    assert.equal((await raw(preview.url, { headers: { Host: 'attacker.invalid' } })).status, 421);
    assert.equal(
      (await raw(preview.url, { headers: { Origin: 'https://attacker.invalid' } })).status,
      403,
    );
    assert.equal(opened, 0);
    const { cookie } = await open(preview);
    for (const endpoint of [
      '/api/app-changes/apply',
      '/api/connections/ask',
      '/api/canvas/submission/commit',
      '/api/documents/ocr',
    ]) {
      const response = await raw(preview.url, {
        path: endpoint,
        method: 'POST',
        headers: { Cookie: cookie },
      });
      assert.equal(response.status, 403);
      assert.match(response.body, /cannot connect accounts/);
    }
    for (const endpoint of ['/api/unknown', '/.env', '/src/server/http.mjs', '/api/memory/export'])
      assert.equal(
        (await raw(preview.url, { path: endpoint, headers: { Cookie: cookie } })).status,
        403,
      );
    assert.equal(
      (await raw(preview.url, { path: '/%2e%2e/.env', headers: { Cookie: cookie } })).status,
      400,
    );
    assert.equal(
      (
        await raw(preview.url, {
          path: '/api/session',
          headers: { Cookie: cookie, Origin: 'http://127.0.0.1:3847' },
        })
      ).status,
      403,
    );
    assert.equal(
      (await raw(preview.url, { method: 'HEAD', headers: { Cookie: cookie } })).status,
      200,
    );
    assert.equal(opened, 1, 'HEAD cannot qualify as trying a preview');
  } finally {
    await preview.close();
  }
});

test('preview closes independently, does not survive expiration, and validates captured asset boundaries', async () => {
  const preview = await createAppPreview({ files: assets() });
  await open(preview);
  await preview.close();
  await preview.close();
  await assert.rejects(raw(preview.url), { code: 'ECONNREFUSED' });
  const expiring = await createAppPreview({ files: assets(), lifetimeMs: 20 });
  await new Promise((resolve) => setTimeout(resolve, 60));
  await assert.rejects(raw(expiring.url), { code: 'ECONNREFUSED' });
  await expiring.close();
  const bad = assets();
  bad.set('/api/session', { bytes: Buffer.from('sensitive'), mime: 'text/plain' });
  await assert.rejects(createAppPreview({ files: bad }), /captured public files/);
  await assert.rejects(
    createAppPreview({ files: assets(), lifetimeMs: 21 * 60_000 }),
    /twenty minutes/,
  );
  await assert.rejects(createAppPreview({ files: new Map() }), /bounded captured app/);
});
