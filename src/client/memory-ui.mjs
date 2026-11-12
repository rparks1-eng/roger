import { renderChatText } from '/client/chat-format.mjs';
const el = (tag, text, className) => {
  const value = document.createElement(tag);
  if (text !== undefined) value.textContent = text;
  if (className) value.className = className;
  return value;
};
const button = (label, action) => {
  const value = el('button', label, 'button button-secondary');
  value.type = 'button';
  value.addEventListener('click', () => void action());
  return value;
};
export function createMemoryUI({ container, api, onResume, getContext }) {
  const status = el('p', '', 'field-hint');
  status.setAttribute('role', 'status');
  const content = el('div');
  const currentThreads = new Map();
  const key = (scope) => `${scope.courseId || ''}:${scope.assignmentId || ''}`;
  function activeThread(scope) {
    return currentThreads.get(key(scope));
  }
  function setThread(scope, id) {
    if (id) currentThreads.set(key(scope), id);
    else currentThreads.delete(key(scope));
  }
  async function run(action) {
    try {
      return await action();
    } catch (error) {
      status.textContent = error.message;
    }
  }
  async function openThread(id, offset = 0) {
    await run(async () => {
      const data = await api(`/api/memory/thread?id=${encodeURIComponent(id)}&offset=${offset}`);
      content.replaceChildren(el('h2', data.thread.title));
      content.append(
        button('Resume this conversation', async () => {
          setThread(data.thread, data.thread.id);
          await onResume(data.thread);
        }),
      );
      const remove = button('Delete conversation', async () => {
        if (!window.confirm('Delete this saved conversation? Export it first if you want a copy.'))
          return;
        await run(async () => {
          await api('/api/memory/delete', { body: { threadId: id } });
          setThread(data.thread, null);
          await render();
        });
      });
      content.append(remove);
      for (const turn of data.turns) {
        const article = el('article', undefined, 'memory-turn');
        const message = el('div');
        renderChatText(message, turn.content);
        article.append(el('h3', turn.role === 'user' ? 'You' : 'Roger'), message);
        for (const citation of turn.citations || []) {
          if (!citation.url && !citation.sourceUrl) continue;
          const link = el(
            'a',
            `${citation.title || 'Source'}${citation.page && !/\/(?:assignments|pages)(?:\/|$)/.test(citation.url || citation.sourceUrl) ? ' · page ' + citation.page : ''}`,
          );
          link.href = citation.url || citation.sourceUrl;
          link.target = '_blank';
          link.rel = 'noopener noreferrer';
          article.append(link);
        }
        content.append(article);
      }
      if (data.nextOffset !== null)
        content.append(button('Older messages', () => openThread(id, data.nextOffset)));
      if (offset) content.append(button('Latest messages', () => openThread(id)));
      status.textContent =
        'Saved history is context, not proof that old course information is still current.';
    });
  }
  async function render(offset = 0) {
    container.replaceChildren(
      el('p', 'YOUR WORK, REMEMBERED', 'eyebrow'),
      el('h1', 'Conversations & memory'),
      status,
      content,
    );
    status.textContent = 'Loading saved work…';
    await run(async () => {
      const settings = await api('/api/memory/settings');
      const data = await api(`/api/memory/threads?offset=${offset}`);
      const pins = await api('/api/memory/pins');
      content.replaceChildren();
      const controls = el('div', undefined, 'memory-controls');
      controls.append(
        button(settings.paused ? 'Resume memory' : 'Pause memory', () =>
          run(async () => {
            await api('/api/memory/settings', { body: { paused: !settings.paused } });
            await render();
          }),
        ),
        button('New conversation', async () => {
          setThread(getContext(), null);
          status.textContent = 'Your next question starts a new conversation.';
        }),
        button('Export memory', () =>
          run(async () => {
            const data = await api('/api/memory/export');
            const url = URL.createObjectURL(
              new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }),
            );
            const link = el('a');
            link.href = url;
            link.download = 'roger-memory.json';
            link.click();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
          }),
        ),
      );
      content.append(controls);
      const form = el('form', undefined, 'memory-preference');
      const label = el('label', 'A preference Roger should remember');
      label.htmlFor = 'memory-preference';
      const input = el('textarea');
      input.id = 'memory-preference';
      input.maxLength = 2000;
      input.required = true;
      input.placeholder = 'For example: ask one practice question at a time.';
      const scope = el('select');
      scope.setAttribute('aria-label', 'Preference applies to');
      for (const [value, name] of [
        ['global', 'All my conversations'],
        ['course', 'This course'],
      ]) {
        const option = el('option', name);
        option.value = value;
        scope.append(option);
      }
      scope.options[1].disabled = !getContext().courseId;
      const save = el('button', 'Remember this', 'button button-primary');
      save.type = 'submit';
      save.disabled = settings.paused;
      form.append(label, input, scope, save);
      form.addEventListener('submit', (event) => {
        event.preventDefault();
        void run(async () => {
          await api('/api/memory/pin', {
            body: {
              content: input.value,
              scope: scope.value,
              courseId: getContext().courseId || '',
            },
          });
          await render();
        });
      });
      content.append(form);
      content.append(el('h2', 'Pinned preferences'));
      if (!pins.pins.length) content.append(el('p', 'No pinned preferences yet.'));
      for (const pin of pins.pins) {
        const row = el('article', undefined, 'memory-turn');
        row.append(
          el('p', pin.content),
          el('small', pin.scope === 'global' ? 'All conversations' : `Course ${pin.courseId}`),
          button('Forget preference', () =>
            run(async () => {
              await api('/api/memory/forget', { body: { pinId: pin.id } });
              await render();
            }),
          ),
        );
        content.append(row);
      }
      content.append(el('h2', 'Recent conversations'));
      if (!data.threads.length)
        content.append(el('p', 'Ask Roger a question to start your history.'));
      for (const thread of data.threads) {
        const row = el('article', undefined, 'memory-turn');
        row.append(
          button(thread.title, () => openThread(thread.id)),
          el(
            'small',
            `${thread.courseId ? 'Course ' + thread.courseId : 'General'} · ${new Date(thread.updatedAt).toLocaleString()}`,
          ),
        );
        content.append(row);
      }
      if (data.nextOffset !== null)
        content.append(button('Older conversations', () => render(data.nextOffset)));
      if (offset) content.append(button('Latest conversations', () => render()));
      status.textContent = `${settings.paused ? 'Memory is paused.' : 'Memory stays on this computer. Relevant excerpts accompany questions to your chosen AI.'} ${settings.threadCount} conversations · ${(settings.storageBytes / 1048576).toFixed(1)} MB used. You can inspect, export, or delete saved work.`;
    });
  }
  return { render, openThread, activeThread, setThread };
}
