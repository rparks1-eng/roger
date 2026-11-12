import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { PassThrough } from 'node:stream';
import { createNarrationService } from '../src/server/narration.mjs';
import { createReaderServer } from '../src/server/http.mjs';

const payload = { text: 'A short source passage.', preset: 'clear' };
function wav() {
  const audio = Buffer.alloc(48);
  audio.write('RIFF', 0);
  audio.writeUInt32LE(40, 4);
  audio.write('WAVEfmt ', 8);
  audio.writeUInt32LE(16, 16);
  audio.writeUInt16LE(1, 20);
  audio.writeUInt16LE(1, 22);
  audio.writeUInt32LE(24_000, 24);
  audio.writeUInt32LE(48_000, 28);
  audio.writeUInt16LE(2, 32);
  audio.writeUInt16LE(16, 34);
  audio.write('data', 36);
  audio.writeUInt32LE(4, 40);
  return audio;
}
function child(start = () => {}) {
  const process = new EventEmitter();
  process.stdin = new PassThrough();
  process.stdout = new PassThrough();
  process.kills = [];
  process.kill = (signal) => {
    process.kills.push(signal);
    process.emit('killed', signal);
    return true;
  };
  queueMicrotask(() => start(process));
  return process;
}
const success = () =>
  child((process) => {
    process.stdout.write(wav());
    process.emit('close', 0);
  });
function keepAlive(t) {
  const timer = setTimeout(() => {}, 2000);
  t.after(() => clearTimeout(timer));
}

test('local narration uses fixed reviewed worker, scrubbed offline environment and mapped voices', async () => {
  let args;
  let input;
  const service = createNarrationService({
    checkInstalled: async () => true,
    spawnImpl: (...call) => {
      args = call;
      const process = success();
      process.stdin.on('data', (chunk) => {
        input = JSON.parse(chunk);
      });
      return process;
    },
  });
  const status = await service.status();
  assert.equal(status.available, true);
  assert.deepEqual(
    status.voices.map(({ id }) => id),
    ['clear', 'warm', 'calm', 'bright'],
  );
  assert.deepEqual(await service.speak({ ...payload, preset: 'warm' }), wav());
  assert.equal(args[0], process.execPath);
  assert.equal(args[1].length, 1);
  assert.match(args[1][0], /voice-runtime\/worker\.mjs$/);
  assert.deepEqual(args[2].env, {
    PATH: '/usr/bin:/bin',
    LANG: 'en_US.UTF-8',
    HF_HUB_OFFLINE: '1',
    TRANSFORMERS_OFFLINE: '1',
  });
  assert.deepEqual(args[2].stdio, ['pipe', 'pipe', 'ignore']);
  assert.equal(args[2].shell, undefined);
  assert.deepEqual(input, { text: payload.text, voice: 'am_michael', speed: 0.95 });
});

test('invalid inputs and pre-abort never spawn, unavailable runtime gives recoverable503', async () => {
  let spawned = 0;
  const service = createNarrationService({
    checkInstalled: async () => true,
    spawnImpl: () => {
      spawned++;
      return success();
    },
  });
  for (const body of [
    null,
    {},
    { ...payload, text: ' ' },
    { ...payload, text: 'x'.repeat(1801) },
    { ...payload, preset: '__proto__' },
    { ...payload, path: '/tmp/evil' },
  ])
    await assert.rejects(service.speak(body), { status: 400 });
  await assert.rejects(service.speak(payload, AbortSignal.abort()), { name: 'AbortError' });
  assert.equal(spawned, 0);
  const missing = createNarrationService({
    checkInstalled: async () => false,
    spawnImpl: () => {
      throw new Error('must not spawn');
    },
  });
  assert.equal((await missing.status()).available, false);
  await assert.rejects(missing.speak(payload), { status: 503 });
});

test('one voice job stays admitted through cancellation until child actually closes', async () => {
  let running;
  let announce;
  const entered = new Promise((resolve) => {
    announce = resolve;
  });
  const service = createNarrationService({
    checkInstalled: async () => true,
    spawnImpl: () => {
      running = child(() => announce());
      return running;
    },
  });
  const controller = new AbortController();
  const job = service.speak(payload, controller.signal);
  const rejected = assert.rejects(job, { status: 499 });
  await entered;
  await assert.rejects(service.speak(payload), { status: 429 });
  controller.abort();
  assert.deepEqual(running.kills, ['SIGTERM']);
  await assert.rejects(service.speak(payload), { status: 429 });
  running.emit('close', null);
  await rejected;
  const next = service.speak(payload);
  await new Promise((resolve) => queueMicrotask(resolve));
  running.stdout.write(wav());
  running.emit('close', 0);
  assert.deepEqual(await next, wav());
});

test('deadline escalates TERM to KILL and settles only after close', async (t) => {
  keepAlive(t);
  let running;
  const service = createNarrationService({
    deadline: 5,
    checkInstalled: async () => true,
    spawnImpl: () => {
      running = child();
      return running;
    },
  });
  const job = service.speak(payload);
  const rejected = assert.rejects(job, { status: 504 });
  await new Promise((resolve) => setTimeout(resolve, 550));
  assert.deepEqual(running.kills, ['SIGTERM', 'SIGKILL']);
  await assert.rejects(service.speak(payload), { status: 429 });
  running.emit('close', null);
  await rejected;
});

test('oversized stdout stops collection and malformed WAV is rejected', async () => {
  let running;
  const service = createNarrationService({
    checkInstalled: async () => true,
    spawnImpl: () => {
      running = child((process) => {
        process.stdout.write(Buffer.alloc(8_640_045));
        process.emit('close', 0);
      });
      return running;
    },
  });
  await assert.rejects(service.speak(payload), { status: 502 });
  assert.deepEqual(running.kills, ['SIGTERM']);
  for (const bytes of [
    Buffer.from('bad'),
    Buffer.from('RIFF' + ' '.repeat(4) + 'WAVE' + ' '.repeat(32)),
    (() => {
      const bytes = wav();
      bytes.writeUInt32LE(999999, 40);
      return bytes;
    })(),
  ]) {
    const malformed = createNarrationService({
      checkInstalled: async () => true,
      spawnImpl: () =>
        child((process) => {
          process.stdout.write(bytes);
          process.emit('close', 0);
        }),
    });
    await assert.rejects(malformed.speak(payload), { status: 502 });
  }
});

test('worker error retains slot until close and synchronous spawn failure releases it', async () => {
  let running;
  let announce;
  const entered = new Promise((resolve) => {
    announce = resolve;
  });
  const service = createNarrationService({
    checkInstalled: async () => true,
    spawnImpl: () => {
      running = child(() => announce());
      return running;
    },
  });
  const job = service.speak(payload);
  const rejected = assert.rejects(job, { status: 503 });
  await entered;
  running.emit('error', new Error('spawn error'));
  await assert.rejects(service.speak(payload), { status: 429 });
  running.emit('close', -1);
  await rejected;
  let attempts = 0;
  const recovery = createNarrationService({
    checkInstalled: async () => true,
    spawnImpl: () => {
      if (++attempts === 1) throw new Error('failed');
      return success();
    },
  });
  await assert.rejects(recovery.speak(payload), { status: 503 });
  assert.deepEqual(await recovery.speak(payload), wav());
});

test('narration POST retains session, origin, CSRF and request-size boundaries', async (t) => {
  let spawned = 0;
  const narrationAdapter = createNarrationService({
    checkInstalled: async () => true,
    spawnImpl: () => {
      spawned++;
      return success();
    },
  });
  const server = createReaderServer({ narrationAdapter });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const first = await fetch(origin + '/');
  const cookie = first.headers.get('set-cookie').split(';')[0];
  const session = await (await fetch(origin + '/api/session', { headers: { cookie } })).json();
  const headers = {
    cookie,
    origin,
    'content-type': 'application/json',
    'x-reader-csrf': session.csrf,
  };
  const send = (body, override) =>
    fetch(origin + '/api/narration', {
      method: 'POST',
      headers: { ...headers, ...override },
      body: JSON.stringify(body),
    });
  assert.equal((await send(payload, { 'x-reader-csrf': 'wrong' })).status, 403);
  assert.equal((await send(payload, { origin: 'https://evil.example' })).status, 403);
  assert.equal((await send({ ...payload, preset: 'unknown' })).status, 400);
  assert.equal((await send({ ...payload, text: 'x'.repeat(17_000) })).status, 413);
  assert.equal(spawned, 0);
  const response = await send(payload);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'audio/wav');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), wav());
  assert.equal(spawned, 1);
  const status = await fetch(origin + '/api/narration/status', { headers: { cookie } });
  assert.equal((await status.json()).available, true);
});
