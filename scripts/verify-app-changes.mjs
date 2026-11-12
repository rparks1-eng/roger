// Whole-app source editing in an owned disposable checkout; no live account or source writes.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createReaderServer, readerAssets } from '../src/server/http.mjs';
import { qaScratch, browserOptions } from './quality/scratch.mjs';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const run = await qaScratch();
const project = fileURLToPath(new URL('../', import.meta.url));
const checkout = path.join(run.work, 'source-preview');
for (const [relative] of readerAssets.values()) {
  const target = path.join(checkout, relative);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, await readFile(path.join(project, relative)));
}
const beforeHTML = await readFile(path.join(checkout, 'public/index.html'), 'utf8');
const beforeJS = await readFile(path.join(checkout, 'src/client/app.mjs'), 'utf8');
const originalHeading = '<h1 id="library-heading">Library<span class="heading-dot">.</span></h1>';
const lastLine =
  "start().catch((error) => status(error.message || 'Reload Atlas Reader to start again.'));";
const plan = {
  title: 'Reading checkpoint in the Library',
  summary:
    'Renames the existing Library heading and adds a working checkpoint counter directly to that page.',
  edits: [
    {
      path: 'public/index.html',
      find: originalHeading,
      replace:
        '<h1 id="library-heading">Reading desk<span class="heading-dot">.</span></h1><section aria-label="Reading checkpoint"><button type="button" id="checkpoint-add">Complete checkpoint</button><output id="checkpoint-count">0 checkpoints</output></section>',
    },
    {
      path: 'src/client/app.mjs',
      find: lastLine,
      replace:
        lastLine +
        "\nlet checkpoints = 0;\ndocument.getElementById('checkpoint-add').addEventListener('click', () => { checkpoints++; document.getElementById('checkpoint-count').textContent = `${checkpoints} checkpoints`; });\n",
    },
  ],
};
let calls = 0;
const server = createReaderServer({
  assetRoot: checkout,
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
            detail: 'Fixture only',
          },
        ],
      };
    },
    async generate({ prompt }) {
      calls++;
      assert.ok(prompt.includes('public/index.html'));
      return { text: JSON.stringify(plan) };
    },
    dispose() {},
  }),
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
});
let browser;
try {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch(browserOptions);
  const context = await browser.newContext();
  const page = await context.newPage();
  page.setDefaultTimeout(20_000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(origin);
  await page.locator('#roger-ai').filter({ hasText: 'AI · codex' }).waitFor({ state: 'attached' });
  await page.evaluate(() => localStorage.setItem('private-fixture', 'never-in-preview'));
  await page.locator('#roger-launch').click();
  await page
    .locator('#roger-message')
    .fill('Add a reading checkpoint feature to the Library page in Roger');
  await page.locator('#roger-send').click();
  await page.locator('.app-change-review').waitFor({ state: 'visible', timeout: 45_000 });
  assert.equal(calls, 1);
  assert.equal(
    await page.getByRole('button', { name: 'Apply to Roger', exact: true }).isEnabled(),
    false,
  );
  assert.equal(
    await readFile(path.join(checkout, 'public/index.html'), 'utf8'),
    beforeHTML,
    'Preview does not mutate source',
  );
  const opened = context.waitForEvent('page');
  await page.getByRole('link', { name: 'Open app preview ↗', exact: true }).click();
  const preview = await opened;
  preview.setDefaultTimeout(15_000);
  preview.on('pageerror', (error) => errors.push(error.message));
  await preview.locator('.canvas-course-card').first().waitFor();
  assert.notEqual(new URL(preview.url()).origin, origin);
  assert.notEqual(new URL(preview.url()).hostname, new URL(origin).hostname);
  assert.equal(
    (await context.cookies(preview.url())).some((cookie) => cookie.name === 'reader_session'),
    false,
  );
  assert.equal(await preview.evaluate(() => localStorage.getItem('private-fixture')), null);
  await preview.getByRole('button', { name: 'Library', exact: true }).click();
  await preview.locator('#library-heading').filter({ hasText: 'Reading desk' }).waitFor();
  await preview.getByRole('button', { name: 'Complete checkpoint', exact: true }).click();
  assert.equal(await preview.locator('#checkpoint-count').textContent(), '1 checkpoints');
  const capabilities = await preview.evaluate(async () => ({
    connections: await (await fetch('/api/connections')).json(),
    mutation: (
      await fetch('/api/app-changes/apply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      })
    ).status,
  }));
  assert.equal(capabilities.connections.selected, null);
  assert.equal(capabilities.mutation, 403);
  await page.getByLabel('I tried this preview and want to apply these changes.').check();
  await page.getByRole('button', { name: 'Apply to Roger', exact: true }).click();
  await page.locator('.app-change-status').filter({ hasText: 'App files updated' }).waitFor();
  assert.notEqual(await readFile(path.join(checkout, 'public/index.html'), 'utf8'), beforeHTML);
  await page.reload();
  await page.getByRole('button', { name: 'Complete checkpoint', exact: true }).click();
  assert.equal(
    await page.locator('#checkpoint-count').textContent(),
    '1 checkpoints',
    'Applied code runs in the real app',
  );
  await page.goto(`${origin}/app-recovery`);
  await page.getByRole('button', { name: 'Undo last app change', exact: true }).click();
  await page.locator('#status').filter({ hasText: 'Previous source restored' }).waitFor();
  assert.equal(await readFile(path.join(checkout, 'public/index.html'), 'utf8'), beforeHTML);
  assert.equal(await readFile(path.join(checkout, 'src/client/app.mjs'), 'utf8'), beforeJS);
  await page.goto(origin);
  assert.equal(await page.locator('#checkpoint-add').count(), 0);
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      result: 'Whole-app source change workflow passed',
      wholeAppPreview: true,
      existingPageChanged: true,
      integratedFeatureWorks: true,
      noSourceWriteBeforeApply: true,
      isolatedSampleData: true,
      explicitApply: true,
      freshReload: true,
      independentRecovery: true,
    }),
  );
} catch (error) {
  for (const context of browser?.contexts() || [])
    for (const page of context.pages()) {
      const status = await page
        .locator('.app-change-status')
        .textContent()
        .catch(() => '');
      if (status) console.error('App change UI:', status);
    }
  throw error;
} finally {
  await browser?.close();
  server.close();
  server.closeAllConnections();
  await once(server, 'close');
  await run.close();
}
