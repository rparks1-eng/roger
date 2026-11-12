import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { chromium } from 'playwright';
import { qaScratch, browserOptions } from './scratch.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
execFileSync(process.execPath, ['scripts/quality/map.mjs', '--check'], {
  cwd: root,
  stdio: 'pipe',
});
const snapshot = JSON.parse(
  await readFile(path.join(root, 'architecture/source-map.json'), 'utf8'),
);
const url = pathToFileURL(path.join(root, 'architecture/Explorer.html')).href;
const run = await qaScratch();
let browser;
const errors = [],
  requests = [];
try {
  browser = await chromium.launch(browserOptions);
  const context = await browser.newContext({ viewport: { width: 1440, height: 950 } });
  await context.route('**/*', (route) => {
    if (route.request().url() === url) return route.continue();
    requests.push(route.request().url());
    return route.abort();
  });
  const page = await context.newPage();
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(url);
  await page.getByRole('heading', { name: 'How Atlas Reader connects' }).waitFor();
  assert.equal(await page.locator('.node').count(), snapshot.nodes.length);
  assert.equal(await page.locator('.edge').count(), snapshot.edges.length);
  assert.ok(
    await page.locator('.canvas').evaluate((canvas) => {
      const svg = canvas.querySelector('svg');
      return [...canvas.querySelectorAll('.edge')].every((edge) => {
        const bounds = edge.getBBox();
        const end = edge.getPointAtLength(edge.getTotalLength());
        const target = [...canvas.querySelectorAll('.node')].find(
          (node) => node.dataset.file === edge.dataset.to,
        );
        return (
          bounds.x >= 0 &&
          bounds.x + bounds.width <= Number(svg.getAttribute('width')) &&
          (Math.abs(end.x - target.offsetLeft) < 0.2 ||
            Math.abs(end.x - target.offsetLeft - target.offsetWidth) < 0.2)
        );
      });
    }),
    'Arrows must stay inside the canvas and terminate at visible node borders.',
  );

  assert.ok(await page.getByRole('region', { name: 'Request walkthrough' }).isVisible());
  await page.getByRole('button', { name: 'Files and connections', exact: true }).click();
  assert.equal(await page.getByRole('region', { name: 'Request walkthrough' }).isVisible(), false);
  await page.locator('[data-file="src/server/python-domain.mjs"]').click();
  const panel = page.getByRole('complementary', { name: 'Selected module' });
  assert.match(await panel.innerText(), /fixed, allowlisted Python jobs/);
  assert.match(await panel.innerText(), /Declared worker/);
  assert.match(await panel.innerText(), /line \d+/);
  assert.match(await panel.innerText(), new RegExp(snapshot.fingerprint.slice(0, 16)));
  await panel.getByRole('button', { name: 'Python job dispatcher', exact: true }).click();
  assert.match(await panel.innerText(), /Reads one allowed JSON job/);
  await page.getByRole('searchbox', { name: 'Find a module' }).fill('pdf');
  assert.equal(await page.locator('.node').count(), 1);
  await page.getByRole('searchbox', { name: 'Find a module' }).fill('no matching module');
  assert.equal(await page.locator('.node').count(), 0);
  assert.match(await page.locator('.canvas').innerText(), /No matching file/);
  await page.getByRole('searchbox', { name: 'Find a module' }).fill('');
  const first = page.locator('.node').first();
  const label = await first.locator('strong').innerText();
  await first.focus();
  await page.keyboard.press('Enter');
  assert.equal(await panel.getByRole('heading', { level: 2 }).innerText(), label);
  await page.getByRole('button', { name: 'Overview', exact: true }).click();
  await page.getByRole('button', { name: 'Create a presentation', exact: true }).click();
  assert.equal(
    await page.locator('.node[aria-pressed="true"]').getAttribute('data-file'),
    'src/client/app.mjs',
  );
  assert.equal(await page.locator('.node').count(), snapshot.nodes.length);
  for (const width of [390, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    assert.ok(
      await page.evaluate(
        () => globalThis.document.documentElement.scrollWidth <= globalThis.innerWidth + 1,
      ),
      'Map should scroll inside its panel, not overflow the page.',
    );
    assert.ok(await panel.isVisible());
  }
  assert.deepEqual(errors, []);
  assert.deepEqual(requests, []);
  console.log(
    JSON.stringify({
      explorer: true,
      sourceFiles: snapshot.nodes.length,
      links: snapshot.edges.length,
      filteringAndEmptyState: true,
      incomingOutgoingAndLineEvidence: true,
      keyboardAndMobile: true,
      offlineRequests: 0,
      sourceFingerprint: snapshot.fingerprint,
    }),
  );
} finally {
  await browser?.close();
  await run.close();
}
