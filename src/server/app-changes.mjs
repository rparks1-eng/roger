import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HttpError } from './security.mjs';
import { createAppPreview } from './app-preview.mjs';

const worker = fileURLToPath(new URL('../python/app_changes.py', import.meta.url));
const toolingRoot = fileURLToPath(new URL('../../', import.meta.url));
const python =
  process.env.READER_PYTHON || (process.platform === 'win32' ? 'python' : '/usr/bin/python3');
const TTL = 20 * 60_000;
const MAX_FILE = 256 * 1024;
function fail(status, message) {
  throw new HttpError(status, message);
}
function text(value, label, limit) {
  if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value) > limit)
    fail(400, `${label} is missing or too long.`);
  return value.trim();
}
function checkAbort(signal) {
  if (signal?.aborted) fail(408, 'App change cancelled.');
}
function processText(
  executable,
  args,
  input,
  { signal, timeout = 10_000, limit = 4 * 1024 * 1024 } = {},
) {
  checkAbort(signal);
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      shell: false,
      cwd: toolingRoot,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        PATH: '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin',
        LANG: 'en_US.UTF-8',
        PYTHONDONTWRITEBYTECODE: '1',
      },
    });
    const chunks = [];
    let size = 0,
      failure = null;
    const stop = () => {
      failure ||= new HttpError(408, 'Source check cancelled or timed out.');
      child.kill('SIGKILL');
    };
    const timer = setTimeout(stop, timeout);
    timer.unref();
    signal?.addEventListener('abort', stop, { once: true });
    child.stdout.on('data', (data) => {
      size += data.length;
      if (size > limit) stop();
      else chunks.push(data);
    });
    child.stderr.on('data', (data) => {
      size += data.length;
      if (size > limit) stop();
    });
    child.stdin.on('error', () => {});
    child.on('error', () => {
      failure ||= new HttpError(503, 'The local source checker is unavailable.');
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', stop);
      if (failure) reject(failure);
      else resolve({ code, output: Buffer.concat(chunks).toString('utf8') });
    });
    child.stdin.end(input);
  });
}
function parseResult(result) {
  const raw = text(typeof result === 'string' ? result : result?.text, 'Generated change', 131_072)
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '');
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    fail(502, 'Roger did not return valid source edits. Try a smaller change.');
  }
  const title = text(value?.title, 'Change title', 100);
  const summary = text(value?.summary, 'Change summary', 1600);
  if (!Array.isArray(value.edits) || !value.edits.length || value.edits.length > 12)
    fail(502, 'The change must contain 1–12 exact edits.');
  return { title, summary, edits: value.edits };
}
function excerpts(content, request, budget) {
  if (Buffer.byteLength(content) <= budget) return content;
  const lines = content.split('\n');
  const used = new Set();
  const section = (label, indices, cap) => {
    let output = `\n/* ${label}; omitted source between sections */\n`;
    const chosen = [];
    for (const index of indices) {
      if (used.has(index)) continue;
      const line = `${lines[index]}\n`;
      if (Buffer.byteLength(output) + Buffer.byteLength(line) > cap) continue;
      output += line;
      chosen.push(index);
    }
    chosen.forEach((index) => used.add(index));
    // Restore source order when selecting the tail from the end inward.
    return (
      `\n/* ${label}; omitted source between sections */\n` +
      chosen
        .sort((a, b) => a - b)
        .map((index) => lines[index] + '\n')
        .join('')
    );
  };
  const head = section(
    'FILE HEAD',
    Array.from({ length: Math.min(70, lines.length) }, (_, index) => index),
    Math.floor(budget * 0.25),
  );
  const tail = section(
    'FILE TAIL',
    Array.from({ length: Math.min(50, lines.length) }, (_, index) => lines.length - 1 - index),
    Math.floor(budget * 0.25),
  );
  const terms = [...new Set(request.toLowerCase().match(/[a-z]{4,}/g) || [])].filter(
    (term) => !['please', 'roger', 'change', 'create', 'would', 'should', 'feature'].includes(term),
  );
  const ranked = lines
    .map((line, index) => ({
      index,
      score: terms.filter((term) => line.toLowerCase().includes(term)).length,
    }))
    .filter((item) => item.score)
    .sort((a, b) => b.score - a.score || a.index - b.index);
  const candidates = new Set();
  for (const { index } of ranked)
    for (let cursor = Math.max(0, index - 6); cursor < Math.min(lines.length, index + 16); cursor++)
      candidates.add(cursor);
  const middle = section(
    'REQUEST MATCHES',
    [...candidates],
    budget - Buffer.byteLength(head + tail),
  );
  return head + tail + middle;
}
function literalEdits(result, context, prior) {
  let output;
  try {
    output = parseResult(result);
  } catch (error) {
    error.repairFeedback =
      'Malformed edit response: return one valid JSON object with title, summary and 1–12 edits, each containing string path, find and replace.';
    throw error;
  }
  const changed = new Map(prior?.files.map((file) => [file.path, file.after]) || []);
  const invalid = (message, feedback) => {
    const error = new HttpError(502, message);
    error.repairFeedback = feedback;
    throw error;
  };
  for (const edit of output.edits) {
    const name = typeof edit?.path === 'string' ? edit.path : '';
    if (!Object.hasOwn(context, name))
      invalid(
        'The model requested a file outside the supported app source.',
        `Unsupported path: ${JSON.stringify(name.slice(0, 200))}. Use only the allowlist; no new file paths.`,
      );
    if (
      typeof edit.find !== 'string' ||
      !edit.find.trim() ||
      Buffer.byteLength(edit.find) > MAX_FILE ||
      typeof edit.replace !== 'string' ||
      Buffer.byteLength(edit.replace) > MAX_FILE
    )
      invalid(
        'An app edit is invalid or too large.',
        `Malformed literal edit in ${name}; find must be a nonempty exact source string, replace a string, each below ${MAX_FILE} bytes.`,
      );
    const before = changed.get(name) ?? context[name].content;
    const find = edit.find;
    const offset = before.indexOf(find);
    let occurrences = 0;
    for (let cursor = offset; cursor !== -1; cursor = before.indexOf(find, cursor + 1))
      occurrences++;
    if (occurrences !== 1)
      invalid(
        'An edit did not match one exact source location. Ask Roger to revise it.',
        `Path: ${name}\nExact occurrences: ${occurrences}\nFailed anchor prefix: ${JSON.stringify(find.slice(0, 500))}\nUse a SHORT unique exact anchor copied verbatim, retaining whitespace. Original source excerpts (earlier edits from the rejected response were not kept):\n${excerpts(context[name].content, find, 2800)}`,
      );
    const after = before.slice(0, offset) + edit.replace + before.slice(offset + find.length);
    if (!after || Buffer.byteLength(after) > MAX_FILE)
      invalid(
        'A changed file is too large.',
        `Reduce the changes to ${name} below ${MAX_FILE} bytes.`,
      );
    changed.set(name, after);
  }
  if (changed.size > 6)
    invalid(
      'Change at most six app files in one preview.',
      'Regenerate the complete change touching at most six allowed files.',
    );
  return { output, changed };
}

function sourcePrompt(files, request) {
  const ranks = Object.entries(files)
    .map(([name, file]) => {
      const tokens = name
        .replace(/[^a-z]/g, ' ')
        .split(' ')
        .filter((word) => word.length > 3);
      let score = tokens.reduce(
        (sum, token) => sum + (request.toLowerCase().includes(token) ? 10 : 0),
        0,
      );
      if (name === 'public/index.html') score += 100;
      if (name === 'src/client/app.mjs') score += 90;
      if (name === 'public/styles.css') score += 5;
      return { name, file, score };
    })
    .sort((a, b) => b.score - a.score);
  const sections = ranks
    .slice(0, 4)
    .map(
      ({ name, file }, index) =>
        `FILE ${name}\n${excerpts(file.content, request, index < 2 ? 12000 : 6500)}`,
    );
  return [
    'Modify the REAL Roger browser app source, not a separate tool or proposal. Implement the user request fully within existing browser files.',
    'Return only JSON: {"title":"short title","summary":"what changes and what remains unsupported","edits":[{"path":"exact allowlisted path","find":"exact unique existing text","replace":"replacement text"}]}.',
    'Every find must occur exactly once in the supplied current file. Max 12 edits, 6 files, total reply under 120000 bytes. No markdown. No placeholder buttons.',
    'Use browser JavaScript and the existing app structure. Adding a page requires actual navigation, view mounting and useful interactions integrated with Roger. Preserve unrelated reading/OCR/Canvas controls.',
    'Do not edit server/auth/API/connection/credentials, dependencies, scripts, tests, or the app-change review UI. Never use external URLs, eval, shell commands, inline script tags or new dependencies. Existing fixed server APIs are unchanged. If a request requires backend access, explain the limitation in summary and implement only a useful browser-side portion without pretending new server capabilities exist.',
    'Preview uses synthetic course fixtures with no account connections. User reviews the whole modified app and explicitly applies changes. Sources contain application code only, not personal course data.',
    `ALLOWLIST: ${Object.keys(files).join(', ')}`,
    'SOURCE EXCERPTS (omitted sections are not editable anchors):',
    ...sections,
    `USER REQUEST:\n${request}`,
  ].join('\n\n');
}
export function createAppChangeService({
  root,
  assets,
  previewFactory = createAppPreview,
  clock = Date.now,
} = {}) {
  if (!path.isAbsolute(root || '') || !(assets instanceof Map))
    throw new Error('App changes require an explicit project and asset map.');
  let draft = null,
    active = null,
    closed = false,
    mutation = false;
  const sourceRoot = realpath(root);
  async function job(action, payload = {}, signal) {
    const result = await processText(
      python,
      ['-B', worker, await sourceRoot, action],
      JSON.stringify(payload),
      { signal },
    );
    let value;
    try {
      value = JSON.parse(result.output);
    } catch {
      fail(503, 'The source checker returned an invalid result.');
    }
    if (result.code !== 0 || value.error) fail(409, value.error || 'Source check failed.');
    return value;
  }
  function assertOpen() {
    if (closed) fail(503, 'App changes are unavailable. Reload Roger.');
  }
  function requireOwner(owner) {
    if (typeof owner !== 'string' || !owner) fail(403, 'A current browser session is required.');
  }
  async function clearDraft() {
    const old = draft;
    draft = null;
    if (old) {
      clearTimeout(old.timer);
      await old.preview.close();
    }
  }
  async function sweep() {
    if (draft && draft.expiresAt <= clock()) await clearDraft();
  }
  async function owned(id, owner) {
    assertOpen();
    requireOwner(owner);
    await sweep();
    if (!draft || draft.owner !== owner || draft.id !== id)
      fail(404, 'This app preview expired or belongs to another session.');
    return draft;
  }
  function publicDraft(value) {
    if (!value) return null;
    return {
      id: value.id,
      title: value.title,
      summary: value.summary,
      files: value.files,
      previewUrl: value.preview.url,
      expiresAt: value.expiresAt,
      checks: value.checks,
      status: 'preview',
    };
  }
  async function capture(changed) {
    const project = await sourceRoot;
    const files = new Map();
    let total = 0;
    for (const [url, [relative, mime]] of assets) {
      const full = path.resolve(project, relative);
      if (!full.startsWith(`${project}${path.sep}`) || (await realpath(full)) !== full)
        fail(409, 'Preview assets must be regular files inside this project.');
      let bytes;
      if (changed.has(relative)) bytes = Buffer.from(changed.get(relative));
      else {
        const handle = await open(full, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          const info = await handle.stat();
          if (!info.isFile() || info.size > 12 * 1024 * 1024)
            fail(413, 'A preview asset is too large.');
          bytes = await handle.readFile();
        } finally {
          await handle.close();
        }
      }
      total += bytes.length;
      if (total > 24 * 1024 * 1024) fail(413, 'The app preview is too large.');
      files.set(url, { bytes, mime });
    }
    return files;
  }
  return {
    async get({ owner = '' } = {}) {
      assertOpen();
      requireOwner(owner);
      await sweep();
      return {
        draft: draft?.owner === owner ? publicDraft(draft) : null,
        ...(await job('status')),
      };
    },
    async build(input, { owner = '', signal, generate } = {}) {
      assertOpen();
      requireOwner(owner);
      await sweep();
      checkAbort(signal);
      if (active || mutation || (draft && draft.owner !== owner))
        fail(409, 'Another app change is in progress. Finish or discard it first.');
      const request = text(input?.request, 'Your app change', 5000);
      const provider = text(input?.provider, 'AI provider', 40);
      const model = input?.model === undefined ? undefined : text(input.model, 'Model', 150);
      if (typeof generate !== 'function') fail(503, 'Connect an AI provider first.');
      const prior = input?.draftId ? await owned(input.draftId, owner) : null;
      if (draft && !prior) fail(409, 'Revise or discard your current app preview first.');
      if (active || mutation) fail(409, 'Another app change is in progress.');
      const controller = new AbortController();
      const operationSignal = signal
        ? AbortSignal.any([signal, controller.signal])
        : controller.signal;
      active = { owner, controller };
      let preview;
      try {
        const snapshot = await job('snapshot', {}, operationSignal);
        if (
          prior &&
          Object.entries(prior.baseline).some(([name, hash]) => snapshot.files[name]?.hash !== hash)
        )
          fail(409, 'Source changed since this preview. Discard it and start again.');
        const context = structuredClone(snapshot.files);
        if (prior) for (const file of prior.files) context[file.path].content = file.after;
        const prompt = sourcePrompt(context, request);
        if (Buffer.byteLength(prompt) > 49_000)
          fail(413, 'The source request is too large. Shorten it.');
        let output,
          changed,
          repair = '';
        for (let attempt = 0; attempt < 2; attempt++) {
          checkAbort(operationSignal);
          // Provider failures are outside the validation catch: never replay them automatically.
          const generated = await generate({
            provider,
            model,
            prompt: prompt + repair,
            signal: operationSignal,
          });
          checkAbort(operationSignal);
          try {
            ({ output, changed } = literalEdits(generated, context, prior));
            break;
          } catch (error) {
            if (attempt || typeof error.repairFeedback !== 'string') throw error;
            repair = `\n\nONE REPAIR PASS: The previous response failed literal-edit validation. No source was changed. Regenerate COMPLETE JSON for the original request from the original supplied source; do not return a partial correction. Use short exact unique anchors copied verbatim.\n${error.repairFeedback.slice(0, 4200)}`;
          }
        }
        const files = [];
        for (const [name, candidate] of changed) {
          const formatted = await processText(
            process.execPath,
            [
              path.join(toolingRoot, 'node_modules/prettier/bin/prettier.cjs'),
              '--no-config',
              '--no-editorconfig',
              '--single-quote',
              '--print-width',
              '100',
              '--trailing-comma',
              'all',
              '--parser',
              name.endsWith('.mjs') ? 'babel' : name.endsWith('.css') ? 'css' : 'html',
            ],
            candidate,
            { signal: operationSignal, limit: MAX_FILE + 65536 },
          );
          if (formatted.code !== 0)
            fail(
              502,
              'Generated source could not be formatted or parsed. Ask Roger to revise the change.',
            );
          const after = formatted.output;
          if (Buffer.byteLength(after) > MAX_FILE) fail(413, 'A formatted file is too large.');
          changed.set(name, after);
          const before = snapshot.files[name].content;
          if (before === after) continue;
          if (name.endsWith('.mjs')) {
            const checked = await processText(
              process.execPath,
              ['--input-type=module', '--check'],
              after,
              { signal: operationSignal, limit: 65536 },
            );
            if (checked.code !== 0)
              fail(502, 'Generated JavaScript has a syntax error. Ask Roger to revise the change.');
            const linted = await processText(
              process.execPath,
              [
                path.join(toolingRoot, 'node_modules/eslint/bin/eslint.js'),
                '--no-config-lookup',
                '--config',
                path.join(toolingRoot, 'eslint.config.mjs'),
                '--stdin',
                '--stdin-filename',
                path.join(toolingRoot, name),
              ],
              after,
              { signal: operationSignal, limit: 65536 },
            );
            if (linted.code !== 0)
              fail(
                502,
                'Generated JavaScript did not pass Roger’s code checks. Ask for a revision.',
              );
          }
          if (
            name.endsWith('.html') &&
            (!/<html[\s>]/i.test(after) ||
              !/<\/html\s*>/i.test(after) ||
              /<script\b(?![^>]*\bsrc\s*=)[^>]*>\s*\S/i.test(after))
          )
            fail(
              502,
              'The generated app page is incomplete or includes unsupported inline scripts.',
            );
          files.push({ path: name, before, after });
        }
        if (!files.length)
          fail(502, 'Roger returned no source changes. Try a more specific request.');
        checkAbort(operationSignal);
        let opened = false;
        preview = await previewFactory({
          files: await capture(changed),
          onOpen: () => {
            opened = true;
          },
        });
        checkAbort(operationSignal);
        const next = {
          id: randomUUID(),
          title: output.title,
          summary: output.summary,
          files,
          baseline: Object.fromEntries(
            Object.entries(snapshot.files).map(([name, file]) => [name, file.hash]),
          ),
          owner,
          preview,
          expiresAt: clock() + TTL,
          get opened() {
            return opened;
          },
          checks: [
            'Exact source anchors matched',
            'Code formatted; JavaScript syntax and lint checked',
            'Isolated whole-app preview; sample data only',
          ],
          timer: null,
        };
        await clearDraft();
        draft = next;
        next.timer = setTimeout(() => {
          if (draft === next) void clearDraft();
        }, TTL);
        next.timer.unref();
        preview = null;
        return publicDraft(next);
      } finally {
        await preview?.close();
        active = null;
      }
    },
    async apply({ id, confirmation } = {}, { owner = '' } = {}) {
      if (active || mutation) fail(409, 'Wait for the current app change.');
      mutation = true;
      try {
        const value = await owned(id, owner);
        if (confirmation !== true || !value.opened)
          fail(409, 'Open and review the app preview, then confirm Apply.');
        await job('apply', {
          baseline: value.baseline,
          files: value.files.map(({ path: name, after }) => ({ path: name, after })),
        });
        const title = value.title;
        await clearDraft();
        return { applied: true, title };
      } finally {
        mutation = false;
      }
    },
    async discard({ id } = {}, { owner = '' } = {}) {
      if (active || mutation) fail(409, 'Cancel generation before discarding.');
      mutation = true;
      try {
        await owned(id, owner);
        await clearDraft();
        return { discarded: true };
      } finally {
        mutation = false;
      }
    },
    async undo(_input = {}, { owner = '' } = {}) {
      assertOpen();
      requireOwner(owner);
      if (active || mutation || draft)
        fail(409, 'Finish or discard your preview before undoing an applied change.');
      mutation = true;
      try {
        return await job('undo');
      } finally {
        mutation = false;
      }
    },
    async disposeOwner(owner) {
      if (active?.owner === owner) active.controller.abort();
      if (draft?.owner === owner) await clearDraft();
    },
    async dispose() {
      closed = true;
      active?.controller.abort();
      await clearDraft();
    },
  };
}
