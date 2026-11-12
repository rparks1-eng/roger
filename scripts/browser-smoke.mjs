// Browser regression uses synthetic documents and intercepted AI/Canvas only.
// QA dependency is external to the runtime app; no install or real provider call.
import { browserOptions } from './quality/scratch.mjs';
import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.READER_PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.READER_QA_URL || 'http://127.0.0.1:3847';
const output = process.env.CODEX_ARTIFACT_DIR;
if (!output || !path.isAbsolute(output))
  throw new Error('Set CODEX_ARTIFACT_DIR to a managed scratch directory.');
await mkdir(output, { recursive: true });
const browser = await chromium.launch(browserOptions);
const errors = [],
  requests = [];
let checks = 0;
try {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    acceptDownloads: true,
  });
  const page = await context.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  // Preserve the real local session/CSRF boundary but isolate fixtures from any
  // explicitly provisioned owner connection. All Canvas routes below are mocked.
  await page.route('**/api/session', async (route) => {
    const response = await route.fetch();
    const value = await response.json();
    await route.fulfill({ json: { ...value, canvas: null } });
  });
  await page.route('**/api/providers', (route) =>
    route.fulfill({
      json: {
        providers: [
          { id: 'ollama', label: 'Qwen · test fixture', state: 'available' },
          { id: 'codex', label: 'Codex · test fixture', state: 'available' },
        ],
      },
    }),
  );
  await page.route('**/api/study', async (route) => {
    const body = route.request().postDataJSON();
    requests.push(body);
    await route.fulfill({
      json: {
        reply: 'Clear boundaries keep the reading app separate from unrelated personal tools.',
        passages: [],
        question: 'Which boundary would you test first?',
      },
    });
  });
  await page.goto(base);
  await page.locator('.primary-nav [data-view=library]').click();
  await page.locator('#upload-inline').waitFor();
  assert.equal(await page.locator('.sidebar,.brand-mark').count(), 0);
  checks++;
  assert.equal(await page.locator('#reader-view').isVisible(), false);
  checks++;
  await page.screenshot({ path: path.join(output, 'library-desktop.png'), fullPage: true });
  const text =
    'READING WORKFLOW\n\nProjects need clear boundaries. A reader should open the document you choose, not an old story.\n\nEvidence belongs beside an answer. Local reading should work even when AI is unavailable.\n\nNotes remain the student’s own work.';
  await page.locator('#upload-input').setInputFiles({
    name: 'Project reading.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from(text),
  });
  await page.locator('#document-title').filter({ hasText: 'Project reading.txt' }).waitFor();
  assert.ok(
    (await page.locator('#document-text').textContent()).includes(
      'Projects need clear boundaries.',
    ),
  );
  checks++;
  await page.locator('#question-input').fill('Why do boundaries matter?');
  await page.locator('#ask-button').click();
  await page.locator('#answer-output').filter({ hasText: 'Clear boundaries' }).waitFor();
  assert.equal(requests.length, 1);
  assert.ok(requests[0].text.includes('Projects need clear boundaries.'));
  checks++;
  await page.locator('#notes-input').fill('Keep course work independent from personal tools.');
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.locator('#save-notes').click(),
  ]);
  assert.equal(download.suggestedFilename(), 'Project reading-notes.md');
  checks++;
  await page.screenshot({ path: path.join(output, 'reader-desktop.png'), fullPage: true });
  await page.locator('#question-scope').selectOption('library');
  await page.locator('#question-input').fill('xylophone marmalade');
  await page.locator('#ask-button').click();
  await page.locator('#app-status').filter({ hasText: 'No matching source' }).waitFor();
  assert.equal(requests.length, 1);
  checks++;
  await page.locator('#provider-select').selectOption('codex');
  await page.locator('#question-scope').selectOption('page');
  await page.locator('#question-input').fill('What is the purpose?');
  await page.locator('#ask-button').click();
  await page.locator('#app-status').filter({ hasText: 'Allow' }).waitFor();
  assert.equal(requests.length, 1);
  checks++;
  const fixture = await context.newPage();
  await fixture.setContent(
    '<main><h1>Source page one</h1><p>Exact PDF words stay linked to the source.</p><div style="break-before:page"></div><h1>Source page two</h1><p>Different pages need distinct evidence.</p></main>',
  );
  const pdf = await fixture.pdf({ format: 'Letter', printBackground: false });
  await fixture.close();
  await page.locator('#back-library').click();
  await page
    .locator('#upload-input')
    .setInputFiles({ name: 'Source fixture.pdf', mimeType: 'application/pdf', buffer: pdf });
  await page.locator('#document-title').filter({ hasText: 'Source fixture.pdf' }).waitFor();
  await page.locator('#pdf-workspace canvas').waitFor();
  assert.equal(await page.locator('#reader-original').isVisible(), true);
  checks++;
  await page.locator('#pdf-workspace .textLayer span').first().waitFor();
  assert.ok((await page.locator('#pdf-workspace .textLayer span').count()) > 0);
  checks++;
  const selected = await page
    .locator('#pdf-workspace .textLayer span')
    .first()
    .evaluate((span) => {
      const range = document.createRange();
      range.selectNodeContents(span);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      span.closest('#pdf-workspace').dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      return selection.toString().trim();
    });
  assert.ok(selected);
  await page.locator('#quote-note').click();
  assert.ok((await page.locator('#notes-input').inputValue()).includes(selected));
  checks++;
  await page.locator('#highlight-selection').click();
  await page.locator('#highlights-list .marked-passage').waitFor();
  assert.ok((await page.locator('#pdf-workspace .pdf-highlight').count()) > 0);
  checks++;
  const [annotations] = await Promise.all([
    page.waitForEvent('download'),
    page.locator('#export-highlights').click(),
  ]);
  assert.equal(annotations.suggestedFilename(), 'Source fixture.pdf-annotations.json');
  checks++;
  await page.locator('#toggle-original').click();
  await page.locator('#document-text').filter({ hasText: 'Exact PDF words' }).waitFor();
  checks++;
  await page.locator('#page-next').click();
  await page.locator('#document-text').filter({ hasText: 'Different pages' }).waitFor();
  assert.equal(await page.locator('#cloud-consent').isChecked(), false);
  checks++;
  assert.equal(await page.locator('#answer-output').textContent(), '');
  checks++;
  await page.locator('#toggle-original').click();
  assert.equal(await page.locator('#reader-original').isVisible(), true);
  checks++;
  await page.locator('#pdf-workspace canvas').waitFor();
  await page.locator('#pdf-workspace .textLayer span').first().waitFor();
  assert.ok((await page.locator('#pdf-workspace .textLayer span').count()) > 0);
  checks++;
  await page.locator('#toggle-original').click();
  // A late answer must not reappear after switching source pages.
  await page.locator('#provider-select').selectOption('ollama');
  await page.route('**/api/study', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 400));
    try {
      await route.fulfill({
        json: {
          reply: 'This stale answer must not appear.',
          passages: [],
          question: 'A stale question?',
        },
      });
    } catch {
      /* Browser cancelled this fixture request. */
    }
  });
  await page.locator('#question-input').fill('What is on page two?');
  await page.locator('#ask-button').click();
  await page.locator('#page-prev').click();
  await page.waitForTimeout(500);
  assert.equal(await page.locator('#answer-output').textContent(), '');
  checks++;
  assert.ok((await page.locator('#app-status').textContent()).includes('cancelled'));
  checks++;
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(150);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  checks++;
  await page.screenshot({ path: path.join(output, 'reader-mobile.png'), fullPage: true });
  await page.locator('#page-next').click();
  await page.locator('#page-indicator').filter({ hasText: '2 of 2' }).waitFor();
  await page.locator('#back-library').click();
  await page.screenshot({ path: path.join(output, 'library-mobile.png'), fullPage: true });
  await page.reload();
  await page.locator('.primary-nav [data-view=library]').click();
  const restored = page.locator('.reading-card').filter({ hasText: 'Source fixture.pdf' });
  const [original] = await Promise.all([
    page.waitForEvent('download'),
    restored.getByRole('button', { name: 'Download original' }).click(),
  ]);
  assert.deepEqual(await readFile(await original.path()), pdf);
  await restored.getByRole('button', { name: 'Open', exact: true }).click();
  await page.locator('#page-indicator').filter({ hasText: '2 of 2' }).waitFor();
  assert.ok((await page.locator('#notes-input').inputValue()).includes(selected));
  await page.locator('#highlights-list').getByRole('button', { name: 'Page 1' }).click();
  await page.locator('#pdf-workspace .pdf-highlight').waitFor();
  checks++;
  await page.locator('#back-library').click();
  const folder = path.join(output, 'reader-folder');
  await mkdir(folder, { recursive: true });
  await writeFile(path.join(folder, 'Reading from folder.md'), 'A deliberately selected document.');
  await writeFile(path.join(folder, 'Unrelated.bin'), 'An unsupported file must not be imported.');
  await page.locator('#folder-input').setInputFiles(folder);
  await page.locator('#app-status').filter({ hasText: 'Added 1 of 2 selected files.' }).waitFor();
  assert.equal(await page.locator('.reading-card').count(), 3);
  assert.equal(await page.getByText('Unrelated.bin').count(), 0);
  checks++;
  // Canvas UI is exercised with fixtures, never a real token or account.
  await page.route('**/api/canvas/connect', (route) =>
    route.fulfill({ json: { profile: { id: '1', name: 'Synthetic course fixture' } } }),
  );
  await page.route('**/api/canvas/courses', (route) =>
    route.fulfill({
      json: {
        courses: [
          { id: '42', name: 'Project systems', code: 'TEST101', termId: '3' },
          { id: '43', name: 'Writing studio', code: 'TEST102', termId: '3' },
          { id: '44', name: 'Earlier course', code: 'TEST103', termId: '2' },
        ],
        terms: [
          { id: '3', name: '2026Fall' },
          { id: '2', name: '2026Spring' },
        ],
        currentTermId: '3',
        coverage: { partial: false },
      },
    }),
  );
  await page.route('**/api/canvas/assignments?*', (route) => {
    const ids = new URL(route.request().url()).searchParams.getAll('courseId');
    return route.fulfill({
      json: {
        courses: ids.map((courseId) => ({
          courseId,
          issue: null,
          assignments:
            courseId === '42'
              ? [
                  {
                    id: '7',
                    name: 'Source review',
                    dueAt: '2099-11-12T15:30:00Z',
                    status: 'unsubmitted',
                  },
                ]
              : [{ id: '8', name: 'Writing exercise', dueAt: null, status: 'submitted' }],
        })),
      },
    });
  });
  await page.route('**/api/canvas/course?id=*', (route) =>
    route.fulfill({
      json: {
        course: { id: '42', name: 'Project systems', code: 'TEST101' },
        assignments: [
          {
            id: '7',
            name: 'Source review',
            dueAt: null,
            locked: false,
            submitted: false,
            url: 'https://babson.instructure.com/courses/42/assignments/7',
          },
        ],
        modules: [
          {
            id: '8',
            name: 'Readings',
            items: [
              {
                id: '9',
                title: 'Course fixture',
                type: 'File',
                fileId: '10',
                locked: false,
                url: 'https://babson.instructure.com/courses/42/modules/items/9',
              },
              {
                id: '11',
                title: 'Week one guide',
                type: 'Page',
                pageUrl: 'week-one',
                locked: false,
                url: 'https://babson.instructure.com/courses/42/pages/week-one',
              },
            ],
          },
        ],
        coverage: { partial: false },
      },
    }),
  );
  await page.route('**/api/canvas/assignment?*', (route) =>
    route.fulfill({
      json: {
        assignment: {
          id: '7',
          name: 'Source review',
          courseId: '42',
          url: 'https://babson.instructure.com/courses/42/assignments/7',
          points: 10,
          locked: false,
          submitted: false,
          submissionTypes: ['online_text_entry'],
          descriptionHtml:
            '<h2>Read the source</h2><p>Explain the <strong>boundary</strong>.</p><ol><li>Read carefully.</li><li>Use evidence.</li></ol><script>window.__unsafeCourseScript=true</script><img src="https://evil.example/tracker" onerror="window.__unsafeCourseScript=true"><a href="javascript:alert(1)">Unsafe link</a><p><a href="/courses/42/files/10/download">Reading attachment</a></p>',
        },
      },
    }),
  );
  await page.route('**/api/canvas/page?*', (route) =>
    route.fulfill({
      json: {
        page: {
          title: 'Week one guide',
          bodyHtml: '<h2>Start with the source</h2><p>Your reading is available inside Atlas.</p>',
        },
      },
    }),
  );
  await page.route('**/api/canvas/submission/review', (route) =>
    route.fulfill({
      json: {
        draftId: 'synthetic-review',
        title: 'Source review',
        content: 'Synthetic student draft',
        liveEnabled: false,
      },
    }),
  );
  await page.route('**/api/canvas/reading', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'text/plain',
      headers: { 'x-reader-filename': 'Course%20fixture.txt' },
      body: 'A course reading can be opened independently of the personal Atlas app.',
    }),
  );
  await page.route('**/api/canvas/disconnect', (route) =>
    route.fulfill({ json: { disconnected: true } }),
  );
  await page.locator('.rail-main [data-view=courses]').click();
  await page.locator('#canvas-setup [data-view=settings]').click();
  await page.getByText('Local developer setup', { exact: true }).click();
  await page.locator('#canvas-token').fill('synthetic-owner-test-token');
  await page.locator('#canvas-connect button').click();
  await page
    .locator('#semester-rows')
    .getByRole('button', { name: /Source review/ })
    .waitFor();
  assert.equal(await page.locator('#course-list .course-card').count(), 2);
  assert.equal(await page.locator('#semester-rows').getByText('Writing exercise').count(), 0);
  await page.getByRole('button', { name: 'All Assignments', exact: true }).click();
  await page.locator('#semester-rows').getByText('Writing exercise').waitFor();
  await page.locator('#semester-course').selectOption('42');
  assert.equal(await page.locator('#semester-rows .canvas-assignment-row').count(), 1);
  await page
    .locator('#semester-rows')
    .getByRole('button', { name: /Source review/ })
    .click();
  await page.locator('.canvas-instructions h2').filter({ hasText: 'Read the source' }).waitFor();
  await page.getByRole('button', { name: '← All Assignments' }).click();
  assert.equal(await page.locator('#semester-course').inputValue(), '42');
  await page.getByRole('button', { name: 'This Semester', exact: true }).click();
  await page.locator('#semester-term').selectOption('2');
  await page.locator('#course-list').getByText('Earlier course').waitFor();
  await page.locator('#semester-term').selectOption('3');
  checks++;
  await page.locator('#course-list .course-card').filter({ hasText: 'Project systems' }).click();
  await page.locator('#course-detail').getByRole('button', { name: 'Source review' }).click();
  await page.locator('.canvas-instructions h2').filter({ hasText: 'Read the source' }).waitFor();
  assert.equal(await page.locator('.canvas-instructions strong').textContent(), 'boundary');
  checks++;
  assert.equal(
    await page
      .locator(
        '.canvas-instructions script,.canvas-instructions img,.canvas-instructions [onerror],.canvas-instructions a[href^="javascript:"]',
      )
      .count(),
    0,
  );
  assert.equal(await page.evaluate(() => window.__unsafeCourseScript), undefined);
  checks++;
  await page.locator('.submission-panel textarea').fill('Synthetic student draft');
  await page
    .locator('.submission-panel')
    .getByRole('button', { name: 'Review submission' })
    .click();
  await page
    .locator('.submission-review')
    .filter({ hasText: 'Nothing has been submitted' })
    .waitFor();
  checks++;
  assert.equal(
    await page
      .locator('.submission-panel')
      .getByRole('button', { name: 'Confirm and submit to Canvas' })
      .count(),
    0,
  );
  checks++;
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.screenshot({ path: path.join(output, 'assignment-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  checks++;
  await page.screenshot({ path: path.join(output, 'assignment-mobile.png'), fullPage: true });
  await page.getByRole('button', { name: '← Back to course' }).click();
  await page.getByRole('button', { name: 'Readings & modules · 1' }).click();
  await page.getByRole('button', { name: 'Read page', exact: true }).click();
  await page
    .locator('.canvas-instructions h2')
    .filter({ hasText: 'Start with the source' })
    .waitFor();
  checks++;
  await page.getByRole('button', { name: '← Back to course' }).click();
  await page.locator('#course-detail').getByRole('button', { name: 'Open reading' }).click();
  await page.locator('#document-title').filter({ hasText: 'Course fixture.txt' }).waitFor();
  checks++;
  assert.ok((await page.locator('#document-text').textContent()).includes('independently'));
  checks++;
  await page.locator('#rail-more summary').click();
  await page.locator('.primary-nav [data-view=settings]').click();
  await page.locator('#canvas-disconnect').click();
  await page.locator('#canvas-status').filter({ hasText: 'Not connected' }).waitFor();
  assert.equal(await page.locator('#course-list').textContent(), '');
  await page.locator('.primary-nav [data-view=library]').click();
  assert.equal(
    await page.locator('.reading-card').filter({ hasText: 'Course fixture.txt' }).count(),
    0,
  );
  assert.equal(await page.locator('.reading-card').count(), 3);
  checks++;
  assert.deepEqual(errors, []);
  checks++;
  console.log(
    JSON.stringify({
      checks,
      errors,
      studyRequests: requests.length,
      pdfPages: 2,
      artifacts: output,
    }),
  );
  await context.close();
} finally {
  await browser.close();
}
