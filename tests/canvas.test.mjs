import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CANVAS_ORIGIN,
  validateCanvasToken,
  listCanvasCourses,
  listCanvasAssignments,
  readCanvasCourse,
  readCanvasSyllabus,
  getCanvasSyllabusFile,
  getCanvasStudyFile,
  getCanvasReading,
  readCanvasAssignment,
  readCanvasPage,
} from '../src/server/canvas.mjs';
const token = 'synthetic-token-not-real';
const json = (value, headers = {}) =>
  new Response(JSON.stringify(value), {
    headers: { 'content-type': 'application/json', ...headers },
  });
test('syllabus discovery follows published module pages and rejects cross-course links', async () => {
  const paths = new Map([
    ['/api/v1/courses/4', { id: 4, course_code: '2026Fall-TEST' }],
    ['/api/v1/courses/4/files', [{ id: 8, display_name: 'Syllabus 2025.pdf' }]],
    ['/api/v1/courses/4/pages', []],
    [
      '/api/v1/courses/4/modules',
      [
        {
          id: 1,
          name: 'Course Resources',
          items: [
            {
              id: 2,
              type: 'Page',
              title: 'Course Syllabus and Calendar',
              page_url: 'syllabus-and-calendar',
            },
          ],
        },
      ],
    ],
    [
      '/api/v1/courses/4/pages/syllabus-and-calendar',
      {
        title: 'Course Syllabus and Calendar',
        published: true,
        body: '<a href="/courses/9/files/3" title="Syllabus.pdf">Old</a><a href="/courses/4/files/7" title="Syllabus 2026.pdf">Current</a>',
      },
    ],
  ]);
  const fetcher = async (url) => {
    const pathname = new URL(url).pathname;
    assert.ok(paths.has(pathname), pathname);
    return json(paths.get(pathname));
  };
  const result = await readCanvasSyllabus(token, 4, { fetcher });
  assert.deepEqual(
    result.candidates.map(({ fileId, linked }) => [fileId, linked]),
    [
      ['7', true],
      ['8', false],
    ],
  );
  paths.set('/api/v1/courses/4/files/10', {
    hidden_for_user: true,
    url: CANVAS_ORIGIN + '/files/10/download',
  });
  await assert.rejects(getCanvasSyllabusFile(token, 4, 10, { fetcher }), { code: 'locked' });
});
test('chooses the dated current term and retains other accessible terms', async () => {
  const term = (id, name, start_at, end_at) => ({ id, name, start_at, end_at });
  const { courses, terms, currentTermId } = await listCanvasCourses(token, {
    now: Date.parse('2026-11-11T15:00:00Z'),
    fetcher: async (url) => {
      const query = new URL(url).searchParams;
      assert.equal(query.get('include[]'), 'term');
      return json([
        {
          id: 1,
          name: 'Old',
          term: term(2, 'Spring', '2026-01-01T05:00:00Z', '2026-06-01T05:00:00Z'),
        },
        {
          id: 3,
          name: 'Current',
          term: term(4, 'Fall', '2026-08-11T05:00:00Z', '2027-01-09T03:59:59Z'),
        },
        { id: 5, name: 'Orientation', term: term(6, 'Default Term', null, null) },
        { id: 7 },
      ]);
    },
  });
  assert.equal(currentTermId, '4');
  assert.deepEqual(
    terms.map(({ id }) => id),
    ['4', '2', '6'],
  );
  assert.deepEqual(
    courses.map(({ termId }) => termId),
    ['2', '4', '6'],
  );
});
test('assignment agenda preserves effective dates and does not hide a partially unavailable term', async () => {
  let requests = 0;
  const { courses } = await listCanvasAssignments(token, ['4', '8', '4'], {
    fetcher: async (url) => {
      requests++;
      const parsed = new URL(url);
      assert.equal(parsed.searchParams.get('override_assignment_dates'), 'true');
      assert.equal(parsed.searchParams.get('include[]'), 'submission');
      if (parsed.pathname.endsWith('/8/assignments')) return new Response(null, { status: 403 });
      return json([
        {
          id: 1,
          name: 'Paper',
          due_at: '2026-11-12T15:30:00Z',
          submission: { workflow_state: 'pending_review' },
        },
        { id: 2, name: 'Worksheet', submission: { missing: true }, locked_for_user: true },
      ]);
    },
  });
  assert.equal(requests, 2);
  assert.deepEqual(
    courses[0].assignments.map(({ dueAt, status }) => [dueAt, status]),
    [
      ['2026-11-12T15:30:00Z', 'submitted'],
      [null, 'missing'],
    ],
  );
  assert.equal(courses[0].issue, null);
  assert.match(courses[1].issue, /did not grant access/);
  await assert.rejects(listCanvasAssignments(token, ['../4']), { code: 'invalid_id' });
});
test('assignment detail preserves instructions as untrusted bounded data and normalizes submission facts', async () => {
  const { assignment } = await readCanvasAssignment(token, 4, 8, {
    fetcher: async (url) => {
      assert.equal(new URL(url).pathname, '/api/v1/courses/4/assignments/8');
      return json({
        id: 8,
        course_id: 4,
        name: '<b>Report</b>',
        description: '<p>Read this.</p>',
        submission_types: ['online_upload'],
        can_submit: true,
        allowed_extensions: ['pdf'],
        group_category_id: 5,
        submission: {
          workflow_state: 'submitted',
          submitted_at: '2026-10-15T12:00:00Z',
          attempt: 2,
        },
      });
    },
  });
  assert.equal(assignment.name, 'Report');
  assert.equal(assignment.descriptionHtml, '<p>Read this.</p>');
  assert.equal(assignment.submitted, true);
  assert.equal(assignment.canSubmit, true);
  assert.equal(assignment.groupCategoryId, 5);
  assert.equal(assignment.submission.attempt, 2);
});
test('assignment detail rejects identity drift and caps long instructions', async () => {
  await assert.rejects(
    readCanvasAssignment(token, 4, 8, { fetcher: async () => json({ id: 9 }) }),
    { code: 'invalid_response' },
  );
  await assert.rejects(
    readCanvasAssignment(token, 4, 8, { fetcher: async () => json({ id: 8, course_id: 9 }) }),
    { code: 'invalid_response' },
  );
  const { assignment } = await readCanvasAssignment(token, 4, 8, {
    fetcher: async () => json({ id: 8, description: 'a'.repeat(120001) }),
  });
  assert.equal(assignment.descriptionHtml.length, 120000);
  assert.equal(assignment.descriptionTruncated, true);
  assert.equal(assignment.canSubmit, undefined);
});
test('course pages validate slug, enforce locks and retain rich body as untrusted data', async () => {
  await assert.rejects(readCanvasPage(token, 4, '../secrets'), { code: 'invalid_page' });
  await assert.rejects(
    readCanvasPage(token, 4, 'week-1', { fetcher: async () => json({ locked_for_user: true }) }),
    { code: 'locked' },
  );
  const { page } = await readCanvasPage(token, 4, 'week-1', {
    fetcher: async (url) => {
      assert.equal(new URL(url).pathname, '/api/v1/courses/4/pages/week-1');
      return json({ title: 'Week 1', body: '<h2>Reading</h2>' });
    },
  });
  assert.equal(page.title, 'Week 1');
  assert.equal(page.bodyHtml, '<h2>Reading</h2>');
});
test('profile pins origin, GET, manual redirects and bearer server transport', async () => {
  const user = await validateCanvasToken(token, {
    fetcher: async (url, init) => {
      assert.equal(url, `${CANVAS_ORIGIN}/api/v1/users/self/profile`);
      assert.equal(init.method, 'GET');
      assert.equal(init.redirect, 'manual');
      assert.equal(init.headers.Authorization, `Bearer ${token}`);
      return json({ id: 1, name: '<b>Student</b>' });
    },
  });
  assert.deepEqual(user, { id: '1', name: 'Student' });
});
test('bad credentials and IDs reject before fetch', async () => {
  const options = {
    fetcher: () => {
      throw Error('must not fetch');
    },
  };
  await assert.rejects(validateCanvasToken('bad\nheader', options), { code: 'invalid_token' });
  await assert.rejects(readCanvasCourse(token, '../1', options), { code: 'invalid_id' });
});
test('untrusted upstream error content never escapes', async () => {
  await assert.rejects(
    validateCanvasToken(token, {
      fetcher: async () => new Response(`secret ${token}`, { status: 401 }),
    }),
    (error) => error.code === 'unauthorized' && !error.message.includes(token),
  );
});
test('foreign pagination is rejected without a second request', async () => {
  let calls = 0;
  await assert.rejects(
    listCanvasCourses(token, {
      fetcher: async () => {
        calls++;
        return json([], { link: '<https://evil.example/api/v1/courses?page=2>; rel="next"' });
      },
    }),
    { code: 'unsafe_url' },
  );
  assert.equal(calls, 1);
});
test('pagination preserves collection filters and has a hard cap', async () => {
  let calls = 0;
  const result = await listCanvasCourses(token, {
    fetcher: async (url) => {
      calls++;
      const next = new URL(url);
      next.searchParams.set('page', String(calls + 1));
      return json([{ id: calls, name: `Course ${calls}` }], { link: `<${next}>; rel="next"` });
    },
  });
  assert.equal(calls, 3);
  assert.equal(result.courses.length, 3);
  assert.equal(result.coverage.partial, true);
  await assert.rejects(
    listCanvasCourses(token, {
      fetcher: async () =>
        json([], {
          link: `<${CANVAS_ORIGIN}/api/v1/courses?enrollment_type=teacher&per_page=100&page=2>; rel="next"`,
        }),
    }),
    { code: 'unsafe_pagination' },
  );
});
test('oversized and malformed JSON are rejected', async () => {
  await assert.rejects(
    validateCanvasToken(token, {
      fetcher: async () => new Response('x', { headers: { 'content-length': String(2 ** 21) } }),
    }),
    { code: 'too_large' },
  );
  await assert.rejects(validateCanvasToken(token, { fetcher: async () => new Response('{') }), {
    code: 'invalid_response',
  });
});
test('course results normalize locked modules and show permission gaps', async () => {
  const result = await readCanvasCourse(token, 4, {
    fetcher: async (url) => {
      const path = new URL(url).pathname;
      if (path.endsWith('/assignments')) return new Response('', { status: 403 });
      if (path.endsWith('/modules'))
        return json([{ id: 5, name: 'Week 1', state: 'locked', items_count: 1 }]);
      if (path.endsWith('/items'))
        return json([
          {
            id: 6,
            title: '<em>Read</em>',
            type: 'File',
            content_id: 7,
            content_details: { locked_for_user: true },
          },
        ]);
      return json({ id: 4, name: 'Course' });
    },
  });
  assert.equal(result.coverage.partial, true);
  assert.deepEqual(result.assignments, []);
  assert.equal(result.modules[0].locked, true);
  assert.equal(result.modules[0].items[0].locked, true);
  assert.equal(result.modules[0].items[0].title, 'Read');
});
test('module fallback fanout is capped at four', async () => {
  let fallbacks = 0;
  const result = await readCanvasCourse(token, 4, {
    fetcher: async (url) => {
      const path = new URL(url).pathname;
      if (path.endsWith('/assignments')) return json([]);
      if (path.endsWith('/modules'))
        return json(
          Array.from({ length: 8 }, (_, index) => ({
            id: index + 1,
            name: 'Module',
            items_count: 1,
          })),
        );
      if (path.endsWith('/items')) {
        fallbacks++;
        return json([]);
      }
      return json({ id: 4 });
    },
  });
  assert.equal(fallbacks, 4);
  assert.equal(result.coverage.partial, true);
});
test('same-origin PDF is downloaded with byte and signature validation', async () => {
  let calls = 0;
  const result = await getCanvasReading(token, 4, 7, {
    fetcher: async () =>
      ++calls === 1
        ? json({
            id: 7,
            'content-type': 'application/pdf',
            display_name: 'Notes.pdf',
            url: `${CANVAS_ORIGIN}/files/7/download?download_frd=1`,
          })
        : new Response('%PDF-1.7\nfixture', { headers: { 'content-type': 'application/pdf' } }),
  });
  assert.equal(result.name, 'Notes.pdf');
  assert.equal(result.mime, 'application/pdf');
  assert.ok(result.bytes instanceof Uint8Array);
});
test('PowerPoint downloads require declared PPTX MIME and ZIP signature', async () => {
  const mime = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
  const fetcher = async (url) =>
    url.includes('/api/')
      ? json({
          id: 7,
          'content-type': mime,
          display_name: 'Slides.pptx',
          url: `${CANVAS_ORIGIN}/files/7/download`,
        })
      : new Response(new Uint8Array([0x50, 0x4b, 0x03, 0x04]), {
          headers: { 'content-type': mime },
        });
  const result = await getCanvasReading(token, 4, 7, { fetcher });
  assert.equal(result.name, 'Slides.pptx');
  assert.equal(result.mime, mime);
  await assert.rejects(
    getCanvasReading(token, 4, 7, {
      fetcher: async (url) =>
        url.includes('/api/')
          ? json({ 'content-type': mime, url: `${CANVAS_ORIGIN}/files/7/download` })
          : new Response('not a zip', { headers: { 'content-type': mime } }),
    }),
    { code: 'invalid_file' },
  );
});
test('download never sends credentials to an arbitrary CDN or follows an untrusted redirect', async () => {
  let calls = 0;
  await assert.rejects(
    getCanvasReading(token, 4, 7, {
      fetcher: async () => {
        calls++;
        return json({
          'content-type': 'application/pdf',
          url: 'https://cdn.example/files/7/download',
        });
      },
    }),
    { code: 'unsafe_url' },
  );
  assert.equal(calls, 1);
  await assert.rejects(
    getCanvasReading(token, 4, 7, {
      fetcher: async (url) =>
        url.includes('/api/')
          ? json({ 'content-type': 'application/pdf', url: `${CANVAS_ORIGIN}/files/7/download` })
          : new Response(null, { status: 302, headers: { location: 'https://cdn.example/file' } }),
    }),
    { code: 'unsafe_url' },
  );
});
test('locked and unsupported files fail without a download', async () => {
  await assert.rejects(
    getCanvasReading(token, 4, 7, { fetcher: async () => json({ locked_for_user: true }) }),
    { code: 'locked' },
  );
  await assert.rejects(
    getCanvasReading(token, 4, 7, { fetcher: async () => json({ 'content-type': 'text/html' }) }),
    { code: 'unsupported_type' },
  );
});
test('pre-aborted requests terminate even when fake body ignores signal', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    validateCanvasToken(token, { signal: controller.signal, fetcher: async () => json({ id: 1 }) }),
    { code: 'aborted' },
  );
});
test('abort interrupts a stalled transport even if adapter ignores abort', async () => {
  const controller = new AbortController();
  const pending = validateCanvasToken(token, {
    signal: controller.signal,
    fetcher: () => new Promise(() => {}),
  });
  controller.abort();
  await assert.rejects(pending, { code: 'aborted' });
});
test('abort interrupts a stalled response stream and cancels reader', async () => {
  const controller = new AbortController();
  let cancelled = false;
  const stream = new ReadableStream(
    {
      pull() {
        controller.abort();
      },
      cancel() {
        cancelled = true;
      },
    },
    { highWaterMark: 0 },
  );
  await assert.rejects(
    validateCanvasToken(token, {
      signal: controller.signal,
      fetcher: async () => new Response(stream),
    }),
    { code: 'aborted' },
  );
  assert.equal(cancelled, true);
});
test('stream bytes are capped even without content-length', async () => {
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(1024 * 1024 + 1));
      controller.close();
    },
  });
  await assert.rejects(validateCanvasToken(token, { fetcher: async () => new Response(stream) }), {
    code: 'too_large',
  });
});
test('a repeated next page is rejected, not fetched repeatedly', async () => {
  let calls = 0;
  await assert.rejects(
    listCanvasCourses(token, {
      fetcher: async (url) => {
        calls++;
        const next = new URL(url);
        next.searchParams.set('page', '2');
        return json([], { link: `<${next}>; rel="next"` });
      },
    }),
    { code: 'unsafe_pagination' },
  );
  assert.equal(calls, 2);
});
test('invalid PDF signature is not served as a reading', async () => {
  await assert.rejects(
    getCanvasReading(token, 4, 7, {
      fetcher: async (url) =>
        url.includes('/api/')
          ? json({ 'content-type': 'application/pdf', url: `${CANVAS_ORIGIN}/files/7/download` })
          : new Response('<html>login</html>'),
    }),
    { code: 'unsupported_type' },
  );
});

test('HTML downloads are available only as study inputs, not ordinary active readings', async () => {
  const metadata = {
    id: 7,
    'content-type': 'text/html',
    display_name: 'overview.html',
    url: `${CANVAS_ORIGIN}/files/7/download`,
  };
  let downloads = 0;
  const fetcher = async (url) => {
    if (new URL(url).pathname.startsWith('/api/')) return json(metadata);
    downloads++;
    return new Response('<h1>Course overview</h1><script>untrusted()</script>', {
      headers: { 'content-type': 'text/html' },
    });
  };
  const file = await getCanvasStudyFile(token, 4, 7, { fetcher });
  assert.equal(file.mime, 'text/html');
  assert.equal(downloads, 1);
  await assert.rejects(getCanvasReading(token, 4, 7, { fetcher }), { code: 'unsupported_type' });
  await assert.rejects(getCanvasSyllabusFile(token, 4, 7, { fetcher }), {
    code: 'unsupported_type',
  });
  metadata['content-type'] = 'application/javascript';
  await assert.rejects(getCanvasStudyFile(token, 4, 7, { fetcher }), { code: 'unsupported_type' });
  assert.equal(downloads, 1);
});
