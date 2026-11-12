export const APPEARANCE_KEY = 'roger.appearance.v1';
const FONTS = {
  rounded: "'Avenir Next', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
  serif: "'Iowan Old Style', Palatino, Georgia, serif",
  mono: "'SFMono-Regular', Consolas, 'Liberation Mono', monospace",
};
const VARIABLES = [
  'canvas',
  'surface',
  'paper',
  'ink',
  'text',
  'muted',
  'forest',
  'accent',
  'accent-hover',
  'header-ink',
  'wash',
  'line',
  'gold',
  'tile-one',
  'tile-two',
  'tile-three',
  'tile-four',
  'display',
  'body',
  'environment-radius',
];
export function isAppearanceRequest(message) {
  return (
    /\b(?:background|wallpaper|theme|palette|appearance|color scheme|colour scheme|fonts?|round(?:ed)? corners)\b/i.test(
      message,
    ) && /\b(?:make|change|set|turn|create|redesign|give|want|add|use)\b/i.test(message)
  );
}
export function validAppearance(value) {
  if (
    !value ||
    value.version !== 1 ||
    typeof value.title !== 'string' ||
    value.title.length > 100 ||
    !value.title.trim() ||
    !Object.hasOwn(FONTS, value.font) ||
    !['none', 'float', 'bounce', 'drift'].includes(value.motion) ||
    !Number.isInteger(value.radius) ||
    value.radius < 0 ||
    value.radius > 32 ||
    !Array.isArray(value.motifs) ||
    value.motifs.length > 5
  )
    return null;
  const palette = {};
  for (const key of ['canvas', 'surface', 'ink', 'accent']) {
    if (typeof value.palette?.[key] !== 'string' || !/^#[\da-f]{6}$/i.test(value.palette[key]))
      return null;
    palette[key] = value.palette[key];
  }
  if (
    value.motifs.some(
      (symbol) =>
        typeof symbol !== 'string' ||
        !symbol.trim() ||
        symbol.length > 12 ||
        /[<>]/.test(symbol) ||
        [...symbol].some((char) => char.charCodeAt(0) < 32),
    )
  )
    return null;
  return {
    version: 1,
    title: value.title,
    palette,
    font: value.font,
    radius: value.radius,
    motion: value.motion,
    motifs: [...value.motifs],
  };
}
function blend(hex, other, amount) {
  return (
    '#' +
    [1, 3, 5]
      .map((offset) =>
        Math.round(
          parseInt(hex.slice(offset, offset + 2), 16) * (1 - amount) +
            parseInt(other.slice(offset, offset + 2), 16) * amount,
        )
          .toString(16)
          .padStart(2, '0'),
      )
      .join('')
  );
}
function foreground(hex) {
  const values = [1, 3, 5]
    .map((offset) => parseInt(hex.slice(offset, offset + 2), 16) / 255)
    .map((value) => (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4));
  return values.reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0) >
    0.179
    ? '#000000'
    : '#ffffff';
}
const el = (tag, text, className) => {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
};
export function createAppearancePreview({
  container,
  api,
  getSelection,
  onConnect,
  onPreview = () => {},
  root = document.documentElement,
  storage,
} = {}) {
  let applied = null,
    previous = null,
    hasPrevious = false,
    draft = null,
    controller = null,
    generation = 0;
  let store = storage;
  const initialVariables = new Map(
    VARIABLES.map((name) => [name, root.style.getPropertyValue(`--${name}`)]),
  );
  let atmosphere = document.getElementById('roger-atmosphere');
  if (!atmosphere) {
    atmosphere = el('div');
    atmosphere.id = 'roger-atmosphere';
    atmosphere.setAttribute('aria-hidden', 'true');
    document.body.prepend(atmosphere);
  }
  function paint(value) {
    if (!value) {
      for (const [name, oldValue] of initialVariables) {
        if (oldValue) root.style.setProperty(`--${name}`, oldValue);
        else root.style.removeProperty(`--${name}`);
      }
      delete root.dataset.generatedAppearance;
      atmosphere.replaceChildren();
      return;
    }
    const { canvas, surface, ink, accent } = value.palette;
    const variables = {
      canvas,
      surface,
      paper: surface,
      ink,
      text: ink,
      muted: blend(ink, surface, 0.2),
      forest: accent,
      accent,
      'accent-hover': blend(accent, ink, 0.15),
      'header-ink': foreground(accent),
      wash: blend(surface, accent, 0.12),
      line: blend(surface, ink, 0.22),
      gold: accent,
      'tile-one': surface,
      'tile-two': blend(surface, accent, 0.08),
      'tile-three': blend(surface, accent, 0.14),
      'tile-four': blend(surface, accent, 0.2),
      display: FONTS[value.font],
      body: FONTS[value.font],
      'environment-radius': `${value.radius}px`,
    };
    for (const [name, color] of Object.entries(variables))
      root.style.setProperty(`--${name}`, color);
    root.dataset.generatedAppearance = 'true';
    atmosphere.dataset.motion = value.motion;
    atmosphere.replaceChildren();
    if (value.motifs.length)
      for (let index = 0; index < 12; index++) {
        const motif = el('span', value.motifs[index % value.motifs.length], 'environment-motif');
        motif.style.left = `${(index * 37 + 7) % 97}%`;
        motif.style.top = `${(index * 29 + 4) % 94}%`;
        motif.style.fontSize = `${22 + (index % 4) * 8}px`;
        motif.style.animationDelay = `${-(index % 5)}s`;
        motif.style.animationDuration = `${5 + (index % 5)}s`;
        atmosphere.append(motif);
      }
  }
  try {
    if (store === undefined) store = globalThis.localStorage;
    const raw = store?.getItem(APPEARANCE_KEY);
    if (raw && raw.length <= 16_384) {
      const saved = JSON.parse(raw);
      applied = validAppearance(saved.applied);
      previous = validAppearance(saved.previous);
      hasPrevious = saved.hasPrevious === true;
    }
  } catch {
    /* Corrupt or blocked storage leaves the original design intact. */
  }
  paint(applied);
  const status = el('p', '', 'appearance-status');
  status.setAttribute('role', 'status');
  const form = el('form');
  const label = el('label', 'Describe your space');
  label.htmlFor = 'appearance-request';
  const input = el('textarea');
  input.id = 'appearance-request';
  input.rows = 3;
  input.maxLength = 4000;
  input.required = true;
  input.placeholder =
    'Make my background a playful mushroom meadow, with soft bouncing stars and rounded buttons…';
  const build = el('button', 'Preview my space', 'button button-primary');
  build.type = 'submit';
  const cancel = el('button', 'Cancel', 'button button-quiet');
  cancel.type = 'button';
  cancel.hidden = true;
  const controls = el('div', undefined, 'appearance-actions');
  const apply = el('button', 'Keep this appearance', 'button button-primary');
  apply.type = 'button';
  const discard = el('button', 'Restore previous appearance', 'button button-secondary');
  discard.type = 'button';
  const undo = el('button', 'Undo last appearance', 'button button-secondary');
  undo.type = 'button';
  const reset = el('button', 'Use original Roger design', 'button button-quiet');
  reset.type = 'button';
  const previewNotice = el('div', undefined, 'appearance-preview-notice');
  previewNotice.hidden = true;
  previewNotice.append(
    el('strong', 'Previewing your app'),
    el('span', 'Try navigating around. Keep this look or restore the previous one.'),
    apply,
    discard,
  );
  document.body.append(previewNotice);
  controls.append(build, cancel, undo, reset);
  form.append(label, input, controls);
  // Manual colors share the same saved appearance and undo history as Roger previews.
  let colorTarget = 'accent',
    hue = 0,
    saturation = 1,
    brightness = 1,
    editingColor = false;
  const picker = el('section', undefined, 'color-picker');
  const targets = el('div', undefined, 'color-targets');
  targets.setAttribute('role', 'group');
  targets.setAttribute('aria-label', 'Color to edit');
  const targetButtons = new Map();
  for (const [key, name] of Object.entries({
    accent: 'Accent',
    canvas: 'Background',
    surface: 'Cards',
    ink: 'Text',
  })) {
    const button = el('button', name);
    button.type = 'button';
    button.addEventListener('click', () => {
      colorTarget = key;
      editingColor = false;
      syncPicker();
    });
    targets.append(button);
    targetButtons.set(key, button);
  }
  const wheel = el('div', undefined, 'color-wheel');
  wheel.setAttribute('role', 'group');
  wheel.setAttribute('aria-label', 'Color wheel');
  const shade = el('div', undefined, 'color-wheel-shade');
  const marker = el('span', undefined, 'color-wheel-marker');
  shade.setAttribute('aria-hidden', 'true');
  marker.setAttribute('aria-hidden', 'true');
  wheel.append(shade, marker);
  const fields = el('div', undefined, 'color-fields');
  const sliders = [];
  for (const [name, max] of [
    ['Hue', 359],
    ['Saturation', 100],
    ['Brightness', 100],
  ]) {
    const label = el('label', name);
    const slider = el('input');
    slider.type = 'range';
    slider.min = '0';
    slider.max = String(max);
    slider.setAttribute('aria-label', name);
    slider.addEventListener('input', () => {
      const value = Number(slider.value);
      if (name === 'Hue') hue = value;
      else if (name === 'Saturation') saturation = value / 100;
      else brightness = value / 100;
      setColor(fromHSV());
    });
    slider.addEventListener('change', () => {
      editingColor = false;
    });
    label.append(slider);
    fields.append(label);
    sliders.push(slider);
  }
  const hexLabel = el('label', 'Hex color');
  const hex = el('input');
  hex.type = 'text';
  hex.maxLength = 7;
  hex.spellcheck = false;
  hex.setAttribute('aria-label', 'Hex color');
  hex.setAttribute('aria-describedby', 'color-help');
  hex.addEventListener('input', () => {
    const value = hex.value.startsWith('#') ? hex.value : `#${hex.value}`;
    const valid = /^#[\da-f]{6}$/i.test(value);
    hex.setAttribute('aria-invalid', String(!valid));
    if (valid) setColor(value.toLowerCase());
  });
  hex.addEventListener('change', () => {
    editingColor = false;
  });
  hexLabel.append(hex);
  fields.append(hexLabel);
  const pickerBody = el('div', undefined, 'color-picker-body');
  pickerBody.append(wheel, fields);
  const help = el(
    'p',
    'Drag to any shade. Fine-tune with the sliders or enter a hex color. Changes save automatically on this device.',
    'field-hint',
  );
  help.id = 'color-help';
  picker.append(targets, pickerBody, help);
  function currentAppearance() {
    if (draft || applied) return structuredClone(draft || applied);
    const computed = getComputedStyle(root);
    const defaults = { canvas: '#f3f0e7', surface: '#ffffff', ink: '#21392e', accent: '#254c3c' };
    const palette = Object.fromEntries(
      Object.entries(defaults).map(([key, fallback]) => {
        const value = computed.getPropertyValue(`--${key}`).trim();
        return [key, /^#[\da-f]{6}$/i.test(value) ? value : fallback];
      }),
    );
    return {
      version: 1,
      title: 'Custom colors',
      palette,
      font: 'rounded',
      radius: 18,
      motion: 'none',
      motifs: [],
    };
  }
  function fromHSV() {
    const c = brightness * saturation,
      x = c * (1 - Math.abs(((hue / 60) % 2) - 1)),
      m = brightness - c;
    const channels = [
      [c, x, 0],
      [x, c, 0],
      [0, c, x],
      [0, x, c],
      [x, 0, c],
      [c, 0, x],
    ][Math.floor(hue / 60) % 6];
    return (
      '#' +
      channels
        .map((value) =>
          Math.round((value + m) * 255)
            .toString(16)
            .padStart(2, '0'),
        )
        .join('')
    );
  }
  function syncPicker() {
    const palette = currentAppearance().palette;
    const color = palette[colorTarget];
    const [r, g, b] = [1, 3, 5].map(
      (offset) => parseInt(color.slice(offset, offset + 2), 16) / 255,
    );
    const max = Math.max(r, g, b),
      min = Math.min(r, g, b),
      delta = max - min;
    if (delta)
      hue =
        ((max === r ? (g - b) / delta : max === g ? (b - r) / delta + 2 : (r - g) / delta + 4) *
          60 +
          360) %
        360;
    saturation = max ? delta / max : saturation;
    brightness = max;
    hex.value = color;
    hex.setAttribute('aria-invalid', 'false');
    sliders[0].value = String(Math.round(hue));
    sliders[1].value = String(Math.round(saturation * 100));
    sliders[2].value = String(Math.round(brightness * 100));
    shade.style.opacity = String(1 - brightness);
    marker.style.left = `${50 + Math.cos((hue * Math.PI) / 180) * saturation * 50}%`;
    marker.style.top = `${50 + Math.sin((hue * Math.PI) / 180) * saturation * 50}%`;
    marker.style.background = color;
    for (const [key, button] of targetButtons) {
      button.setAttribute('aria-pressed', String(key === colorTarget));
      button.style.setProperty('--swatch', palette[key]);
    }
  }
  function setColor(color) {
    clearPending();
    if (!editingColor) {
      previous = applied;
      hasPrevious = true;
      editingColor = true;
    }
    const discardedPreview = Boolean(draft);
    draft = null;
    if (discardedPreview) paint(applied);
    const next = currentAppearance();
    next.title = 'Custom colors';
    next.palette[colorTarget] = color;
    applied = next;
    draft = null;
    paint(applied);
    status.textContent = persist(applied, previous)
      ? `Color saved.${discardedPreview ? ' The unkept AI preview was discarded.' : ''}`
      : 'Color applied for this session. Browser storage is unavailable.';
    refresh();
  }
  function pointColor(event) {
    const rect = wheel.getBoundingClientRect();
    const x = (event.clientX - rect.left - rect.width / 2) / (rect.width / 2);
    const y = (event.clientY - rect.top - rect.height / 2) / (rect.height / 2);
    hue = ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
    saturation = Math.min(1, Math.hypot(x, y));
    setColor(fromHSV());
  }
  let pointer = null;
  wheel.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || pointer !== null) return;
    pointer = event.pointerId;
    editingColor = false;
    wheel.setPointerCapture(pointer);
    pointColor(event);
  });
  wheel.addEventListener('pointermove', (event) => {
    if (event.pointerId === pointer) pointColor(event);
  });
  const finishColor = (event) => {
    if (event.pointerId !== pointer) return;
    pointer = null;
    editingColor = false;
  };
  wheel.addEventListener('pointerup', finishColor);
  wheel.addEventListener('pointercancel', finishColor);
  wheel.addEventListener('lostpointercapture', finishColor);
  function refresh() {
    syncPicker();
    undo.disabled = !hasPrevious || !!draft || !!controller;
    reset.disabled = !applied && !draft;
    previewNotice.hidden = !draft;
    build.disabled = !!controller;
    cancel.hidden = !controller;
  }
  function persist(next, prior) {
    try {
      if (!store) throw new Error();
      store.setItem(
        APPEARANCE_KEY,
        JSON.stringify({ applied: next, previous: prior, hasPrevious }),
      );
      return true;
    } catch {
      return false;
    }
  }
  function clearPending() {
    generation++;
    controller?.abort();
    controller = null;
  }
  async function request(message) {
    const selection = getSelection?.();
    if (!selection) {
      onConnect?.();
      status.textContent = 'Connect an AI provider to design your space.';
      return false;
    }
    clearPending();
    const ownGeneration = generation;
    controller = new AbortController();
    input.value = message;
    status.textContent = 'Roger is designing your app’s appearance…';
    refresh();
    try {
      const result = await api('/api/appearance/build', {
        body: { ...selection, prompt: message, current: draft ?? applied },
        signal: controller.signal,
      });
      if (ownGeneration !== generation) return false;
      const next = validAppearance(result.appearance);
      if (!next) throw new Error('The generated appearance is not supported.');
      draft = next;
      paint(draft);
      status.textContent = `Preview: ${draft.title}. Your previous appearance is still saved.`;
      onPreview(draft);
      return true;
    } catch (error) {
      if (ownGeneration === generation) status.textContent = error.message;
      return false;
    } finally {
      if (ownGeneration === generation) {
        controller = null;
        refresh();
      }
    }
  }
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    void request(input.value);
  });
  cancel.addEventListener('click', () => {
    clearPending();
    status.textContent = 'Appearance creation cancelled.';
    refresh();
  });
  apply.addEventListener('click', () => {
    if (!draft) return;
    clearPending();
    previous = applied;
    hasPrevious = true;
    applied = draft;
    draft = null;
    const saved = persist(applied, previous);
    status.textContent = saved
      ? `${applied.title} saved in this browser.`
      : `${applied.title} applied for this session. Browser storage is unavailable.`;
    refresh();
  });
  discard.addEventListener('click', () => {
    clearPending();
    draft = null;
    paint(applied);
    status.textContent = 'Previous appearance restored.';
    refresh();
  });
  undo.addEventListener('click', () => {
    if (!hasPrevious) return;
    clearPending();
    editingColor = false;
    const old = applied;
    applied = previous;
    previous = old;
    draft = null;
    paint(applied);
    status.textContent = persist(applied, previous)
      ? 'Previous appearance restored and saved.'
      : 'Appearance restored for this session.';
    refresh();
  });
  reset.addEventListener('click', () => {
    clearPending();
    previous = applied;
    hasPrevious = true;
    applied = null;
    draft = null;
    editingColor = false;
    paint(null);
    status.textContent = persist(null, previous)
      ? 'Original Roger design restored.'
      : 'Original design restored for this session.';
    refresh();
  });
  function render() {
    if (!container) return;
    const advanced = el('details', undefined, 'appearance-ai');
    advanced.append(
      el('summary', 'Ask Roger for a bigger change'),
      el(
        'p',
        'You can also ask Roger from any page to change the look or build a tool. AI changes open as a preview before you keep them.',
      ),
      form,
    );
    const history = el('div', undefined, 'appearance-actions');
    history.append(undo, reset);
    container.replaceChildren(picker, history, status, advanced);
    refresh();
  }
  function dispose() {
    clearPending();
    draft = null;
    paint(applied);
    previewNotice.remove();
  }
  return {
    render,
    request,
    getApplied: () => (applied ? structuredClone(applied) : null),
    dispose,
  };
}
