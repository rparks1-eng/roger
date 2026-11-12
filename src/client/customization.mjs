// Local, reversible customization. Saved content is text, never executable code.
export const CUSTOMIZATION_KEY = 'roger.customization.v1';
const LIMITS = Object.freeze({
  pages: 12,
  title: 80,
  content: 16_000,
  requests: 20,
  request: 1_000,
});
const OPTIONS = Object.freeze({
  theme: ['forest', 'ink', 'sunset'],
  density: ['comfortable', 'compact'],
  fontSize: ['readable', 'larger'],
  layout: ['cards', 'list'],
  voice: ['clear', 'warm', 'calm', 'bright'],
});
const fresh = () => ({
  version: 1,
  preferences: Object.fromEntries(Object.entries(OPTIONS).map(([key, values]) => [key, values[0]])),
  pages: [],
  requests: [],
});
const text = (value, max) => typeof value === 'string' && value.length <= max;
const identity = (value) => typeof value === 'string' && /^[a-z0-9-]{1,60}$/.test(value);

export function validateCustomization(value) {
  const result = fresh();
  if (!value || value.version !== 1 || typeof value.preferences !== 'object') return result;
  for (const [key, choices] of Object.entries(OPTIONS))
    if (choices.includes(value.preferences?.[key]))
      result.preferences[key] = value.preferences[key];
  const seen = new Set();
  for (const page of Array.isArray(value.pages) ? value.pages.slice(0, LIMITS.pages) : []) {
    if (
      !page ||
      !identity(page.id) ||
      seen.has(page.id) ||
      !text(page.title, LIMITS.title) ||
      !page.title.trim() ||
      !text(page.content, LIMITS.content)
    )
      continue;
    seen.add(page.id);
    result.pages.push({ id: page.id, title: page.title.trim(), content: page.content });
  }
  for (const request of Array.isArray(value.requests)
    ? value.requests.slice(0, LIMITS.requests)
    : []) {
    if (
      !request ||
      !identity(request.id) ||
      !text(request.text, LIMITS.request) ||
      !request.text.trim() ||
      !text(request.createdAt, 40)
    )
      continue;
    result.requests.push({ id: request.id, text: request.text, createdAt: request.createdAt });
  }
  return result;
}

export function createCustomization({
  onNavigate = () => {},
  onVoicePreset,
  onBuild,
  getVoicePreset,
  storage,
  root,
} = {}) {
  let store = storage;
  let storageAvailable = true;
  let state = fresh();
  let storedVoice = false;
  try {
    if (store === undefined) store = globalThis.localStorage;
    const raw = store?.getItem(CUSTOMIZATION_KEY);
    if (raw && raw.length <= 300_000) {
      const parsed = JSON.parse(raw);
      state = validateCustomization(parsed);
      storedVoice = parsed?.version === 1 && OPTIONS.voice.includes(parsed.preferences?.voice);
    }
    if (!store) storageAvailable = false;
  } catch {
    storageAvailable = false;
  }
  const documentRoot = root || globalThis.document?.documentElement;
  let mounted;
  let selectedPage = state.pages[0]?.id;
  let sequence = 0;
  const id = (prefix) =>
    `${prefix}-${globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}-${(++sequence).toString(36)}`}`;
  function apply() {
    for (const key of ['theme', 'density', 'fontSize', 'layout'])
      if (documentRoot) documentRoot.dataset[key] = state.preferences[key];
  }
  apply();
  // The narration module remains authoritative when its getter is supplied.
  function syncVoice() {
    const voice = getVoicePreset?.();
    if (OPTIONS.voice.includes(voice)) state.preferences.voice = voice;
  }
  if (onVoicePreset && storedVoice && !getVoicePreset) onVoicePreset(state.preferences.voice);
  syncVoice();
  function persist() {
    try {
      if (!store) throw new Error('Storage unavailable');
      store.setItem(CUSTOMIZATION_KEY, JSON.stringify(state));
      storageAvailable = true;
    } catch {
      storageAvailable = false;
    }
    return storageAvailable;
  }
  const saved = () =>
    storageAvailable
      ? ' Saved in this browser.'
      : ' This change is session-only because browser storage is unavailable.';
  function refresh() {
    if (mounted) render(mounted);
  }
  function preference(key, value) {
    if (!OPTIONS[key].includes(value))
      return { handled: true, reply: `Choose ${OPTIONS[key].join(', ')} for ${key}.` };
    if (key === 'voice' && (!onVoicePreset || onVoicePreset(value) === false))
      return {
        handled: true,
        reply:
          'That voice preset is unavailable here. Open the reading controls to see available voices.',
      };
    state.preferences[key] = value;
    apply();
    persist();
    refresh();
    return {
      handled: true,
      reply: `${key === 'fontSize' ? 'Text size' : key[0].toUpperCase() + key.slice(1)} set to ${value}.${saved()}`,
    };
  }
  function addPage(title) {
    title = title.trim().replace(/^["“']|["”']$/g, '');
    if (!title || title.length > LIMITS.title)
      return { handled: true, reply: 'Give the page a name of 1–80 characters.' };
    const existing = state.pages.find((page) => page.title.toLowerCase() === title.toLowerCase());
    if (existing) {
      selectedPage = existing.id;
      refresh();
      onNavigate('customize', { pageId: selectedPage });
      return { handled: true, reply: `Opened your existing “${title}” page.` };
    }
    if (state.pages.length >= LIMITS.pages)
      return {
        handled: true,
        reply:
          'You have 12 saved pages. Export and remove a page in Customize before adding another.',
      };
    const page = { id: id('page'), title, content: '' };
    state.pages.push(page);
    selectedPage = page.id;
    persist();
    refresh();
    onNavigate('customize', { pageId: page.id });
    return {
      handled: true,
      reply: `Created “${title}”, an editable notes page in Customize.${saved()}`,
    };
  }
  function requestFeature(message) {
    if (onBuild) {
      onBuild(message);
      return { handled: true, reply: 'Opening your working preview in Your tools…' };
    }
    if (message.length > LIMITS.request)
      return { handled: true, reply: 'Keep a feature request under 1,000 characters.' };
    if (state.requests.length >= LIMITS.requests)
      return {
        handled: true,
        reply:
          'Your 20-request change list is full. Export it and remove completed requests in Customize.',
      };
    state.requests.push({ id: id('request'), text: message, createdAt: new Date().toISOString() });
    persist();
    refresh();
    return {
      handled: true,
      reply: `Added this to your change brief; the feature is not implemented. Export the brief from Customize for a coding review.${saved()}`,
    };
  }
  function handle(message) {
    if (typeof message !== 'string' || message.length > 2_000) return { handled: false };
    const command = message.trim().replace(/[.!]+$/, '');
    let match = command.match(
      /^(?:please\s+)?(?:set|change|switch)\s+(?:the\s+|my\s+)?(theme|density|layout|voice|font size|text size)\s+(?:to\s+)?([a-z]+)$/i,
    );
    if (match)
      return preference(
        /size/i.test(match[1]) ? 'fontSize' : match[1].toLowerCase(),
        match[2].toLowerCase(),
      );
    if (
      /^(?:please\s+)?(?:make|use)\s+(?:the\s+)?(?:text|font)\s+(?:bigger|larger)$/i.test(command)
    )
      return preference('fontSize', 'larger');
    match = command.match(
      /^(?:please\s+)?(?:add|create|make)\s+(?:a\s+|an\s+)?(?:new\s+)?(?:notes\s+)?page\s+(?:called|named)\s+(.+)$/i,
    );
    if (match) return addPage(match[1]);
    match = command.match(/^rename\s+(?:the\s+)?page\s+["“]?(.+?)["”]?\s+to\s+["“]?(.+?)["”]?$/i);
    if (match) {
      const page = state.pages.find(
        (item) => item.title.toLowerCase() === match[1].trim().toLowerCase(),
      );
      const title = match[2].trim();
      if (!page)
        return {
          handled: true,
          reply: 'I could not find that saved page. Check its name in Customize.',
        };
      if (
        !title ||
        title.length > LIMITS.title ||
        state.pages.some(
          (item) => item !== page && item.title.toLowerCase() === title.toLowerCase(),
        )
      )
        return { handled: true, reply: 'Choose a unique page name of 1–80 characters.' };
      page.title = title;
      persist();
      refresh();
      return { handled: true, reply: `Renamed the page to “${title}”.${saved()}` };
    }
    if (
      /^(?:open|show)\s+(?:my\s+)?(?:customiz(?:e|ation)|saved pages|change brief)$/i.test(command)
    ) {
      onNavigate('customize');
      return {
        handled: true,
        reply: 'Opened Customize: appearance, saved pages, and your change brief.',
      };
    }
    if (
      /^(?:feature request\s*:|(?:add|build|create|implement)\s+(?:a\s+|an\s+)?(?:new\s+)?feature\b)/i.test(
        command,
      )
    )
      return requestFeature(command);
    return { handled: false };
  }
  function exportBrief() {
    syncVoice();
    return [
      '# Roger change brief',
      '',
      'Local preferences',
      '```json',
      JSON.stringify(state.preferences, null, 2),
      '```',
      '',
      '## Requested features — not implemented',
      ...state.requests.map((item) => `- ${item.text}`),
      '',
      '## Saved pages',
      ...state.pages.flatMap((page) => [`### ${page.title}`, '', page.content, '']),
      '## Implementation boundary',
      'Review proposed code and tests before applying changes. This export contains no credentials. It does not execute code, access external accounts, or deploy changes.',
      '',
    ].join('\n');
  }
  function render(container) {
    syncVoice();
    mounted = container;
    const node = (tag, content, className) => {
      const item = document.createElement(tag);
      if (content !== undefined) item.textContent = content;
      if (className) item.className = className;
      return item;
    };
    const button = (label, action, className = 'button button-secondary') => {
      const item = node('button', label, className);
      item.type = 'button';
      item.addEventListener('click', action);
      return item;
    };
    const panel = node('section', undefined, 'customization-panel');
    panel.append(node('h3', 'Reading & display'), node('p', 'Adjust text, spacing and narration.'));
    const controls = node('div', undefined, 'customization-controls');
    for (const [key, choices] of Object.entries(OPTIONS)) {
      if (key === 'theme') continue;
      const label = node(
        'label',
        key === 'fontSize' ? 'Text size' : key[0].toUpperCase() + key.slice(1),
      );
      const select = node('select');
      select.setAttribute('aria-label', label.textContent);
      for (const choice of choices) {
        const option = node('option', choice);
        option.value = choice;
        select.append(option);
      }
      select.value = state.preferences[key];
      select.disabled = key === 'voice' && !onVoicePreset;
      select.addEventListener('change', () => {
        const result = preference(key, select.value);
        announce(result.reply);
      });
      label.append(select);
      controls.append(label);
    }
    panel.append(controls);
    const pages = node('details', undefined, 'customization-pages');
    pages.open = Boolean(selectedPage);
    pages.append(node('summary', 'Your notes & pages'));
    const addForm = node('form');
    const title = node('input');
    title.placeholder = 'New page name';
    title.maxLength = LIMITS.title;
    title.required = true;
    title.setAttribute('aria-label', 'New page name');
    const add = node('button', 'Add page', 'button button-primary');
    add.type = 'submit';
    addForm.append(title, add);
    addForm.addEventListener('submit', (event) => {
      event.preventDefault();
      announce(addPage(title.value).reply);
    });
    pages.append(addForm);
    const list = node('div', undefined, 'customization-page-list');
    for (const page of state.pages) {
      const control = button(page.title, () => {
        selectedPage = page.id;
        render(container);
      });
      control.setAttribute('aria-pressed', String(page.id === selectedPage));
      list.append(control);
    }
    pages.append(list);
    const page = state.pages.find((item) => item.id === selectedPage);
    if (page) {
      const editor = node('section', undefined, 'customization-editor');
      editor.append(node('h4', page.title));
      const content = node('textarea');
      content.value = page.content;
      content.maxLength = LIMITS.content;
      content.rows = 12;
      content.setAttribute('aria-label', `${page.title} content`);
      content.addEventListener('input', () => {
        page.content = content.value;
        persist();
        announce(
          storageAvailable
            ? 'Page saved in this browser.'
            : 'Page is session-only. Export it before closing.',
        );
      });
      editor.append(
        content,
        button('Remove page', () => {
          if (
            page.content &&
            !globalThis.confirm('Remove this saved page? Export your brief first to keep a copy.')
          )
            return;
          state.pages = state.pages.filter((item) => item !== page);
          selectedPage = state.pages[0]?.id;
          persist();
          render(container);
        }),
      );
      pages.append(editor);
    } else
      pages.append(
        node('p', 'Add a notes page here, or tell Roger “add a page called Exam plan”.', 'muted'),
      );
    const requests = node('section', undefined, 'customization-requests');
    requests.append(
      node('h3', onBuild ? 'Ask Roger to change it' : 'Change brief'),
      node(
        'p',
        onBuild
          ? 'Describe the change or tool you want. Roger uses your chosen AI to create a working preview; you try it before choosing Keep.'
          : 'Feature ideas stay here until someone implements and verifies them. Nothing is sent automatically.',
        'muted',
      ),
    );
    const form = node('form');
    const input = node('textarea');
    input.rows = 2;
    input.maxLength = LIMITS.request;
    input.required = true;
    input.placeholder = 'Make my study space calmer, or build a revision planner…';
    input.setAttribute('aria-label', 'Feature request');
    const submit = node(
      'button',
      onBuild ? 'Build preview' : 'Save feature request',
      'button button-secondary',
    );
    submit.type = 'submit';
    form.append(input, submit);
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      if (input.value.trim()) announce(requestFeature(input.value.trim()).reply);
    });
    requests.append(form);
    const queue = node('ul');
    for (const request of state.requests) {
      const row = node('li');
      row.append(
        node('p', request.text),
        button('Remove request', () => {
          state.requests = state.requests.filter((item) => item !== request);
          persist();
          render(container);
        }),
      );
      if (onBuild) row.append(button('Build this idea', () => onBuild(request.text)));
      queue.append(row);
    }
    const exportPages = button('Export saved pages & ideas', () => {
      const blob = new Blob([exportBrief()], { type: 'text/markdown;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const link = node('a');
      link.href = url;
      link.download = 'Roger change brief.md';
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    });
    requests.append(queue);
    if (state.pages.length || state.requests.length) pages.append(exportPages);
    // Existing notes remain reachable; feature building belongs in the Roger conversation.
    if (state.pages.length || state.requests.length) panel.append(pages);
    if (state.requests.length) {
      const archive = node('details');
      archive.append(node('summary', 'Earlier saved ideas'), requests);
      panel.append(archive);
    }
    const status = node(
      'p',
      storageAvailable
        ? 'Saved on this device.'
        : 'Browser storage unavailable. Export your pages before closing.',
      'field-hint',
    );
    status.dataset.customizationStatus = '';
    status.setAttribute('role', 'status');
    panel.append(status);
    container.replaceChildren(panel);
  }
  function announce(message) {
    const status = mounted?.querySelector('[data-customization-status]');
    if (status) status.textContent = message;
  }
  return {
    handle,
    render,
    getState: () => {
      syncVoice();
      return structuredClone(state);
    },
    exportBrief,
  };
}
