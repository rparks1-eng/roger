/** Review actual browser-app edits before the server applies their source files. */
const el = (tag, text, className) => {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
};

export function isAppChangeRequest(message) {
  if (typeof message !== 'string' || message.length > 6000) return false;
  if (/\b(?:standalone|stand-alone|separate tool|independent tool|notes page)\b/i.test(message))
    return false;
  const action =
    /^(?:(?:please|roger|hey(?: roger)?|actually)[,\s]+)*(?:feature request:\s*)?(?:(?:can|could|would|will) you (?:please )?|(?:i (?:want|need)(?: you)? to|i'd like(?: you)? to|we need to|let'?s) )?(?:add|build|create|make|change|redesign|revise|update|improve|remove|move|replace|reorganize)\b/i;
  const surface =
    /\b(?:app|website|site|roger|navigation|sidebar|dashboard|calendar|header|footer|layout|feature|page|library|assignments|courses|reader|assignment list|course list)\b/i;
  const appearance =
    /\b(?:colors?|colours?|theme|palette|wallpaper|background|fonts?|rounded corners)\b/i;
  const structure =
    /\b(?:feature|navigation|sidebar|dashboard|calendar|layout|page|button|filter|sort|search|tab|assignment list|course list)\b/i;
  return (
    action.test(message.trim()) &&
    surface.test(message) &&
    (!appearance.test(message) || structure.test(message))
  );
}

function previewAddress(value) {
  try {
    const url = new URL(value);
    if (
      url.protocol !== 'http:' ||
      !['127.0.0.1', 'localhost'].includes(url.hostname) ||
      !url.port ||
      url.username ||
      url.password
    )
      return null;
    return url.href;
  } catch {
    return null;
  }
}

export function createAppChangesUI({ container, api, getSelection, onConnect, onNavigate }) {
  let draft = null,
    canUndo = false,
    controller = null,
    mutating = false,
    visible = false;
  let generation = 0,
    renderTask = Promise.resolve(),
    loaded = false;
  const heading = el('header', undefined, 'app-changes-heading');
  const eyebrow = el('p', 'CHANGE ROGER', 'eyebrow');
  heading.append(
    eyebrow,
    el('h1', 'Change Roger'),
    el(
      'p',
      'Ask for a page, a feature, or a better way something works. Try the changed app before applying it.',
      'page-description',
    ),
  );
  const stage = el('ol', undefined, 'app-change-steps');
  for (const label of ['Describe the change', 'Try the whole app', 'Apply or discard'])
    stage.append(el('li', label));
  const form = el('form', undefined, 'app-change-form');
  const label = el('label', 'What should Roger change?');
  label.htmlFor = 'app-change-request';
  const input = el('textarea');
  input.id = 'app-change-request';
  input.rows = 3;
  input.maxLength = 5000;
  input.required = true;
  input.placeholder = 'Add a “Due this week” filter to All Assignments, with a count next to it…';
  const actions = el('div', undefined, 'app-change-actions');
  const connect = el('button', 'Choose AI', 'button button-secondary');
  connect.type = 'button';
  const build = el('button', 'Build app preview', 'button button-primary');
  build.type = 'submit';
  const cancel = el('button', 'Cancel build', 'button button-quiet');
  cancel.type = 'button';
  cancel.hidden = true;
  actions.append(connect, build, cancel);
  const disclosure = el(
    'p',
    'Your request and selected public application source go to your chosen AI. Personal files, course content and account keys are not included.',
    'field-hint',
  );
  form.append(label, input, actions, disclosure);
  const status = el('p', '', 'app-change-status');
  status.setAttribute('role', 'status');
  const loading = el('section', undefined, 'app-change-loading');
  loading.hidden = true;
  loading.setAttribute('aria-label', 'Building app preview');
  loading.append(
    el('span', 'Roger is editing the app…'),
    el('div'),
    el('div'),
    el('p', 'The current app stays available. Your change opens as a separate preview.'),
  );
  const review = el('section', undefined, 'app-change-review');
  review.hidden = true;
  const reviewHeading = el('h2');
  const summary = el('p');
  const previewLink = el('a', 'Open app preview ↗', 'button button-primary');
  previewLink.target = '_blank';
  previewLink.rel = 'noopener noreferrer';
  const explanation = el(
    'p',
    'This is a running copy of the full app, using example courses. Try the changed page and its controls; real account connections are unavailable in the preview.',
    'field-hint',
  );
  const checks = el('ul', undefined, 'app-change-checks');
  const files = el('div', undefined, 'app-change-files');
  const confirmation = el('label', undefined, 'app-change-confirmation');
  const confirm = el('input');
  confirm.type = 'checkbox';
  confirm.id = 'app-change-confirm';
  confirmation.append(confirm, el('span', 'I tried this preview and want to apply these changes.'));
  const commitActions = el('div', undefined, 'app-change-actions');
  const apply = el('button', 'Apply to Roger', 'button button-primary');
  apply.type = 'button';
  const discard = el('button', 'Discard preview', 'button button-quiet');
  discard.type = 'button';
  commitActions.append(apply, discard);
  review.append(
    el('p', 'PREVIEW READY', 'eyebrow'),
    reviewHeading,
    summary,
    previewLink,
    explanation,
    checks,
    files,
    confirmation,
    commitActions,
  );
  const recovery = el('footer', undefined, 'app-change-recovery');
  const undo = el('button', 'Undo last app change', 'button button-secondary');
  undo.type = 'button';
  const reload = el('button', 'Reload Roger', 'button button-primary');
  reload.type = 'button';
  reload.hidden = true;
  const recoveryLink = el('a', 'Recovery controls');
  recoveryLink.href = '/app-recovery';
  recoveryLink.target = '_blank';
  recoveryLink.rel = 'noopener noreferrer';
  recovery.append(
    undo,
    reload,
    recoveryLink,
    el(
      'p',
      'Changes edit this local app’s browser pages and behavior. Server, account and permission changes need a separate implementation.',
      'field-hint',
    ),
  );
  container.replaceChildren(heading, stage, form, status, loading, review, recovery);

  function updateControls() {
    const busy = Boolean(controller) || mutating;
    build.disabled = busy || !loaded;
    input.disabled = busy;
    connect.disabled = busy;
    cancel.hidden = !controller;
    loading.hidden = !controller;
    apply.disabled = busy || !draft || !confirm.checked;
    discard.disabled = busy || !draft;
    confirm.disabled = busy || !draft;
    undo.disabled = busy || !canUndo;
    build.textContent = draft ? 'Revise app preview' : 'Build app preview';
    input.placeholder = draft
      ? 'What should Roger adjust in this preview?'
      : 'Add a “Due this week” filter to All Assignments, with a count next to it…';
    const selected = getSelection?.();
    connect.textContent = selected ? `AI · ${selected.label || selected.provider}` : 'Choose AI';
    stage.dataset.step = controller
      ? 'building'
      : draft
        ? 'preview'
        : reload.hidden
          ? 'describe'
          : 'applied';
  }
  function showDraft(next) {
    if (next && !previewAddress(next.previewUrl))
      throw new Error('The app preview address is unavailable. Build it again.');
    draft = next;
    confirm.checked = false;
    review.hidden = !draft;
    files.replaceChildren();
    checks.replaceChildren();
    if (draft) {
      reviewHeading.textContent = draft.title;
      summary.textContent = draft.summary;
      previewLink.href = previewAddress(draft.previewUrl);
      for (const check of draft.checks || [])
        checks.append(
          el(
            'li',
            typeof check === 'string'
              ? check
              : String(check.label || check.name || 'Check completed'),
          ),
        );
      for (const file of draft.files || []) {
        const detail = el('details');
        detail.append(el('summary', file.path));
        const compare = el('div', undefined, 'app-change-comparison');
        for (const [name, content] of [
          ['Before', file.before],
          ['After', file.after],
        ]) {
          const pane = el('section');
          pane.append(el('h3', name), el('pre', content || '(empty)'));
          compare.append(pane);
        }
        detail.append(compare);
        files.append(detail);
      }
    }
    updateControls();
  }
  async function refresh() {
    const ticket = generation;
    try {
      const next = await api('/api/app-changes');
      if (!visible || ticket !== generation) return;
      canUndo = next.canUndo === true;
      showDraft(next.draft || null);
      loaded = true;
      updateControls();
    } catch (error) {
      if (visible && ticket === generation) {
        status.textContent = error.message;
        loaded = false;
        updateControls();
      }
    }
  }
  async function generate() {
    const request = input.value.trim();
    if (!visible || !request || controller || mutating || !loaded) return false;
    const selection = getSelection?.();
    if (!selection) {
      status.textContent = 'Connect an AI first. Your request will stay here.';
      onConnect();
      return false;
    }
    const ticket = ++generation;
    controller = new AbortController();
    const signal = controller.signal;
    reload.hidden = true;
    review.hidden = true;
    status.textContent = 'Building a changed copy of Roger. The current app has not been modified.';
    updateControls();
    try {
      const next = await api('/api/app-changes/build', {
        body: { request, ...selection, ...(draft ? { draftId: draft.id } : {}) },
        signal,
      });
      if (!visible || ticket !== generation) return false;
      showDraft(next);
      input.value = '';
      status.textContent = 'Preview ready. Open it, try the change, then apply or discard it here.';
      return true;
    } catch (error) {
      if (visible && ticket === generation) {
        review.hidden = !draft;
        status.textContent = signal.aborted
          ? 'Build cancelled. No app files were changed.'
          : error.message;
      }
      return false;
    } finally {
      if (ticket === generation) {
        controller = null;
        updateControls();
      }
    }
  }
  async function mutation(action, body) {
    if (mutating || controller) return;
    mutating = true;
    updateControls();
    try {
      const result = await api(`/api/app-changes/${action}`, { body });
      if (action === 'apply' && result.applied !== true)
        throw new Error('The app change was not confirmed. Check recovery before trying again.');
      if (action === 'undo' && result.undone !== true)
        throw new Error('Undo was not confirmed. Check recovery before trying again.');
      showDraft(null);
      status.textContent =
        action === 'apply'
          ? 'App files updated. Reload Roger to use the change. Undo is available here and in Recovery controls.'
          : action === 'undo'
            ? 'Previous app files restored. Reload Roger to use the restored version.'
            : 'Preview discarded. The current app is unchanged.';
      reload.hidden = action === 'discard';
      await refresh();
    } catch (error) {
      status.textContent = error.message;
    } finally {
      mutating = false;
      updateControls();
    }
  }
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    void generate();
  });
  connect.addEventListener('click', onConnect);
  cancel.addEventListener('click', () => controller?.abort());
  confirm.addEventListener('change', updateControls);
  apply.addEventListener('click', () => {
    if (draft && confirm.checked) void mutation('apply', { id: draft.id, confirmation: true });
  });
  discard.addEventListener('click', () => {
    if (draft) void mutation('discard', { id: draft.id });
  });
  undo.addEventListener('click', () => {
    if (canUndo) void mutation('undo', {});
  });
  reload.addEventListener('click', () => {
    if (
      globalThis.confirm(
        'Reload Roger? Open readings and unsaved reading notes will leave this browser session. Download anything you want to keep first.',
      )
    )
      globalThis.location.reload();
  });
  return {
    render() {
      visible = true;
      updateControls();
      renderTask = refresh();
      return renderTask;
    },
    async request(message) {
      onNavigate();
      input.value = message;
      await renderTask;
      return generate();
    },
    leave() {
      visible = false;
      generation++;
      if (controller) {
        controller.abort();
        controller = null;
        status.textContent =
          'Build cancelled because you left app changes. No app files were changed.';
      }
      updateControls();
    },
    getState: () => ({ draft, canUndo, building: Boolean(controller), mutating }),
  };
}
