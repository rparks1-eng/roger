// Post-apply workflow check. Synthetic documents, no owner configuration or AI.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { qaScratch, browserOptions } from './quality/scratch.mjs';
import { createReaderServer } from '../src/server/http.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
execFileSync(process.execPath, ['scripts/quality/core-provenance.mjs'], {
  cwd: root,
  stdio: 'inherit',
});
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.READER_PLAYWRIGHT_MODULE || 'playwright');
const fixture = execFileSync(
  process.env.READER_PYTHON || '/usr/bin/python3',
  [
    '-I',
    '-B',
    '-c',
    `import io,sys,zipfile
p='http://schemas.openxmlformats.org/presentationml/2006/main'
a='http://schemas.openxmlformats.org/drawingml/2006/main'
r='http://schemas.openxmlformats.org/officeDocument/2006/relationships'
out=io.BytesIO()
with zipfile.ZipFile(out,'w',compression=zipfile.ZIP_DEFLATED) as z:
 z.writestr('ppt/presentation.xml',f'<p:presentation xmlns:p="{p}" xmlns:r="{r}"><p:sldIdLst><p:sldId id="1" r:id="one"/><p:sldId id="2" r:id="two"/></p:sldIdLst></p:presentation>')
 z.writestr('ppt/_rels/presentation.xml.rels',f'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="one" Type="{r}/slide" Target="/ppt/slides/slide1.xml"/><Relationship Id="two" Type="{r}/slide" Target="slides/slide2.xml"/></Relationships>')
 for i,text in [(1,'Python migration first slide'),(2,'Second slide remains ordered')]:
  z.writestr(f'ppt/slides/slide{i}.xml',f'<p:sld xmlns:p="{p}" xmlns:a="{a}"><a:p><a:r><a:t>{text}</a:t></a:r></a:p></p:sld>')
sys.stdout.buffer.write(out.getvalue())`,
  ],
  { maxBuffer: 65536 },
);
const run = await qaScratch();
const server = createReaderServer({
  studyAdapter: {
    ...(await import('../src/server/study.mjs')),
    async providerStatus() {
      return { providers: [{ id: 'ollama', label: 'Synthetic local helper', state: 'available' }] };
    },
  },
});
let browser;
try {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = 'http://127.0.0.1:' + server.address().port;
  // Chromium's fake output stream keeps this synthetic WAV regression independent
  // of a Mac audio device. Real speaker/voice quality is a separate live check.
  browser = await chromium.launch({
    ...browserOptions,
    downloadsPath: run.work,
    args: [...(browserOptions.args || []), '--disable-audio-output'],
  });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const narrationRequests = [];
  const narrationWav = Buffer.alloc(44 + 9600);
  narrationWav.write('RIFF', 0);
  narrationWav.writeUInt32LE(narrationWav.length - 8, 4);
  narrationWav.write('WAVEfmt ', 8);
  narrationWav.writeUInt32LE(16, 16);
  narrationWav.writeUInt16LE(1, 20);
  narrationWav.writeUInt16LE(1, 22);
  narrationWav.writeUInt32LE(24000, 24);
  narrationWav.writeUInt32LE(48000, 28);
  narrationWav.writeUInt16LE(2, 32);
  narrationWav.writeUInt16LE(16, 34);
  narrationWav.write('data', 36);
  narrationWav.writeUInt32LE(9600, 40);
  await page.route('**/api/narration/status', (route) =>
    route.fulfill({
      json: {
        available: true,
        engine: 'kokoro',
        voices: ['clear', 'warm', 'calm', 'bright'].map((id) => ({ id, name: id })),
      },
    }),
  );
  await page.route('**/api/narration', (route) => {
    narrationRequests.push(route.request().postDataJSON());
    return route.fulfill({ contentType: 'audio/wav', body: narrationWav });
  });
  await page.goto(origin);
  await page.locator('.primary-nav [data-view=library]').click();
  await page.locator('#upload-inline').waitFor();
  for (const asset of ['roger', 'roger-peek', 'beaver']) {
    const image = await page.request.get(`${origin}/assets/${asset}.png`);
    assert.equal(image.status(), 200);
    assert.match(image.headers()['content-type'], /image\/png/);
  }
  assert.equal(await page.locator('#roger-composer').isVisible(), false);
  await page.locator('#roger-launch').hover();
  await page.locator('#roger-composer').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#roger-widget-response').textContent(), '');
  assert.equal(await page.locator('#roger-source').isVisible(), false);
  await page.locator('#roger-message').fill('Explain this reading');
  await page.locator('#roger-send').click();
  await page.locator('#roger-widget-response').filter({ hasText: 'need a source first' }).waitFor();
  assert.match(await page.locator('#roger-widget-response').textContent(), /need a source first/);
  await page.locator('#roger-collapse').click();
  await page.locator('#roger-composer').waitFor({ state: 'hidden' });
  await page.locator('#roger-launch').click();
  assert.equal(await page.locator('#roger-launch').getAttribute('aria-expanded'), 'true');
  assert.equal(
    await page
      .locator('#roger-message')
      .evaluate((input) => input === globalThis.document.activeElement),
    true,
  );
  await page.locator('#roger-message').press('Escape');
  await page.locator('#roger-composer').waitFor({ state: 'hidden' });
  assert.equal(await page.locator('#library-view').isVisible(), true);
  const response = page.waitForResponse((r) => r.url().endsWith('/api/documents/presentation'));
  await page.locator('#upload-input').setInputFiles({
    name: 'Python migration fixture.pptx',
    mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    buffer: fixture,
  });
  assert.equal((await response).status(), 200);
  await page.locator('#document-meta').filter({ hasText: '2 slides' }).waitFor();
  await page.locator('.voice-settings > summary').click();
  assert.deepEqual(await page.locator('#narration-preset option').allTextContents(), [
    'Clear',
    'Warm',
    'Calm',
    'Bright',
  ]);
  await page.waitForFunction(
    () => globalThis.document.getElementById('narration-engine').value === 'natural',
  );
  await page.locator('#narration-preset').selectOption('warm');
  assert.equal(
    await page.evaluate(
      async () => (await import('/client/speech.mjs')).getSpeechPreferences().presetId,
    ),
    'warm',
  );
  await page.locator('#preview-voice').click();
  await page
    .locator('#reading-status')
    .filter({ hasText: 'Voice sample finished' })
    .waitFor()
    .catch(async (error) => {
      console.error(
        JSON.stringify({
          voiceStatus: await page.locator('#reading-status').textContent(),
          appStatus: await page.locator('#app-status').textContent(),
          narrationRequests: narrationRequests.length,
          errors,
        }),
      );
      throw error;
    });
  assert.equal(narrationRequests.length, 1);
  assert.equal(narrationRequests[0].preset, 'warm');
  assert.match(narrationRequests[0].text, /one idea at a time/);
  await page.locator('#narration-preset').selectOption('clear');
  await page.locator('.voice-settings > summary').click();
  await page.locator('#roger-launch').click();
  assert.deepEqual(await page.locator('#roger-source option').allTextContents(), [
    'Search open readings',
    'Python migration fixture.pptx',
  ]);
  await page.locator('#roger-collapse').click();
  assert.equal(await page.locator('#reader-view').isVisible(), true);
  assert.ok(
    (await page.locator('#document-text').textContent()).includes('Python migration first slide'),
  );
  await page.locator('#page-next').click();
  assert.ok(
    (await page.locator('#document-text').textContent()).includes('Second slide remains ordered'),
  );
  const session = await page.evaluate(() => fetch('/api/session').then((r) => r.json()));
  const headers = {
    origin,
    'content-type': 'application/octet-stream',
    'x-reader-csrf': session.csrf,
  };
  assert.equal(
    (
      await page.request.post(origin + '/api/documents/presentation', {
        headers,
        data: Buffer.from('damaged'),
      })
    ).status(),
    400,
  );
  assert.equal(
    (
      await page.request.post(origin + '/api/documents/presentation', { headers, data: fixture })
    ).status(),
    200,
  );
  // Library questions use the actual Python retrieval endpoint. Only AI is mocked.
  let aiRequests = 0;
  const aiBodies = [];
  let holdAi = false;
  let enteredAi;
  let releaseAi;
  await page.route('**/api/study', async (route) => {
    aiRequests++;
    aiBodies.push(route.request().postDataJSON());
    if (holdAi) {
      const release = new Promise((resolve) => {
        releaseAi = resolve;
      });
      enteredAi();
      await release;
    }
    return route.fulfill({
      json: {
        reply: 'The selected source supports this answer.',
        passages: [],
        question: 'What does the next slide add?',
      },
    });
  });
  await page.locator('#question-scope').selectOption('library');
  await page.locator('#question-input').fill('Second slide');
  const retrieved = page.waitForResponse((r) => r.url().endsWith('/api/retrieval'));
  await page.locator('#ask-button').click();
  assert.equal((await retrieved).status(), 200);
  await page
    .locator('#answer-output')
    .filter({ hasText: 'The selected source supports' })
    .waitFor();
  assert.equal(aiRequests, 1);
  let entered;
  const waiting = new Promise((resolve) => {
    entered = resolve;
  });
  await page.route('**/api/retrieval', async (route) => {
    const response = await route.fetch();
    entered();
    await new Promise((resolve) => setTimeout(resolve, 300));
    try {
      await route.fulfill({ response });
    } catch {
      /* Intentionally cancelled request. */
    }
  });
  await page.locator('#question-input').fill('first slide');
  await page.locator('#ask-button').click();
  await waiting;
  await page.locator('#page-prev').click();
  await page.waitForTimeout(400);
  assert.equal(aiRequests, 1);
  assert.equal(await page.locator('#answer-output').textContent(), '');
  await page.unroute('**/api/retrieval');
  // The floating composer answers in place, with the same local-only transport and evidence.
  await page.locator('#back-library').click();
  await page.locator('#roger-launch').click();
  await page.locator('#roger-source').selectOption('library');
  await page.locator('#roger-message').fill('Second slide');
  const widgetRetrieval = page.waitForResponse((r) => r.url().endsWith('/api/retrieval'));
  await page.locator('#roger-send').click();
  assert.equal((await widgetRetrieval).status(), 200);
  await page
    .locator('#roger-widget-response')
    .filter({ hasText: 'The selected source supports' })
    .waitFor();
  assert.equal(await page.locator('#library-view').isVisible(), true);
  assert.equal(await page.locator('#reader-view').isVisible(), false);
  assert.match(
    await page.locator('#roger-widget-sources').textContent(),
    /Python migration fixture/,
  );
  assert.deepEqual([aiBodies.at(-1).provider, aiBodies.at(-1).allowCloud], ['ollama', false]);
  assert.match(aiBodies.at(-1).text, /Second slide remains ordered/);
  const documentId = await page.locator('#roger-source option').nth(1).getAttribute('value');
  await page.locator('#roger-source').selectOption(documentId);
  await page.locator('#roger-message').fill('Python migration first slide');
  const documentRetrieval = page.waitForResponse((r) => r.url().endsWith('/api/retrieval'));
  await page.locator('#roger-send').click();
  assert.equal((await documentRetrieval).status(), 200);
  await page
    .locator('#roger-widget-response')
    .filter({ hasText: 'The selected source supports' })
    .waitFor();
  assert.match(aiBodies.at(-1).text, /Python migration first slide/);
  assert.equal(await page.locator('#library-view').isVisible(), true);
  assert.equal(aiRequests, 3);
  // Closing the composer cancels a pending answer and cannot populate a reopened widget.
  holdAi = true;
  const pendingAi = new Promise((resolve) => {
    enteredAi = resolve;
  });
  await page.locator('#roger-message').fill('Second slide');
  await page.locator('#roger-send').click();
  await pendingAi;
  await page.locator('#roger-collapse').click();
  await page.locator('#roger-composer').waitFor({ state: 'hidden' });
  releaseAi();
  holdAi = false;
  await page.waitForTimeout(150);
  await page.locator('#roger-launch').click();
  assert.equal(await page.locator('#roger-widget-response').textContent(), '');
  assert.equal(await page.locator('#roger-send').isEnabled(), true);
  assert.equal(await page.locator('#library-view').isVisible(), true);
  await page.locator('#roger-message').press('Escape');
  await page.locator('#roger-composer').waitFor({ state: 'hidden' });
  const courseSearch = await page.evaluate(async () => {
    const { collectSources, retrieveStudySources } = await import('/client/study-ui.mjs');
    const { readMaterials, mountCourseStudy, extractCourseFileLinks } =
      await import('/client/course-study-ui.mjs');
    const { api } = await import('/client/api.mjs');
    const materials = Array.from({ length: 60 }, (_, index) => ({
      kind: 'material',
      title: `Reading ${index + 1}`,
      url: `https://babson.instructure.com/courses/1/files/${index + 1}`,
      pages: Array.from({ length: 8 }, (_, page) => ({
        page: page + 1,
        text:
          index === 59 && page === 7
            ? 'The zephyr coefficient measures nonlinear retrieval performance.'
            : `Ordinary reading ${index + 1}, page ${page + 1}, discusses a standard classroom method.`,
      })),
    }));
    const sources = collectSources(
      { name: 'Course' },
      '',
      null,
      { notes: '', files: [] },
      materials,
    );
    const progress = [];
    const selected = await retrieveStudySources(
      sources,
      'zephyr coefficient',
      api,
      new AbortController().signal,
      (done, total) => progress.push([done, total]),
    );
    const unusable = Array.from({ length: 24 }, (_, index) => ({
      id: `empty-${index}`,
      kind: 'material',
      text: 'Vocabulary',
    }));
    const recovered = await retrieveStudySources(
      [
        ...unusable,
        { id: 'valid-last', kind: 'material', text: 'The zephyr coefficient measures retrieval.' },
      ],
      'zephyr',
      api,
      new AbortController().signal,
    );
    const assignmentSources = Array.from({ length: 13 }, (_, index) => ({
      assignmentId: String(index + 1),
      title: `Assignment ${index + 1}`,
    }));
    const batches = [];
    const loader = { readText: (_key, _course, _signal, fetchValue) => fetchValue() };
    const fakeApi = async (url) => {
      const ids = new URL(url, globalThis.location.origin).searchParams.getAll('assignmentId');
      batches.push(ids.length);
      return {
        assignments: ids.map((id) => ({
          id,
          name: `Assignment ${id}`,
          descriptionHtml: `Full instructions for assignment ${id}.`,
        })),
        unavailable: [],
      };
    };
    const loaded = await readMaterials(assignmentSources, {
      courseId: '1',
      loader,
      api: fakeApi,
      plainText: (value) => value,
      signal: new AbortController().signal,
    });
    const cancel = new AbortController();
    let cancelled = false;
    let cancelProgress = 0;
    try {
      await readMaterials(assignmentSources, {
        courseId: '1',
        loader,
        api: fakeApi,
        plainText: (value) => value,
        signal: cancel.signal,
        onProgress: () => {
          cancelProgress++;
          cancel.abort();
        },
      });
    } catch (error) {
      cancelled = error.name === 'AbortError';
    }
    const linkedHtml =
      '<a href="/courses/1/files/90/download?download_frd=1">Slides.pdf</a><a href="/courses/1/files/90">Duplicate</a><a href="/courses/2/files/91">Other course</a><a href="javascript:alert(1)">Unsafe</a><a href="https://external.example/book">External book</a><a href="/files/92" data-api-endpoint="https://babson.instructure.com/api/v1/courses/1/files/92">Missing.pdf</a>';
    const links = extractCourseFileLinks(linkedHtml, '1');
    const linkedRead = [];
    const nested = await readMaterials(
      [
        {
          pageUrl: 'chapter-4',
          title: 'Chapter 4',
          url: 'https://babson.instructure.com/courses/1/pages/chapter-4',
        },
      ],
      {
        courseId: '1',
        signal: new AbortController().signal,
        plainText: () => 'Chapter introduction.',
        api: async () => ({ page: { bodyHtml: linkedHtml } }),
        loader: {
          readText: (_key, _course, _signal, fetchValue) => fetchValue(),
          readMaterial: async (source) => {
            linkedRead.push(source.fileId);
            if (source.fileId === '92') throw new Error('File unavailable');
            return {
              pages: [
                { page: 8, text: 'The linked document contains the chapter practice problems.' },
              ],
            };
          },
        },
      },
    );
    const content = globalThis.document.createElement('div');
    globalThis.document.body.append(content);
    const draft = {};
    mountCourseStudy({
      content,
      course: {
        course: { id: '1' },
        assignments: assignmentSources.map((item) => ({ id: item.assignmentId, name: item.title })),
        modules: [],
      },
      draft,
      loader,
      api: fakeApi,
      operation: () => {},
      invalidate: () => {},
      importFile: () => {},
      plainText: (value) => value,
      external: () => globalThis.document.createElement('span'),
    });
    const controls = [...content.querySelectorAll('button')];
    controls.find((button) => button.textContent === 'Clear selection').click();
    const clearCount = draft.selected.length;
    controls.find((button) => button.textContent === 'Select all').click();
    const allCount = draft.selected.length;
    const disabled = content.querySelectorAll('input:disabled').length;
    content.remove();
    return {
      nested: {
        links: links.map((link) => link.fileId),
        reads: linkedRead,
        entries: nested.entries.map(({ title, foundIn }) => ({ title, foundIn })),
        skipped: nested.skipped,
      },
      recovered: recovered.some((source) => source.id === 'valid-last'),
      chunks: sources.length,
      marker: selected.find((source) => source.text.includes('zephyr coefficient')),
      progress: progress.at(-1),
      batchSizes: batches.slice(0, 3),
      loaded: loaded.entries.length,
      cancelled,
      cancelProgress,
      clearCount,
      allCount,
      disabled,
    };
  });
  assert.deepEqual(courseSearch.nested.links, ['90', '92']);
  assert.deepEqual(courseSearch.nested.reads, ['90', '92']);
  assert.equal(courseSearch.nested.entries[1].foundIn, 'Linked from Chapter 4');
  assert.ok(
    courseSearch.nested.skipped.some(
      (item) => item.includes('Missing.pdf') && item.includes('unavailable'),
    ),
  );
  assert.ok(
    courseSearch.nested.skipped.some(
      (item) => item.includes('External book') && item.includes('not downloaded'),
    ),
  );
  assert.equal(courseSearch.recovered, true);
  assert.equal(courseSearch.chunks, 480);
  assert.equal(courseSearch.marker.label, 'Reading 60');
  assert.equal(courseSearch.marker.page, 8);
  assert.deepEqual(courseSearch.progress, [480, 480]);
  assert.deepEqual(courseSearch.batchSizes, [5, 5, 3]);
  assert.equal(courseSearch.loaded, 13);
  assert.equal(courseSearch.cancelled, true);
  assert.equal(courseSearch.cancelProgress, 1);
  assert.equal(courseSearch.clearCount, 0);
  assert.equal(courseSearch.allCount, 13);
  assert.equal(courseSearch.disabled, 0);
  await page.evaluate(async () => {
    const { mountCourseStudy } = await import('/client/course-study-ui.mjs');
    const { api } = await import('/client/api.mjs');
    const document = globalThis.document;
    const fixture = document.createElement('section');
    fixture.id = 'external-study-fixture';
    document.body.append(fixture);
    let active;
    const invalidate = () => active?.abort();
    mountCourseStudy({
      content: fixture,
      course: {
        course: { id: '1', name: 'Fixture course' },
        assignments: [],
        modules: [
          {
            name: 'Fixture module',
            items: [
              {
                id: '81',
                title: 'Sample lecture',
                studyCategory: 'Videos',
                fileId: '91',
                url: 'https://babson.instructure.com/courses/1/modules/items/81',
              },
              {
                id: '82',
                title: 'Supplemental reading',
                studyCategory: 'Links',
                url: 'https://babson.instructure.com/courses/1/modules/items/82',
              },
              {
                id: '83',
                title: 'Restricted video',
                studyCategory: 'Videos',
                locked: true,
                url: 'https://babson.instructure.com/courses/1/modules/items/83',
              },
            ],
          },
        ],
      },
      draft: { mode: 'discussion', notes: '', files: [], decks: new Map() },
      loader: {
        discover: async () => ({ candidates: [] }),
        readMaterial() {
          throw new Error('External content must use the attached text.');
        },
      },
      api,
      operation: () => {
        invalidate();
        const controller = new AbortController();
        active = controller;
        return {
          signal: controller.signal,
          cancel: () => controller.abort(),
          valid: () => active === controller && !controller.signal.aborted,
        };
      },
      invalidate,
      importFile: () => {},
      plainText: (html) => html,
      external: (label, url) => {
        const link = document.createElement('a');
        link.href = url;
        link.textContent = label;
        return link;
      },
    });
  });
  const externalStudy = page.locator('#external-study-fixture');
  await externalStudy
    .getByText('0 of 0 available course sources selected', { exact: false })
    .waitFor();
  await externalStudy.getByText('Videos · 2', { exact: true }).click();
  const lecture = externalStudy.getByRole('listitem').filter({ hasText: 'Sample lecture' });
  const restricted = externalStudy.getByRole('listitem').filter({ hasText: 'Restricted video' });
  assert.equal(await restricted.getByText('Locked in Canvas').isVisible(), true);
  assert.equal(await restricted.getByText('Attach transcript').count(), 0);
  await lecture.getByText('Attach transcript', { exact: true }).click();
  await lecture.getByText('Unavailable for practice until text is attached.').waitFor();
  await lecture.getByLabel('Load local text file').setInputFiles({
    name: 'lecture.vtt',
    mimeType: 'text/vtt',
    buffer: Buffer.from(
      'WEBVTT\nKind: captions\nLanguage: en\n\nNOTE Retrieval evidence for editing only.\nThis is not a caption.\n\n00:00:05.000 --> 00:00:10.000\nRetrieval uses linked readings as evidence for the answer.\n\n00:00:12.000 --> 00:00:14.000\nThe instructor reviews a second example.',
    ),
  });
  await lecture.getByText('Text loaded.', { exact: false }).waitFor();
  await lecture.getByRole('button', { name: 'Use attached text' }).click();
  await lecture.getByRole('checkbox', { name: 'Sample lecture' }).waitFor();
  assert.equal(await lecture.getByRole('checkbox').isChecked(), true);
  await externalStudy.getByText('Links · 1', { exact: true }).click();
  const reading = externalStudy.getByRole('listitem').filter({ hasText: 'Supplemental reading' });
  await reading.getByText('Attach reading text', { exact: true }).click();
  await reading
    .getByRole('textbox', { name: 'Reading text for Supplemental reading' })
    .fill('This sample reading compares several classroom discussion styles.');
  await reading.getByRole('button', { name: 'Use attached text' }).click();
  await externalStudy
    .getByText('2 of 2 available course sources selected', { exact: false })
    .waitFor();
  await externalStudy.getByRole('button', { name: 'Open exam practice' }).click();
  await externalStudy
    .getByRole('textbox', { name: 'Exam topic (optional)' })
    .fill('Retrieval evidence');
  await externalStudy.getByRole('button', { name: 'Build set', exact: true }).click();
  const transcriptCitation = externalStudy.locator('.study-citation');
  await transcriptCitation
    .getByText('Sample lecture · 00:00:05.000 · Your attached transcript')
    .waitFor();
  assert.equal(
    await transcriptCitation.getByRole('link', { name: 'Open Canvas item' }).getAttribute('href'),
    'https://babson.instructure.com/courses/1/modules/items/81',
  );
  await externalStudy
    .getByText('Retrieval uses linked readings as evidence for the answer.')
    .waitFor();
  await lecture.getByRole('button', { name: 'Remove attached text' }).click();
  assert.equal(await lecture.getByRole('checkbox').isVisible(), false);
  assert.equal(await transcriptCitation.count(), 0);
  await externalStudy
    .getByText('1 of 1 available course sources selected', { exact: false })
    .waitFor();
  await externalStudy.evaluate((node) => node.remove());
  await page.evaluate(async () => {
    const { mountAssignmentStudy } = await import('/client/study-ui.mjs');
    const { api } = await import('/client/api.mjs');
    const document = globalThis.document;
    const fixture = document.createElement('section');
    fixture.id = 'study-format-fixture';
    const instructions = 'Projects count for 40%, discussion for 35%, and quizzes for 25%.';
    const source = document.createElement('p');
    source.id = 'assignment-instructions';
    source.tabIndex = -1;
    source.textContent = instructions;
    const content = document.createElement('div');
    const reopen = document.createElement('button');
    reopen.type = 'button';
    reopen.textContent = 'Reopen fixture Study';
    const draft = { mode: 'discussion', notes: '', files: [], decks: new Map() };
    const mount = () => {
      content.replaceChildren();
      mountAssignmentStudy({
        container: content,
        assignment: { name: '=1+1', url: 'https://babson.instructure.com/courses/1/assignments/2' },
        courseId: '1',
        instructions,
        draft,
        loader: { discover: async () => ({ candidates: [] }) },
        api,
        operation: () => {
          const controller = new AbortController();
          return {
            signal: controller.signal,
            valid: () => !controller.signal.aborted,
            cancel: () => controller.abort(),
          };
        },
      });
    };
    reopen.addEventListener('click', mount);
    fixture.append(source, reopen, content);
    document.body.append(fixture);
    mount();
  });
  const study = page.locator('#study-format-fixture');
  const build = study.getByRole('button', { name: 'Build set', exact: true });
  await build.click();
  const discussion = study.getByRole('textbox', { name: 'Your response' });
  await discussion.fill('The project has the greatest weight in this assignment.');
  await study.getByRole('button', { name: 'Show rubric' }).click();
  await study.getByText('State your interpretation', { exact: false }).waitFor();
  await study.getByRole('button', { name: 'Reopen fixture Study' }).click();
  await study.getByText('Reopened this set from memory.').waitFor();
  assert.match(await discussion.inputValue(), /greatest weight/);
  const discussionSaved = page.waitForEvent('download');
  await study.getByRole('button', { name: 'Download discussion prompts' }).click();
  const discussionFile = await readFile(await (await discussionSaved).path(), 'utf8');
  assert.match(discussionFile, /greatest weight/);
  assert.match(discussionFile, /Projects count for 40%/);
  await study.getByLabel('Format').selectOption('worksheet');
  await build.click();
  await study.getByText('Average 33.33% · range 15 percentage points').waitFor();
  const input = study.getByRole('spinbutton', { name: 'Practice percentage in B2' });
  await input.fill('75.25');
  await study.getByText('Average 45.08% · range 50.25 percentage points').waitFor();
  const download = study.getByRole('button', { name: 'Download worksheet CSV' });
  await input.fill('101');
  assert.equal(await download.isEnabled(), false);
  await input.fill('75.25');
  await study.getByText('Source for B2', { exact: true }).click();
  const citation = study.getByRole('button', { name: 'Go to instructions', exact: true });
  await citation.focus();
  await citation.press('Enter');
  assert.equal(await study.locator('#assignment-instructions:focus').count(), 1);
  await study.getByRole('button', { name: 'Reopen fixture Study' }).click();
  await study.getByText('Reopened this worksheet with your edits.').waitFor();
  assert.equal(await input.inputValue(), '75.25');
  const worksheetSaved = page.waitForEvent('download');
  await download.click();
  const worksheetFile = await readFile(await (await worksheetSaved).path(), 'utf8');
  assert.match(
    worksheetFile,
    /B2,75\.25,40,"Source: =1\+1","URL: https:\/\/babson\.instructure\.com\/courses\/1\/assignments\/2","Quote: Projects count for 40%/,
  );
  assert.ok(worksheetFile.includes('Average,"=ROUND(AVERAGE(B2:B4),2)"'));
  assert.ok(worksheetFile.includes('Range,"=ROUND(MAX(B2:B4)-MIN(B2:B4),2)"'));
  assert.deepEqual(errors, []);
  await browser.close();
  browser = null;
  process.env.READER_QA_URL = origin;
  process.env.CODEX_ARTIFACT_DIR = run.work;
  await import('../scripts/browser-smoke.mjs');
  console.log(
    'Python PPTX, real library retrieval, stale-result cancellation, malformed-file recovery and existing browser suite passed.',
  );
} finally {
  await browser?.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await run.close();
}
