import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CUSTOMIZATION_KEY,
  createCustomization,
  validateCustomization,
} from '../src/client/customization.mjs';

function fixture(initial) {
  const values = new Map(initial ? [[CUSTOMIZATION_KEY, JSON.stringify(initial)]] : []);
  const storage = {
    getItem: (key) => values.get(key),
    setItem: (key, value) => values.set(key, value),
  };
  const root = { dataset: {} };
  return { storage, root, values };
}

test('appearance choices persist and a new instance inherits only validated controls', () => {
  const setup = fixture();
  const first = createCustomization(setup);
  assert.equal(first.handle('set theme to sunset').handled, true);
  first.handle('make text larger');
  first.handle('switch layout to list');
  first.handle('set density to compact');
  const next = createCustomization(setup);
  assert.equal(next.getState().preferences.theme, 'sunset');
  assert.deepEqual(setup.root.dataset, {
    theme: 'sunset',
    fontSize: 'larger',
    layout: 'list',
    density: 'compact',
  });
  const result = next.handle('set theme to javascript');
  assert.match(result.reply, /Choose forest, ink, sunset/);
  assert.equal(setup.root.dataset.theme, 'sunset');
});

test('pages are bounded plain content and survive a fresh instance without execution', () => {
  const setup = fixture();
  const navigation = [];
  const api = createCustomization({ ...setup, onNavigate: (...args) => navigation.push(args) });
  api.handle('add a page called <img src=x onerror=alert(1)>');
  assert.equal(api.getState().pages[0].title, '<img src=x onerror=alert(1)>');
  assert.equal(navigation[0][0], 'customize');
  api.handle('rename page <img src=x onerror=alert(1)> to Exam plan');
  for (let i = 1; i < 12; i++) api.handle(`create a page called Topic ${i}`);
  assert.match(api.handle('add a page called Overflow').reply, /12 saved pages/);
  assert.equal(createCustomization(setup).getState().pages.length, 12);
  assert.equal(createCustomization(setup).getState().pages[0].title, 'Exam plan');
  assert.match(api.exportBrief(), /### Exam plan/);
});

test('academic questions are untouched and feature requests remain explicitly unimplemented', () => {
  const setup = fixture();
  const api = createCustomization(setup);
  assert.deepEqual(api.handle('What causes a change in density?'), { handled: false });
  const result = api.handle('feature request: Build a grade calculator');
  assert.match(result.reply, /feature is not implemented/);
  assert.equal(
    createCustomization(setup).getState().requests[0].text,
    'feature request: Build a grade calculator',
  );
  assert.match(api.exportBrief(), /Requested features — not implemented/);
  for (let i = 1; i < 20; i++) api.handle(`add a feature number ${i}`);
  assert.match(api.handle('add a feature beyond the limit').reply, /20-request/);
});

test('unavailable storage produces session-only result and no false persistence claim', () => {
  const storage = {
    getItem: () => null,
    setItem: () => {
      throw new Error('quota');
    },
  };
  const api = createCustomization({ storage, root: { dataset: {} } });
  const result = api.handle('set theme to ink');
  assert.match(result.reply, /session-only/);
  assert.doesNotMatch(result.reply, /Saved in this browser/);
  assert.equal(api.getState().preferences.theme, 'ink');
});

test('corrupt and oversized persisted records cannot inject controls or executable properties', () => {
  const data = validateCustomization({
    version: 1,
    preferences: { theme: 'url(evil)', layout: 'list' },
    pages: [
      { id: 'valid', title: 'Safe', content: '<script>not executable</script>', script: 'bad' },
      { id: 'valid', title: 'Duplicate', content: '' },
      { id: 'too-large', title: 'Oversized', content: 'x'.repeat(16_001) },
    ],
    requests: [{ id: 'unsafe', text: 'x'.repeat(1_001), createdAt: '' }],
  });
  assert.equal(data.preferences.theme, 'forest');
  assert.equal(data.preferences.layout, 'list');
  assert.equal(data.pages.length, 1);
  assert.equal(data.requests.length, 0);
  assert.equal(data.pages[0].script, undefined);
  const api = createCustomization({
    root: { dataset: {} },
    storage: { getItem: () => '{broken', setItem() {} },
  });
  assert.equal(api.getState().pages.length, 0);
});

test('voice callbacks use all four supported presets without overriding a fresh setup', () => {
  const setup = fixture();
  const heard = [];
  const api = createCustomization({ ...setup, onVoicePreset: (value) => heard.push(value) });
  assert.deepEqual(heard, []);
  for (const voice of ['clear', 'warm', 'calm', 'bright']) api.handle(`set voice to ${voice}`);
  assert.deepEqual(heard, ['clear', 'warm', 'calm', 'bright']);
  createCustomization({ ...setup, onVoicePreset: (value) => heard.push(value) });
  assert.equal(heard.at(-1), 'bright');
  const missing = createCustomization(fixture());
  assert.match(missing.handle('set voice to warm').reply, /unavailable/);
});

test('narration owner overrides stale saved customization voice', () => {
  const setup = fixture();
  const first = createCustomization({ ...setup, onVoicePreset: () => true });
  first.handle('set voice to bright');
  let active = 'warm';
  let changes = 0;
  const api = createCustomization({
    ...setup,
    getVoicePreset: () => active,
    onVoicePreset: () => {
      changes++;
    },
  });
  assert.equal(api.getState().preferences.voice, 'warm');
  assert.equal(changes, 0);
  active = 'calm';
  assert.equal(api.getState().preferences.voice, 'calm');
});
