import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { installedCodex } from '../core/cli-runner.ts';
import { codexStudyArgs } from '../core/cli-protocol.ts';

const LIMITS = { input: 65_536, output: 262_144, text: 131_072, timeout: 120_000 };
const PROVIDERS = [
  {
    id: 'codex',
    name: 'Codex',
    method: 'account',
    setupUrl: 'https://developers.openai.com/codex/auth',
  },
  {
    id: 'openai',
    name: 'OpenAI API',
    method: 'key',
    setupUrl: 'https://platform.openai.com/api-keys',
  },
  {
    id: 'anthropic',
    name: 'Claude API',
    method: 'key',
    setupUrl: 'https://platform.claude.com/settings/keys',
  },
  {
    id: 'gemini',
    name: 'Gemini API',
    method: 'key',
    setupUrl: 'https://aistudio.google.com/api-keys',
  },
  { id: 'xai', name: 'Grok API', method: 'key', setupUrl: 'https://console.x.ai/' },
];
const ORIGINS = {
  openai: 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com/v1',
  gemini: 'https://generativelanguage.googleapis.com/v1beta',
  xai: 'https://api.x.ai/v1',
};
let activeGeneration = false;
let activeLogin = false;
export class ConnectionError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}
function fail(code, message) {
  throw new ConnectionError(code, message);
}
function providerOf(id) {
  const provider = PROVIDERS.find((item) => item.id === id);
  if (!provider) fail('invalid', 'Choose a supported AI provider.');
  return provider;
}
function commandEnvironment() {
  return {
    HOME: homedir(),
    PATH: '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin',
    LANG: 'en_US.UTF-8',
    RUST_LOG: 'error',
  };
}
// Same deny-tools contract as the study transport, with room for feature code.
export function createConnectionEventReader() {
  let buffer = '',
    text = null,
    complete = false,
    started = false,
    startupNotice = false;
  function line(raw) {
    if (!raw.trim()) return;
    const event = JSON.parse(raw);
    if (
      ![
        'thread.started',
        'turn.started',
        'item.started',
        'item.updated',
        'item.completed',
        'turn.completed',
      ].includes(event?.type)
    )
      throw new Error('output');
    if (event.type === 'turn.started') started = true;
    if (event.item !== undefined) {
      const item = event.item;
      if (
        !started &&
        !startupNotice &&
        item?.type === 'error' &&
        item.message ===
          'Code Mode is unavailable because code-mode host is disabled. Code mode will fail closed; enable `features.code_mode_host` and install `codex-code-mode-host`.'
      ) {
        startupNotice = true;
        return;
      }
      if (!['agent_message', 'reasoning'].includes(item?.type)) throw new Error('tool');
      if (event.type === 'item.completed' && item.type === 'agent_message') {
        if (text !== null || complete || typeof item.text !== 'string') throw new Error('output');
        text = item.text;
      }
    }
    if (event.type === 'turn.completed') {
      if (complete) throw new Error('output');
      complete = true;
    }
  }
  return {
    push(chunk) {
      buffer += chunk;
      if (Buffer.byteLength(buffer) > LIMITS.output) throw new Error('oversized');
      let end;
      while ((end = buffer.indexOf('\n')) >= 0) {
        line(buffer.slice(0, end));
        buffer = buffer.slice(end + 1);
      }
    },
    finish() {
      if (buffer.trim()) line(buffer);
      buffer = '';
      if (!complete || text === null) throw new Error('output');
      return JSON.parse(text);
    },
  };
}
// Only fixed official CLI operations are accepted. Output never becomes a command.
function runProcess(
  executable,
  args,
  { signal, cwd, input = '', timeout = 8_000, events = false } = {},
) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new ConnectionError('cancelled', 'Request cancelled.'));
      return;
    }
    const child = spawn(executable, args, {
      cwd: cwd ?? tmpdir(),
      env: commandEnvironment(),
      shell: false,
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '',
      stderr = '',
      total = 0,
      failure,
      killTimer,
      closed = false;
    const eventReader = events ? createConnectionEventReader() : null;
    const terminate = (force) => {
      if (closed) return;
      try {
        process.kill(-child.pid, force ? 'SIGKILL' : 'SIGTERM');
      } catch {
        child.kill(force ? 'SIGKILL' : 'SIGTERM');
      }
    };
    const stop = (error) => {
      if (failure || closed) return;
      failure = error;
      terminate(false);
      killTimer = setTimeout(() => terminate(true), 500);
      killTimer.unref();
    };
    const abort = () => stop(new ConnectionError('cancelled', 'Request cancelled.'));
    const timer = setTimeout(
      () => stop(new ConnectionError('timeout', 'The provider took too long. Try again.')),
      timeout,
    );
    timer.unref();
    signal?.addEventListener('abort', abort, { once: true });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      total += Buffer.byteLength(chunk);
      if (total > LIMITS.output) {
        stop(new ConnectionError('oversized', 'The provider response was too large.'));
        return;
      }
      if (failure) return;
      if (eventReader) {
        try {
          eventReader.push(chunk);
        } catch {
          stop(new ConnectionError('output', 'Codex returned an unsupported response.'));
        }
      } else stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      total += Buffer.byteLength(chunk);
      if (total > LIMITS.output)
        stop(new ConnectionError('oversized', 'The provider response was too large.'));
      else if (!events) stderr += chunk;
    });
    child.stdin.on('error', () =>
      stop(new ConnectionError('unavailable', 'Could not reach the provider.')),
    );
    child.on('error', () => stop(new ConnectionError('unavailable', 'Could not start Codex.')));
    child.on('close', (code) => {
      closed = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      signal?.removeEventListener('abort', abort);
      if (failure) {
        reject(failure);
        return;
      }
      if (events) {
        if (code !== 0) {
          reject(
            new ConnectionError(
              'unavailable',
              'Codex could not complete this request. Check your account access and usage limits.',
            ),
          );
          return;
        }
        try {
          resolve(eventReader.finish());
        } catch {
          reject(new ConnectionError('output', 'Codex did not return a complete response.'));
        }
      } else resolve({ code, stdout, stderr });
    });
    if (signal?.aborted) abort();
    child.stdin.end(failure ? '' : input);
  });
}
async function checkCodex(signal) {
  const executable = await installedCodex();
  if (!executable) return { installed: false, signedIn: false };
  const result = await runProcess(executable, ['login', 'status'], { signal });
  return {
    installed: true,
    signedIn: result.code === 0 && /logged in/i.test(result.stdout + result.stderr),
  };
}
async function runCodex(prompt, signal) {
  const executable = await installedCodex();
  if (!executable) fail('unavailable', 'Install Codex first.');
  const directory = await mkdtemp(path.join(tmpdir(), 'roger-generation-'));
  try {
    const schema = path.join(directory, 'response.json');
    await writeFile(
      schema,
      JSON.stringify({
        type: 'object',
        additionalProperties: false,
        required: ['text'],
        properties: { text: { type: 'string', minLength: 1, maxLength: LIMITS.text } },
      }),
      { mode: 0o600 },
    );
    const result = await runProcess(executable, codexStudyArgs(schema), {
      cwd: directory,
      signal,
      timeout: LIMITS.timeout,
      events: true,
      input: `Respond with the requested result inside the text field. Do not use tools.\n\n${prompt}`,
    });
    if (typeof result?.text !== 'string') fail('output', 'Codex returned no text.');
    return result.text;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
async function startLogin(signal) {
  const executable = await installedCodex();
  if (!executable) fail('unavailable', 'Install Codex to sign in with your ChatGPT account.');
  return runProcess(executable, ['login'], { signal, timeout: 240_000 });
}
async function readJson(response, signal) {
  if (!response.ok) {
    await response.body?.cancel();
    if (response.status === 401 || response.status === 403)
      fail(
        'authentication',
        'The provider rejected this connection. Check its key or account access.',
      );
    if (response.status === 429)
      fail('limit', 'The provider usage limit was reached. Check billing or try later.');
    fail(
      'unavailable',
      'The provider could not complete the request. Check the selected model and account access.',
    );
  }
  const reader = response.body?.getReader();
  if (!reader) fail('output', 'The provider returned an empty response.');
  let length = 0;
  const chunks = [];
  const abort = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener('abort', abort, { once: true });
  try {
    while (true) {
      signal.throwIfAborted();
      const next = await reader.read();
      signal.throwIfAborted();
      if (next.done) break;
      length += next.value.byteLength;
      if (length > LIMITS.output) {
        await reader.cancel();
        fail('oversized', 'The provider response was too large.');
      }
      chunks.push(next.value);
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      fail('output', 'The provider returned an unreadable response.');
    }
  } finally {
    signal.removeEventListener('abort', abort);
    reader.releaseLock();
  }
}
function headers(provider, key) {
  if (provider === 'anthropic')
    return {
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    };
  if (provider === 'gemini') return { 'x-goog-api-key': key, 'content-type': 'application/json' };
  return { authorization: `Bearer ${key}`, 'content-type': 'application/json' };
}
function modelIds(provider, data) {
  if (!data || typeof data !== 'object') fail('output', 'The provider returned no model list.');
  const source = provider === 'gemini' ? data.models : data.data;
  if (!Array.isArray(source)) fail('output', 'The provider returned an unreadable model list.');
  const candidates =
    provider === 'gemini'
      ? source
          .filter((item) => item?.supportedGenerationMethods?.includes('generateContent'))
          .map((item) =>
            typeof item.name === 'string' ? item.name.replace(/^models\//, '') : null,
          )
      : source.map((item) => item?.id);
  return [
    ...new Set(
      candidates.filter(
        (id) =>
          typeof id === 'string' &&
          /^[\w.-]{1,120}$/.test(id) &&
          (provider !== 'openai' || /^(gpt-|o[1-9])/.test(id)) &&
          !/(audio|realtime|image|transcribe|tts|embedding|moderation)/.test(id),
      ),
    ),
  ]
    .sort((a, b) => b.localeCompare(a, 'en', { numeric: true }))
    .slice(0, 100);
}
// Create one service per authenticated Reader session. API keys remain only in
// server memory; neither status nor generated artifacts ever include credentials.
export function createConnectionService({
  fetcher = fetch,
  codexStatus = checkCodex,
  codexGenerate = runCodex,
  codexLogin = startLogin,
} = {}) {
  const connections = new Map();
  let selected = null,
    closed = false,
    revision = 0,
    loginController = null,
    loginState = 'idle',
    loginMessage = '';
  const pending = new Set();
  function assertOpen() {
    if (closed) fail('unavailable', 'Reconnect this Roger session.');
    if (process.env.READER_AI_DISABLED === '1')
      fail('unavailable', 'AI is disabled on this server.');
  }
  function scope(signal, duration) {
    return signal
      ? AbortSignal.any([signal, AbortSignal.timeout(duration)])
      : AbortSignal.timeout(duration);
  }
  async function request(provider, key, endpoint, signal, body) {
    try {
      const response = await fetcher(`${ORIGINS[provider]}${endpoint}`, {
        method: body ? 'POST' : 'GET',
        headers: headers(provider, key),
        body: body ? JSON.stringify(body) : undefined,
        redirect: 'error',
        cache: 'no-store',
        signal,
      });
      return await readJson(response, signal);
    } catch (error) {
      if (error instanceof ConnectionError) throw error;
      if (signal.aborted) fail('cancelled', 'The request was cancelled or timed out.');
      fail('unavailable', 'Could not reach the provider. No other provider was used.');
    }
  }
  async function status(signal) {
    let codex = { installed: false, signedIn: false };
    try {
      codex = await codexStatus(scope(signal, 8_000));
    } catch {
      /* Status never turns failure into connected. */
    }
    if (!codex.signedIn) connections.delete('codex');
    if (selected && !connections.has(selected.provider)) selected = null;
    return {
      selected,
      login: { state: loginState, message: loginMessage },
      providers: PROVIDERS.map((provider) => {
        const connection = connections.get(provider.id);
        return {
          ...provider,
          state: connection
            ? 'connected'
            : provider.id === 'codex'
              ? codex.signedIn
                ? 'available'
                : codex.installed
                  ? 'signed-out'
                  : 'not-installed'
              : 'disconnected',
          models: connection?.models ?? (provider.id === 'codex' ? ['account-default'] : []),
          model: connection?.model ?? null,
          detail:
            provider.id === 'codex'
              ? 'Uses the official Codex account on this computer. It does not read or continue this chat.'
              : 'Connect with a provider API key. API billing is separate from chat subscriptions. Keys last for this Roger server session.',
        };
      }),
    };
  }
  async function connect(value, signal) {
    assertOpen();
    const provider = providerOf(value?.provider);
    if (value?.consent !== true)
      fail('consent', 'Confirm that requests may be sent to this provider.');
    const ownRevision = revision;
    let connection;
    if (provider.id === 'codex') {
      const state = await codexStatus(scope(signal, 8_000));
      if (!state.signedIn) fail('authentication', 'Sign in with Codex first, then connect.');
      connection = { models: ['account-default'], model: 'account-default' };
    } else {
      const existing = connections.get(provider.id);
      const key = value.apiKey ?? existing?.key;
      if (typeof key !== 'string' || key.length < 12 || key.length > 1024 || /\s/.test(key))
        fail('invalid', 'Enter a valid API key from the selected provider.');
      const models = modelIds(
        provider.id,
        await request(
          provider.id,
          key,
          provider.id === 'gemini' ? '/models?pageSize=100' : '/models',
          scope(signal, 15_000),
        ),
      );
      if (!models.length) fail('unavailable', 'This key has no supported text models.');
      const model = value.model || existing?.model || models[0];
      if (!models.includes(model)) fail('invalid', 'Choose a model available to this connection.');
      connection = { key, models, model };
    }
    if (ownRevision !== revision || closed || signal?.aborted)
      fail('cancelled', 'Connection cancelled.');
    connections.set(provider.id, connection);
    selected = { provider: provider.id, model: connection.model };
    return status(signal);
  }
  function disconnect({ provider } = {}) {
    providerOf(provider);
    revision++;
    connections.delete(provider);
    if (selected?.provider === provider) selected = null;
    for (const operation of pending)
      if (operation.provider === provider) operation.controller.abort();
    if (provider === 'codex') loginController?.abort();
    return { disconnected: provider };
  }
  async function login(value, signal) {
    assertOpen();
    if (value?.provider !== 'codex' || value?.consent !== true)
      fail('consent', 'Choose Codex and confirm sign-in.');
    if (activeLogin) fail('busy', 'A Codex sign-in is already open.');
    activeLogin = true;
    loginController = new AbortController();
    loginState = 'waiting';
    loginMessage =
      'Finish signing in in the official Codex browser window, then refresh connections.';
    const controller = loginController;
    void codexLogin(controller.signal)
      .then((result) => {
        loginState = result.code === 0 ? 'complete' : 'failed';
        loginMessage =
          result.code === 0
            ? 'Sign-in finished. Refresh and connect Codex.'
            : 'Sign-in did not complete. Try again.';
      })
      .catch(() => {
        loginState = 'failed';
        loginMessage = 'Sign-in was cancelled or did not complete.';
      })
      .finally(() => {
        activeLogin = false;
        if (loginController === controller) loginController = null;
      });
    return { state: loginState, message: loginMessage };
  }
  async function generate({ provider, model, prompt, signal }) {
    assertOpen();
    providerOf(provider);
    const connection = connections.get(provider);
    if (!connection) fail('consent', 'Connect this provider before sending a request.');
    model ||= connection.model;
    if (!connection.models.includes(model)) fail('invalid', 'Choose a model from this connection.');
    if (typeof prompt !== 'string' || !prompt.trim() || Buffer.byteLength(prompt) > LIMITS.input)
      fail('oversized', 'The request is empty or too long.');
    if (activeGeneration) fail('busy', 'Another AI request is running. Wait or cancel it first.');
    activeGeneration = true;
    const controller = new AbortController();
    const operation = { controller, provider };
    pending.add(operation);
    const operationSignal = scope(
      signal ? AbortSignal.any([signal, controller.signal]) : controller.signal,
      LIMITS.timeout,
    );
    try {
      operationSignal.throwIfAborted();
      let text;
      if (provider === 'codex') text = await codexGenerate(prompt, operationSignal);
      else if (provider === 'anthropic') {
        const data = await request(provider, connection.key, '/messages', operationSignal, {
          model,
          max_tokens: 8192,
          messages: [{ role: 'user', content: prompt }],
        });
        text = data.content
          ?.filter((item) => item.type === 'text')
          .map((item) => item.text)
          .join('\n');
      } else if (provider === 'gemini') {
        const data = await request(
          provider,
          connection.key,
          `/models/${encodeURIComponent(model)}:generateContent`,
          operationSignal,
          {
            contents: [{ role: 'user', parts: [{ text: prompt }] }],
            generationConfig: { maxOutputTokens: 8192 },
          },
        );
        text = data.candidates?.[0]?.content?.parts?.map((item) => item.text ?? '').join('\n');
      } else if (provider === 'openai') {
        const data = await request(provider, connection.key, '/responses', operationSignal, {
          model,
          input: prompt,
          max_output_tokens: 8192,
          store: false,
        });
        text = data.output
          ?.flatMap((item) => (item.type === 'message' ? (item.content ?? []) : []))
          .filter((item) => item.type === 'output_text')
          .map((item) => item.text)
          .join('\n');
      } else {
        const data = await request(provider, connection.key, '/chat/completions', operationSignal, {
          model,
          messages: [{ role: 'user', content: prompt }],
          max_tokens: 8192,
          stream: false,
        });
        text = data.choices?.[0]?.message?.content;
      }
      operationSignal.throwIfAborted();
      if (typeof text !== 'string' || !text.trim() || Buffer.byteLength(text) > LIMITS.text)
        fail('output', 'The provider returned an empty or oversized answer.');
      return { text, provider, model };
    } finally {
      pending.delete(operation);
      activeGeneration = false;
    }
  }
  function dispose() {
    closed = true;
    revision++;
    connections.clear();
    selected = null;
    loginController?.abort();
    for (const operation of pending) operation.controller.abort();
  }
  return { status, connect, disconnect, login, generate, dispose };
}
