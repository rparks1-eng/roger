// Isolated browser regression: synthetic model output, private disposable store,
// no user account, no model call, no external network, no active Roger browser.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import { createReaderServer } from '../src/server/http.mjs';
import { createFeatureBuilder } from '../src/server/builder.mjs';
import { qaScratch, browserOptions } from './quality/scratch.mjs';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.READER_PLAYWRIGHT_MODULE || 'playwright');
const run = await qaScratch();
const directory = await mkdtemp(path.join(run.work, 'builder-workflow-'));
const prompts = [];
let modelTime = 0;
let slowStarted, slowAborted;
let signalSlowStart = () => {};
let signalSlowAbort = () => {};
function resetSlow() {
  slowStarted = new Promise((resolve) => {
    signalSlowStart = resolve;
  });
  slowAborted = new Promise((resolve) => {
    signalSlowAbort = resolve;
  });
}
resetSlow();
function boundedWait(promise, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out`)), 10_000);
    timer.unref();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
function fixture(step = 1) {
  return {
    title: 'Practice counter',
    summary: `A counter increasing by ${step}.`,
    html: `<!doctype html><html><head><meta charset="utf-8"><title>Practice counter</title></head><body>
      <h1>Practice counter</h1><button id="increment">Increment</button><output id="count">0</output>
      <button id="parent-probe">Check parent isolation</button><output id="parent-result"></output>
      <button id="fetch-probe">Check network isolation</button><output id="fetch-result"></output>
      <button id="navigation-probe">Check navigation isolation</button>
      <script>
      let count=0; document.querySelector('#increment').onclick=()=>document.querySelector('#count').textContent=String(count+=${step});
      document.querySelector('#parent-probe').onclick=()=>{try{parent.document.body;document.querySelector('#parent-result').textContent='exposed';}catch{document.querySelector('#parent-result').textContent='blocked';}};
      document.querySelector('#fetch-probe').onclick=async()=>{try{await fetch('https://roger-blocked.invalid/probe');document.querySelector('#fetch-result').textContent='exposed';}catch{document.querySelector('#fetch-result').textContent='blocked';}};
      document.querySelector('#navigation-probe').onclick=()=>{location.assign('https://roger-blocked.invalid/navigation');};
      </script></body></html>`,
  };
}
const featureBuilder = createFeatureBuilder({ storagePath: path.join(directory, 'features.json') });
const server = createReaderServer({
  // Model calls are instantaneous fixtures; advance their simulated duration so
  // this UI workflow does not test the independent per-minute admission quota.
  clock: () => Date.now() + modelTime,
  featureBuilder,
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
            setupUrl: 'https://developers.openai.com/codex/auth',
          },
        ],
      };
    },
    async generate({ prompt, signal }) {
      prompts.push(prompt);
      modelTime += 65_000;
      const request = prompt.split('USER REQUEST:\n').at(-1);
      if (request.includes('SLOW_FIXTURE')) {
        signalSlowStart();
        await new Promise((resolve, reject) => {
          const fail = () => {
            signalSlowAbort();
            reject(new Error('Fixture generation cancelled'));
          };
          if (signal.aborted) fail();
          else signal.addEventListener('abort', fail, { once: true });
        });
      }
      if (request.includes('FAIL_FIXTURE')) throw new Error('Fixture unavailable');
      return {
        text: JSON.stringify(
          fixture(request.includes('three') ? 3 : request.includes('two') ? 2 : 1),
        ),
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
  const page = await browser.newPage();
  page.setDefaultTimeout(10_000);
  const external = [],
    errors = [],
    violations = [],
    failedRequests = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('response', (response) => {
    if (response.status() >= 400 && response.status() !== 403)
      failedRequests.push({ status: response.status(), path: new URL(response.url()).pathname });
  });
  page.on('console', (message) => {
    if (/Content Security Policy|violates.*policy|Refused to frame/i.test(message.text()))
      violations.push(message.text());
  });
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
  const navigate = async () => {
    await page.goto(origin);
    await page
      .locator('#roger-ai')
      .filter({ hasText: 'AI · codex' })
      .waitFor({ state: 'attached' });
    await page.getByRole('button', { name: 'Your tools', exact: true }).click();
    await page.locator('.feature-list').waitFor();
  };
  const build = async (request) => {
    await page.locator('#builder-request').fill(request);
    await page.locator('#builder-view button[type="submit"]').click();
    await page.locator('.builder-status').filter({ hasText: 'Preview ready' }).waitFor();
    await page
      .frameLocator('.feature-frame')
      .getByRole('button', { name: 'Increment', exact: true })
      .waitFor();
  };
  const increment = async (expected) => {
    const frame = page.frameLocator('.feature-frame');
    await frame.getByRole('button', { name: 'Increment', exact: true }).click();
    assert.equal(await frame.locator('#count').textContent(), String(expected));
  };
  await navigate();
  await build('Create a counter');
  await increment(1);
  await build('Change increment to two');
  assert.match(prompts.at(-1), /Revise this existing feature/);
  assert.match(prompts.at(-1), /id=\\"increment\\"/);
  await increment(2);
  await page.locator('#builder-request').fill('FAIL_FIXTURE revision');
  await page.locator('#builder-view button[type="submit"]').click();
  await page.locator('.builder-status').filter({ hasText: 'request could not' }).waitFor();
  assert.equal(
    await page.getByRole('button', { name: 'Keep this version', exact: true }).isVisible(),
    true,
  );
  await increment(2);
  const previewUrl = await page.locator('.feature-frame').getAttribute('src');
  const direct = await page.request.get(origin + previewUrl, {
    headers: { 'sec-fetch-dest': 'document' },
  });
  assert.equal(direct.status(), 403);
  const fixtureFrame = page.frames().find((frame) => frame.url().includes('/api/features/preview'));
  assert.equal(await fixtureFrame.evaluate(() => globalThis.document.compatMode), 'CSS1Compat');
  assert.equal(await fixtureFrame.evaluate(() => typeof globalThis.RTCPeerConnection), 'undefined');
  assert.equal(
    await fixtureFrame.evaluate(() => {
      try {
        return globalThis.document.cookie;
      } catch {
        return 'blocked';
      }
    }),
    'blocked',
  );
  await page
    .frameLocator('.feature-frame')
    .getByRole('button', { name: 'Check parent isolation' })
    .click();
  assert.equal(
    await page.frameLocator('.feature-frame').locator('#parent-result').textContent(),
    'blocked',
  );
  await page
    .frameLocator('.feature-frame')
    .getByRole('button', { name: 'Check network isolation' })
    .click();
  await page
    .frameLocator('.feature-frame')
    .locator('#fetch-result')
    .filter({ hasText: 'blocked' })
    .waitFor();
  const navigationBlocked = page.waitForEvent('console', {
    predicate: (message) =>
      /Framing.*roger-blocked\.invalid/.test(message.text()) &&
      /Content Security Policy|violates|Refused/i.test(message.text()),
  });
  await page
    .frameLocator('.feature-frame')
    .getByRole('button', { name: 'Check navigation isolation' })
    .click();
  await navigationBlocked.catch((error) => {
    console.error(JSON.stringify({ external, violations }));
    throw error;
  });
  assert.deepEqual(external, []);
  await page.getByRole('button', { name: 'Keep this version', exact: true }).click();
  await page.locator('.builder-status').filter({ hasText: 'Saved in Roger' }).waitFor();
  await increment(2);
  await navigate();
  await page.locator('.feature-list-item').filter({ hasText: 'Practice counter' }).click();
  await increment(2);
  await build('Change increment to three');
  await increment(3);
  await page.getByRole('button', { name: 'Keep this version', exact: true }).click();
  await page.locator('.builder-status').filter({ hasText: 'Saved in Roger' }).waitFor();
  await page.getByRole('button', { name: 'Undo last change', exact: true }).click();
  await page
    .locator('.builder-status')
    .filter({ hasText: 'Restored the previous version' })
    .waitFor();
  await increment(2);
  await page.getByRole('button', { name: 'Stop preview', exact: true }).click();
  assert.equal(await page.locator('.feature-frame').count(), 0);
  resetSlow();
  await page.locator('#builder-request').fill('SLOW_FIXTURE revision');
  await page.locator('#builder-view button[type="submit"]').click();
  await boundedWait(slowStarted, 'Slow generation start');
  await page.getByRole('button', { name: 'Library', exact: true }).first().click();
  await boundedWait(slowAborted, 'Leave cancellation');
  assert.equal(await page.locator('.feature-frame').count(), 0);
  assert.equal(await page.locator('#builder-view').isVisible(), false);
  await page.getByRole('button', { name: 'Your tools', exact: true }).click();
  await increment(2);
  assert.ok(
    violations.length >= 2,
    'Browser must actually reject the generated network/navigation probes',
  );
  assert.deepEqual(errors, []);
  assert.deepEqual(external, []);
  assert.deepEqual(failedRequests, [{ status: 400, path: '/api/features/build' }]);
  console.log(
    'Builder browser workflow passed: working code, preview revision, persistence, undo, cancellation, iframe isolation and blocked network/navigation.',
  );
} finally {
  await browser?.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await run.close();
}
