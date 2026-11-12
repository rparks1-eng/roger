function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}
function button(text, action) {
  const node = element('button', text, 'button button-secondary');
  node.type = 'button';
  node.addEventListener('click', action);
  return node;
}

export function createConnectionsUI({ container, api, onChange = () => {} }) {
  let snapshot = { selected: null, providers: [] },
    generation = 0;
  const notice = element('p', '', 'connection-notice');
  notice.setAttribute('role', 'status');
  let busy = false;
  async function perform(action) {
    if (busy) return;
    busy = true;
    notice.textContent = 'Connecting…';
    container.querySelectorAll('button, input, select').forEach((control) => {
      control.disabled = true;
    });
    try {
      await action();
      await render();
    } catch (error) {
      notice.textContent = error.message;
    } finally {
      busy = false;
      container.querySelectorAll('button, input, select').forEach((control) => {
        control.disabled = false;
      });
    }
  }
  function draw() {
    container.replaceChildren();
    container.append(
      element('h2', 'Choose your AI'),
      element(
        'p',
        'Connect once for this session, choose a model, then ask Roger to help or build. Your selected provider receives only what you send with a request.',
      ),
      notice,
    );
    container.append(
      element(
        'p',
        snapshot.selected
          ? `Using ${snapshot.providers.find((item) => item.id === snapshot.selected.provider)?.name ?? snapshot.selected.provider} · ${snapshot.selected.model === 'account-default' ? 'account default model' : snapshot.selected.model}`
          : 'No connected AI selected.',
        'connection-current',
      ),
    );
    const grid = element('div', undefined, 'connection-grid');
    for (const provider of snapshot.providers) {
      const card = element('section', undefined, 'connection-card');
      card.dataset.provider = provider.id;
      card.append(
        element('h3', provider.name),
        element(
          'p',
          provider.state === 'connected'
            ? 'Connected'
            : provider.state === 'available'
              ? 'Signed in on this computer · ready to connect'
              : provider.state === 'signed-out'
                ? 'Sign in to get started'
                : provider.state === 'not-installed'
                  ? 'Codex is not installed on this computer'
                  : 'Not connected',
          'connection-state',
        ),
        element('p', provider.detail),
      );
      const link = element(
        'a',
        provider.method === 'account' ? 'Codex setup and sign-in help' : 'Get an API key',
      );
      link.href = provider.setupUrl;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      card.append(link);
      if (provider.state === 'connected') {
        const label = element('label', 'Model');
        const select = element('select');
        select.setAttribute('aria-label', `${provider.name} model`);
        for (const model of provider.models) {
          const option = element(
            'option',
            model === 'account-default' ? 'Your Codex account default' : model,
          );
          option.value = model;
          select.append(option);
        }
        select.value = provider.model;
        label.append(select);
        card.append(label);
        card.append(
          button(
            snapshot.selected?.provider === provider.id
              ? 'Use selected model'
              : `Use ${provider.name}`,
            () =>
              perform(async () => {
                await api('/api/connections/connect', {
                  body: { provider: provider.id, model: select.value, consent: true },
                });
                notice.textContent = `${provider.name} is ready.`;
              }),
          ),
          button('Disconnect from Roger', () =>
            perform(async () => {
              await api('/api/connections/disconnect', { body: { provider: provider.id } });
              notice.textContent = 'Disconnected from Roger. Your provider account is unchanged.';
            }),
          ),
        );
      } else if (provider.state !== 'not-installed') {
        const form = element('form', undefined, 'connection-form');
        let key;
        if (provider.method === 'key') {
          const label = element('label', 'API key');
          key = element('input');
          key.type = 'password';
          key.autocomplete = 'off';
          key.required = true;
          key.maxLength = 1024;
          key.setAttribute('aria-label', `${provider.name} API key`);
          label.append(key);
          form.append(label);
        }
        const consentLabel = element('label', undefined, 'connection-consent');
        const consent = element('input');
        consent.type = 'checkbox';
        consent.required = true;
        consentLabel.append(
          consent,
          document.createTextNode(
            provider.state === 'signed-out'
              ? 'Open the official Codex sign-in on this computer.'
              : `Allow Roger to send my requests to ${provider.name}. Usage counts against my provider account.`,
          ),
        );
        form.append(consentLabel);
        const submit = element(
          'button',
          provider.state === 'signed-out' ? 'Sign in with Codex' : `Connect ${provider.name}`,
          'button',
        );
        submit.type = 'submit';
        form.append(submit);
        form.addEventListener('submit', (event) => {
          event.preventDefault();
          if (!consent.checked) return;
          const apiKey = key?.value;
          void perform(async () => {
            if (provider.state === 'signed-out') {
              const result = await api('/api/connections/login', {
                body: { provider: provider.id, consent: true },
              });
              notice.textContent = result.message;
            } else {
              try {
                await api('/api/connections/connect', {
                  body: { provider: provider.id, apiKey, consent: true },
                });
              } finally {
                if (key) key.value = '';
              }
              notice.textContent = `${provider.name} connected. Choose its model below.`;
            }
          });
        });
        card.append(form);
      }
      grid.append(card);
    }
    container.append(
      grid,
      button('Refresh connections', () =>
        perform(async () => {
          notice.textContent = '';
        }),
      ),
    );
    if (snapshot.login?.state === 'waiting') container.append(element('p', snapshot.login.message));
    container.append(
      element(
        'p',
        'Codex uses the official sign-in already available on this computer. Claude, Gemini, Grok and OpenAI API use their provider keys here; Roger does not ask for chat-account passwords. Keys are held in server memory until disconnect, session expiry or server restart.',
      ),
    );
  }
  async function render() {
    const ownGeneration = ++generation;
    if (!snapshot.providers.length)
      container.replaceChildren(
        element('p', 'Checking your AI connections…', 'connection-loading'),
      );
    const next = await api('/api/connections');
    if (ownGeneration !== generation) return;
    snapshot = next;
    draw();
    onChange(getSelection());
  }
  function getSelection() {
    return snapshot.selected ? { ...snapshot.selected } : null;
  }
  return { render, getSelection };
}
