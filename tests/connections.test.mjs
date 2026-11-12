import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createConnectionService,
  createConnectionEventReader,
} from '../src/server/connections.mjs';

const signedIn = async () => ({ installed: true, signedIn: true });
const reply = (value, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
const key = 'test-secret-only-on-server';

test('Codex requires explicit consent, detects real status and never exposes credentials', async () => {
  const service = createConnectionService({
    codexStatus: signedIn,
    codexGenerate: async () => 'Working feature',
  });
  assert.equal((await service.status()).providers[0].state, 'available');
  await assert.rejects(service.generate({ provider: 'codex', prompt: 'build' }), {
    code: 'consent',
  });
  await assert.rejects(service.connect({ provider: 'codex' }), { code: 'consent' });
  await service.connect({ provider: 'codex', consent: true });
  assert.deepEqual(await service.generate({ provider: 'codex', prompt: 'build' }), {
    provider: 'codex',
    model: 'account-default',
    text: 'Working feature',
  });
  service.disconnect({ provider: 'codex' });
  assert.equal((await service.status()).selected, null);
  service.dispose();
});

test('API connections validate keys through fixed model endpoints and keep secrets out of status', async () => {
  const requests = [];
  const service = createConnectionService({
    codexStatus: signedIn,
    fetcher: async (url, options) => {
      requests.push({ url, options });
      return url.endsWith('/models')
        ? reply({ data: [{ id: 'gpt-test' }, { id: 'gpt-test-audio' }, { id: 'evil/model' }] })
        : reply({
            output: [{ type: 'message', content: [{ type: 'output_text', text: 'Built' }] }],
          });
    },
  });
  const status = await service.connect({ provider: 'openai', apiKey: key, consent: true });
  assert.equal(JSON.stringify(status).includes(key), false);
  assert.deepEqual(status.selected, { provider: 'openai', model: 'gpt-test' });
  assert.equal(
    (await service.generate({ provider: 'openai', prompt: 'Build a timer' })).text,
    'Built',
  );
  assert.equal(requests[0].url, 'https://api.openai.com/v1/models');
  assert.equal(requests[1].options.headers.authorization, `Bearer ${key}`);
  assert.equal(requests[1].options.redirect, 'error');
  assert.equal(JSON.parse(requests[1].options.body).store, false);
  await assert.rejects(service.generate({ provider: 'openai', model: '../secrets', prompt: 'x' }), {
    code: 'invalid',
  });
  service.dispose();
});

test('Claude, Gemini and Grok use their own credentials, models and text response formats', async () => {
  const cases = [
    [
      'anthropic',
      { data: [{ id: 'claude-test' }] },
      { content: [{ type: 'text', text: 'Claude answer' }] },
      'x-api-key',
      'Claude answer',
    ],
    [
      'gemini',
      { models: [{ name: 'models/gemini-test', supportedGenerationMethods: ['generateContent'] }] },
      { candidates: [{ content: { parts: [{ text: 'Gemini answer' }] } }] },
      'x-goog-api-key',
      'Gemini answer',
    ],
    [
      'xai',
      { data: [{ id: 'grok-test' }] },
      { choices: [{ message: { content: 'Grok answer' } }] },
      'authorization',
      'Grok answer',
    ],
  ];
  for (const [provider, models, output, header, answer] of cases) {
    const requests = [];
    const service = createConnectionService({
      codexStatus: signedIn,
      fetcher: async (url, options) => {
        requests.push({ url, options });
        return reply(options.method === 'GET' ? models : output);
      },
    });
    await service.connect({ provider, apiKey: key, consent: true });
    assert.equal((await service.generate({ provider, prompt: 'hello' })).text, answer);
    assert.equal(requests[1].options.headers[header].includes(key), true);
    assert.equal(requests[1].url.includes(key), false);
    service.dispose();
  }
});

test('invalid credentials and raw provider errors never become connected or leak to clients', async () => {
  const service = createConnectionService({
    codexStatus: signedIn,
    fetcher: async () => reply({ error: key }, 401),
  });
  await assert.rejects(
    service.connect({ provider: 'anthropic', apiKey: key, consent: true }),
    (error) => error.code === 'authentication' && !error.message.includes(key),
  );
  assert.equal(
    (await service.status()).providers.find((item) => item.id === 'anthropic').state,
    'disconnected',
  );
  await assert.rejects(service.connect({ provider: 'unknown', apiKey: key, consent: true }), {
    code: 'invalid',
  });
  service.dispose();
});

test('disconnect prevents a late connection from reappearing', async () => {
  let finish;
  const service = createConnectionService({
    codexStatus: signedIn,
    fetcher: () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  });
  const connecting = service.connect({ provider: 'openai', apiKey: key, consent: true });
  service.disconnect({ provider: 'openai' });
  finish(reply({ data: [{ id: 'gpt-test' }] }));
  await assert.rejects(connecting, { code: 'cancelled' });
  assert.equal((await service.status()).selected, null);
  service.dispose();
});

test('generation admission is global, cancellation waits for the operation and releases its slot', async () => {
  let release;
  const first = createConnectionService({
    codexStatus: signedIn,
    codexGenerate: (_prompt, signal) =>
      new Promise((resolve, reject) => {
        release = () => (signal.aborted ? reject(new Error('cancelled')) : resolve('ok'));
      }),
  });
  const second = createConnectionService({
    codexStatus: signedIn,
    codexGenerate: async () => 'next',
  });
  await first.connect({ provider: 'codex', consent: true });
  await second.connect({ provider: 'codex', consent: true });
  const running = first.generate({ provider: 'codex', prompt: 'first' });
  await assert.rejects(second.generate({ provider: 'codex', prompt: 'second' }), { code: 'busy' });
  first.disconnect({ provider: 'codex' });
  await assert.rejects(second.generate({ provider: 'codex', prompt: 'third' }), { code: 'busy' });
  release();
  await assert.rejects(running);
  assert.equal((await second.generate({ provider: 'codex', prompt: 'fourth' })).text, 'next');
  first.dispose();
  second.dispose();
});

test('oversized, missing and truncated outputs fail closed without fallback', async () => {
  const service = createConnectionService({
    codexStatus: signedIn,
    codexGenerate: async () => 'a'.repeat(131_073),
  });
  await service.connect({ provider: 'codex', consent: true });
  await assert.rejects(service.generate({ provider: 'codex', prompt: 'a'.repeat(65_537) }), {
    code: 'oversized',
  });
  await assert.rejects(service.generate({ provider: 'codex', prompt: 'hello' }), {
    code: 'output',
  });
  service.dispose();
  const reader = createConnectionEventReader();
  reader.push(
    JSON.stringify({
      type: 'item.completed',
      item: { type: 'agent_message', text: '{"text":"hello"}' },
    }),
  );
  assert.throws(() => reader.finish());
});

test('Codex output permits large code as text and rejects every tool event', () => {
  const reader = createConnectionEventReader();
  const text = '<div>working</div>'.repeat(2500);
  for (const event of [
    { type: 'turn.started' },
    { type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify({ text }) } },
    { type: 'turn.completed' },
  ])
    reader.push(JSON.stringify(event) + '\n');
  assert.equal(reader.finish().text, text);
  for (const type of [
    'command_execution',
    'file_change',
    'mcp_tool_call',
    'web_search',
    'future_tool',
  ]) {
    assert.throws(
      () =>
        createConnectionEventReader().push(
          JSON.stringify({ type: 'item.started', item: { type } }) + '\n',
        ),
      /tool/,
    );
  }
});

test('sign-in starts only after consent and disposal cancels it without logging out the account', async () => {
  let resolveLogin, loginSignal;
  const service = createConnectionService({
    codexStatus: signedIn,
    codexLogin: (signal) => {
      loginSignal = signal;
      return new Promise((resolve) => {
        resolveLogin = resolve;
      });
    },
  });
  await assert.rejects(service.login({ provider: 'codex' }), { code: 'consent' });
  assert.equal((await service.login({ provider: 'codex', consent: true })).state, 'waiting');
  service.dispose();
  assert.equal(loginSignal.aborted, true);
  resolveLogin({ code: 1 });
});
