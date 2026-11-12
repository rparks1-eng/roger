import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const worker = fileURLToPath(new URL('../python/presentation.py', import.meta.url));
const interpreter = process.env.READER_PYTHON ?? '/usr/bin/python3';
export const PYTHON_PRESENTATION_LIMITS = Object.freeze({
  bytes: 12 * 1024 * 1024,
  output: 1024 * 1024,
  timeoutMs: 10_000,
});
const messages = {
  input: 'Document must be between 1 byte and 12 MiB.',
  archive: 'PowerPoint archive exceeds its limits.',
  missing: 'PowerPoint slide data is missing.',
  xml: 'Unsupported XML declarations in PowerPoint.',
  slides: 'PowerPoint must contain 1–150 readable slides.',
  text: 'PowerPoint text exceeds this reading’s limit.',
  damaged: 'PowerPoint could not be read. Use a .pptx file or export it to PDF.',
};
let active = false;

export async function pythonPresentationAvailable() {
  if (!path.isAbsolute(interpreter)) return false;
  return Promise.all([access(interpreter, constants.X_OK), access(worker, constants.R_OK)]).then(
    () => true,
    () => false,
  );
}

// Only this fixed Python source runs. Uploaded content is stdin, never arguments.
// No shell, credentials, external API, extracted files or persistent worker.
export async function runPythonPresentation(
  bytes,
  { signal } = {},
  { spawnProcess = spawn, timeoutMs = PYTHON_PRESENTATION_LIMITS.timeoutMs } = {},
) {
  if (
    !(bytes instanceof Uint8Array) ||
    !bytes.byteLength ||
    bytes.byteLength > PYTHON_PRESENTATION_LIMITS.bytes
  )
    throw Error(messages.input);
  if (signal?.aborted) throw Error('Document processing cancelled.');
  if (active) throw Error('Another PowerPoint import is running. Try again shortly.');
  if (!(await pythonPresentationAvailable()))
    throw Error(
      'PowerPoint import requires Python 3.9 or newer. Set READER_PYTHON to its absolute executable path.',
    );
  if (signal?.aborted) throw Error('Document processing cancelled.');
  if (active) throw Error('Another PowerPoint import is running. Try again shortly.');
  active = true;
  try {
    const output = await new Promise((resolve, reject) => {
      const child = spawnProcess(interpreter, ['-I', '-B', worker], {
        shell: false,
        cwd: path.dirname(worker),
        stdio: ['pipe', 'pipe', 'ignore'],
        env: { PATH: '/usr/bin:/bin', LANG: 'en_US.UTF-8' },
      });
      const chunks = [];
      let size = 0,
        failure = null,
        settled = false;
      const stop = (message) => {
        if (!failure) {
          failure = Error(message);
          child.kill('SIGKILL');
        }
      };
      const abort = () => stop('Document processing cancelled.');
      const timer = setTimeout(
        () => stop('PowerPoint import exceeded its 10-second limit.'),
        timeoutMs,
      );
      const finish = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        error ? reject(error) : resolve(Buffer.concat(chunks));
      };
      signal?.addEventListener('abort', abort, { once: true });
      child.on('error', () => finish(Error('Python PowerPoint worker could not start.')));
      child.stdin.on('error', () => {});
      child.stdout.on('data', (chunk) => {
        size += chunk.length;
        if (size > PYTHON_PRESENTATION_LIMITS.output) stop('PowerPoint output exceeded its limit.');
        else if (!failure) chunks.push(chunk);
      });
      child.on('close', (code) =>
        finish(failure ?? (code === 0 ? null : Error('Python PowerPoint worker failed.'))),
      );
      child.stdin.end(bytes);
      if (signal?.aborted) abort();
    });
    let envelope;
    try {
      envelope = JSON.parse(output.toString('utf8'));
    } catch {
      throw Error('Python returned an invalid PowerPoint result.');
    }
    if (envelope?.ok === false) throw Error(messages[envelope.error] ?? messages.damaged);
    const result = envelope?.result;
    if (
      envelope?.ok !== true ||
      result?.kind !== 'pptx' ||
      result.layout !== 'text-only' ||
      !Array.isArray(result.pages) ||
      !result.pages.length ||
      result.pages.length > 150 ||
      result.pages.some((p, i) => p?.page !== i + 1 || typeof p.text !== 'string') ||
      result.pages.reduce((n, p) => n + p.text.length, 0) > 120_000 ||
      !Array.isArray(result.warnings) ||
      result.warnings.length !== 1 ||
      typeof result.warnings[0] !== 'string' ||
      result.warnings[0].length > 500
    )
      throw Error('Python returned an invalid PowerPoint result.');
    return result;
  } finally {
    active = false;
  }
}
