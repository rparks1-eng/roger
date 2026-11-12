// Synthetic account, isolated browser and in-memory SQLite. Never touches owner history.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { chromium } from 'playwright';
import { createReaderServer } from '../src/server/http.mjs';
import { createMemoryStore } from '../src/server/memory.mjs';
import { qaScratch, browserOptions } from './quality/scratch.mjs';

const run = await qaScratch();
const memory = createMemoryStore({ dbPath: ':memory:' });
const prompts = [],
  errors = [],
  networkErrors = [];
let courseReads = 0;
const course = { id: '1', name: 'Corporate Financial Management', code: 'FIN3515', termId: 'fall' };
const assignment = {
  id: '10',
  courseId: '1',
  name: 'Finance exam',
  dueAt: '2026-12-01T18:00:00Z',
  status: 'unsubmitted',
  submitted: false,
  url: 'https://babson.instructure.com/courses/1/assignments/10',
};
const server = createReaderServer({
  memoryStore: memory,
  configuredCanvas: {
    token: 'synthetic-memory-ui-token',
    profile: { id: '123', name: 'Synthetic Student' },
  },
  canvasAdapter: {
    async listCanvasCourses() {
      return {
        courses: [course],
        terms: [{ id: 'fall', name: 'Fall 2026' }],
        currentTermId: 'fall',
        coverage: { partial: false, reasons: [] },
      };
    },
    async listCanvasAssignments() {
      return { courses: [{ courseId: '1', assignments: [assignment] }] };
    },
    async readCanvasCourse() {
      courseReads++;
      return {
        course,
        assignments: [assignment],
        modules: [],
        coverage: { partial: false, reasons: [] },
      };
    },
  },
  studyAdapter: {
    async providerStatus() {
      return { providers: [{ id: 'ollama', label: 'Test only', state: 'available' }] };
    },
    async answerStudy({ text }) {
      return {
        reply: 'Fixture reading answer.',
        passages: [{ quote: text.slice(0, 32), note: 'Fixture citation note.' }],
        question: 'What evidence would you compare next?',
      };
    },
  },
  narrationAdapter: { status: () => ({ available: false, voices: [] }) },
  connectionFactory: () => ({
    async status() {
      return {
        selected: { provider: 'codex', model: 'fixture' },
        providers: [
          {
            id: 'codex',
            name: 'Codex fixture',
            state: 'connected',
            method: 'account',
            models: ['fixture'],
            model: 'fixture',
            detail: 'Synthetic local test adapter',
            setupUrl: 'https://developers.openai.com/codex/auth',
          },
        ],
      };
    },
    async generate({ prompt }) {
      prompts.push(prompt);
      return {
        text: `Fixture answer ${prompts.length}: Finance exam dates were discussed. [1]`,
        provider: 'codex',
        model: 'fixture',
      };
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
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  page.setDefaultTimeout(8000);
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('response', (response) => {
    if (response.status() >= 400 && response.url().includes('/api/'))
      networkErrors.push({ status: response.status(), url: response.url().replace(origin, '') });
  });
  await page.route('**/api/documents/status', (route) =>
    route.fulfill({ json: { ocr: { available: false } } }),
  );
  await page.goto(origin);
  await page.locator('#roger-ai').filter({ hasText: 'AI · codex' }).waitFor({ state: 'attached' });
  async function ask(message) {
    if (!(await page.locator('#roger-composer').isVisible()))
      await page.locator('#roger-launch').click();
    await page.locator('#roger-mode').selectOption('ask');
    await page.locator('#roger-message').fill(message);
    await page.locator('#roger-send').click();
  }
  async function memoryView() {
    if (await page.locator('#roger-composer').isVisible())
      await page.locator('#roger-collapse').click();
    await page.locator('[data-view="memory"]').click();
    await page
      .locator('#memory-content')
      .getByRole('heading', { name: 'Recent conversations', exact: true })
      .waitFor();
  }
  await page.locator('[data-view="library"]').click();
  await ask('Open Corporate Financial Management');
  await page
    .locator('#course-detail')
    .getByRole('heading', { name: 'Corporate Financial Management', exact: true })
    .waitFor();
  assert.equal(courseReads, 1);
  await ask('What do these instructions require?');
  await page.locator('#roger-widget-response').filter({ hasText: 'Fixture answer 1' }).waitFor();
  assert.equal(memory.listThreads({ courseId: '1' }).total, 1);
  const saved = memory.listThreads({ courseId: '1' }).threads[0];
  assert.ok(prompts[0].includes('Finance exam'));
  assert.equal(
    memory
      .readThread({ threadId: saved.id, courseId: '1' })
      .turns.find((turn) => turn.content.startsWith('Fixture answer 1')).citations.length > 0,
    true,
  );
  const firstTurnCount = memory.readThread({ threadId: saved.id, courseId: '1' }).total;
  await memoryView();
  await page.getByRole('button', { name: saved.title, exact: true }).click();
  await page.getByRole('button', { name: 'Resume this conversation', exact: true }).click();
  await page.locator('#roger-widget-response').filter({ hasText: 'Resumed:' }).waitFor();
  await ask('Why?');
  await page.locator('#roger-widget-response').filter({ hasText: 'Fixture answer 2' }).waitFor();
  assert.ok(prompts[1].includes('MEMORY'));
  assert.ok(prompts[1].includes('What do these instructions require?'));
  assert.equal(courseReads, 1, 'Resume should reuse the fresh course cache.');

  await page.reload();
  await page.locator('#roger-ai').filter({ hasText: 'AI · codex' }).waitFor({ state: 'attached' });
  await memoryView();
  await page.getByRole('button', { name: saved.title, exact: true }).click();
  await page.locator('.memory-turn').filter({ hasText: 'Fixture answer 2' }).waitFor();
  assert.equal(await page.locator('.memory-turn').filter({ hasText: 'Fixture answer' }).count(), 2);
  await page.getByRole('button', { name: 'Resume this conversation', exact: true }).click();
  await page.locator('#roger-widget-response').filter({ hasText: 'Resumed:' }).waitFor();
  await memoryView();
  await page.locator('#memory-preference').fill('Ask one practice question at a time.');
  await page.getByRole('combobox', { name: 'Preference applies to' }).selectOption('course');
  await page.getByRole('button', { name: 'Remember this', exact: true }).click();
  await page.getByRole('button', { name: 'Forget preference', exact: true }).waitFor();
  assert.equal(memory.listPins({ courseId: '1' }).pins.length, 1);
  assert.equal(memory.listPins({ courseId: '2' }).pins.length, 0);
  await page.getByRole('button', { name: 'Forget preference', exact: true }).click();
  await page.getByText('No pinned preferences yet.', { exact: true }).waitFor();
  assert.equal(memory.listPins({ all: true }).pins.length, 0);
  await page.getByRole('button', { name: 'Pause memory', exact: true }).click();
  await page.getByRole('button', { name: 'Resume memory', exact: true }).waitFor();
  assert.equal(memory.settings().paused, true);
  await page.locator('[data-view="library"]').click();
  await ask('Tell me something helpful');
  await page.locator('#roger-widget-response').filter({ hasText: 'Fixture answer 3' }).waitFor();
  assert.equal(prompts[2].includes('MEMORY'), false);
  assert.equal(memory.listThreads({ all: true }).total, 1);
  await memoryView();
  await page.getByRole('button', { name: 'Resume memory', exact: true }).click();
  await page.getByRole('button', { name: 'Pause memory', exact: true }).waitFor();
  assert.equal(memory.settings().paused, false);

  const unauthenticated = await fetch(origin + '/api/memory/threads');
  assert.equal(unauthenticated.status, 401);
  await unauthenticated.body?.cancel();
  const forbidden = await page.request.post(origin + '/api/memory/delete', {
    data: { threadId: saved.id },
    headers: { origin },
  });
  assert.equal(forbidden.status(), 403);
  const exported = await page.request.get(origin + '/api/memory/export');
  assert.equal(exported.status(), 200);
  assert.equal((await exported.json()).threads[0].turns.length, firstTurnCount + 2);
  await page.getByRole('button', { name: saved.title, exact: true }).click();
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: 'Delete conversation', exact: true }).click();
  await page.getByText('Ask Roger a question to start your history.', { exact: true }).waitFor();
  assert.equal(memory.listThreads({ all: true }).total, 0);
  async function recordReading(filename, quote, question) {
    await page.locator('#upload-input').setInputFiles({
      name: filename,
      mimeType: 'text/plain',
      buffer: Buffer.from(quote),
    });
    await page.getByRole('heading', { name: filename, exact: true }).waitFor();
    await page.locator('#question-input').fill(question);
    const saved = page.waitForResponse(
      (response) => response.url().endsWith('/api/memory/record') && response.status() === 200,
    );
    await page.locator('#ask-button').click();
    await saved;
  }
  const harbor = 'North harbor expanded after storms in the synthetic reading.';
  await recordReading('harbor-fixture.txt', harbor, 'Why did the harbor expand?');
  await recordReading(
    'garden-fixture.txt',
    'Garden paths were widened for the school project.',
    'Why were the paths widened?',
  );
  const readingThreads = memory.listThreads({ all: true }).threads;
  assert.equal(readingThreads.length, 2);
  const harborThread = readingThreads.find(
    (thread) => thread.title === 'Why did the harbor expand?',
  );
  assert.equal(memory.retrieve({ query: 'harbor' }).context, '');
  const harborTurn = memory.readThread({
    threadId: harborThread.id,
    documentId: harborThread.documentId,
  }).turns[1];
  assert.deepEqual(harborTurn.citations, [
    {
      documentId: harborThread.documentId,
      revision: harborThread.documentId,
      title: 'harbor-fixture.txt',
      quote: harbor.slice(0, 32).trim(),
      page: 1,
      location: 'section',
    },
  ]);
  await memoryView();
  await page.getByRole('button', { name: harborThread.title, exact: true }).click();
  await page.getByText('harbor-fixture.txt · section 1', { exact: true }).click();
  await page.getByRole('button', { name: 'Open cited source', exact: true }).click();
  await page.getByRole('heading', { name: 'harbor-fixture.txt', exact: true }).waitFor();
  await memoryView();
  await page.getByRole('button', { name: harborThread.title, exact: true }).click();
  await page.getByRole('button', { name: 'Resume this conversation', exact: true }).click();
  await page.getByRole('heading', { name: 'harbor-fixture.txt', exact: true }).waitFor();
  await page.locator('[data-view="library"]').first().click();
  await page.getByRole('button', { name: 'Remove harbor-fixture.txt', exact: true }).click();
  await page
    .getByRole('button', { name: 'Remove harbor-fixture.txt', exact: true })
    .waitFor({ state: 'detached' });
  await memoryView();
  await page.getByRole('button', { name: harborThread.title, exact: true }).click();
  await page.getByRole('button', { name: 'Resume this conversation', exact: true }).click();
  await page
    .getByText('Open the original file in Readings to resume this conversation.', { exact: true })
    .waitFor();
  assert.equal(await page.locator('#memory-view').isVisible(), true);
  assert.deepEqual(errors, []);
  assert.deepEqual(networkErrors, []);
  console.log(
    'Memory UI passed: scoped Canvas and reading history, local citations and resume, missing-file handling, follow-up recall, pin/forget, pause, export, deletion and HTTP auth.',
  );
} catch (error) {
  console.error(
    'Memory UI diagnostics:',
    JSON.stringify({ errors, networkErrors, prompts: prompts.length, courseReads }),
  );
  error.stack = error.stack?.split('Call log:')[0];
  throw error;
} finally {
  await browser?.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await run.close();
}
