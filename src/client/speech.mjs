let generation = 0;
let naturalProvider = null;
let naturalSession = null;
export function configureNaturalNarration(provider) {
  naturalProvider = typeof provider === 'function' ? provider : null;
}
const pendingVoices = new Set();
export function stopSpeech() {
  generation++;
  for (const cancel of [...pendingVoices]) cancel();
  if (naturalSession) {
    naturalSession.controller.abort();
    naturalSession.audio?.pause();
    if (naturalSession.url) URL.revokeObjectURL(naturalSession.url);
    naturalSession = null;
  }
  if ('speechSynthesis' in window) window.speechSynthesis.cancel();
}
export function pauseSpeech() {
  if (naturalSession) {
    const session = naturalSession;
    naturalSession.paused = !naturalSession.paused;
    if (naturalSession.audio) {
      if (naturalSession.paused) naturalSession.audio.pause();
      else
        void naturalSession.audio
          .play()
          .catch(
            () =>
              naturalSession === session &&
              session.status('Playback could not resume. Try Listen again.'),
          );
    }
    return naturalSession.paused;
  }
  if ('speechSynthesis' in window) {
    if (window.speechSynthesis.paused) window.speechSynthesis.resume();
    else window.speechSynthesis.pause();
    return window.speechSynthesis.paused;
  }
  return false;
}
export const NARRATION_PRESETS = Object.freeze([
  {
    id: 'clear',
    label: 'Clear',
    rate: 1,
    pitch: 1,
    preferred: ['Samantha', 'Alex', 'Ava', 'Serena'],
  },
  {
    id: 'warm',
    label: 'Warm',
    rate: 0.96,
    pitch: 0.98,
    preferred: ['Karen', 'Moira', 'Samantha', 'Allison'],
  },
  {
    id: 'calm',
    label: 'Calm',
    rate: 0.88,
    pitch: 1,
    preferred: ['Daniel', 'Alex', 'Oliver', 'Tom'],
  },
  {
    id: 'bright',
    label: 'Bright',
    rate: 1.05,
    pitch: 1.03,
    preferred: ['Tessa', 'Serena', 'Samantha', 'Ava'],
  },
]);
const SETTINGS_KEY = 'atlas-reader:narration:v1';
const NOVELTY =
  /^(?:Albert|Bad News|Bahh|Bells|Boing|Bubbles|Cellos|Fred|Good News|Hysterical|Jester|Junior|Kathy|Organ|Pipe|Trinoids|Whisper|Wobble|Zarvox)(?:\b|$)/i;
function normalizePreferences(value = {}) {
  return {
    engineId: ['natural', 'device'].includes(value?.engineId) ? value.engineId : 'auto',
    presetId: NARRATION_PRESETS.some((preset) => preset.id === value?.presetId)
      ? value.presetId
      : 'clear',
    voiceId: typeof value?.voiceId === 'string' && value.voiceId.length <= 300 ? value.voiceId : '',
  };
}
let preferences;
try {
  preferences = normalizePreferences(
    JSON.parse(window.localStorage?.getItem(SETTINGS_KEY) || '{}'),
  );
} catch {
  preferences = normalizePreferences();
}
export function getSpeechPreferences() {
  return { ...preferences };
}
export function setSpeechPreferences(value) {
  preferences = normalizePreferences({ ...preferences, ...value });
  try {
    window.localStorage?.setItem(SETTINGS_KEY, JSON.stringify(preferences));
  } catch {
    /* Private browsing may disallow preference storage. */
  }
  return getSpeechPreferences();
}
function voiceId(voice) {
  return `${voice.voiceURI || voice.name}|${voice.lang}`;
}
export function getLocalVoices(synth = window.speechSynthesis) {
  return (synth?.getVoices() || [])
    .filter((voice) => voice.localService === true && /^en(?:[-_]|$)/i.test(voice.lang))
    .map((voice) => ({ id: voiceId(voice), name: voice.name, lang: voice.lang, voice }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
export function narrationChoice(synth = window.speechSynthesis, settings = preferences) {
  const preset =
    NARRATION_PRESETS.find((item) => item.id === settings.presetId) || NARRATION_PRESETS[0];
  const voices = getLocalVoices(synth);
  const explicit = voices.find((item) => item.id === settings.voiceId);
  const score = ({ voice }) => {
    const preferred = preset.preferred.findIndex((name) =>
      new RegExp(`^${name}(?:\\b|$)`, 'i').test(voice.name),
    );
    return (
      (NOVELTY.test(voice.name) ? -20_000 : 0) +
      (/enhanced|premium|neural|natural/i.test(voice.name) ? 10_000 : 0) +
      (preferred >= 0 ? 500 - preferred * 10 : 0) +
      (/^en[-_]US$/i.test(voice.lang) ? 20 : 0) +
      (voice.default ? 10 : 0)
    );
  };
  const selected = explicit || [...voices].sort((a, b) => score(b) - score(a))[0];
  return {
    preset,
    voice: selected?.voice || null,
    count: voices.length,
    fallback: Boolean(settings.voiceId && !explicit),
  };
}
export function watchLocalVoices(callback) {
  const synth = window.speechSynthesis;
  const changed = () => callback(getLocalVoices(synth));
  synth?.addEventListener('voiceschanged', changed);
  changed();
  return () => synth?.removeEventListener('voiceschanged', changed);
}
function localVoice(synth, settings) {
  return narrationChoice(synth, settings).voice;
}
function awaitLocalVoice(synth, settings) {
  const available = localVoice(synth, settings);
  if (available) return Promise.resolve(available);
  return new Promise((resolve) => {
    let timer;
    const finish = (voice) => {
      clearTimeout(timer);
      synth.removeEventListener('voiceschanged', changed);
      pendingVoices.delete(cancel);
      resolve(voice);
    };
    const changed = () => {
      const voice = localVoice(synth, settings);
      if (voice) finish(voice);
    };
    const cancel = () => finish(null);
    pendingVoices.add(cancel);
    synth.addEventListener('voiceschanged', changed);
    timer = setTimeout(cancel, 1500);
    changed();
  });
}
function chunks(text) {
  const pieces = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + 1000, text.length);
    if (end < text.length) {
      // Retain every original character, including the boundary whitespace.
      // Prefer a word boundary; a >1000-character token has to be split.
      let sentence = -1;
      for (let boundary = end; boundary > start + 300; boundary--) {
        if (/[.!?]/.test(text[boundary - 2] || '') && /\s/.test(text[boundary - 1])) {
          sentence = boundary;
          break;
        }
      }
      if (sentence > start) end = sentence;
      for (let boundary = end; boundary > start; boundary--) {
        if (/\s/.test(text[boundary - 1])) {
          end = boundary;
          break;
        }
      }
    }
    pieces.push(text.slice(start, end));
    start = end;
  }
  return pieces;
}
async function readNatural(text, onStatus, settings, options, current) {
  if (!naturalProvider)
    throw new Error(
      'Natural local voices are unavailable. Choose Device voices to use an installed voice.',
    );
  const session = {
    controller: new AbortController(),
    audio: null,
    url: null,
    paused: false,
    status: onStatus,
  };
  naturalSession = session;
  const pieces = chunks(text);
  let index = 0;
  const releaseAudio = () => {
    session.audio?.pause();
    session.audio = null;
    if (session.url) URL.revokeObjectURL(session.url);
    session.url = null;
  };
  const active = () =>
    generation === current && naturalSession === session && !session.controller.signal.aborted;
  async function next() {
    if (!active()) return;
    releaseAudio();
    if (index >= pieces.length) {
      naturalSession = null;
      onStatus(options.sample ? 'Voice sample finished' : 'Finished this page');
      return;
    }
    onStatus(`Preparing natural local voice · part ${index + 1} of ${pieces.length}…`);
    const result = await naturalProvider(
      pieces[index++],
      settings.presetId,
      session.controller.signal,
    );
    if (!active()) return;
    if (!result?.bytes || !/^audio\/wav(?:;|$)/i.test(result.mime || ''))
      throw new Error(
        'The local voice did not return playable audio. Try again or choose Device voices.',
      );
    session.url = URL.createObjectURL(new Blob([result.bytes], { type: 'audio/wav' }));
    const audio = new Audio(session.url);
    session.audio = audio;
    audio.onended = () => {
      void next().catch(failed);
    };
    audio.onerror = () =>
      failed(new Error('Local audio playback failed. Try again or choose Device voices.'));
    if (!session.paused) await audio.play();
    if (active())
      onStatus(
        `${session.paused ? 'Paused' : options.sample ? 'Voice sample' : 'Reading'} · natural local · ${settings.presetId}`,
      );
  }
  function failed(error) {
    if (!active()) return;
    releaseAudio();
    session.controller.abort();
    naturalSession = null;
    onStatus(error.message);
  }
  try {
    await next();
  } catch (error) {
    if (!active()) return 'Stopped';
    failed(error);
    throw error;
  }
  return active() ? 'Reading this page' : 'Stopped';
}

export async function readSpeech(text, onStatus = () => {}, options = {}) {
  stopSpeech();
  if (!text.trim()) throw new Error('This page has no extracted text to read.');
  const current = generation;
  const settings = normalizePreferences({ ...preferences, ...options });
  if (settings.engineId === 'natural' || (settings.engineId === 'auto' && naturalProvider))
    return readNatural(text, onStatus, settings, options, current);
  if (!('speechSynthesis' in window)) throw new Error('This browser does not support narration.');
  const synth = window.speechSynthesis;
  onStatus('Checking local device voices…');
  const voice = await awaitLocalVoice(synth, settings);
  if (current !== generation) return 'Stopped';
  if (!voice) {
    onStatus('Local narration unavailable');
    throw new Error(
      'No local English device voice is available. Enable one in your device settings; Atlas will not silently send this reading to a remote voice service.',
    );
  }
  const { preset, fallback } = narrationChoice(synth, settings);
  const pieces = chunks(text);
  let index = 0;
  function next() {
    if (current !== generation) return;
    if (index >= pieces.length) {
      onStatus(options.sample ? 'Voice sample finished' : 'Finished this page');
      return;
    }
    const utterance = new SpeechSynthesisUtterance(pieces[index++]);
    utterance.voice = voice;
    utterance.lang = voice.lang;
    utterance.rate = preset.rate;
    utterance.pitch = preset.pitch;
    utterance.onend = next;
    utterance.onerror = () => {
      if (current === generation) onStatus('Narration stopped. Try a different device voice.');
    };
    window.speechSynthesis.speak(utterance);
  }
  onStatus(
    `${options.sample ? 'Voice sample' : 'Reading'} · ${preset.label} · ${voice.name}${fallback ? ' (saved voice unavailable)' : ''}`,
  );
  next();
  return 'Reading this page';
}
