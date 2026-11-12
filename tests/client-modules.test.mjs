import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';

const speechSource = await readFile(new URL('../src/client/speech.mjs', import.meta.url), 'utf8');
const documentsSource = await readFile(
  new URL('../src/client/documents.mjs', import.meta.url),
  'utf8',
);
function speechHarness(initial = [], stored = null) {
  const storage = new Map(stored ? [['atlas-reader:narration:v1', stored]] : []);
  let voices = initial;
  const audios = [],
    revoked = [];
  const listeners = new Set(),
    timers = new Map(),
    spoken = [];
  let sequence = 0,
    cancels = 0;
  const synth = {
    getVoices: () => voices,
    addEventListener: (type, fn) => listeners.add(fn),
    removeEventListener: (type, fn) => listeners.delete(fn),
    cancel: () => {
      cancels++;
    },
    speak: (item) => spoken.push(item),
    paused: false,
    pause() {
      this.paused = true;
    },
    resume() {
      this.paused = false;
    },
  };
  const context = vm.createContext({
    window: {
      speechSynthesis: synth,
      localStorage: {
        getItem: (key) => storage.get(key),
        setItem: (key, value) => storage.set(key, value),
      },
    },
    AbortController,
    Blob,
    URL: {
      createObjectURL: () => `blob:fixture-${audios.length}`,
      revokeObjectURL: (url) => revoked.push(url),
    },
    Audio: class {
      constructor(url) {
        this.url = url;
        this.paused = true;
        audios.push(this);
      }
      async play() {
        this.paused = false;
      }
      pause() {
        this.paused = true;
      }
    },
    SpeechSynthesisUtterance: class {
      constructor(text) {
        this.text = text;
      }
    },
    setTimeout: (fn) => {
      const id = ++sequence;
      timers.set(id, fn);
      return id;
    },
    clearTimeout: (id) => timers.delete(id),
  });
  vm.runInContext(
    speechSource.replaceAll('export ', '') +
      '\nglobalThis.api={readSpeech,stopSpeech,pauseSpeech,NARRATION_PRESETS,getSpeechPreferences,setSpeechPreferences,getLocalVoices,narrationChoice,watchLocalVoices,configureNaturalNarration};',
    context,
  );
  return {
    ...context.api,
    spoken,
    audios,
    revoked,
    storage,
    synth,
    listeners,
    timers,
    get cancels() {
      return cancels;
    },
    voices(value) {
      voices = value;
      for (const listener of [...listeners]) listener();
    },
    expire() {
      for (const timer of [...timers.values()]) timer();
    },
  };
}
const local = { name: 'Local', lang: 'en-US', localService: true };
test('narration waits for local voice and never chooses a remote default', async () => {
  const harness = speechHarness([{ name: 'Online', lang: 'en-US', localService: false }]);
  const statuses = [];
  const pending = harness.readSpeech('Read this source.', (text) => statuses.push(text));
  assert.equal(harness.spoken.length, 0);
  assert.equal(harness.listeners.size, 1);
  harness.voices([local]);
  assert.equal(await pending, 'Reading this page');
  assert.equal(harness.spoken[0].voice, local);
  assert.equal(harness.listeners.size, 0);
  assert.equal(harness.timers.size, 0);
  harness.spoken[0].onend();
  assert.equal(statuses.at(-1), 'Finished this page');
});
test('missing local voice fails clearly and releases listeners and timers', async () => {
  const harness = speechHarness([{ name: 'Online', lang: 'en-US', localService: false }]);
  const pending = harness.readSpeech('Source text');
  harness.expire();
  await assert.rejects(pending, /No local English device voice/);
  assert.equal(harness.spoken.length, 0);
  assert.equal(harness.listeners.size, 0);
  assert.equal(harness.timers.size, 0);
});
test('stop cancels delayed voices and stale utterance callbacks', async () => {
  const harness = speechHarness();
  const pending = harness.readSpeech('Old text');
  harness.stopSpeech();
  harness.voices([local]);
  assert.equal(await pending, 'Stopped');
  assert.equal(harness.spoken.length, 0);
  assert.equal(harness.listeners.size, 0);
  assert.equal(harness.timers.size, 0);
  await harness.readSpeech('new '.repeat(400));
  const first = harness.spoken[0];
  harness.stopSpeech();
  first.onend();
  assert.equal(harness.spoken.length, 1);
});
test('word-boundary chunks retain every source character within 1000 chars', async () => {
  const harness = speechHarness([local]);
  const text =
    'A first sentence.\n' +
    'A longer sentence with original spacing.  '.repeat(140) +
    'x'.repeat(1200);
  await harness.readSpeech(text);
  for (let index = 0; index < harness.spoken.length; index++) harness.spoken[index].onend();
  assert.equal(harness.spoken.map((item) => item.text).join(''), text);
  assert.ok(harness.spoken.every((item) => item.text.length <= 1000));
  assert.match(harness.spoken[0].text, /\s$/);
  harness.pauseSpeech();
  assert.equal(harness.synth.paused, true);
  harness.pauseSpeech();
  assert.equal(harness.synth.paused, false);
});
test('four presets choose natural local voices instead of the first novelty voice', async () => {
  const voices = ['Albert', 'Samantha', 'Karen', 'Daniel', 'Tessa'].map((name) => ({
    ...local,
    name,
  }));
  voices.unshift({ ...local, name: 'Remote Premium', localService: false });
  const harness = speechHarness(voices);
  const expected = { clear: 'Samantha', warm: 'Karen', calm: 'Daniel', bright: 'Tessa' };
  assert.deepEqual(
    Array.from(harness.NARRATION_PRESETS, (preset) => preset.id),
    Object.keys(expected),
  );
  for (const preset of harness.NARRATION_PRESETS) {
    harness.setSpeechPreferences({ presetId: preset.id });
    await harness.readSpeech('Keep this exact source wording.');
    const utterance = harness.spoken.at(-1);
    assert.equal(utterance.voice.name, expected[preset.id]);
    assert.equal(utterance.rate, preset.rate);
    assert.equal(utterance.pitch, preset.pitch);
    assert.equal(utterance.text, 'Keep this exact source wording.');
    assert.equal(utterance.voice.localService, true);
  }
});
test('enhanced local voices are preferred and explicit choices remain authoritative', async () => {
  const voices = ['Samantha', 'Karen', 'Ava (Enhanced)'].map((name) => ({ ...local, name }));
  const harness = speechHarness(voices);
  assert.equal(harness.narrationChoice().voice.name, 'Ava (Enhanced)');
  harness.setSpeechPreferences({ voiceId: 'Karen|en-US', presetId: 'calm' });
  await harness.readSpeech('Source text.');
  assert.equal(harness.spoken[0].voice.name, 'Karen');
  assert.equal(harness.spoken[0].rate, 0.88);
  const reloaded = speechHarness(voices, harness.storage.get('atlas-reader:narration:v1'));
  assert.equal(reloaded.getSpeechPreferences().presetId, 'calm');
  assert.equal(reloaded.narrationChoice().voice.name, 'Karen');
});
test('one voice and unavailable saved voices are reported honestly without remote fallback', async () => {
  const harness = speechHarness([local, { ...local, name: 'Online', localService: false }]);
  harness.setSpeechPreferences({ voiceId: 'Online|en-US', presetId: 'warm' });
  const choice = harness.narrationChoice();
  assert.equal(choice.count, 1);
  assert.equal(choice.voice, local);
  assert.equal(choice.fallback, true);
  assert.equal(harness.getLocalVoices().length, 1);
  const invalid = speechHarness([local], '{broken');
  assert.equal(invalid.getSpeechPreferences().presetId, 'clear');
});
test('voice preview uses the chosen delivery and voice observation releases its listener', async () => {
  const harness = speechHarness([local]);
  let observed = 0;
  const cleanup = harness.watchLocalVoices(() => observed++);
  harness.voices([local]);
  assert.equal(observed, 2);
  cleanup();
  assert.equal(harness.listeners.size, 0);
  const statuses = [];
  await harness.readSpeech('A fixed voice preview.', (text) => statuses.push(text), {
    presetId: 'bright',
    sample: true,
  });
  assert.equal(harness.spoken[0].rate, 1.05);
  harness.spoken[0].onend();
  assert.equal(statuses.at(-1), 'Voice sample finished');
});

test('natural local narration uses the selected preset and releases playback on stop', async () => {
  const harness = speechHarness([local]);
  const requests = [];
  harness.configureNaturalNarration(async (text, preset, signal) => {
    requests.push({ text, preset, signal });
    return { bytes: new Uint8Array([1, 2]), mime: 'audio/wav' };
  });
  await harness.readSpeech('The exact source to read.', () => {}, {
    engineId: 'natural',
    presetId: 'warm',
  });
  assert.equal(requests[0].text, 'The exact source to read.');
  assert.equal(requests[0].preset, 'warm');
  assert.equal(harness.spoken.length, 0);
  assert.equal(harness.audios.length, 1);
  assert.equal(harness.pauseSpeech(), true);
  assert.equal(harness.audios[0].paused, true);
  assert.equal(harness.pauseSpeech(), false);
  harness.stopSpeech();
  assert.equal(requests[0].signal.aborted, true);
  assert.equal(harness.audios[0].paused, true);
  assert.equal(harness.revoked.length, 1);
  harness.audios[0].onended();
  assert.equal(requests.length, 1);
});
test('natural synthesis cancelled before completion cannot start audio or device fallback', async () => {
  const harness = speechHarness([local]);
  let complete, signal;
  harness.configureNaturalNarration((_text, _preset, incoming) => {
    signal = incoming;
    return new Promise((resolve) => {
      complete = resolve;
    });
  });
  const pending = harness.readSpeech('Cancelled source.', () => {}, { engineId: 'natural' });
  harness.stopSpeech();
  complete({ bytes: new Uint8Array([1]), mime: 'audio/wav' });
  assert.equal(await pending, 'Stopped');
  assert.equal(signal.aborted, true);
  assert.equal(harness.audios.length, 0);
  assert.equal(harness.spoken.length, 0);
});
test('natural voice errors never silently fall back to device narration', async () => {
  const harness = speechHarness([local]);
  harness.configureNaturalNarration(async () => {
    throw new Error('Local voice worker unavailable.');
  });
  await assert.rejects(
    harness.readSpeech('Source.', () => {}, { engineId: 'natural' }),
    /unavailable/,
  );
  assert.equal(harness.spoken.length, 0);
  assert.equal(harness.audios.length, 0);
});

function documentHarness(getPdfModule) {
  const context = vm.createContext({
    crypto: webcrypto,
    TextDecoder,
    Uint8Array,
    Blob,
    setTimeout,
    clearTimeout,
    URL: { createObjectURL: () => 'blob:fixture', revokeObjectURL: () => {} },
    getPdfModule,
  });
  // Replace only the browser-specific dynamic module URL; extraction code is
  // unchanged. No dependency installs, workers, providers, or network requests.
  assert.equal(documentsSource.split("import('/vendor/pdf.mjs')").length, 2);
  vm.runInContext(
    documentsSource
      .replace("import('/vendor/pdf.mjs')", 'getPdfModule()')
      .replaceAll('export ', '') + '\nglobalThis.api={readDocument,disposeDocuments};',
    context,
  );
  return context.api;
}
const pdfFile = () => new File(['%PDF-fixture'], 'fixture.pdf', { type: 'application/pdf' });
test('failed PDF loading still destroys loading task', async () => {
  let destroyed = 0;
  const api = documentHarness(async () => ({
    GlobalWorkerOptions: {},
    getDocument: () => ({
      promise: Promise.reject(new Error('invalid PDF')),
      destroy: async () => {
        destroyed++;
      },
    }),
  }));
  await assert.rejects(api.readDocument(pdfFile()), /invalid PDF/);
  assert.equal(destroyed, 1);
});
test('failed PDF text extraction cleans the page and loading task', async () => {
  let destroyed = 0,
    cleaned = 0;
  const api = documentHarness(async () => ({
    GlobalWorkerOptions: {},
    getDocument: () => ({
      promise: Promise.resolve({
        numPages: 1,
        getPage: async () => ({
          getTextContent: async () => {
            throw new Error('text failed');
          },
          cleanup: () => {
            cleaned++;
          },
        }),
      }),
      destroy: async () => {
        destroyed++;
      },
    }),
  }));
  await assert.rejects(api.readDocument(pdfFile()), /text failed/);
  assert.equal(cleaned, 1);
  assert.equal(destroyed, 1);
});
test('extracted page offsets exactly cover stored source and text bound is enforced', async () => {
  let destroyed = 0;
  const api = documentHarness(async () => ({
    GlobalWorkerOptions: {},
    getDocument: () => ({
      promise: Promise.resolve({
        numPages: 2,
        getPage: async (page) => ({
          getTextContent: async () => ({ items: [{ str: `Page ${page}`, hasEOL: true }] }),
          cleanup: () => {},
        }),
      }),
      destroy: async () => {
        destroyed++;
      },
    }),
  }));
  const doc = await api.readDocument(pdfFile());
  assert.equal(doc.text, 'Page 1\n\nPage 2\n\n');
  assert.equal(doc.text.slice(doc.pages[0].start, doc.pages[0].end), 'Page 1\n\n');
  assert.equal(doc.pages[1].start, doc.pages[0].end);
  assert.equal(doc.pages[1].end, doc.text.length);
  assert.equal(destroyed, 1);
  await assert.rejects(
    api.readDocument(new File(['x'.repeat(120001)], 'large.txt', { type: 'text/plain' })),
    /120,000/,
  );
});
