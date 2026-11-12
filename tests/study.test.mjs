import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import {
  answerStudy,
  createStudySet,
  providerStatus,
  STUDY_BINDING,
  STUDY_LIMITS,
} from '../src/server/study.mjs';

test('discussion and worksheets use cited local passages even if a model is requested', async () => {
  const sources = [
    { id: 'lesson', kind: 'material', text: 'The example compares a 20% share and a 30% share.' },
  ];
  let providerCalls = 0;
  const fetcher = async () => {
    providerCalls++;
    throw new Error('No provider should be called');
  };
  const worksheet = await createStudySet(
    { mode: 'worksheet', engine: 'local', sources },
    undefined,
    { fetcher },
  );
  assert.deepEqual(
    worksheet.worksheet.rows.map(({ value }) => value),
    [20, 30],
  );
  const discussion = await createStudySet(
    { mode: 'discussion', engine: 'local', sources },
    undefined,
    { fetcher },
  );
  assert.equal(discussion.cards[0].sourceId, 'lesson');
  assert.equal(discussion.cards[0].quote, sources[0].text);
  assert.equal(discussion.fallback, false);
  assert.equal(providerCalls, 0);
});
import { retrieveSources } from '../src/server/retrieval.mjs';
import { pythonDomain } from '../src/server/python-domain.mjs';
import { codexStudyArgs, createStudyEventReader } from '../src/core/cli-protocol.ts';

const source = 'Mara closed the door. The empty chair faced her.';
const reply = {
  reply: 'The empty chair may suggest absence, though the passage does not explain whose absence.',
  passages: [{ quote: 'The empty chair', note: 'A concrete detail supports this interpretation.' }],
  question: 'What effect does the closed door have?',
};
const payload = (extra) => ({ text: source, message: 'What could the chair suggest?', ...extra });
const tags = (digest) => Response.json({ models: [{ name: STUDY_BINDING.model, digest }] });
const local = (value = reply) => {
  const calls = [];
  const fetcher = async (url, options) => {
    calls.push({ url, options });
    return url.endsWith('/api/tags')
      ? tags(STUDY_BINDING.digest)
      : Response.json({ model: STUDY_BINDING.model, done: true, response: JSON.stringify(value) });
  };
  return { calls, fetcher };
};
const signal = () => new AbortController().signal;
const errorCode = (code) => (error) => error.code === code;

test('imported core snapshots match recorded destination hashes', async () => {
  const manifest = JSON.parse(await readFile(new URL('../CORE-SOURCES.json', import.meta.url)));
  assert.deepEqual(
    manifest.files.map((file) => file.source),
    ['cli-runner.ts', 'cli-protocol.ts'].map((name) => `src/lib/study/${name}`),
  );
  for (const file of manifest.files) {
    const bytes = await readFile(new URL(`../${file.destination}`, import.meta.url));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), file.destinationSha256);
  }
});

test('local model must match pinned digest and transport stays loopback', async () => {
  const mock = local();
  assert.deepEqual(await answerStudy(payload(), signal(), mock), reply);
  assert.equal(mock.calls.length, 2);
  for (const call of mock.calls) {
    assert.ok(call.url.startsWith('http://127.0.0.1:11434/api/'));
    assert.equal(call.options.redirect, 'error');
  }
  const body = JSON.parse(mock.calls[1].options.body);
  assert.equal(body.model, 'qwen3:4b');
  assert.equal(body.keep_alive, 0);
  assert.equal(body.stream, false);
  assert.equal(body.tools, undefined);
  assert.match(body.system, /untrusted data/);
  assert.equal(JSON.parse(body.prompt).source, source);
  assert.equal(JSON.parse(body.prompt).studentQuestion, payload().message);
  assert.equal(JSON.parse(body.prompt).question, undefined);
  assert.match(body.format.properties.question.description, /NEW follow-up/);
});

test('wrong or missing local model fails without any connected fallback', async () => {
  let calls = 0;
  let cloud = 0;
  await assert.rejects(
    answerStudy(payload(), signal(), {
      fetcher: async () => {
        calls++;
        return tags('different');
      },
      runCodex: async () => {
        cloud++;
      },
    }),
    errorCode('unavailable'),
  );
  assert.equal(calls, 1);
  assert.equal(cloud, 0);
});

test('cloud requires consent and independent server opt-in', async () => {
  const old = process.env.READER_CODEX_ENABLED;
  delete process.env.READER_CODEX_ENABLED;
  try {
    let calls = 0;
    const deps = {
      runCodex: async () => {
        calls++;
        return reply;
      },
    };
    await assert.rejects(
      answerStudy(payload({ provider: 'codex' }), signal(), deps),
      errorCode('consent'),
    );
    await assert.rejects(
      answerStudy(payload({ provider: 'codex', allowCloud: true }), signal(), deps),
      errorCode('unavailable'),
    );
    assert.equal(calls, 0);
    process.env.READER_CODEX_ENABLED = '1';
    assert.deepEqual(
      await answerStudy(payload({ provider: 'codex', allowCloud: true }), signal(), deps),
      reply,
    );
    assert.equal(calls, 1);
  } finally {
    if (old === undefined) delete process.env.READER_CODEX_ENABLED;
    else process.env.READER_CODEX_ENABLED = old;
  }
});

test('invalid input and bounded text reject before providers', async () => {
  const fetcher = async () => {
    throw new Error('must not call');
  };
  for (const value of [
    payload({ provider: 'unknown' }),
    payload({ allowCloud: 'yes' }),
    payload({ text: '' }),
    payload({ tools: ['shell'] }),
    null,
  ]) {
    await assert.rejects(answerStudy(value, signal(), { fetcher }), errorCode('invalid'));
  }
  await assert.rejects(
    answerStudy(payload({ text: 'x'.repeat(24_000) }), signal(), { fetcher }),
    errorCode('oversized'),
  );
});

test('invented optional quote removed, valid source preserved', async () => {
  const mock = local({
    ...reply,
    passages: [{ quote: 'Invented sentence.', note: 'Not in the source.' }],
  });
  const result = await answerStudy(payload(), signal(), mock);
  assert.deepEqual(result.passages, []);
  assert.equal(result.reply, reply.reply);
});

test('strict response shape, word count, and unsafe output rejected', async () => {
  for (const value of [
    { ...reply, extra: true },
    { ...reply, reply: 'word '.repeat(101) },
    { ...reply, question: 'word '.repeat(31) },
    { ...reply, reply: '<script>alert(1)</script>' },
    { ...reply, passages: [{ quote: 'x', note: 'y', path: '/secret' }] },
    { ...reply, question: payload().message },
  ]) {
    await assert.rejects(answerStudy(payload(), signal(), local(value)), errorCode('output'));
  }
});

test('oversized upstream response is bounded and aborted caller never calls provider', async () => {
  await assert.rejects(
    answerStudy(payload(), signal(), {
      fetcher: async () => new Response('x'.repeat(STUDY_LIMITS.responseBytes + 1)),
    }),
    errorCode('oversized'),
  );
  const controller = new AbortController();
  controller.abort();
  let called = false;
  await assert.rejects(
    answerStudy(payload(), controller.signal, {
      fetcher: async () => {
        called = true;
      },
    }),
    errorCode('timeout'),
  );
  assert.equal(called, false);
});

test('status reads metadata only and honestly reports unavailable or disabled', async () => {
  const old = process.env.READER_CODEX_ENABLED;
  delete process.env.READER_CODEX_ENABLED;
  try {
    const mock = local();
    const result = await providerStatus(signal(), mock);
    assert.equal(result.providers[0].state, 'available');
    assert.equal(result.providers[1].state, 'disabled');
    assert.deepEqual(
      mock.calls.map((call) => call.url),
      [`${STUDY_BINDING.origin}/api/tags`],
    );
    const missing = await providerStatus(signal(), {
      fetcher: async () => {
        throw new Error('offline');
      },
    });
    assert.equal(missing.providers[0].state, 'unavailable');
  } finally {
    if (old === undefined) delete process.env.READER_CODEX_ENABLED;
    else process.env.READER_CODEX_ENABLED = old;
  }
});

test('AI kill switch blocks generation and status without network calls', async () => {
  const old = process.env.READER_AI_DISABLED;
  process.env.READER_AI_DISABLED = '1';
  try {
    let called = false;
    const fetcher = async () => {
      called = true;
    };
    await assert.rejects(answerStudy(payload(), signal(), { fetcher }), errorCode('unavailable'));
    const status = await providerStatus(signal(), { fetcher });
    assert.equal(status.providers[0].state, 'disabled');
    assert.equal(called, false);
  } finally {
    if (old === undefined) delete process.env.READER_AI_DISABLED;
    else process.env.READER_AI_DISABLED = old;
  }
});

test('Python retrieval indexes supplied sources only and route does not auto-escalate', async () => {
  const documents = [{ id: 'note', revision: '1', title: 'My note', text: source }];
  const result = await retrieveSources({ documents, query: 'chair' });
  assert.equal(result.state, 'matched');
  assert.equal(result.passages[0].documentId, 'note');
  assert.equal(result.method, 'keyword');
  assert.equal((await retrieveSources({ documents, query: 'volcano' })).state, 'no-match');
  assert.deepEqual(
    await pythonDomain('study.route', { task: 'interpretation', hasEvidence: true }),
    { kind: 'model', provider: 'ollama', reason: 'user-selected' },
  );
  assert.equal(
    (
      await pythonDomain('study.route', {
        task: 'interpretation',
        provider: 'codex',
        hasEvidence: true,
      })
    ).kind,
    'needs-consent',
  );
});

test('CLI protocol denies tools and fixed arguments cannot be supplied by client', () => {
  const args = codexStudyArgs('/synthetic/reply.schema.json');
  assert.ok(args.includes('--ignore-user-config'));
  assert.ok(args.includes('--ignore-rules'));
  assert.ok(args.includes('read-only'));
  assert.ok(args.includes('web_search="disabled"'));
  assert.ok(args.includes('shell_tool'));
  assert.ok(args.includes('code_mode_host'));
  for (const type of [
    'command_execution',
    'mcp_tool_call',
    'web_search',
    'file_change',
    'future_tool',
  ]) {
    const reader = createStudyEventReader();
    assert.throws(
      () => reader.push(JSON.stringify({ type: 'item.started', item: { type } }) + '\n'),
      /tool/,
    );
  }
  const reader = createStudyEventReader();
  reader.push(JSON.stringify({ type: 'turn.started' }) + '\n');
  reader.push(
    JSON.stringify({
      type: 'item.completed',
      item: { type: 'agent_message', text: JSON.stringify(reply) },
    }) + '\n',
  );
  reader.push(JSON.stringify({ type: 'turn.completed' }) + '\n');
  assert.deepEqual(reader.finish(), reply);
});

test('upstream private errors are sanitized and cloud gate is restored', async () => {
  const oldReader = process.env.READER_CODEX_ENABLED,
    oldAtlas = process.env.ATLAS_STUDY_CODEX_ENABLED;
  process.env.READER_CODEX_ENABLED = '1';
  delete process.env.ATLAS_STUDY_CODEX_ENABLED;
  try {
    await assert.rejects(
      answerStudy(payload({ provider: 'codex', allowCloud: true }), signal(), {
        runCodex: async () => {
          assert.equal(process.env.ATLAS_STUDY_CODEX_ENABLED, '1');
          throw new Error('/private/account/token');
        },
      }),
      (error) => error.code === 'unavailable' && !error.message.includes('private'),
    );
    assert.equal(process.env.ATLAS_STUDY_CODEX_ENABLED, undefined);
  } finally {
    if (oldReader === undefined) delete process.env.READER_CODEX_ENABLED;
    else process.env.READER_CODEX_ENABLED = oldReader;
    if (oldAtlas === undefined) delete process.env.ATLAS_STUDY_CODEX_ENABLED;
    else process.env.ATLAS_STUDY_CODEX_ENABLED = oldAtlas;
  }
});
