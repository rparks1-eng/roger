import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { webcrypto } from 'node:crypto';

const source = await readFile(new URL('../src/client/documents.mjs', import.meta.url), 'utf8');
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
function harness(getPdfModule) {
  const timers = new Map();
  let sequence = 0;
  const context = vm.createContext({
    crypto: webcrypto,
    TextDecoder,
    Uint8Array,
    Blob,
    URL: { createObjectURL: () => 'blob:fixture', revokeObjectURL: () => {} },
    getPdfModule,
    setTimeout: (fn, delay) => {
      assert.equal(delay, 30_000);
      const id = ++sequence;
      timers.set(id, fn);
      return id;
    },
    clearTimeout: (id) => timers.delete(id),
  });
  vm.runInContext(
    source.replace("import('/vendor/pdf.mjs')", 'getPdfModule()').replaceAll('export ', '') +
      '\nglobalThis.read=readDocument;',
    context,
  );
  return {
    read: context.read,
    timers,
    expire: () => {
      for (const fn of [...timers.values()]) fn();
    },
  };
}
const pdf = () => new File(['%PDF-fixture'], 'fixture.pdf', { type: 'application/pdf' });
test('document pre-abort does not read the file or install timers', async () => {
  const h = harness();
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    h.read(
      {
        size: 1,
        arrayBuffer: () => {
          throw Error('must not read');
        },
      },
      { signal: controller.signal },
    ),
    { name: 'AbortError' },
  );
  assert.equal(h.timers.size, 0);
});
test('hung file arrayBuffer can be cancelled and releases deadline', async () => {
  const h = harness();
  const controller = new AbortController();
  const entered = deferred();
  const pending = h.read(
    {
      size: 1,
      arrayBuffer: () => {
        entered.resolve();
        return new Promise(() => {});
      },
    },
    { signal: controller.signal },
  );
  await entered.promise;
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(h.timers.size, 0);
});
test('hung PDF loading deadline destroys its task even when destroy also hangs', async () => {
  const entered = deferred();
  let destroyed = 0;
  const h = harness(async () => ({
    GlobalWorkerOptions: {},
    getDocument: () => {
      entered.resolve();
      return {
        promise: new Promise(() => {}),
        destroy: () => {
          destroyed++;
          return new Promise(() => {});
        },
      };
    },
  }));
  const pending = h.read(pdf());
  await entered.promise;
  h.expire();
  await assert.rejects(pending, /timed out/);
  assert.equal(destroyed, 1);
  assert.equal(h.timers.size, 0);
});
test('hung PDF page extraction cancellation cleans page and loading task once', async () => {
  const entered = deferred();
  let cleaned = 0,
    destroyed = 0;
  const h = harness(async () => ({
    GlobalWorkerOptions: {},
    getDocument: () => ({
      promise: Promise.resolve({
        numPages: 1,
        getPage: async () => ({
          getTextContent: () => {
            entered.resolve();
            return new Promise(() => {});
          },
          cleanup: () => {
            cleaned++;
          },
        }),
      }),
      destroy: () => {
        destroyed++;
      },
    }),
  }));
  const controller = new AbortController();
  const pending = h.read(pdf(), { signal: controller.signal });
  await entered.promise;
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(cleaned, 1);
  assert.equal(destroyed, 1);
  assert.equal(h.timers.size, 0);
});
test('PDF page arriving after cancellation is cleaned rather than retained', async () => {
  const entered = deferred(),
    page = deferred();
  let cleaned = 0,
    destroyed = 0;
  const h = harness(async () => ({
    GlobalWorkerOptions: {},
    getDocument: () => ({
      promise: Promise.resolve({
        numPages: 1,
        getPage: () => {
          entered.resolve();
          return page.promise;
        },
      }),
      destroy: () => {
        destroyed++;
      },
    }),
  }));
  const controller = new AbortController();
  const pending = h.read(pdf(), { signal: controller.signal });
  await entered.promise;
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  page.resolve({
    cleanup: () => {
      cleaned++;
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(cleaned, 1);
  assert.equal(destroyed, 1);
  assert.equal(h.timers.size, 0);
});
