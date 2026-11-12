import test from 'node:test';
import assert from 'node:assert/strict';
import { downloadCanvasFile } from '../src/server/canvas-download.mjs';
const initial = 'https://babson.instructure.com/files/321/download?verifier=secret';
const cdn = 'https://a1-321.cluster1.canvas-user-content.com/files/321/download?token=secret';
const storage =
  'https://inst-fs-iad-prod.inscloudgate.net/files/fe7087fb-f773-4355-8c56-35a430a813d2/Reading.pdf?token=secret';
const final =
  'https://cdn.inst-fs-iad-prod.inscloudgate.net/1606687c-bac3-4d8d-ae97-c854ebf3c677/Reading.pdf?token=secret';
const token = 'owner-private-token';
const options = { courseId: '123', fileId: '321' };
test('Canvas two-hop file download sends bearer only to initial Canvas host', async () => {
  const calls = [];
  const result = await downloadCanvasFile(token, initial, {
    ...options,
    fetcher: async (url, config) => {
      calls.push({ url, config });
      return calls.length === 1
        ? new Response(null, { status: 302, headers: { location: cdn } })
        : calls.length === 2
          ? new Response(null, { status: 302, headers: { location: storage } })
          : new Response('%PDF-fixture', { headers: { 'content-type': 'application/pdf' } });
    },
  });
  assert.equal(new TextDecoder().decode(result.bytes), '%PDF-fixture');
  assert.equal(calls.length, 3);
  assert.equal(calls[0].config.headers.Authorization, `Bearer ${token}`);
  assert.ok(
    calls
      .slice(1)
      .every(
        (call) =>
          !('Authorization' in call.config.headers) &&
          call.config.redirect === 'manual' &&
          call.config.credentials === 'omit',
      ),
  );
});
test('Canvas refuses private networks, lookalikes, wrong file, unverified storage and unsafe URL parts', async () => {
  for (const target of [
    'http://a1-321.cluster1.canvas-user-content.com/files/321/download',
    'https://127.0.0.1/files/321/download',
    'https://a1-321.cluster1.canvas-user-content.com.evil.test/files/321/download',
    'https://a1-999.cluster1.canvas-user-content.com/files/321/download',
    'https://a1-321.cluster1.canvas-user-content.com/files/999/download',
    storage,
    'https://user:pass@a1-321.cluster1.canvas-user-content.com/files/321/download',
  ]) {
    let calls = 0;
    await assert.rejects(
      downloadCanvasFile(token, initial, {
        ...options,
        fetcher: async () => {
          calls++;
          return new Response(null, { status: 302, headers: { location: target } });
        },
      }),
      { code: 'unsafe_url' },
    );
    assert.equal(calls, 1);
  }
});
test('Canvas refuses arbitrary initial URLs before sending bearer', async () => {
  let calls = 0;
  await assert.rejects(
    downloadCanvasFile(token, cdn, {
      ...options,
      fetcher: () => {
        calls++;
      },
    }),
    { code: 'unsafe_url' },
  );
  assert.equal(calls, 0);
});
test('Canvas bounds file size and cancels a stalled download', async () => {
  await assert.rejects(
    downloadCanvasFile(token, initial, {
      ...options,
      fetcher: async () =>
        new Response('x', { headers: { 'content-length': String(13 * 1024 * 1024) } }),
    }),
    { code: 'too_large' },
  );
  const controller = new AbortController();
  const result = downloadCanvasFile(token, initial, {
    ...options,
    signal: controller.signal,
    fetcher: () => new Promise(() => {}),
  });
  controller.abort();
  await assert.rejects(result, { code: 'aborted' });
});
test('Canvas supports observed final IAD CDN without forwarding bearer', async () => {
  const calls = [];
  const targets = [cdn, storage, final];
  const result = await downloadCanvasFile(token, initial, {
    ...options,
    fetcher: async (url, config) => {
      calls.push(config);
      return calls.length <= 3
        ? new Response(null, { status: 302, headers: { location: targets[calls.length - 1] } })
        : new Response('file');
    },
  });
  assert.equal(result.bytes.length, 4);
  assert.equal(calls.length, 4);
  assert.ok(calls.slice(1).every((call) => !call.headers.Authorization));
});
test('Canvas does not follow a fourth redirect or redirect back to token-bearing origin', async () => {
  let calls = 0;
  const targets = [cdn, storage, final, initial];
  await assert.rejects(
    downloadCanvasFile(token, initial, {
      ...options,
      fetcher: async () =>
        new Response(null, { status: 302, headers: { location: targets[calls++] } }),
    }),
    { code: 'unsafe_url' },
  );
  assert.equal(calls, 4);
});
