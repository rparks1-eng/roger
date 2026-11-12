import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSelectionRects, mountPDFWorkspace } from '../src/client/pdf-workspace.mjs';

test('PDF selection rectangles clip to the original page and normalize for resize', () => {
  const bounds = { left: 100, top: 200, width: 400, height: 600 };
  assert.deepEqual(
    normalizeSelectionRects(
      [
        { left: 120, top: 260, right: 300, bottom: 280 },
        { left: 90, top: 790, right: 200, bottom: 850 },
        { left: 0, top: 0, right: 1, bottom: 1 },
        { left: NaN, top: 200, right: 300, bottom: 250 },
      ],
      bounds,
    ),
    [
      { x: 0.05, y: 0.1, width: 0.45, height: 20 / 600 },
      { x: 0, y: 590 / 600, width: 0.25, height: 10 / 600 },
    ],
  );
  assert.deepEqual(normalizeSelectionRects([], { width: 0, height: 20 }), []);
});
test('PDF selection bounds cap excessive rectangles', () => {
  const rect = { left: 0, top: 0, right: 1, bottom: 1 };
  assert.equal(
    normalizeSelectionRects(Array(1000).fill(rect), { left: 0, top: 0, width: 2, height: 2 })
      .length,
    200,
  );
});
test('PDF workspace rejects excessive bytes before loading PDF.js', async () => {
  let loaded = false;
  await assert.rejects(
    mountPDFWorkspace({
      container: {},
      bytes: { byteLength: 13 * 1024 * 1024 },
      pdfjs: {
        getDocument() {
          loaded = true;
        },
      },
    }),
    /12 MB/,
  );
  assert.equal(loaded, false);
});
test('PDF load failure destroys task and clears the workspace once', async () => {
  let destroyed = 0,
    cleared = 0;
  const container = {
    removeEventListener() {},
    replaceChildren() {
      cleared++;
    },
  };
  await assert.rejects(
    mountPDFWorkspace({
      container,
      bytes: new ArrayBuffer(1),
      pdfjs: {
        GlobalWorkerOptions: {},
        getDocument() {
          return {
            promise: Promise.reject(new Error('invalid source')),
            destroy() {
              destroyed++;
            },
          };
        },
      },
    }),
    /invalid source/,
  );
  assert.equal(destroyed, 1);
  assert.equal(cleared, 1);
});
test('PDF abort closes pending loading and releases task', async () => {
  let destroyed = 0;
  const controller = new AbortController();
  const pending = mountPDFWorkspace({
    container: { removeEventListener() {}, replaceChildren() {} },
    bytes: new ArrayBuffer(1),
    signal: controller.signal,
    pdfjs: {
      GlobalWorkerOptions: {},
      getDocument() {
        queueMicrotask(() => controller.abort());
        return {
          promise: new Promise(() => {}),
          destroy() {
            destroyed++;
          },
        };
      },
    },
  });
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(destroyed, 1);
});
