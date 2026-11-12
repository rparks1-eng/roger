import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import {
  runPythonPresentation,
  PYTHON_PRESENTATION_LIMITS,
} from '../src/server/python-presentation.mjs';

const bytes = Buffer.from('synthetic');
function fakeChild(onStart) {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.kills = 0;
  child.kill = () => {
    child.kills++;
    queueMicrotask(() => child.emit('close', null));
    return true;
  };
  queueMicrotask(() => onStart?.(child));
  return child;
}
test('Python boundary uses fixed source, isolated interpreter and no inherited secrets', async () => {
  let call;
  const result = {
    kind: 'pptx',
    layout: 'text-only',
    pages: [{ page: 1, text: 'A page' }],
    warnings: ['Text only'],
  };
  const value = await runPythonPresentation(
    bytes,
    {},
    {
      spawnProcess: (...args) => {
        call = args;
        return fakeChild((child) => {
          child.stdout.write(JSON.stringify({ ok: true, result }));
          child.emit('close', 0);
        });
      },
    },
  );
  assert.deepEqual(value, result);
  assert.deepEqual(call[1].slice(0, 2), ['-I', '-B']);
  assert.ok(call[1][2].endsWith('/src/python/presentation.py'));
  assert.equal(call[2].shell, false);
  assert.deepEqual(Object.keys(call[2].env).sort(), ['LANG', 'PATH']);
  assert.equal(call[1].includes('synthetic'), false);
});
test('pre-abort and oversized inputs do not spawn', async () => {
  const deps = {
    spawnProcess: () => {
      throw Error('must not start');
    },
  };
  await assert.rejects(
    runPythonPresentation(bytes, { signal: AbortSignal.abort() }, deps),
    /cancelled/,
  );
  await assert.rejects(
    runPythonPresentation(Buffer.alloc(PYTHON_PRESENTATION_LIMITS.bytes + 1), {}, deps),
    /12 MiB/,
  );
});
test('one global slot rejects concurrent work and abort waits for worker close', async () => {
  const controller = new AbortController();
  let child, entered;
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  const pending = runPythonPresentation(
    bytes,
    { signal: controller.signal },
    {
      spawnProcess: () => {
        child = fakeChild(entered);
        return child;
      },
    },
  );
  await started;
  await assert.rejects(runPythonPresentation(bytes), /Another PowerPoint/);
  controller.abort();
  await assert.rejects(pending, /cancelled/);
  assert.equal(child.kills, 1);
  await assert.rejects(runPythonPresentation(bytes), /PowerPoint could not be read/);
});
test('deadline kills worker and frees slot without a fallback parser', async () => {
  let child;
  await assert.rejects(
    runPythonPresentation(
      bytes,
      {},
      {
        timeoutMs: 10,
        spawnProcess: () => {
          child = fakeChild();
          return child;
        },
      },
    ),
    /10-second/,
  );
  assert.equal(child.kills, 1);
  await assert.rejects(runPythonPresentation(bytes), /PowerPoint could not be read/);
});
test('unbounded output is killed and malformed JSON cannot become a document', async () => {
  let child;
  await assert.rejects(
    runPythonPresentation(
      bytes,
      {},
      {
        spawnProcess: () => {
          child = fakeChild((c) =>
            c.stdout.write(Buffer.alloc(PYTHON_PRESENTATION_LIMITS.output + 1)),
          );
          return child;
        },
      },
    ),
    /output exceeded/,
  );
  assert.equal(child.kills, 1);
  for (const output of ['not JSON', JSON.stringify({ ok: true, result: { pages: [] } })])
    await assert.rejects(
      runPythonPresentation(
        bytes,
        {},
        {
          spawnProcess: () =>
            fakeChild((c) => {
              c.stdout.write(output);
              c.emit('close', 0);
            }),
        },
      ),
      /invalid PowerPoint/,
    );
});
test('worker failure and unsafe error text are sanitized', async () => {
  await assert.rejects(
    runPythonPresentation(bytes, {}, { spawnProcess: () => fakeChild((c) => c.emit('close', 1)) }),
    /worker failed/,
  );
  await assert.rejects(
    runPythonPresentation(
      bytes,
      {},
      {
        spawnProcess: () =>
          fakeChild((c) => {
            c.stdout.write(JSON.stringify({ ok: false, error: '/private/secret' }));
            c.emit('close', 0);
          }),
      },
    ),
    (error) => !error.message.includes('private') && /PowerPoint/.test(error.message),
  );
});
