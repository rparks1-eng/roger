// Synthetic Canvas latency/interaction regression. Never loads owner accounts.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { performance } from 'node:perf_hooks';
import { createReaderServer } from '../src/server/http.mjs';
import { browserOptions, qaScratch } from './quality/scratch.mjs';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.READER_PLAYWRIGHT_MODULE || 'playwright');
const run = await qaScratch();
const courses = ['AI Development', 'Finance', 'Short Story', 'Creative Writing'].map(
  (name, index) => ({ id: String(index + 1), name, code: `COURSE${index + 101}`, termId: 'fall' }),
);
let appearanceCalls = 0,
  fixtureTime = 0;
const appearance = {
  version: 1,
  title: 'Fixture meadow',
  palette: { canvas: '#e8efe4', surface: '#f3f6ee', ink: '#18201e', accent: '#315d47' },
  font: 'rounded',
  radius: 22,
  motion: 'bounce',
  motifs: ['🍄', '⭐'],
};
const counts = { courses: 0, assignments: 0, course: 0, assignment: 0 };
const day = new Date();
const due = new Date(day.getFullYear(), day.getMonth(), day.getDate(), 23, 59).toISOString();
const prior = new Date(day.getFullYear(), day.getMonth(), day.getDate() - 1, 23, 59).toISOString();
const records = (courseId) => [
  {
    id: `${courseId}01`,
    name: `Missing essay ${courseId}`,
    status: 'missing',
    dueAt: prior,
    submitted: false,
    locked: false,
    points: 10,
  },
  {
    id: `${courseId}02`,
    name: `Upcoming reading ${courseId}`,
    status: 'unsubmitted',
    dueAt: due,
    submitted: false,
    locked: false,
    points: 5,
  },
  {
    id: `${courseId}03`,
    name: `Submitted exercise ${courseId}`,
    status: 'submitted',
    dueAt: prior,
    submitted: true,
    locked: false,
    points: 5,
  },
];
const delay = (signal) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(finish, 80);
    function finish() {
      signal?.removeEventListener('abort', abort);
      resolve();
    }
    function abort() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      reject(new Error('Fixture cancelled'));
    }
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  });
let releaseAgenda;
const firstAgenda = new Promise((resolve) => {
  releaseAgenda = resolve;
});
const server = createReaderServer({
  // Several complete sessions are compressed into seconds; quota behavior has separate tests.
  clock: () => Date.now() + fixtureTime,
  configuredCanvas: { token: 'synthetic-not-a-token', profile: { name: 'Fixture student' } },
  canvasAdapter: {
    async listCanvasCourses(_token, { signal }) {
      counts.courses++;
      await delay(signal);
      return { courses, terms: [{ id: 'fall', name: 'Fall 2026' }], currentTermId: 'fall' };
    },
    async listCanvasAssignments(_token, ids, { signal }) {
      counts.assignments++;
      if (counts.assignments === 1) await firstAgenda;
      await delay(signal);
      return { courses: ids.map((courseId) => ({ courseId, assignments: records(courseId) })) };
    },
    async readCanvasCourse(_token, id, { signal }) {
      counts.course++;
      await delay(signal);
      return {
        course: courses.find((course) => course.id === id),
        assignments: records(id),
        modules: [],
      };
    },
    async readCanvasAssignment(_token, courseId, id, { signal }) {
      counts.assignment++;
      await delay(signal);
      return {
        assignment: {
          ...records(courseId).find((item) => item.id === id),
          descriptionHtml: '<p>Read the assigned text and explain your reasoning.</p>',
          submissionTypes: ['online_upload'],
          canSubmit: false,
        },
      };
    },
  },
  studyAdapter: {
    async providerStatus() {
      return { providers: [] };
    },
  },
  documentAdapter: {
    async getDocumentProcessingStatus() {
      return { ocr: { available: false } };
    },
  },
  narrationAdapter: {
    async status() {
      return { available: false, voices: [] };
    },
  },
  connectionFactory: () => ({
    async status() {
      return {
        selected: { provider: 'codex', model: 'account-default' },
        providers: [
          {
            id: 'codex',
            name: 'Fixture AI',
            method: 'account',
            state: 'connected',
            models: ['account-default'],
            model: 'account-default',
            detail: 'Synthetic regression provider',
          },
        ],
      };
    },
    async generate({ prompt }) {
      appearanceCalls++;
      fixtureTime += 65_000;
      if (prompt.includes('FAIL_APPEARANCE')) throw new Error('Fixture appearance failure');
      return JSON.stringify(appearance);
    },
    dispose() {},
  }),
});
let browser;
try {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch(browserOptions);
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
  page.setDefaultTimeout(10_000);
  const errors = [],
    external = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/*', (route) => {
    if (
      route
        .request()
        .url()
        .startsWith(origin + '/')
    )
      return route.continue();
    external.push(route.request().url());
    return route.abort();
  });
  await page.goto(origin);
  await page.locator('.canvas-course-card').first().waitFor();
  assert.equal(await page.locator('.canvas-course-card').count(), 4);
  assert.equal(
    await page.locator('.canvas-course-card:disabled').count(),
    0,
    'Course navigation must not wait for all assignments',
  );
  assert.equal(await page.locator('.loading-shape--agenda').isVisible(), true);
  releaseAgenda();
  await page.locator('#semester-assignment-status').filter({ hasText: 'Updated' }).waitFor();
  assert.equal(counts.courses, 1);
  assert.equal(counts.assignments, 1);
  assert.equal(await page.locator('.agenda-date-group').first().textContent(), 'Today');
  await page.locator('.semester-missing-link').click();
  assert.equal(
    await page.locator('#semester-rows .canvas-assignment-row[data-tone="danger"]').count(),
    4,
  );
  assert.equal(await page.locator('#semester-rows .canvas-badge').first().textContent(), 'Missing');
  const red = await page
    .locator('#semester-rows .canvas-badge')
    .first()
    .evaluate((node) => globalThis.getComputedStyle(node).color);
  assert.equal(red, 'rgb(155, 38, 58)');
  await page.locator('#semester-status').selectOption('all');
  await page.getByRole('button', { name: 'Calendar', exact: true }).click();
  assert.equal(await page.locator('.calendar-day[data-today="true"]').count(), 1);
  assert.equal(await page.locator('.calendar-assignment[data-tone="danger"]').count(), 4);
  await page.getByRole('button', { name: 'Next month', exact: true }).click();
  await page.getByRole('button', { name: 'Today', exact: true }).click();
  await page.locator('.calendar-assignment').filter({ hasText: 'Missing essay 1' }).click();
  await page
    .locator('.canvas-assignment-detail h2')
    .filter({ hasText: 'Missing essay 1' })
    .waitFor();
  assert.equal(counts.assignment, 1);
  await page.getByRole('button', { name: '← All Assignments', exact: true }).click();
  await page.getByRole('button', { name: 'This Semester', exact: true }).click();
  let started = performance.now();
  await page.locator('.canvas-course-card').filter({ hasText: 'AI Development' }).click();
  await page.locator('.canvas-course-header h2').filter({ hasText: 'AI Development' }).waitFor();
  const coldCourseMs = performance.now() - started;
  await page.getByRole('button', { name: '← This Semester', exact: true }).click();
  started = performance.now();
  await page.locator('.canvas-course-card').filter({ hasText: 'AI Development' }).click();
  await page.locator('.canvas-course-header h2').filter({ hasText: 'AI Development' }).waitFor();
  const warmCourseMs = performance.now() - started;
  assert.equal(counts.course, 1, 'A warm course open must not make another Canvas call');
  await page
    .locator('.course-detail .canvas-assignment-row')
    .filter({ hasText: 'Missing essay 1' })
    .click();
  await page
    .locator('.canvas-assignment-detail h2')
    .filter({ hasText: 'Missing essay 1' })
    .waitFor();
  assert.equal(counts.assignment, 1, 'Warm assignment instructions are reused');
  await page.locator('#customize-toggle').click();
  await page.locator('#customize-drawer').waitFor();
  assert.equal(await page.locator('.canvas-assignment-detail h2').textContent(), 'Missing essay 1');
  assert.equal(await page.locator('.primary-nav [data-view="customize"]').count(), 0);
  await page.getByRole('combobox', { name: 'Text size', exact: true }).selectOption('larger');
  assert.equal(await page.locator('html').getAttribute('data-font-size'), 'larger');
  await page.locator('#customize-close').press('Escape');
  await page.locator('#customize-drawer').waitFor({ state: 'hidden' });
  assert.equal(
    await page
      .locator('#customize-toggle')
      .evaluate((element) => element === globalThis.document.activeElement),
    true,
  );
  await page.getByRole('button', { name: '← This Semester', exact: true }).click();
  await page.locator('#semester-refresh').click();
  await page.locator('#semester-refresh').waitFor({ state: 'visible' });
  await page.waitForFunction(
    () => !globalThis.document.getElementById('semester-refresh').disabled,
  );
  assert.equal(counts.courses, 2);
  assert.equal(counts.assignments, 2);
  await page.locator('.canvas-course-card').filter({ hasText: 'AI Development' }).click();
  await page.locator('.canvas-course-header h2').filter({ hasText: 'AI Development' }).waitFor();
  assert.equal(counts.course, 2, 'Explicit refresh also invalidates detail cache');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('#customize-toggle').click();
  assert.equal(
    await page.evaluate(
      () => globalThis.document.documentElement.scrollWidth <= globalThis.innerWidth,
    ),
    true,
  );
  const bounds = await page.locator('#customize-drawer').boundingBox();
  assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= 390);
  await page.locator('#customize-close').click();
  await page.setViewportSize({ width: 1200, height: 900 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.locator('#customize-toggle').click();
  await page.locator('#appearance-request').fill('Create a meadow theme');
  await page.getByRole('button', { name: 'Preview my space', exact: true }).click();
  await page.locator('#customize-drawer').waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: 'Keep this appearance', exact: true }).waitFor();
  assert.equal(await page.locator('html').getAttribute('data-generated-appearance'), 'true');
  assert.equal(
    await page
      .locator('.environment-motif')
      .first()
      .evaluate((node) => globalThis.getComputedStyle(node).animationName),
    'none',
  );
  await page.getByRole('button', { name: 'Restore previous appearance', exact: true }).click();
  assert.equal(await page.locator('html').getAttribute('data-generated-appearance'), null);
  await page.locator('#customize-toggle').click();
  await page.locator('#appearance-request').fill('Create a meadow theme again');
  await page.getByRole('button', { name: 'Preview my space', exact: true }).click();
  await page.locator('#customize-drawer').waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: 'Keep this appearance', exact: true }).click();
  assert.equal(await page.locator('.appearance-preview-notice').isVisible(), false);
  await page.reload();
  await page.locator('.canvas-course-card').first().waitFor();
  await page.locator('#semester-assignment-status').filter({ hasText: 'Updated' }).waitFor();
  assert.equal(await page.locator('html').getAttribute('data-generated-appearance'), 'true');
  assert.equal(
    await page.locator('html').evaluate((node) => node.style.getPropertyValue('--canvas')),
    appearance.palette.canvas,
  );
  assert.equal(await page.locator('.appearance-preview-notice').isVisible(), false);
  await page.locator('#customize-toggle').click();
  await page.getByRole('button', { name: 'Undo last appearance', exact: true }).click();
  assert.equal(await page.locator('html').getAttribute('data-generated-appearance'), null);
  await page.locator('#appearance-request').fill('FAIL_APPEARANCE');
  await page.getByRole('button', { name: 'Preview my space', exact: true }).click();
  await page
    .locator('.appearance-status')
    .filter({ hasText: 'The request could not be completed' })
    .waitFor();
  assert.equal(
    await page.locator('#customize-drawer').isVisible(),
    true,
    'A failed generation must leave the form and error reachable',
  );
  assert.equal(await page.locator('.appearance-preview-notice').isVisible(), false);
  await page.locator('#customize-close').click();
  await page.reload();
  await page.locator('.canvas-course-card').first().waitFor();
  await page.locator('#semester-assignment-status').filter({ hasText: 'Updated' }).waitFor();
  assert.equal(
    await page.locator('html').getAttribute('data-generated-appearance'),
    null,
    'Undo must survive reload',
  );
  assert.equal(appearanceCalls, 3);
  const navigation = await page.evaluate(async () => {
    const { createCanvasPanel } = await import('/client/canvas-ui.mjs');
    const course = { id: '42', name: 'Navigation fixture', code: 'TEST42', termId: 'current' };
    const assignment = {
      id: '4201',
      name: 'Navigation assignment',
      status: 'missing',
      dueAt: new Date().toISOString(),
      submitted: false,
      points: 10,
      submissionTypes: ['online_upload'],
      descriptionHtml:
        '<p>Use the assigned sources.</p><script>Do not expose this script.</script>',
      canSubmit: false,
    };
    const panel = createCanvasPanel({
      state: { connected: true },
      api: async (url) => {
        const parsed = new URL(url, globalThis.location.origin);
        if (parsed.pathname === '/api/canvas/courses')
          return {
            courses: [course],
            terms: [{ id: 'current', name: 'Current' }],
            currentTermId: 'current',
          };
        if (parsed.pathname === '/api/canvas/assignments')
          return { courses: [{ courseId: '42', assignments: [assignment] }] };
        if (parsed.pathname === '/api/canvas/course')
          return { course, assignments: [assignment], modules: [] };
        if (parsed.pathname === '/api/canvas/assignment') return { assignment };
        throw new Error('Unexpected navigation fixture request');
      },
      importFile: async () => {},
      status: () => {},
    });
    panel.restore({ name: 'Navigation fixture' });
    await panel.loadCourses({ reuse: true });
    const index = panel.getNavigationIndex();
    await panel.navigate({ courseId: '42' });
    const courseContext = panel.getContext();
    await panel.navigate({ courseId: '42', assignmentId: '4201' });
    const assignmentContext = panel.getContext();
    const sources = panel.getSourceContext();
    let rejected = false;
    try {
      await panel.navigate({ courseId: 'outside' });
    } catch {
      rejected = true;
    }
    panel.restore(null);
    return {
      index,
      courseContext,
      assignmentContext,
      sources,
      rejected,
      cleared: panel.getSourceContext(),
      emptyIndex: panel.getNavigationIndex(),
    };
  });
  assert.equal(navigation.index.courses[0].id, '42');
  assert.equal(navigation.index.assignments[0].courseId, '42');
  assert.equal(navigation.courseContext.courseTitle, 'Navigation fixture');
  assert.equal(navigation.courseContext.assignmentId, null);
  assert.equal(navigation.assignmentContext.assignmentTitle, 'Navigation assignment');
  assert.equal(navigation.assignmentContext.courseId, '42');
  assert.match(navigation.sources[0].text, /Use the assigned sources/);
  assert.doesNotMatch(navigation.sources[0].text, /expose this script/);
  assert.equal(navigation.rejected, true);
  assert.deepEqual(navigation.cleared, []);
  assert.deepEqual(navigation.emptyIndex, { courses: [], assignments: [] });
  assert.deepEqual(errors, []);
  assert.deepEqual(external, []);
  console.log(
    JSON.stringify({
      result: 'Semester/status/calendar/drawer/appearance workflow passed',
      appearanceCalls,
      syntheticCanvasDelayMs: 80,
      coldCourseMs: Math.round(coldCourseMs),
      warmCourseMs: Math.round(warmCourseMs),
      warmExtraCourseCalls: 0,
      counts,
    }),
  );
} finally {
  releaseAgenda();
  await browser?.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await run.close();
}
