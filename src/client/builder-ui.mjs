/** Generated tools run only in a sandboxed iframe; never in Roger's document. */
const el = (tag, text, className) => {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
};
export function isBuildRequest(message) {
  return /^(?:please\s+)?(?:build|create|make|add|change|redesign|revise|update|improve)\b/i.test(
    message.trim(),
  );
}
export function mountFeatureFrame(container, url, title) {
  container.replaceChildren();
  const frame = el('iframe');
  frame.title = title;
  frame.setAttribute('sandbox', 'allow-scripts');
  frame.setAttribute('referrerpolicy', 'no-referrer');
  frame.setAttribute(
    'allow',
    "camera 'none'; microphone 'none'; geolocation 'none'; clipboard-read 'none'; clipboard-write 'none'",
  );
  frame.src = url;
  frame.className = 'feature-frame';
  container.append(frame);
  return frame;
}
export function createBuilderUI({ container, api, getSelection, onConnect, onNavigate }) {
  let current = null,
    draft = null,
    controller = null,
    generation = 0,
    features = [];
  let renderTask = Promise.resolve();
  let visible = false;
  const heading = el('div', undefined, 'builder-heading');
  heading.append(
    el('p', 'MADE FOR THE WAY YOU THINK', 'eyebrow'),
    el('h1', 'Build with Roger'),
    el('p', 'Describe a tool. Try it. Make it yours.', 'page-description'),
  );
  const sidebar = el('aside', undefined, 'feature-library');
  sidebar.setAttribute('aria-label', 'Your tools');
  const list = el('div', undefined, 'feature-list');
  const fresh = el('button', '＋ New tool', 'button button-secondary');
  fresh.type = 'button';
  sidebar.append(el('h2', 'Your tools'), fresh, list);
  const workspace = el('section', undefined, 'builder-workspace');
  const title = el('h2', 'What would help?');
  const description = el(
    'p',
    'Try a revision planner, a practice quiz, a finance calculator, or a study timer.',
    'muted',
  );
  const form = el('form');
  const label = el('label', 'Tell Roger what to build or change');
  label.htmlFor = 'builder-request';
  const input = el('textarea');
  input.id = 'builder-request';
  input.rows = 3;
  input.maxLength = 4000;
  input.required = true;
  input.placeholder =
    'Build a study timer with focus and break sessions, and a checklist I can edit…';
  const row = el('div', undefined, 'builder-actions');
  const connect = el('button', 'Choose AI', 'button button-secondary');
  connect.type = 'button';
  const generate = el('button', 'Build preview', 'button button-primary');
  generate.type = 'submit';
  const cancel = el('button', 'Cancel', 'button button-quiet');
  cancel.type = 'button';
  cancel.hidden = true;
  row.append(connect, generate, cancel);
  const disclosure = el(
    'p',
    'Only your request and the tool being revised go to your chosen AI. Readings are not added automatically.',
    'field-hint',
  );
  form.append(label, input, row, disclosure);
  const status = el('p', '', 'builder-status');
  status.setAttribute('role', 'status');
  const review = el('div', undefined, 'builder-review');
  review.hidden = true;
  const summary = el('p');
  const keep = el('button', 'Keep this version', 'button button-primary');
  keep.type = 'button';
  const discard = el('button', 'Discard preview', 'button button-quiet');
  discard.type = 'button';
  const stop = el('button', 'Stop preview', 'button button-secondary');
  stop.type = 'button';
  const undo = el('button', 'Undo last change', 'button button-secondary');
  undo.type = 'button';
  undo.hidden = true;
  const previewActions = el('div', undefined, 'builder-actions');
  previewActions.append(keep, discard, undo, stop);
  review.append(summary, previewActions);
  const stage = el('div', undefined, 'feature-stage');
  const limits = el(
    'p',
    'Tools run inside Roger as independent interactive pages. They can’t change accounts, submit coursework, install software, or modify Roger’s server.',
    'field-hint',
  );
  workspace.append(title, description, form, status, review, stage, limits);
  const layout = el('div', undefined, 'builder-layout');
  layout.append(sidebar, workspace);
  container.replaceChildren(heading, layout);
  function setBusy(busy) {
    generate.disabled = busy;
    input.disabled = busy;
    fresh.disabled = busy;
    connect.disabled = busy;
    cancel.hidden = !busy;
    keep.disabled = busy;
    discard.disabled = busy;
    undo.disabled = busy;
  }
  function selected() {
    const selection = getSelection();
    connect.textContent = selection ? `AI · ${selection.label || selection.provider}` : 'Choose AI';
    return selection;
  }
  function showFeature(feature) {
    current = feature;
    draft = null;
    title.textContent = feature.title;
    description.textContent = `Saved tool · version ${feature.version}`;
    summary.textContent = feature.summary;
    review.hidden = false;
    keep.hidden = true;
    discard.hidden = true;
    undo.hidden = !feature.canUndo;
    mountFeatureFrame(
      stage,
      `/api/features/view?id=${encodeURIComponent(feature.id)}`,
      feature.title,
    );
    generate.textContent = 'Preview changes';
    input.placeholder = 'What should Roger change about this tool?';
  }
  function showDraft(value) {
    draft = value;
    title.textContent = value.title;
    summary.textContent = value.summary;
    description.textContent = 'Preview · try it before keeping it';
    review.hidden = false;
    keep.hidden = false;
    discard.hidden = false;
    undo.hidden = true;
    generate.textContent = 'Preview changes';
    mountFeatureFrame(
      stage,
      `/api/features/preview?draftId=${encodeURIComponent(value.draftId)}`,
      value.title,
    );
  }
  async function refreshList() {
    const result = await api('/api/features');
    features = result.features;
    list.replaceChildren();
    if (!features.length) list.append(el('p', 'Your saved tools will appear here.', 'muted'));
    for (const feature of features) {
      const button = el('button', feature.title, 'feature-list-item');
      button.type = 'button';
      button.addEventListener('click', async () => {
        if (controller) return;
        if (draft) await discardDraft();
        try {
          showFeature(await api(`/api/features/item?id=${encodeURIComponent(feature.id)}`));
        } catch (error) {
          status.textContent = error.message;
        }
      });
      list.append(button);
    }
  }
  async function discardDraft() {
    const discarded = draft;
    draft = null;
    if (discarded)
      await api('/api/features/discard', { body: { draftId: discarded.draftId } }).catch(() => {});
  }
  async function build() {
    const request = input.value.trim();
    if (!visible || !request || controller) return;
    const selection = selected();
    if (!selection) {
      status.textContent = 'Choose an AI connection first. Your request will stay here.';
      onConnect();
      return;
    }
    const ticket = ++generation;
    controller = new AbortController();
    const signal = controller.signal;
    setBusy(true);
    stage.replaceChildren(el('div', 'Roger is building your preview…', 'feature-loading'));
    review.hidden = true;
    status.textContent = 'Building a working preview. You can cancel while Roger works.';
    try {
      const result = await api('/api/features/build', {
        body: {
          request,
          provider: selection.provider,
          model: selection.model,
          ...(draft
            ? { draftId: draft.draftId }
            : current
              ? { featureId: current.id, baseVersion: current.version }
              : {}),
        },
        signal,
      });
      if (ticket !== generation || !visible) return;
      showDraft(result);
      status.textContent =
        'Preview ready. Test the controls, then keep it or ask for another version.';
    } catch (error) {
      if (ticket === generation) {
        if (draft && visible) showDraft(draft);
        else if (current && visible) showFeature(current);
        else stage.replaceChildren();
        status.textContent = signal.aborted
          ? 'Build cancelled. Your saved version is unchanged.'
          : error.message;
      }
    } finally {
      if (ticket === generation) {
        controller = null;
        setBusy(false);
      }
    }
  }
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    void build();
  });
  connect.addEventListener('click', onConnect);
  cancel.addEventListener('click', () => controller?.abort());
  stop.addEventListener('click', () => {
    stage.replaceChildren();
    status.textContent = 'Preview stopped. Reopen the tool to run it again.';
  });
  fresh.addEventListener('click', async () => {
    await discardDraft();
    current = null;
    input.value = '';
    stage.replaceChildren();
    review.hidden = true;
    title.textContent = 'What would help?';
    description.textContent = 'A new tool, built around you.';
    generate.textContent = 'Build preview';
    status.textContent = '';
    input.focus();
  });
  keep.addEventListener('click', async () => {
    if (!draft || controller) return;
    setBusy(true);
    try {
      const saved = await api('/api/features/keep', { body: { draftId: draft.draftId } });
      current = saved;
      draft = null;
      await refreshList();
      showFeature(saved);
      input.value = '';
      status.textContent = 'Saved in Roger. You can reopen this tool after reloading.';
    } catch (error) {
      status.textContent = error.message;
    } finally {
      setBusy(false);
    }
  });
  discard.addEventListener('click', async () => {
    await discardDraft();
    if (current) showFeature(current);
    else {
      stage.replaceChildren();
      review.hidden = true;
    }
    status.textContent = 'Preview discarded. Your saved tools are unchanged.';
  });
  undo.addEventListener('click', async () => {
    if (!current || controller) return;
    setBusy(true);
    try {
      const restored = await api('/api/features/undo', {
        body: { id: current.id, baseVersion: current.version },
      });
      current = restored;
      await refreshList();
      showFeature(restored);
      status.textContent = 'Restored the previous version.';
    } catch (error) {
      status.textContent = error.message;
    } finally {
      setBusy(false);
    }
  });
  return {
    render() {
      visible = true;
      selected();
      renderTask = refreshList()
        .then(() => {
          if (!visible || controller) return;
          if (draft) showDraft(draft);
          else if (current) showFeature(current);
        })
        .catch((error) => {
          status.textContent = error.message;
        });
      return renderTask;
    },
    async request(message) {
      onNavigate();
      input.value = message;
      await renderTask;
      await build();
    },
    leave() {
      visible = false;
      if (controller) {
        controller.abort();
        controller = null;
        generation++;
        setBusy(false);
        status.textContent = 'Build cancelled because you left the workspace.';
      }
      stage.replaceChildren();
    },
    getState() {
      return { current, draft, building: Boolean(controller) };
    },
  };
}
