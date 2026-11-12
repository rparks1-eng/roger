import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, chmod, symlink, lstat } from 'node:fs/promises';
import path from 'node:path';
import { createFeatureBuilder } from '../src/server/builder.mjs';
import { qaScratch } from '../scripts/quality/scratch.mjs';

let scratch;
before(async () => {
  scratch = await qaScratch();
});
after(async () => {
  await scratch.close();
});
const feature = (title = 'Practice timer') => ({
  title,
  summary: 'A working study timer with start and reset.',
  html: '<!doctype html><html><body><button id="go">Start</button><output>0</output><script>document.querySelector("#go").onclick=()=>document.querySelector("output").textContent="1";</script></body></html>',
});
const input = { request: 'Make an interactive study timer', provider: 'codex' };
async function setup(options = {}) {
  const directory = await mkdtemp(path.join(scratch.work, 'features-'));
  const storagePath = path.join(directory, 'features.json');
  return {
    storagePath,
    service: createFeatureBuilder({
      storagePath,
      generate: async () => ({ text: JSON.stringify(feature()) }),
      ...options,
    }),
  };
}

test('build returns executable artifact only as an owner-bound preview; keep survives a fresh instance', async () => {
  let prompt;
  const { service, storagePath } = await setup({
    generate: async (request) => {
      prompt = request;
      return { text: JSON.stringify(feature()) };
    },
  });
  const draft = await service.build(input, { owner: 'browser-a' });
  assert.equal(draft.baseVersion, 0);
  assert.match(draft.html, /onclick/);
  assert.match(prompt.prompt, /NO network/);
  assert.equal(prompt.provider, 'codex');
  assert.deepEqual(await service.list(), []);
  assert.throws(() => service.getDraft(draft.draftId, { owner: 'browser-b' }), { status: 404 });
  await assert.rejects(service.keep({ draftId: draft.draftId }, { owner: 'browser-b' }), {
    status: 404,
  });
  const kept = await service.keep({ draftId: draft.draftId }, { owner: 'browser-a' });
  assert.equal(kept.version, 1);
  assert.equal(kept.canUndo, false);
  assert.equal((await lstat(storagePath)).mode & 0o077, 0);
  const fresh = createFeatureBuilder({ storagePath });
  assert.equal((await fresh.get(kept.id)).html, draft.html);
  assert.equal((await fresh.list())[0].title, 'Practice timer');
  assert.equal((await fresh.list())[0].html, undefined);
  assert.throws(() => service.getDraft(draft.draftId, { owner: 'browser-a' }), { status: 404 });
});

test('revisions use current code, reject stale previews and undo without the AI', async () => {
  let count = 0;
  const prompts = [];
  const { service } = await setup({
    generate: async (value) => {
      prompts.push(value.prompt);
      return JSON.stringify(feature(`Timer ${++count}`));
    },
  });
  const first = await service.build(input);
  const saved = await service.keep({ draftId: first.draftId });
  const change = {
    ...input,
    featureId: saved.id,
    baseVersion: saved.version,
    request: 'Add a reset control',
  };
  const second = await service.build(change);
  const stale = await service.build(change);
  const updated = await service.keep({ draftId: second.draftId });
  assert.equal(updated.version, 2);
  assert.equal(updated.title, 'Timer 2');
  assert.equal(updated.canUndo, true);
  assert.match(prompts[1], /Timer 1/);
  await assert.rejects(service.keep({ draftId: stale.draftId }), { status: 409 });
  await assert.rejects(service.build(change), { status: 409 });
  await assert.rejects(service.undo({ id: saved.id, baseVersion: 1 }), { status: 409 });
  const restored = await service.undo({ id: saved.id, baseVersion: 2 });
  assert.equal(restored.title, 'Timer 1');
  assert.equal(restored.version, 3);
  assert.equal(restored.canUndo, false);
  await assert.rejects(service.undo({ id: saved.id, baseVersion: 3 }), { status: 409 });
});

test('parallel keep requests are serialized and cannot overwrite an installed version', async () => {
  const { service } = await setup();
  const initial = await service.build(input);
  const saved = await service.keep({ draftId: initial.draftId });
  const change = { ...input, featureId: saved.id, baseVersion: 1 };
  const a = await service.build(change);
  const b = await service.build(change);
  const result = await Promise.allSettled([
    service.keep({ draftId: a.draftId }),
    service.keep({ draftId: b.draftId }),
  ]);
  assert.equal(result.filter((entry) => entry.status === 'fulfilled').length, 1);
  assert.equal(result.find((entry) => entry.status === 'rejected').reason.status, 409);
  assert.equal((await service.get(saved.id)).version, 2);
});

test('build admission, cancellation and provider failures recover without creating a draft', async () => {
  let resolve;
  const { service } = await setup({
    generate: () =>
      new Promise((done) => {
        resolve = done;
      }),
  });
  const controller = new AbortController();
  const active = service.build(input, { signal: controller.signal });
  // Let the pending filesystem read reach the injected provider without sleeps.
  while (!resolve) await new Promise((done) => setImmediate(done));
  await assert.rejects(service.build(input), { status: 429 });
  controller.abort();
  resolve(JSON.stringify(feature()));
  await assert.rejects(active, { status: 408 });
  assert.deepEqual(await service.list(), []);
  await assert.rejects(
    service.build(input, {
      generate: async () => {
        throw new Error('provider failed');
      },
    }),
    /provider failed/,
  );
  const recovered = await service.build(input, { generate: async () => JSON.stringify(feature()) });
  assert.equal(recovered.title, 'Practice timer');
  const preAborted = new AbortController();
  preAborted.abort();
  await assert.rejects(service.build(input, { signal: preAborted.signal }), { status: 408 });
});

test('invalid generated artifacts and oversized requests never replace saved features', async () => {
  const { service } = await setup();
  for (const output of [
    'not json',
    JSON.stringify({ ...feature(), html: '<button>Incomplete</button>' }),
    JSON.stringify({
      ...feature(),
      html: '<html><body><script src="https://example.test/code.js"></script></body></html>',
    }),
    JSON.stringify({ ...feature(), title: 'x'.repeat(101) }),
    JSON.stringify({ ...feature(), html: `<html><body>${'x'.repeat(49 * 1024)}</body></html>` }),
  ]) {
    await assert.rejects(service.build(input, { generate: async () => output }));
  }
  await assert.rejects(service.build({ ...input, request: 'x'.repeat(6001) }), { status: 400 });
  await assert.rejects(service.get('../../other.json'), { status: 400 });
  assert.deepEqual(await service.list(), []);
});

test('drafts expire, have a count limit, and can be discarded only by their owner', async () => {
  let now = 1000;
  const { service } = await setup({ clock: () => now });
  const drafts = [];
  for (let index = 0; index < 8; index++) drafts.push(await service.build(input, { owner: 'a' }));
  await assert.rejects(service.build(input, { owner: 'a' }), { status: 429 });
  assert.throws(() => service.discard({ draftId: drafts[0].draftId }, { owner: 'b' }), {
    status: 404,
  });
  service.discard({ draftId: drafts[0].draftId }, { owner: 'a' });
  await service.build(input, { owner: 'a' });
  now += 30 * 60_000;
  assert.throws(() => service.getDraft(drafts[1].draftId, { owner: 'a' }), { status: 404 });
  await service.build(input, { owner: 'a' });
});

test('corrupt, shared or linked storage fails closed and preserves contents', async () => {
  const { service, storagePath } = await setup();
  await writeFile(storagePath, '{corrupt', { mode: 0o600 });
  await assert.rejects(service.list(), { status: 503 });
  await assert.rejects(service.build(input), { status: 503 });
  assert.equal(await readFile(storagePath, 'utf8'), '{corrupt');
  await writeFile(storagePath, JSON.stringify({ schema: 1, features: [] }));
  await chmod(storagePath, 0o644);
  await assert.rejects(service.list(), { status: 503 });
  const linkedPath = path.join(path.dirname(storagePath), 'linked.json');
  await symlink(storagePath, linkedPath);
  await assert.rejects(createFeatureBuilder({ storagePath: linkedPath }).list(), { status: 503 });
});

test('a preview can be revised before keeping and failed revisions preserve the previous preview', async () => {
  const { service } = await setup();
  const draft = await service.build(input, { owner: 'a' });
  await assert.rejects(service.build({ ...input, draftId: draft.draftId }, { owner: 'b' }), {
    status: 404,
  });
  await assert.rejects(
    service.build(
      { ...input, draftId: draft.draftId },
      { owner: 'a', generate: async () => 'bad response' },
    ),
  );
  assert.equal(service.getDraft(draft.draftId, { owner: 'a' }).html, draft.html);
  let prompt;
  const revised = await service.build(
    { ...input, draftId: draft.draftId, request: 'Add break mode' },
    {
      owner: 'a',
      generate: async (value) => {
        prompt = value.prompt;
        return JSON.stringify(feature('Break timer'));
      },
    },
  );
  assert.match(prompt, /onclick/);
  assert.equal(revised.featureId, draft.featureId);
  assert.equal(revised.baseVersion, 0);
  assert.throws(() => service.getDraft(draft.draftId, { owner: 'a' }), { status: 404 });
  const saved = await service.keep({ draftId: revised.draftId }, { owner: 'a' });
  assert.equal(saved.title, 'Break timer');
  assert.equal(saved.version, 1);
});

test('installed feature count and rollback history stay bounded', async () => {
  const { service, storagePath } = await setup();
  let saved;
  for (let index = 0; index < 20; index++) {
    const draft = await service.build(input);
    const result = await service.keep({ draftId: draft.draftId });
    saved ??= result;
  }
  assert.equal((await service.list()).length, 20);
  await assert.rejects(service.build(input), { status: 409 });
  for (let index = 0; index < 7; index++) {
    const draft = await service.build({
      ...input,
      featureId: saved.id,
      baseVersion: saved.version,
    });
    saved = await service.keep({ draftId: draft.draftId });
  }
  const stored = JSON.parse(await readFile(storagePath, 'utf8'));
  assert.equal(stored.features.find((entry) => entry.id === saved.id).history.length, 5);
  assert.equal(saved.version, 8);
});
