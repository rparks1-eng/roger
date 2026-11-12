import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { pythonDomain } from '../src/server/python-domain.mjs';

function fake(start) {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.kills = 0;
  child.kill = () => {
    child.kills++;
    queueMicrotask(() => child.emit('close', null));
    return true;
  };
  queueMicrotask(() => start?.(child));
  return child;
}
const deps = (output) => ({
  spawnProcess: () =>
    fake((c) => {
      c.stdout.write(output);
      c.emit('close', 0);
    }),
});
test('domain jobs use a fixed Python entry and scrubbed environment', async () => {
  let call;
  const result = await pythonDomain(
    'study.route',
    { task: 'application', hasEvidence: false },
    {},
    {
      spawnProcess: (...args) => {
        call = args;
        return fake((c) => {
          c.stdout.write('{"ok":true,"result":{"kind":"application"}}');
          c.emit('close', 0);
        });
      },
    },
  );
  assert.equal(result.kind, 'application');
  assert.deepEqual(call[1].slice(0, 2), ['-I', '-B']);
  assert.ok(call[1][2].endsWith('/src/python/worker.py'));
  assert.equal(call[1][3], 'study.route');
  assert.equal(call[2].shell, false);
  assert.deepEqual(Object.keys(call[2].env).sort(), ['LANG', 'PATH']);
});
test('unknown operations, pre-abort and oversized JSON fail before spawn', async () => {
  const dependency = {
    spawnProcess: () => {
      throw Error('must not run');
    },
  };
  await assert.rejects(pythonDomain('shell', { command: 'ls' }, {}, dependency), {
    code: 'invalid',
  });
  await assert.rejects(pythonDomain('retrieval', {}, { signal: AbortSignal.abort() }, dependency), {
    code: 'timeout',
  });
  await assert.rejects(pythonDomain('study.route', { text: 'x'.repeat(4097) }, {}, dependency), {
    code: 'oversized',
  });
});
test('global two-job admission, cancellation and slot release', async () => {
  const controllers = [new AbortController(), new AbortController()];
  let started = 0,
    ready;
  const entered = new Promise((resolve) => {
    ready = resolve;
  });
  const pending = controllers.map((c) =>
    pythonDomain(
      'study.route',
      {},
      { signal: c.signal },
      {
        spawnProcess: () =>
          fake(() => {
            if (++started === 2) ready();
          }),
      },
    ),
  );
  await entered;
  await assert.rejects(pythonDomain('study.route', {}), { code: 'busy' });
  controllers.forEach((c) => c.abort());
  await Promise.all(pending.map((p) => assert.rejects(p, { code: 'timeout' })));
  assert.equal(await pythonDomain('study.route', {}, {}, deps('{"ok":true,"result":true}')), true);
});
test('deadline and oversized stdout kill workers', async () => {
  let child;
  await assert.rejects(
    pythonDomain(
      'study.route',
      {},
      {},
      {
        timeoutMs: 5,
        spawnProcess: () => {
          child = fake();
          return child;
        },
      },
    ),
    { code: 'timeout' },
  );
  assert.equal(child.kills, 1);
  await assert.rejects(
    pythonDomain(
      'study.route',
      {},
      {},
      {
        spawnProcess: () => {
          child = fake((c) => c.stdout.write(Buffer.alloc(2 * 1024 * 1024 + 1)));
          return child;
        },
      },
    ),
    { code: 'oversized' },
  );
  assert.equal(child.kills, 1);
});
test('malformed output and arbitrary private errors are sanitized', async () => {
  for (const output of ['bad', '{}', '{"ok":false,"error":"/private/token"}'])
    await assert.rejects(pythonDomain('study.route', {}, {}, deps(output)), { code: 'output' });
  await assert.rejects(
    pythonDomain('study.route', {}, {}, deps('{"ok":false,"error":"consent"}')),
    { code: 'consent' },
  );
});
test('separate real retrieval jobs do not retain previous sources', async () => {
  const first = await pythonDomain('retrieval', {
    documents: [{ id: 'one', revision: '1', title: 'Fixture', text: 'private chair' }],
    query: 'chair',
  });
  assert.equal(first.state, 'matched');
  assert.deepEqual(
    (await pythonDomain('retrieval', { documents: [], query: 'chair' })).passages,
    [],
  );
});
