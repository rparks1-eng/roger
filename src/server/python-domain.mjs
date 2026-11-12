// Fixed, stateless Python jobs. Never pass credentials, commands or file paths.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const worker = fileURLToPath(new URL('../python/worker.py', import.meta.url));
const python = process.env.READER_PYTHON ?? '/usr/bin/python3';
const limits = Object.freeze({
  'books.opds': 3 * 1024 * 1024,
  retrieval: 2 * 1024 * 1024,
  'study.prepare': 128 * 1024,
  'study.validate': 256 * 1024,
  'study.route': 4096,
  'study.set.prepare': 384 * 1024,
  'study.set.rank': 384 * 1024,
  'study.set.build': 128 * 1024,
  'study.exam.plan': 1024 * 1024,
  'syllabus.html': 1024 * 1024,
  'syllabus.docx': 3 * 1024 * 1024,
  'syllabus.excerpts': 1024 * 1024,
  ...Object.fromEntries(
    ['profile', 'courses', 'course', 'assignment', 'assignments', 'page'].map((name) => [
      'canvas.' + name,
      8 * 1024 * 1024,
    ]),
  ),
});
const codes = new Set([
  'invalid',
  'oversized',
  'consent',
  'output',
  'invalid_id',
  'invalid_response',
  'invalid_document',
  'locked',
]);
let active = 0;
export class PythonDomainError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
    this.status =
      {
        invalid: 400,
        oversized: 413,
        consent: 403,
        locked: 403,
        invalid_id: 400,
        timeout: 504,
        unavailable: 503,
        busy: 429,
      }[code] ?? 502;
  }
}
export async function pythonDomain(
  operation,
  value,
  { signal } = {},
  { spawnProcess = spawn, timeoutMs = 10_000 } = {},
) {
  const fail = (code) => {
    throw new PythonDomainError(code);
  };
  if (!Object.hasOwn(limits, operation) || !path.isAbsolute(python)) fail('invalid');
  if (signal?.aborted) fail('timeout');
  const input = JSON.stringify(value);
  if (typeof input !== 'string' || Buffer.byteLength(input) > limits[operation]) fail('oversized');
  if (active >= 2) fail('busy');
  active++;
  try {
    const bytes = await new Promise((resolve, reject) => {
      const child = spawnProcess(python, ['-I', '-B', worker, operation], {
        shell: false,
        cwd: path.dirname(worker),
        stdio: ['pipe', 'pipe', 'ignore'],
        env: { PATH: '/usr/bin:/bin', LANG: 'en_US.UTF-8' },
      });
      const chunks = [];
      let total = 0,
        failure = null,
        done = false;
      const stop = (code) => {
        if (!failure) {
          failure = new PythonDomainError(code);
          child.kill('SIGKILL');
        }
      };
      const abort = () => stop('timeout');
      const timer = setTimeout(abort, timeoutMs);
      const finish = (error) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        error ? reject(error) : resolve(Buffer.concat(chunks));
      };
      signal?.addEventListener('abort', abort, { once: true });
      child.on('error', () => finish(new PythonDomainError('unavailable')));
      child.stdin.on('error', () => {});
      child.stdout.on('data', (chunk) => {
        total += chunk.length;
        if (total > 2 * 1024 * 1024) stop('oversized');
        else if (!failure) chunks.push(chunk);
      });
      child.on('close', (code) =>
        finish(failure ?? (code === 0 ? null : new PythonDomainError('unavailable'))),
      );
      child.stdin.end(input);
      if (signal?.aborted) abort();
    });
    let envelope;
    try {
      envelope = JSON.parse(bytes.toString('utf8'));
    } catch {
      fail('output');
    }
    if (envelope?.ok === false) fail(codes.has(envelope.error) ? envelope.error : 'output');
    if (envelope?.ok !== true || !Object.hasOwn(envelope, 'result')) fail('output');
    return envelope.result;
  } finally {
    active--;
  }
}
