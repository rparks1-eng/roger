import test from 'node:test';
import assert from 'node:assert/strict';
import { createAppearanceBuilder, validateAppearance } from '../src/server/appearance-builder.mjs';
import { validAppearance, isAppearanceRequest } from '../src/client/appearance-preview.mjs';

const meadow = () => ({
  version: 1,
  title: 'Mushroom meadow',
  palette: { canvas: '#e3efd8', surface: '#f0f6e8', ink: '#20392b', accent: '#27613e' },
  font: 'rounded',
  radius: 22,
  motion: 'bounce',
  motifs: ['🍄', '⭐'],
});

test('generated appearance accepts new palettes and motion without executable fields', () => {
  const result = validateAppearance({
    ...meadow(),
    script: 'danger()',
    css: 'body{display:none}',
    palette: { ...meadow().palette, url: 'https://example.com' },
  });
  assert.equal(result.motion, 'bounce');
  assert.deepEqual(result.motifs, ['🍄', '⭐']);
  assert.equal(result.script, undefined);
  assert.equal(result.palette.url, undefined);
  assert.deepEqual(validAppearance(result), result);
});

test('unsafe appearance values cannot enter CSS or decoration nodes', () => {
  const attacks = [
    { font: 'url(https://example.com)' },
    { motion: 'expression(alert(1))' },
    { radius: Infinity },
    { radius: -1 },
    { motifs: ['<img onerror=x>'] },
    { motifs: ['a\u0000b'] },
    { motifs: Array(6).fill('⭐') },
    { palette: { ...meadow().palette, canvas: 'url(https://example.com)' } },
  ];
  for (const attack of attacks) {
    assert.throws(() => validateAppearance({ ...meadow(), ...attack }));
    assert.equal(validAppearance({ ...meadow(), ...attack }), null);
  }
  assert.equal(validAppearance({ ...meadow(), radius: 3.2 }), null);
});

test('unreadable model text colors are corrected for both app surfaces', () => {
  const white = validateAppearance({
    ...meadow(),
    palette: { canvas: '#ffffff', surface: '#fdfdfd', ink: '#eeeeee', accent: '#338877' },
  });
  assert.equal(white.palette.ink, '#18201e');
  const dark = validateAppearance({
    ...meadow(),
    palette: { canvas: '#000000', surface: '#101010', ink: '#222222', accent: '#88bbff' },
  });
  assert.equal(dark.palette.ink, '#ffffff');
});

test('builder sends only design data and validates a connected model response', async () => {
  let request;
  const builder = createAppearanceBuilder({
    generate: async (input) => {
      request = input;
      return { text: JSON.stringify(meadow()) };
    },
  });
  const result = await builder.build({
    provider: 'codex',
    model: 'account-default',
    prompt: 'Make the background a bouncy mushroom meadow',
    current: meadow(),
    secret: 'do-not-send',
  });
  assert.equal(result.appearance.title, 'Mushroom meadow');
  assert.equal(request.provider, 'codex');
  assert.ok(request.prompt.includes('mushroom meadow'));
  assert.equal(request.prompt.includes('do-not-send'), false);
  assert.equal(request.prompt.includes('readings'), false);
});

test('cancellation, malformed responses and missing connections leave no appearance result', async () => {
  const aborted = new AbortController();
  aborted.abort();
  const builder = createAppearanceBuilder({
    generate: async () => ({ text: JSON.stringify(meadow()) }),
  });
  await assert.rejects(builder.build({ prompt: 'New theme' }, { signal: aborted.signal }), {
    status: 408,
  });
  await assert.rejects(createAppearanceBuilder().build({ prompt: 'New theme' }), { status: 503 });
  for (const text of [
    'not JSON',
    JSON.stringify({ ...meadow(), motion: 'unknown' }),
    'x'.repeat(16_385),
  ]) {
    await assert.rejects(
      createAppearanceBuilder({ generate: async () => ({ text }) }).build({ prompt: 'New theme' }),
      { status: 502 },
    );
  }
});

test('appearance requests route separately from ordinary academic questions and tool creation', () => {
  assert.equal(isAppearanceRequest('Make my background a bouncy mushroom meadow'), true);
  assert.equal(isAppearanceRequest('Change the font to a bookish serif'), true);
  assert.equal(isAppearanceRequest('Build a finance calculator'), false);
  assert.equal(isAppearanceRequest('What is the background of this author?'), false);
});
