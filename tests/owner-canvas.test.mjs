import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, lstat, chmod, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { loadOwnerCanvas, saveOwnerCanvas } from '../src/server/owner-canvas.mjs';
import { createReaderServer } from '../src/server/http.mjs';

const token = 'synthetic-owner-canvas-token';
const profile = { id: '123', name: 'Synthetic Student' };
async function storage(t) {
  const directory = await mkdtemp(
    path.join(process.env.CODEX_ARTIFACT_DIR || tmpdir(), 'atlas-reader-owner-test-'),
  );
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, file: path.join(directory, 'private', 'canvas-owner.json') };
}
test('owner credential storage is private and missing config stays optional', async (t) => {
  const { file } = await storage(t);
  assert.equal(await loadOwnerCanvas(file), null);
  await saveOwnerCanvas(token, profile, file);
  assert.equal((await lstat(file)).mode & 0o777, 0o600);
  assert.equal((await lstat(path.dirname(file))).mode & 0o777, 0o700);
  assert.deepEqual(await loadOwnerCanvas(file), { token, profile });
});
test('owner save never overwrites an existing credential', async (t) => {
  const { file } = await storage(t);
  await saveOwnerCanvas(token, profile, file);
  const original = await readFile(file, 'utf8');
  await assert.rejects(saveOwnerCanvas('different-synthetic-token', profile, file), {
    code: 'EEXIST',
  });
  assert.equal(await readFile(file, 'utf8'), original);
});
test('owner loader rejects broad permissions, direct symlinks, oversized and malformed files', async (t) => {
  const { file, directory } = await storage(t);
  await saveOwnerCanvas(token, profile, file);
  await chmod(file, 0o644);
  await assert.rejects(loadOwnerCanvas(file), /could not be opened safely/);
  await chmod(file, 0o600);
  const link = path.join(directory, 'linked.json');
  await symlink(file, link);
  await assert.rejects(loadOwnerCanvas(link), /could not be opened safely/);
  await assert.rejects(saveOwnerCanvas(token, profile, link), { code: 'EEXIST' });
  await writeFile(file, 'x'.repeat(8193));
  await assert.rejects(loadOwnerCanvas(file), /could not be opened safely/);
  await writeFile(file, 'not JSON');
  await assert.rejects(loadOwnerCanvas(file), /could not be opened safely/);
});
test('owner loader validates origin and strips unrelated fields', async (t) => {
  const { file } = await storage(t);
  await saveOwnerCanvas(token, profile, file);
  const value = JSON.parse(await readFile(file, 'utf8'));
  value.profile.unrelatedSecret = 'must-not-return';
  value.other = 'also-excluded';
  await writeFile(file, JSON.stringify(value));
  assert.deepEqual(await loadOwnerCanvas(file), { token, profile });
  value.origin = 'https://other.example';
  await writeFile(file, JSON.stringify(value));
  await assert.rejects(loadOwnerCanvas(file), /could not be opened safely/);
});
async function serverFixture(t) {
  const seen = [];
  const server = createReaderServer({
    configuredCanvas: { token, profile },
    canvasAdapter: {
      async listCanvasCourses(value) {
        seen.push(value);
        return { courses: [], coverage: { complete: true } };
      },
    },
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const page = await fetch(origin);
  const cookie = page.headers.get('set-cookie').split(';')[0];
  await page.text();
  const send = (route, options = {}) =>
    fetch(origin + route, { ...options, headers: { cookie, ...options.headers } });
  return { send, origin, seen };
}
test('owner bootstrap exposes only profile and csrf, never the token, and serves isolated adapter', async (t) => {
  const app = await serverFixture(t);
  assert.equal((await app.send('/api/canvas/courses')).status, 409);
  const response = await app.send('/api/session'),
    text = await response.text();
  assert.equal(text.includes(token), false);
  const session = JSON.parse(text);
  assert.deepEqual(session.canvas, profile);
  assert.equal(typeof session.csrf, 'string');
  assert.deepEqual(Object.keys(session).sort(), ['canvas', 'csrf', 'ephemeral']);
  const courses = await app.send('/api/canvas/courses');
  assert.equal(courses.status, 200);
  assert.equal((await courses.text()).includes(token), false);
  assert.deepEqual(app.seen, [token]);
});
test('explicit disconnect survives repeated session bootstrap in same session', async (t) => {
  const app = await serverFixture(t);
  const session = await (await app.send('/api/session')).json();
  const response = await app.send('/api/canvas/disconnect', {
    method: 'POST',
    headers: {
      origin: app.origin,
      'content-type': 'application/json',
      'x-reader-csrf': session.csrf,
    },
    body: '{}',
  });
  assert.equal(response.status, 200);
  assert.equal((await response.text()).includes(token), false);
  for (let count = 0; count < 2; count++)
    assert.equal((await (await app.send('/api/session')).json()).canvas, null);
  assert.equal((await app.send('/api/canvas/courses')).status, 409);
  assert.deepEqual(app.seen, []);
});
