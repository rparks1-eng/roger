import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { getCanvasExportFile, listCanvasExportFiles } from '../src/server/canvas.mjs';
import { createCourseArchive, createCourseExport } from '../src/server/course-export.mjs';
import { createReaderServer } from '../src/server/http.mjs';
const course = {
  course: { id: '42', name: 'Corporate Finance', code: 'FIN3515', token: 'must-not-export' },
  assignments: [
    {
      id: '1',
      name: 'Exam 2',
      dueAt: '2026-11-12T15:30:00Z',
      url: 'https://babson.instructure.com/courses/42/assignments/1',
      submitted: false,
    },
  ],
  modules: [
    {
      id: '2',
      name: 'Chapter 8',
      items: [
        {
          id: '3',
          title: 'Slides.pdf',
          type: 'File',
          fileId: '44',
          url: 'https://babson.instructure.com/courses/42/files/44',
        },
      ],
    },
  ],
  coverage: { complete: false, reasons: ['Some module items were not visible.'] },
};
const syllabus = {
  candidates: [
    {
      kind: 'file',
      title: 'Syllabus.pdf',
      fileId: '45',
      url: 'https://babson.instructure.com/courses/42/files/45',
      via: 'Welcome module',
    },
  ],
  coverage: { complete: true, reasons: [] },
};
test('portable JSON snapshot preserves source references, partial coverage and explicit file boundaries', () => {
  const result = createCourseExport(course, syllabus, 'json', { now: () => 0 });
  const value = JSON.parse(result.content);
  assert.equal(value.exportedAt, '1970-01-01T00:00:00.000Z');
  assert.equal(value.course.id, '42');
  assert.equal(value.assignments[0].dueAt, course.assignments[0].dueAt);
  assert.equal(value.coverage.course.complete, false);
  assert.equal(value.files.length, 2);
  assert.equal(
    value.files.every((file) => file.included === false),
    true,
  );
  assert.equal(value.syllabus[0].foundIn, 'Welcome module');
  assert.doesNotMatch(result.content, /must-not-export/);
  assert.match(value.scope, /not a Canvas IMS export/);
});
test('Markdown export escapes source formatting, rejects executable links and labels empty syllabus', () => {
  const modified = structuredClone(course);
  modified.course.name = '[Click](javascript:bad)';
  modified.modules[0].items[0].url = 'javascript:bad';
  const result = createCourseExport(modified, { candidates: [] }, 'markdown', { now: () => 0 });
  assert.match(result.fileName, /\.md$/);
  assert.match(result.content, /\\\[Click\\\]/);
  assert.match(result.content, /No syllabus candidate was found/);
  assert.doesNotMatch(result.content, / {2}javascript:/);
  assert.match(result.content, /Original files are linked, not embedded/);
});
test('export validates course and format instead of producing an official archive', () => {
  assert.throws(() => createCourseExport(course, syllabus, 'ims'), { status: 400 });
  assert.throws(() => createCourseExport({ ...course, course: { id: '../../x' } }, syllabus), {
    status: 400,
  });
});

function unpack(content) {
  const result = spawnSync(
    process.env.READER_PYTHON || 'python3',
    [
      '-B',
      '-c',
      'import io, json, sys, zipfile\nwith zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read())) as z:\n    print(json.dumps({name: z.read(name).hex() for name in z.namelist()}))',
    ],
    { input: content, encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr);
  return Object.fromEntries(
    Object.entries(JSON.parse(result.stdout)).map(([path, hex]) => [path, Buffer.from(hex, 'hex')]),
  );
}

test('ZIP round trips authorized originals and labels unavailable or restricted references', async () => {
  const locked = { ...course.modules[0].items[0], fileId: '46', title: 'Locked.pdf', locked: true };
  const modified = structuredClone(course);
  modified.modules[0].items[0].url += '?verifier=private-download-credential';
  modified.modules[0].items.push(locked);
  const original = Buffer.from('%PDF-synthetic bytes');
  const calls = [];
  const result = await createCourseArchive(modified, syllabus, {
    listing: {
      coverage: { complete: false, reasons: ['Canvas limited the file listing.'] },
      files: [
        { fileId: '44', title: 'Duplicate reference' },
        { fileId: '46', title: 'Still locked' },
        { fileId: '47', title: 'Extra workbook' },
      ],
    },
    now: () => 0,
    readFile(fileId) {
      calls.push(fileId);
      if (fileId === '45')
        throw Object.assign(new Error('private upstream detail'), { code: 'unavailable' });
      return {
        name: '../../Slides.html',
        mime: fileId === '44' ? 'application/pdf' : 'text/html',
        bytes: original,
      };
    },
  });
  assert.equal(result.fileName, 'roger-course-42.zip');
  assert.deepEqual(calls, ['44', '45', '47']);
  const files = unpack(result.content);
  assert.deepEqual(Object.keys(files), ['course.json', 'files/44-Slides.pdf']);
  assert.deepEqual(files['files/44-Slides.pdf'], original);
  const manifest = JSON.parse(files['course.json']);
  assert.deepEqual(
    manifest.files.map(({ fileId, status }) => [fileId, status]),
    [
      ['44', 'included'],
      ['46', 'unavailable'],
      ['45', 'unavailable'],
      ['47', 'unavailable'],
    ],
  );
  assert.deepEqual(manifest.files[0].foundIn, ['Module: Chapter 8', 'Course Files']);
  assert.equal(manifest.files[0].url, 'https://babson.instructure.com/courses/42/files/44');
  assert.equal(manifest.coverage.originals.complete, false);
  assert.equal(manifest.coverage.originals.included, 1);
  assert.equal(manifest.coverage.originals.unavailable, 3);
  assert.doesNotMatch(files['course.json'].toString(), /private upstream|verifier|must-not-export/);
});

test('ZIP stops after its attempt budget and does not mask revoked access', async () => {
  const listing = { files: Array.from({ length: 20 }, (_, i) => ({ fileId: String(i + 60) })) };
  let calls = 0;
  const result = await createCourseArchive(course, syllabus, {
    listing,
    readFile() {
      calls++;
      throw Object.assign(new Error('unsupported'), { code: 'unsupported_type' });
    },
  });
  const manifest = JSON.parse(unpack(result.content)['course.json']);
  assert.equal(calls, manifest.coverage.originals.maxAttempts);
  assert.match(manifest.files.at(-1).reason, /archive reached/);
  await assert.rejects(
    createCourseArchive(course, syllabus, {
      listing,
      readFile() {
        throw Object.assign(new Error('Reconnect Canvas'), { code: 'unauthorized' });
      },
    }),
    { code: 'unauthorized' },
  );
});

test('original file adapter only uses same-course Canvas reads and skips locked or unsupported types', async () => {
  const token = 'fixture-token-1234';
  const calls = [];
  const type = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  const options = {
    async fetcher(url, init) {
      assert.equal(init.method, 'GET');
      const { pathname } = new URL(url);
      calls.push(pathname);
      assert.equal(init.headers.Authorization, `Bearer ${token}`);
      if (pathname === '/api/v1/courses/42/files') {
        return Response.json([
          { id: 44, display_name: 'Workbook.xlsx', url: 'https://signed.invalid' },
        ]);
      }
      if (pathname === '/files/44/download')
        return new Response(new Uint8Array([80, 75, 3, 4]), { headers: { 'content-type': type } });
      if (pathname === '/api/v1/courses/42/files/44')
        return Response.json({
          id: 44,
          display_name: 'Workbook.xlsx',
          url: '/files/44/download',
          content_type: type,
        });
      if (pathname === '/api/v1/courses/42/files/46')
        return Response.json({ id: 46, hidden_for_user: true });
      if (pathname === '/api/v1/courses/42/files/47')
        return Response.json({ id: 47, content_type: 'text/html' });
      throw new Error('Unexpected Canvas request.');
    },
  };
  const list = await listCanvasExportFiles(token, '42', options);
  assert.deepEqual(list.files, [
    {
      fileId: '44',
      title: 'Workbook.xlsx',
      url: 'https://babson.instructure.com/courses/42/files/44',
      locked: false,
    },
  ]);
  const original = await getCanvasExportFile(token, '42', '44', options);
  assert.equal(original.mime, type);
  assert.deepEqual([...original.bytes], [80, 75, 3, 4]);
  await assert.rejects(getCanvasExportFile(token, '42', '46', options), { code: 'locked' });
  await assert.rejects(getCanvasExportFile(token, '42', '47', options), {
    code: 'unsupported_type',
  });
  assert.deepEqual(calls, [
    '/api/v1/courses/42/files',
    '/api/v1/courses/42/files/44',
    '/files/44/download',
    '/api/v1/courses/42/files/46',
    '/api/v1/courses/42/files/47',
  ]);
});

test('local download route requires a connected session and returns ZIP attachment metadata', async (t) => {
  const token = 'fixture-token-1234';
  const server = createReaderServer({
    configuredCanvas: { token, profile: { name: 'Fixture' } },
    canvasAdapter: {
      readCanvasCourse(activeToken, courseId) {
        assert.equal(activeToken, token);
        assert.equal(courseId, '42');
        return course;
      },
      readCanvasSyllabus: () => syllabus,
      listCanvasExportFiles: () => ({ files: [] }),
      getCanvasExportFile: () => ({ bytes: Buffer.from('original'), mime: 'text/plain' }),
    },
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(
    () =>
      new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections();
      }),
  );
  const origin = `http://127.0.0.1:${server.address().port}`;
  const path = '/api/canvas/export?courseId=42&format=zip';
  const home = await fetch(origin);
  const cookie = home.headers.get('set-cookie').split(';')[0];
  await home.body.cancel();
  const headers = { cookie };
  const disconnected = await fetch(origin + path, { headers });
  assert.equal(disconnected.status, 409);
  await disconnected.body.cancel();
  const session = await fetch(origin + '/api/session', { headers });
  assert.equal(session.status, 200);
  await session.body.cancel();
  const response = await fetch(origin + path, { headers });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'application/zip');
  assert.equal(response.headers.get('x-reader-filename'), 'roger-course-42.zip');
  assert.match(response.headers.get('content-disposition'), /^attachment;/);
  assert.equal(
    unpack(Buffer.from(await response.arrayBuffer()))['files/44-Slides.txt'].toString(),
    'original',
  );
});
