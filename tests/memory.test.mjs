import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { stat, symlink, writeFile, mkdir, access } from 'node:fs/promises';
import { createMemoryStore } from '../src/server/memory.mjs';
import { qaScratch } from '../scripts/quality/scratch.mjs';

function fixture(options = {}) {
  return createMemoryStore({ dbPath: ':memory:', ...options });
}
const turn = (content, extra = {}) => ({ role: 'user', content, ...extra });

test('course and assignment memory stay separate, including explicit thread reuse', () => {
  const store = fixture();
  try {
    const first = store.appendTurn(
      turn('Capital structure matters', { courseId: 'FIN', assignmentId: 'exam1' }),
    );
    store.appendTurn(turn('Literary symbolism', { courseId: 'ENG', assignmentId: 'essay1' }));
    assert.equal(
      store.retrieve({ query: 'capital', courseId: 'FIN', assignmentId: 'exam1' }).citations.length,
      1,
    );
    assert.equal(
      store.retrieve({ query: 'capital', courseId: 'FIN', assignmentId: 'exam2' }).context,
      '',
    );
    assert.equal(store.retrieve({ query: 'capital' }).context, '');
    assert.throws(
      () =>
        store.appendTurn(
          turn('Wrong course', {
            threadId: first.threadId,
            courseId: 'ENG',
            assignmentId: 'essay1',
          }),
        ),
      { status: 403 },
    );
    assert.throws(() => store.readThread({ threadId: first.threadId }), { status: 403 });
    assert.equal(store.readThread({ threadId: first.threadId, all: true }).turns.length, 1);
    assert.equal(store.listThreads({ all: true }).total, 2);
  } finally {
    store.close();
  }
});

test('follow-up questions inherit recent turns without lexical overlap and deduplicate history', () => {
  const store = fixture();
  try {
    const first = store.appendTurn(turn('Explain capital structure', { courseId: 'FIN' }));
    store.appendTurn({
      role: 'assistant',
      content: 'Debt and equity finance a firm.',
      threadId: first.threadId,
      courseId: 'FIN',
    });
    const followup = store.retrieve({ query: 'Why?', threadId: first.threadId, courseId: 'FIN' });
    assert.ok(followup.context.includes('Debt and equity'));
    assert.equal(followup.citations.length, 2);
    assert.equal(
      store.retrieve({ query: 'capital', threadId: first.threadId, courseId: 'FIN' }).citations
        .length,
      2,
    );
    assert.throws(
      () => store.retrieve({ query: 'Why?', threadId: first.threadId, courseId: 'ENG' }),
      { status: 403 },
    );
  } finally {
    store.close();
  }
});

test('pause prevents saving and retrieval while inspection, export and forgetting remain available', () => {
  const store = fixture();
  try {
    const first = store.appendTurn(turn('A saved conversation'));
    const preference = store.pin({ scope: 'global', content: 'Explain with examples.' }).pin;
    store.settings({ paused: true });
    assert.throws(() => store.appendTurn(turn('Do not save this')), { status: 409 });
    assert.throws(() => store.pin({ scope: 'global', content: 'Not saved' }), { status: 409 });
    assert.deepEqual(store.retrieve({ query: 'saved', recentWork: true }), {
      paused: true,
      context: '',
      citations: [],
      threads: [],
    });
    assert.equal(store.readThread({ threadId: first.threadId }).turns.length, 1);
    assert.equal(store.export().threads.length, 1);
    assert.equal(store.forget({ pinId: preference.id }).forgotten, true);
    assert.equal(store.deleteThread({ threadId: first.threadId }).deleted, true);
    assert.equal(store.export().threads.length, 0);
    store.settings({ paused: false });
    assert.equal(store.appendTurn(turn('Memory resumed')).saved, true);
  } finally {
    store.close();
  }
});

test('global and course pins have explicit scope and recent-work retrieval exposes metadata only across courses', () => {
  const store = fixture();
  try {
    store.pin({ scope: 'global', content: 'Use plain language.' });
    store.pin({ scope: 'course', courseId: 'FIN', content: 'Include spreadsheet examples.' });
    store.appendTurn(turn('Private prose draft here', { title: 'Memoir draft', courseId: 'ENG' }));
    const finance = store.retrieve({ courseId: 'FIN', recentWork: true });
    assert.ok(finance.context.includes('Use plain language.'));
    assert.ok(finance.context.includes('spreadsheet examples'));
    assert.ok(finance.context.includes('Memoir draft'));
    assert.equal(finance.context.includes('Private prose draft here'), false);
    assert.equal(
      store.retrieve({ courseId: 'ENG' }).context.includes('spreadsheet examples'),
      false,
    );
  } finally {
    store.close();
  }
});

test('provider context stays bounded, citations survive and full turns remain exportable', () => {
  const store = fixture();
  try {
    let threadId;
    for (let index = 0; index < 12; index++) {
      const saved = store.appendTurn({
        role: 'assistant',
        threadId,
        content: `Capital structure ${index} ` + 'learning '.repeat(1000),
        citations: [
          {
            title: 'Course PDF',
            page: 2,
            url: 'https://canvas.example/courses/10/files/20',
            quote: 'Capital structure',
          },
        ],
      });
      threadId = saved.threadId;
    }
    const result = store.retrieve({ query: 'capital', threadId });
    assert.ok(result.context.length <= 12000);
    assert.equal(result.citations[0].sources[0].page, 2);
    assert.equal(store.export({ threadId }).threads[0].turns.length, 12);
    const page = store.readThread({ threadId, limit: 5 });
    assert.equal(page.turns.length, 5);
    assert.equal(page.total, 12);
    assert.equal(page.nextOffset, 5);
    assert.equal(store.readThread({ threadId, limit: 5, offset: 10 }).turns.length, 2);
  } finally {
    store.close();
  }
});

test('credentials and executable citation links are rejected before being stored', () => {
  const store = fixture();
  try {
    assert.throws(() => store.appendTurn(turn('sk-proj-abcdefghijklmnopqrstuvwxyz1234567890')), {
      status: 400,
    });
    assert.throws(
      () => store.pin({ scope: 'global', content: 'password=averylongpasswordvalue' }),
      { status: 400 },
    );
    for (const url of [
      'javascript:alert(1)',
      'file:///Users/private',
      'https://canvas.example/?access_token=secret',
    ])
      assert.throws(() => store.appendTurn({ ...turn('A citation'), citations: [{ url }] }), {
        status: 400,
      });
    assert.equal(store.settings().threadCount, 0);
  } finally {
    store.close();
  }
});

test('storage capacity stops new writes without deleting history and remains inspectable', () => {
  const store = fixture({ maxBytes: 128 * 1024 });
  try {
    const saved = store.appendTurn(turn('Keep this original.'));
    assert.throws(() => store.appendTurn(turn('x'.repeat(65_536))), { status: 507 });
    assert.equal(
      store.readThread({ threadId: saved.threadId }).turns[0].content,
      'Keep this original.',
    );
    assert.equal(store.settings({ paused: true }).paused, true);
    assert.equal(store.export().threads.length, 1);
  } finally {
    store.close();
  }
});

test('a fresh instance inherits saved turns and pause; private files and symlink boundaries hold', async () => {
  const scratch = await qaScratch();
  const folder = path.join(scratch.work, 'private-memory');
  const dbPath = path.join(folder, 'memory.sqlite');
  let store;
  try {
    store = createMemoryStore({ dbPath });
    await assert.rejects(access(dbPath));
    const saved = store.appendTurn(
      turn('Persistent thought', { citations: [{ title: 'Original', page: 3 }] }),
    );
    store.settings({ paused: true });
    store.close();
    assert.equal((await stat(dbPath)).mode & 0o077, 0);
    store = createMemoryStore({ dbPath });
    assert.equal(store.settings().paused, true);
    assert.equal(store.readThread({ threadId: saved.threadId }).turns[0].citations[0].page, 3);
    store.close();
    store = null;
    const unsafe = path.join(scratch.work, 'unsafe');
    await mkdir(unsafe, { mode: 0o700 });
    const target = path.join(unsafe, 'target');
    await writeFile(target, 'unchanged', { mode: 0o600 });
    const linked = path.join(unsafe, 'linked.sqlite');
    await symlink(target, linked);
    const rejected = createMemoryStore({ dbPath: linked });
    assert.throws(() => rejected.settings(), { status: 503 });
    rejected.close();
  } finally {
    store?.close();
    await scratch.close();
  }
});

test('memory rejects known provider and GitHub secret prefixes even without a label', () => {
  const store = fixture();
  const synthetic = [
    'AIza' + 'A'.repeat(35),
    'xai-' + 'a'.repeat(40),
    'ghp_' + 'a'.repeat(36),
    'gho_' + 'b'.repeat(36),
    'github_pat_' + 'a'.repeat(60),
    'sk-ant-' + 'a'.repeat(30),
  ];
  try {
    for (const secret of synthetic) {
      assert.throws(() => store.appendTurn(turn(secret)), { status: 400 });
      assert.throws(() => store.pin({ scope: 'global', content: secret }), { status: 400 });
      assert.throws(() => store.retrieve({ query: secret }), { status: 400 });
      assert.throws(
        () => store.appendTurn(turn('Safe source context', { citations: [{ title: secret }] })),
        { status: 400 },
      );
    }
    assert.equal(store.listThreads().total, 0);
    assert.equal(store.listPins().pins.length, 0);
    assert.doesNotThrow(() =>
      store.appendTurn(turn('I use Gemini and Grok to study. API keys stay in provider settings.')),
    );
  } finally {
    store.close();
  }
});
