// Synthetic Canvas latency/interaction regression. Never loads owner accounts.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as wait } from 'node:timers/promises';
import { createReaderServer } from '../src/server/http.mjs';
import { createStudySet, retrieveStudyPassages } from '../src/server/study.mjs';
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
    async readCanvasSyllabus(_token, id) {
      if (id === '2')
        return {
          candidates: [
            {
              kind: 'page',
              title: 'Private professor syllabus',
              via: 'Private module',
              url: 'https://babson.instructure.com/courses/9988/assignments/syllabus',
              text: 'Private room and grade policy',
              evidence: {
                grading: [{ excerpt: 'Private grading formula' }],
                officeHours: [{ excerpt: 'Private office location' }],
              },
            },
            {
              kind: 'file',
              fileId: '993311',
              title: 'Private filename.pdf',
              via: 'Private module',
            },
          ],
          coverage: { complete: true, reasons: [] },
        };
      return { candidates: [], coverage: { complete: true } };
    },
    async listCanvasExportFiles() {
      return {
        files: [{ fileId: '11', title: 'Fixture notes.txt' }],
        coverage: { complete: true },
      };
    },
    async getCanvasExportFile(_token, id, fileId) {
      assert.equal(id, '1');
      assert.equal(fileId, '11');
      return {
        name: 'Fixture notes.txt',
        mime: 'text/plain',
        bytes: Buffer.from('Fixture notes.'),
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
    createStudySet,
    retrieveStudyPassages,
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
  browser = await chromium.launch({ ...browserOptions, downloadsPath: run.work });
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
  assert.equal(await page.locator('#canvas-disconnect').isVisible(), false);
  assert.equal(await page.locator('.app-header').count(), 0);
  assert.match(await page.locator('.semester-deadline-title').textContent(), /Upcoming reading/);
  assert.match(await page.locator('.semester-deadline-relative').textContent(), /Due in/);
  assert.match(await page.locator('.semester-deadline-when').textContent(), /Due today at/);
  await page.locator('.rail-main [data-view=planner]').click();
  await page
    .locator('#homework-planner')
    .getByRole('heading', { name: 'Your availability' })
    .waitFor();
  const icsTime = (time) => new Date(time).toISOString().replace(/[-:]|\.\d{3}/g, '');
  const start = Date.now() + 3_600_000;
  const calendar = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'BEGIN:VEVENT',
    'UID:study-fixture',
    `DTSTART:${icsTime(start)}`,
    `DTEND:${icsTime(start + 3_600_000)}`,
    'SUMMARY:Sample class',
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n');
  await page.locator('#homework-planner input[type=file]').setInputFiles({
    name: 'schedule.ics',
    mimeType: 'text/calendar',
    buffer: Buffer.from(calendar),
  });
  await page
    .locator('#homework-planner')
    .getByText(/1 busy block through/)
    .waitFor();
  await page.locator('#homework-planner').getByRole('button', { name: 'Remove calendar' }).click();
  await page.locator('.rail-main [data-view=courses]').click();

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
  await page
    .locator('.assignment-calendar-toolbar')
    .getByRole('button', { name: 'Today', exact: true })
    .click();
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
  await page.getByRole('combobox', { name: 'Course snapshot format' }).selectOption('zip');
  const archiveDownload = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download course snapshot' }).click();
  const archive = await archiveDownload;
  assert.equal(archive.suggestedFilename(), 'roger-course-1.zip');
  const archiveBytes = await readFile(await archive.path());
  assert.equal(archiveBytes.readUInt32LE(0), 0x04034b50);
  assert.ok(archiveBytes.includes(Buffer.from('files/11-Fixture-notes.txt')));
  await page
    .locator('.course-detail .canvas-assignment-row')
    .filter({ hasText: 'Missing essay 1' })
    .click();
  await page
    .locator('.canvas-assignment-detail h2')
    .filter({ hasText: 'Missing essay 1' })
    .waitFor();
  assert.equal(counts.assignment, 1, 'Warm assignment instructions are reused');
  await page.getByRole('button', { name: 'Study this', exact: true }).click();
  const study = page.locator('#assignment-study-slot');
  const build = study.getByRole('button', { name: 'Build set', exact: true });
  const notes = study.getByRole('textbox', { name: 'Your notes' });
  await notes.fill('Compare the assigned reading with evidence from the discussion.');
  await page.route(
    '**/api/study/set',
    async (route) => {
      await wait(2400);
      await route.abort('internetdisconnected');
    },
    { times: 1 },
  );
  await build.click();
  await study.locator('.loading-shape--practice').waitFor();
  assert.equal(await build.isEnabled(), false);
  assert.equal(await study.getByRole('button', { name: 'Cancel', exact: true }).isVisible(), true);
  await study.screenshot({ path: join(run.work, 'study-loading.png') });
  await study.getByText('Connection interrupted. Check your connection and try again.').waitFor();
  assert.equal(await study.locator('.loading-shape--practice').count(), 0);
  assert.equal(
    await notes.inputValue(),
    'Compare the assigned reading with evidence from the discussion.',
  );
  await build.click();
  await study.getByRole('button', { name: 'Show answer', exact: true }).click();
  await study.getByRole('button', { name: 'Go to instructions', exact: true }).click();
  assert.equal(await page.locator('#assignment-instructions:focus').count(), 1);
  await page.getByRole('button', { name: 'Study this', exact: true }).click();
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
  // A slow refresh may return successful courses alongside an unavailable one.
  const agendaApi = '**/api/canvas/assignments?*';
  await page.route(
    agendaApi,
    async (route) => {
      const response = await route.fetch();
      const result = await response.json();
      const unavailable = result.courses.find(({ courseId }) => courseId === '1');
      unavailable.assignments = [];
      unavailable.issue = 'Assignments could not be loaded. Try refreshing.';
      await wait(2400);
      await route.fulfill({ response, json: result });
    },
    { times: 1 },
  );
  const upcoming = page.locator('#semester-rows').getByText('Upcoming reading 1');
  await upcoming.waitFor();
  await page.locator('#semester-refresh').click();
  await page.locator('#semester-rows[aria-busy=true]').waitFor();
  assert.equal(await upcoming.isVisible(), true, 'Keep the last agenda visible while refreshing');
  await page.screenshot({ path: join(run.work, 'canvas-refresh.png') });
  await page.locator('#semester-assignment-status').filter({ hasText: 'COURSE101' }).waitFor();
  assert.equal(await upcoming.isVisible(), true, 'Keep the last results for the affected class');
  assert.match(
    await page.locator('#semester-assignment-status').textContent(),
    /previous results/i,
  );
  await page.waitForFunction(
    () => !globalThis.document.getElementById('semester-refresh').disabled,
  );
  assert.equal(counts.courses, 2);
  assert.equal(counts.assignments, 2);
  await page.locator('#semester-refresh').click();
  await page.locator('#semester-assignment-status').filter({ hasText: 'Updated' }).waitFor();
  assert.equal(await upcoming.isVisible(), true);
  await page.locator('.canvas-course-card').filter({ hasText: 'AI Development' }).click();
  await page.locator('.canvas-course-header h2').filter({ hasText: 'AI Development' }).waitFor();
  assert.equal(counts.course, 3, 'Explicit refresh also invalidates detail cache');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('#rail-more summary').click();
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
  await page.locator('.appearance-ai summary').click();
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
  await page.locator('.appearance-ai summary').click();
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
  await page.locator('.appearance-ai summary').click();
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
  // Continuous colors work without AI, persist exactly, and undo a whole drag.
  await page.locator('#customize-toggle').click();
  assert.equal(await page.getByRole('combobox', { name: 'Theme', exact: true }).count(), 0);
  assert.equal(await page.getByText('Make it yours', { exact: true }).count(), 0);
  await page.getByRole('textbox', { name: 'Hex color', exact: true }).fill('#724ac8');
  assert.equal(
    await page.locator('html').evaluate((el) => el.style.getPropertyValue('--accent')),
    '#724ac8',
  );
  await page.getByRole('textbox', { name: 'Hex color', exact: true }).fill('#zzzzzz');
  assert.equal(
    await page.locator('html').evaluate((el) => el.style.getPropertyValue('--accent')),
    '#724ac8',
  );
  await page.locator('#customize-close').click();
  await page.reload();
  await page.locator('.canvas-course-card').first().waitFor();
  assert.equal(
    await page.locator('html').evaluate((el) => el.style.getPropertyValue('--accent')),
    '#724ac8',
  );
  await page.locator('#customize-toggle').click();
  const wheel = await page.getByRole('group', { name: 'Color wheel', exact: true }).boundingBox();
  await page.mouse.move(wheel.x + wheel.width * 0.7, wheel.y + wheel.height / 2);
  await page.mouse.down();
  await page.mouse.move(wheel.x + wheel.width / 2, wheel.y + wheel.height * 0.85, { steps: 5 });
  await page.mouse.up();
  assert.notEqual(
    await page.locator('html').evaluate((el) => el.style.getPropertyValue('--accent')),
    '#724ac8',
  );
  await page.getByRole('button', { name: 'Undo last appearance', exact: true }).click();
  assert.equal(
    await page.locator('html').evaluate((el) => el.style.getPropertyValue('--accent')),
    '#724ac8',
  );
  await page.getByRole('button', { name: 'Background', exact: true }).click();
  await page.getByRole('textbox', { name: 'Hex color', exact: true }).fill('#c4d4e8');
  assert.equal(
    await page.locator('html').evaluate((el) => el.style.getPropertyValue('--canvas')),
    '#c4d4e8',
  );
  const brightness = page.getByRole('slider', { name: 'Brightness', exact: true });
  await brightness.focus();
  await brightness.press('ArrowLeft');
  assert.notEqual(
    await page.locator('html').evaluate((el) => el.style.getPropertyValue('--canvas')),
    '#c4d4e8',
  );
  assert.equal(appearanceCalls, 3, 'Manual colors never call the AI provider');
  await page.getByRole('button', { name: 'Use original Roger design', exact: true }).click();
  assert.equal(await page.locator('html').getAttribute('data-generated-appearance'), null);
  await page.locator('#customize-close').click();
  // Editing colors must not silently accept a generated, unkept design.
  const originalPalette = await page
    .locator('html')
    .evaluate((el) =>
      ['canvas', 'surface', 'ink'].map((key) =>
        globalThis.getComputedStyle(el).getPropertyValue(`--${key}`).trim(),
      ),
    );
  await page.locator('#customize-toggle').click();
  await page.locator('.appearance-ai summary').click();
  await page.locator('#appearance-request').fill('Create a meadow theme for manual editing');
  await page.getByRole('button', { name: 'Preview my space', exact: true }).click();
  await page.locator('#customize-drawer').waitFor({ state: 'hidden' });
  await page.locator('#customize-toggle').click();
  await page.getByRole('button', { name: 'Accent', exact: true }).click();
  await page.getByRole('textbox', { name: 'Hex color', exact: true }).fill('#244568');
  assert.equal(await page.locator('#roger-atmosphere .environment-motif').count(), 0);
  assert.deepEqual(
    await page
      .locator('html')
      .evaluate((el) =>
        ['canvas', 'surface', 'ink'].map((key) => el.style.getPropertyValue(`--${key}`).trim()),
      ),
    originalPalette,
  );
  assert.equal(await page.locator('.appearance-preview-notice').isVisible(), false);
  await page
    .locator('.appearance-status')
    .filter({ hasText: 'unkept AI preview was discarded' })
    .waitFor();
  await page.getByRole('button', { name: 'Use original Roger design', exact: true }).click();
  await page.locator('#customize-close').click();
  assert.equal(appearanceCalls, 4);
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
  await page.evaluate(() => localStorage.setItem('private-workspace-check', 'private-test-value'));
  await page.route('http://localhost:**/*', (route) => route.continue());
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const maskedStart = { ...counts };
  await page.getByRole('switch', { name: 'Demo mode' }).click();
  await page.getByText('Demo mode · live Canvas, details masked').waitFor();
  await page.locator('#semester-assignment-status').filter({ hasText: 'Updated' }).waitFor();
  assert.ok(counts.courses > maskedStart.courses);
  assert.ok(counts.assignments > maskedStart.assignments);
  assert.equal(await page.evaluate(() => localStorage.getItem('private-workspace-check')), null);
  await page.locator('.canvas-course-card').filter({ hasText: 'Course 2' }).click();
  await page.getByRole('button', { name: 'Syllabus', exact: true }).click();
  await page.getByText('Sample office hours: Tuesdays', { exact: false }).waitFor();
  assert.doesNotMatch(
    await page.locator('body').innerText(),
    /Fixture student|Missing essay|Private professor|Private grading|Private filename/,
  );
  const maskedPayloads = await page.evaluate(async () => {
    const get = async (path) => (await fetch(path)).json();
    const session = await get('/api/session');
    const answer = await fetch('/api/demo/ask', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Reader-CSRF': session.csrf },
      body: JSON.stringify({ message: 'What are Course 2 office hours?', courseId: '2' }),
    });
    const blocked = await fetch('/api/canvas/syllabus-file', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Reader-CSRF': session.csrf },
      body: JSON.stringify({ courseId: '2', fileId: '993311' }),
    });
    return {
      syllabus: await get('/api/canvas/syllabus?id=2'),
      assignments: await get('/api/canvas/assignments?courseId=2'),
      answer: await answer.json(),
      blocked: blocked.status,
    };
  });
  assert.equal(maskedPayloads.assignments.courses[0].assignments[0].status, 'unsubmitted');
  assert.equal(maskedPayloads.assignments.courses[0].assignments[1].status, 'submitted');
  assert.equal(maskedPayloads.syllabus.candidates.length, 2);
  assert.match(maskedPayloads.syllabus.candidates[1].note, /samples for recording/);
  assert.match(maskedPayloads.syllabus.candidates[1].evidence.grading[0].excerpt, /Sample grading/);
  assert.equal(maskedPayloads.answer.passages[0].destination.section, 'syllabus');
  assert.equal(maskedPayloads.blocked, 403);
  assert.doesNotMatch(
    JSON.stringify(maskedPayloads),
    /Private|babson\.instructure\.com|993311|9988|Missing essay/,
  );
  await page.getByRole('button', { name: 'Assignments', exact: true }).click();
  await page.locator('.canvas-course-content .canvas-assignment-row').first().click();
  await page.getByRole('button', { name: 'Study this', exact: true }).click();
  const maskedStudy = page.locator('#assignment-study-slot');
  await maskedStudy.getByRole('button', { name: 'Build set', exact: true }).click();
  await maskedStudy.getByRole('button', { name: 'Show answer', exact: true }).click();
  await maskedStudy.getByRole('button', { name: 'Go to instructions', exact: true }).click();
  assert.equal(await maskedStudy.getByLabel('Add a note file').count(), 0);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const demoSwitch = page.getByRole('switch', { name: 'Demo mode' });
  assert.equal(await demoSwitch.getAttribute('aria-checked'), 'true');
  await demoSwitch.click();
  await page.waitForURL(origin + '/?setup=settings');
  await page.locator('#canvas-status').filter({ hasText: 'Fixture student' }).waitFor();
  assert.equal(await demoSwitch.getAttribute('aria-checked'), 'false');
  const liveCounts = { ...counts };
  const crossSiteDemo = await page.request.get(origin + '/demo', {
    headers: { 'Sec-Fetch-Site': 'cross-site' },
  });
  assert.equal(crossSiteDemo.status(), 403);
  await page.unrouteAll();
  const context = page.context();
  await context.route('**/*', (route) => {
    const host = new URL(route.request().url()).hostname;
    if (host === 'localhost' || route.request().url() === origin + '/demo') return route.continue();
    external.push(route.request().url());
    return route.abort();
  });
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const [demo] = await Promise.all([
    context.waitForEvent('page'),
    page.evaluate(() => void globalThis.open('/demo', '_blank', 'noopener')),
  ]);
  demo.on('pageerror', (error) => errors.push(error.message));
  await demo.getByText('Demo mode · fictional courses and assignments').waitFor();
  await demo.locator('#semester-assignment-status').filter({ hasText: 'Updated' }).waitFor();
  assert.equal(new URL(demo.url()).hostname, 'localhost');
  assert.equal(await demo.title(), 'Roger Demo mode');
  assert.equal(await demo.locator('.canvas-course-card').count(), 4);
  assert.match(
    await demo.locator('.canvas-course-card').first().textContent(),
    /Designing Better Cities/,
  );
  assert.doesNotMatch(
    await demo.locator('body').innerText(),
    /Fixture student|Upcoming reading|marked missing/,
  );
  assert.equal(await demo.evaluate(() => localStorage.getItem('private-workspace-check')), null);
  const demoChecks = await demo.evaluate(async () => {
    const get = async (url) => (await fetch(url)).json();
    const assignments = await get('/api/canvas/assignments');
    return {
      session: (await get('/api/session')).canvas,
      states: assignments.courses.flatMap((course) =>
        course.assignments.map(({ status }) => status),
      ),
      names: assignments.courses.flatMap((course) => course.assignments.map(({ name }) => name)),
      threads: (await get('/api/memory/threads')).threads,
      providerWrite: (await fetch('/api/connections/ask', { method: 'POST' })).status,
    };
  });
  assert.deepEqual(demoChecks.session, { name: 'Sample student' });
  assert.equal(demoChecks.states.length, 16);
  assert.equal(new Set(demoChecks.names).size, 16);
  assert.ok(!demoChecks.states.includes('missing'));
  assert.deepEqual(demoChecks.threads, []);
  assert.equal(demoChecks.providerWrite, 403);
  assert.equal(
    await demo.evaluate(
      async () =>
        (
          await fetch('/api/demo/ask', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message: 'How is Everyday Astronomy graded?' }),
          })
        ).status,
    ),
    403,
  );
  await demo.getByRole('button', { name: 'Ask Roger', exact: true }).click();
  const reply = demo.locator('#roger-widget-response');
  const askDemo = async (question, expected) => {
    await demo.getByRole('textbox', { name: 'Ask Roger' }).fill(question);
    await demo.getByRole('button', { name: 'Send question' }).click();
    await reply.filter({ hasText: expected }).waitFor();
  };
  await askDemo(
    'What do I submit for the Neighborhood redesign brief?',
    /two-page redesign brief.*\[1\]/,
  );
  await demo.getByRole('button', { name: '[1] Neighborhood redesign brief · Assignment' }).click();
  await demo
    .locator('#assignment-instructions')
    .filter({ hasText: 'labeled street sketch' })
    .waitFor();
  await askDemo(
    'How does grading work in Everyday Astronomy and when are office hours?',
    /Observation logs count for 50%.*Observatory 105.*\[1\]/,
  );
  await demo.getByRole('button', { name: '[1] Everyday Astronomy syllabus · Syllabus' }).click();
  await demo
    .locator('#course-detail')
    .getByText('Office hours are Wednesdays', { exact: false })
    .waitFor();
  await askDemo('Why does the Moon change phases?', /different portions of its sunlit half.*\[1\]/);
  await demo.getByRole('button', { name: '[1] A guide to lunar phases · Course reading' }).click();
  await demo
    .locator('#course-detail')
    .getByText('The Moon reflects sunlight.', { exact: false })
    .waitFor();
  await askDemo('What is my actual GPA?', /couldn’t find that in the demo materials/);
  await demo.getByRole('button', { name: 'Close Ask Roger' }).click();
  await demo.locator('.rail-main [data-view=courses]').click();
  await demo
    .getByRole('button', { name: /Designing Better Cities.*Assignments & readings/ })
    .click();
  await demo.getByRole('button', { name: 'Announcements', exact: true }).click();
  await demo.getByRole('button', { name: 'Materials for the next class' }).click();
  await demo.getByText('Read the review notes', { exact: false }).waitFor();
  await demo.getByRole('button', { name: 'Discussions', exact: true }).click();
  await demo.getByRole('button', { name: 'Share a first observation' }).click();
  await demo
    .locator('.canvas-community-replies .canvas-community-replies')
    .getByText('Which detail helped', { exact: false })
    .waitFor();
  await demo.getByRole('button', { name: 'Groups', exact: true }).click();
  await demo.getByRole('button', { name: 'Studio team', exact: true }).click();
  await demo
    .getByRole('group', { name: 'Group sections' })
    .getByRole('button', { name: 'Announcements' })
    .click();
  await demo.getByRole('button', { name: 'Materials for the next class' }).waitFor();
  await demo.locator('.rail-main [data-view=courses]').click();
  await demo.locator('.desk-links [data-view=resources]').click();
  await demo.getByRole('heading', { name: 'Find books', exact: true }).waitFor();
  assert.equal(await demo.locator('#resource-news').isVisible(), false);
  await demo
    .getByRole('searchbox', { name: 'Title, author, subject or ISBN' })
    .fill('Pride and Prejudice');
  await demo.getByRole('button', { name: 'Search books', exact: true }).click();
  await demo.getByRole('heading', { name: 'Pride and Prejudice', exact: true }).waitFor();
  await demo.locator('.rail-main [data-view=courses]').click();
  await demo.locator('.desk-links [data-view=research]').click();
  await demo.getByRole('heading', { name: 'News & research', exact: true }).waitFor();
  assert.equal(await demo.getByRole('searchbox').isVisible(), false);
  assert.equal(await demo.locator('#research-content .news-logo').count(), 19);
  for (const title of [
    'The Washington Post',
    'Boston Business Journal',
    'S&P Capital IQ',
    'Mintel',
  ])
    assert.equal(await demo.getByRole('link', { name: title, exact: true }).isVisible(), true);
  await demo.locator('.rail-main [data-view=courses]').click();
  await demo.locator('.desk-links [data-view=tools]').click();
  const grades = demo.locator('#weighted-calculator');
  for (const [name, value] of [
    ['score-1', '80'],
    ['weight-1', '30'],
    ['score-2', '90'],
    ['weight-2', '20'],
  ])
    await grades.locator(`[name=${name}]`).fill(value);
  await grades.getByRole('button', { name: 'Calculate grade' }).click();
  await grades.locator('output').filter({ hasText: '84% average across 50%' }).waitFor();
  await grades.locator('[name=weight-2]').fill('80');
  await grades.getByRole('button', { name: 'Calculate grade' }).click();
  await grades
    .locator('output')
    .filter({ hasText: 'Weights cannot add up to more than 100%' })
    .waitFor();
  const gpa = demo.locator('#gpa-calculator');
  await gpa.getByLabel('Letter grade').nth(0).selectOption('4');
  await gpa.getByLabel('Credits').nth(0).fill('4');
  await gpa.getByLabel('Letter grade').nth(1).selectOption('3');
  await gpa.getByLabel('Credits').nth(1).fill('2');
  await gpa.getByRole('button', { name: 'Calculate GPA' }).click();
  await gpa.getByText('3.67 estimated GPA across 6 credits.').waitFor();
  const target = demo.locator('#target-calculator');
  await target.locator('[name=average]').fill('80');
  await target.locator('[name=completed]').fill('50');
  await target.locator('[name=target]').fill('85');
  await target.getByRole('button', { name: 'Find required score' }).click();
  await target.getByText('Aim for 90% across the remaining 50% of the course.').waitFor();
  const breakEven = demo.locator('#break-even-calculator');
  await breakEven.locator('[name=fixed]').fill('1000');
  await breakEven.locator('[name=price]').fill('30');
  await breakEven.locator('[name=variable]').fill('12');
  await breakEven.getByRole('button', { name: 'Find break-even' }).click();
  await breakEven.getByText('Break even at 56 units with $18.00 contribution per unit.').waitFor();
  await demo.setViewportSize({ width: 390, height: 844 });
  const fitsViewport = () =>
    globalThis.document.documentElement.scrollWidth <= globalThis.innerWidth;
  assert.equal(await demo.evaluate(fitsViewport), true);
  const mobileNotice = await demo.locator('.app-preview-notice').boundingBox();
  const mobileNav = await demo.locator('.app-rail').boundingBox();
  assert.ok(
    mobileNotice.y + mobileNotice.height <= mobileNav.y,
    'Demo notice clears mobile navigation',
  );
  await demo.getByRole('button', { name: 'Open calculator', exact: true }).click();
  const finance = demo.locator('#finance-calculator');
  const output = finance.locator('output');
  const press = async (...keys) => {
    for (const key of keys) await finance.locator(`[data-key="${key}"]`).click();
  };
  await finance.locator('[data-key="ON"]').waitFor();
  assert.equal(await finance.locator('#finance-keypad button').count(), 44);
  for (const [width, height] of [
    [430, 740],
    [320, 568],
    [844, 390],
    [568, 320],
  ]) {
    await demo.setViewportSize({ width, height });
    assert.equal(await demo.evaluate(fitsViewport), true);
    assert.equal(await demo.locator('.app-rail').isVisible(), false);
    const allKeysFit = await finance.locator('#finance-keypad button').evaluateAll((keys) =>
      keys.every((key) => {
        const rect = key.getBoundingClientRect();
        return (
          rect.top >= 0 &&
          rect.bottom <= globalThis.innerHeight &&
          rect.width >= 44 &&
          rect.height >= 44
        );
      }),
    );
    assert.ok(allKeysFit, `All 44 keys fit at ${width}×${height} with 44px targets`);
    const notice = await demo.locator('.app-preview-notice').boundingBox();
    const heading = await demo.locator('#finance-view-heading').boundingBox();
    assert.ok(notice.y + notice.height <= heading.y, 'Demo notice must not cover the calculator');
    await demo.screenshot({ path: join(run.work, `calculator-${width}x${height}.png`) });
  }
  await demo.setViewportSize({ width: 390, height: 844 });
  assert.equal(await demo.locator('.app-rail').isVisible(), false);
  assert.equal(await demo.evaluate(fitsViewport), true);
  const keySize = await finance.locator('[data-key="0"]').boundingBox();
  assert.ok(keySize.width >= 44 && keySize.height >= 44);
  await press('ON');
  assert.equal(await output.textContent(), '');
  await press('ON', '2ND');
  assert.equal(await finance.locator('[data-key="2ND"]').getAttribute('aria-pressed'), 'true');
  await press('IY', '1', '2', 'ENTER', '2ND', 'CPT');
  await press('1', '2', 'N', '5', 'IY', '1', '0', '0', '0', 'SIGN', 'PV', 'CPT', 'FV');
  assert.equal(Number((await output.textContent()).replaceAll(',', '')), 1051.16);
  await press('2ND', 'FV', '1', '2', 'N', '1', '2', '0', '0', 'PV', 'CPT', 'PMT');
  assert.equal(Number((await output.textContent()).replaceAll(',', '')), -100);
  await press('CF', '2ND', 'CE', '1', '0', '0', 'SIGN', 'ENTER', 'DOWN');
  await press('6', '0', 'ENTER', 'DOWN', 'DOWN', '6', '0', 'ENTER');
  await press('NPV', '1', '0', 'ENTER', 'DOWN', 'CPT');
  assert.equal(Number((await output.textContent()).replaceAll(',', '')), 4.13);
  await press('IRR', 'CPT');
  assert.equal(Number((await output.textContent()).replaceAll(',', '')), 13.07);
  await demo.getByRole('button', { name: '← Student tools', exact: true }).click();
  await demo.getByRole('button', { name: 'Open calculator', exact: true }).click();
  assert.equal(Number((await output.textContent()).replaceAll(',', '')), 13.07);
  await demo.getByRole('button', { name: '← Student tools', exact: true }).click();
  await demo.locator('.rail-main [data-view=courses]').click();
  assert.equal(await demo.evaluate(fitsViewport), true);
  assert.equal(await demo.locator('#roger-widget-sources article').count(), 0);
  assert.equal(await demo.locator('a[href*="babson.instructure.com"]').count(), 0);
  assert.deepEqual(
    await demo.evaluate(async () => (await (await fetch('/api/memory/threads')).json()).threads),
    [],
  );
  assert.deepEqual(counts, liveCounts);
  assert.equal(new URL(page.url()).origin, origin);
  assert.equal(
    await page.evaluate(() => localStorage.getItem('private-workspace-check')),
    'private-test-value',
  );
  assert.deepEqual(errors, []);
  assert.deepEqual(external, []);
  console.log(
    JSON.stringify({
      result: 'Semester/status/calendar/drawer/appearance and recording demo workflows passed',
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
