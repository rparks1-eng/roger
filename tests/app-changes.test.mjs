import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createAppChangeService } from '../src/server/app-changes.mjs';
import { qaScratch } from '../scripts/quality/scratch.mjs';
let scratch;
before(async () => {
  scratch = await qaScratch();
});
after(async () => {
  await scratch.close();
});
const html =
  '<html><body><h1>Roger</h1><script type="module" src="/app.js"></script></body></html>';
const input = { request: 'Change the main heading to Course desk', provider: 'codex' };
const output = (
  edits = [{ path: 'public/index.html', find: '<h1>Roger</h1>', replace: '<h1>Course desk</h1>' }],
) => ({
  text: JSON.stringify({
    title: 'Course desk',
    summary: 'A changed heading in the actual app.',
    edits,
  }),
});
async function setup() {
  const root = await mkdtemp(path.join(scratch.work, 'app-source-'));
  await mkdir(path.join(root, 'public'));
  await mkdir(path.join(root, 'src/client'), { recursive: true });
  await writeFile(path.join(root, 'public/index.html'), html);
  await writeFile(path.join(root, 'public/styles.css'), 'body { color: green; }');
  await writeFile(path.join(root, 'src/client/app.mjs'), "console.log('Roger');");
  const assets = new Map([
    ['/', ['public/index.html', 'text/html']],
    ['/styles.css', ['public/styles.css', 'text/css']],
    ['/app.js', ['src/client/app.mjs', 'text/javascript']],
  ]);
  let openPreview,
    captured,
    closed = 0;
  const previewFactory = async ({ files, onOpen }) => {
    captured = files;
    openPreview = onOpen;
    return {
      url: 'http://127.0.0.1:54321/?preview=fixture',
      async close() {
        closed++;
      },
    };
  };
  const service = createAppChangeService({ root, assets, previewFactory });
  return {
    root,
    service,
    assets,
    previewFactory,
    open: () => openPreview(),
    capture: () => captured,
    closed: () => closed,
  };
}

test('actual app edits remain isolated until reviewed Apply and survive restart with independent Undo', async () => {
  const fixture = await setup();
  const { service, root } = fixture;
  try {
    let prompt;
    const draft = await service.build(input, {
      owner: 'a',
      generate: async (request) => {
        prompt = request.prompt;
        return output();
      },
    });
    assert.match(prompt, /REAL Roger browser app source/);
    assert.ok(Buffer.byteLength(prompt) < 60000);
    assert.equal(await readFile(path.join(root, 'public/index.html'), 'utf8'), html);
    assert.match(fixture.capture().get('/').bytes.toString(), /Course desk/);
    await assert.rejects(
      service.apply({ id: draft.id, confirmation: true }, { owner: 'a' }),
      /Open and review/,
    );
    await assert.rejects(
      service.apply({ id: draft.id, confirmation: true }, { owner: 'b' }),
      /another session/,
    );
    fixture.open();
    await assert.rejects(
      service.apply({ id: draft.id, confirmation: false }, { owner: 'a' }),
      /confirm Apply/,
    );
    assert.equal(
      (await service.apply({ id: draft.id, confirmation: true }, { owner: 'a' })).applied,
      true,
    );
    assert.match(await readFile(path.join(root, 'public/index.html'), 'utf8'), /Course desk/);
    assert.equal(fixture.closed(), 1);
    await service.dispose();
    const fresh = createAppChangeService({
      root,
      assets: fixture.assets,
      previewFactory: fixture.previewFactory,
    });
    assert.equal((await fresh.get({ owner: 'a' })).canUndo, true);
    assert.equal((await fresh.undo({}, { owner: 'a' })).undone, true);
    assert.equal(await readFile(path.join(root, 'public/index.html'), 'utf8'), html);
    await fresh.dispose();
  } finally {
    await service.dispose();
  }
});

test('protected paths, ambiguous anchors and invalid JavaScript never become previews', async () => {
  const fixture = await setup();
  try {
    for (const edits of [
      [{ path: 'src/server/http.mjs', find: 'x', replace: 'malicious' }],
      [{ path: '../outside', find: 'x', replace: 'malicious' }],
      [{ path: 'public/index.html', find: 'missing anchor', replace: 'x' }],
      [{ path: 'src/client/app.mjs', find: "console.log('Roger');", replace: 'export const =' }],
    ])
      await assert.rejects(
        fixture.service.build(input, { owner: 'a', generate: async () => output(edits) }),
      );
    assert.equal(fixture.capture(), undefined);
    assert.equal(await readFile(path.join(fixture.root, 'public/index.html'), 'utf8'), html);
  } finally {
    await fixture.service.dispose();
  }
});

test('revision keeps the original baseline; changed source blocks Apply and owner disposal closes preview', async () => {
  const fixture = await setup();
  try {
    const first = await fixture.service.build(input, {
      owner: 'a',
      generate: async () => output(),
    });
    const next = await fixture.service.build(
      { ...input, draftId: first.id },
      {
        owner: 'a',
        generate: async () =>
          output([
            {
              path: 'public/index.html',
              find: '<h1>Course desk</h1>',
              replace: '<h1>My classes</h1>',
            },
          ]),
      },
    );
    assert.match(next.files[0].before, /<h1>Roger<\/h1>/);
    assert.match(next.files[0].after, /My classes/);
    fixture.open();
    await writeFile(path.join(fixture.root, 'public/styles.css'), 'body { color: red; }');
    await assert.rejects(
      fixture.service.apply({ id: next.id, confirmation: true }, { owner: 'a' }),
      /source changed/,
    );
    await fixture.service.disposeOwner('a');
    assert.equal(fixture.closed(), 2);
    assert.equal((await fixture.service.get({ owner: 'a' })).draft, null);
  } finally {
    await fixture.service.dispose();
  }
});

test('concurrent generation and cancellation never write source or leave a preview', async () => {
  const fixture = await setup();
  const controller = new AbortController();
  let release;
  try {
    const waiting = new Promise((resolve) => {
      release = resolve;
    });
    const build = fixture.service.build(input, {
      owner: 'a',
      signal: controller.signal,
      generate: async () => {
        await waiting;
        return output();
      },
    });
    await assert.rejects(
      fixture.service.build(input, { owner: 'b', generate: async () => output() }),
      /in progress/,
    );
    controller.abort();
    release();
    await assert.rejects(build, /cancelled/);
    assert.equal(fixture.capture(), undefined);
    assert.equal(await readFile(path.join(fixture.root, 'public/index.html'), 'utf8'), html);
  } finally {
    release?.();
    await fixture.service.dispose();
  }
});

test('multi-chunk Unicode source survives preview and apply without replacement characters', async () => {
  const fixture = await setup();
  const words = '日本語🙂'.repeat(10000);
  const source = `<html><body><h1>Roger</h1><p>${words}</p></body></html>`;
  await writeFile(path.join(fixture.root, 'public/index.html'), source);
  try {
    const draft = await fixture.service.build(input, {
      owner: 'a',
      generate: async () => output(),
    });
    assert.ok(draft.files[0].before.includes(words));
    assert.ok(draft.files[0].after.includes(words));
    assert.equal(draft.files[0].after.includes('\uFFFD'), false);
    fixture.open();
    await fixture.service.apply({ id: draft.id, confirmation: true }, { owner: 'a' });
    assert.ok(
      (await readFile(path.join(fixture.root, 'public/index.html'), 'utf8')).includes(words),
    );
  } finally {
    await fixture.service.dispose();
  }
});

test('one repair pass receives concrete anchor feedback and retains the existing preview until success', async () => {
  const fixture = await setup();
  try {
    const first = await fixture.service.build(input, {
      owner: 'a',
      generate: async () => output(),
    });
    let calls = 0;
    const revised = await fixture.service.build(
      { ...input, draftId: first.id },
      {
        owner: 'a',
        generate: async ({ prompt }) => {
          calls++;
          assert.ok(Buffer.byteLength(prompt) < 60000);
          assert.equal((await fixture.service.get({ owner: 'a' })).draft.id, first.id);
          assert.equal(fixture.closed(), 0);
          assert.equal(await readFile(path.join(fixture.root, 'public/index.html'), 'utf8'), html);
          if (calls === 1)
            return output([
              { path: 'public/index.html', find: '<h1>Missing</h1>', replace: '<h1>Reading</h1>' },
            ]);
          assert.match(prompt, /ONE REPAIR PASS/);
          assert.match(prompt, /Path: public\/index.html/);
          assert.match(prompt, /Exact occurrences: 0/);
          assert.match(prompt, /Failed anchor prefix/);
          return output([
            {
              path: 'public/index.html',
              find: '<h1>Course desk</h1>',
              replace: '<h1>Reading</h1>',
            },
          ]);
        },
      },
    );
    assert.equal(calls, 2);
    assert.match(revised.files[0].after, /Reading/);
    assert.equal(fixture.closed(), 1);
  } finally {
    await fixture.service.dispose();
  }
});

test('repair is bounded to two generations and never retries provider errors or cancellation', async () => {
  const fixture = await setup();
  try {
    const first = await fixture.service.build(input, {
      owner: 'a',
      generate: async () => output(),
    });
    for (const invalid of [
      () => ({ text: 'not JSON' }),
      () => output([{ path: 'src/server/http.mjs', find: 'x', replace: 'y' }]),
    ]) {
      let calls = 0;
      await assert.rejects(
        fixture.service.build(
          { ...input, draftId: first.id },
          {
            owner: 'a',
            generate: async () => {
              calls++;
              return invalid();
            },
          },
        ),
      );
      assert.equal(calls, 2);
      assert.equal((await fixture.service.get({ owner: 'a' })).draft.id, first.id);
    }
    let failedCalls = 0;
    await assert.rejects(
      fixture.service.build(
        { ...input, draftId: first.id },
        {
          owner: 'a',
          generate: async () => {
            failedCalls++;
            throw new Error('Provider unavailable');
          },
        },
      ),
      /Provider unavailable/,
    );
    assert.equal(failedCalls, 1);
    const controller = new AbortController();
    let cancelledCalls = 0;
    await assert.rejects(
      fixture.service.build(
        { ...input, draftId: first.id },
        {
          owner: 'a',
          signal: controller.signal,
          generate: async () => {
            cancelledCalls++;
            controller.abort();
            return { text: 'not JSON' };
          },
        },
      ),
      /cancelled/,
    );
    assert.equal(cancelledCalls, 1);
  } finally {
    await fixture.service.dispose();
  }
});

test('large source context retains both file head and tail before ranked matches', async () => {
  const fixture = await setup();
  const source = [
    '// HEAD_SENTINEL',
    ...Array.from(
      { length: 1500 },
      (_, index) => `// Library reading line ${index} ${'filler '.repeat(7)}`,
    ),
    '// TAIL_SENTINEL',
  ].join('\n');
  await writeFile(path.join(fixture.root, 'src/client/app.mjs'), source);
  try {
    await fixture.service.build(
      { ...input, request: 'Add a Library reading checklist' },
      {
        owner: 'a',
        generate: async ({ prompt }) => {
          assert.ok(Buffer.byteLength(prompt) <= 49000);
          assert.match(prompt, /HEAD_SENTINEL/);
          assert.match(prompt, /TAIL_SENTINEL/);
          return output();
        },
      },
    );
  } finally {
    await fixture.service.dispose();
  }
});
