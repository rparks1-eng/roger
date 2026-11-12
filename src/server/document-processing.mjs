import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import path from 'node:path';
import { runPythonPresentation, pythonPresentationAvailable } from './python-presentation.mjs';

const OCR_BINARY = path.join(
  homedir(),
  'Library',
  'Application Support',
  'Atlas',
  'current',
  'runtime',
  'atlas-pdf-ocr',
);
const MAX_BYTES = 12 * 1024 * 1024;
let ocrBusy = false;
const failure = (message) => new Error(message);
function bytesOf(input) {
  if (!(input instanceof Uint8Array) || !input.byteLength || input.byteLength > MAX_BYTES)
    throw failure('Document must be between 1 byte and 12 MiB.');
  return Buffer.from(input.buffer, input.byteOffset, input.byteLength);
}

export async function getDocumentProcessingStatus() {
  const available =
    process.platform === 'darwin' &&
    (await access(OCR_BINARY, constants.X_OK).then(
      () => true,
      () => false,
    ));
  return {
    ocr: { available, engine: 'Apple Vision', local: true, maxPages: 12 },
    presentation: {
      available: await pythonPresentationAvailable(),
      formats: ['pptx'],
      layout: 'text-only',
      engine: 'python-stdlib',
    },
  };
}

/** Local fixed helper only. Uploaded bytes are never a filename or command. */
export async function processPdfOcr(input, pages, { signal } = {}) {
  const bytes = bytesOf(input);
  if (
    bytes.subarray(0, 5).toString() !== '%PDF-' ||
    !Array.isArray(pages) ||
    !pages.length ||
    pages.length > 12 ||
    new Set(pages).size !== pages.length ||
    pages.some((page) => !Number.isInteger(page) || page < 1 || page > 150)
  )
    throw failure('Choose 1–12 valid PDF pages.');
  if (signal?.aborted) throw failure('Document processing cancelled.');
  if (ocrBusy) throw failure('Another OCR request is running. Try again shortly.');
  if (!(await getDocumentProcessingStatus()).ocr.available)
    throw failure('Local Apple Vision OCR is not installed on this computer.');
  // Claim after asynchronous availability check, not before it.
  if (ocrBusy) throw failure('Another OCR request is running. Try again shortly.');
  ocrBusy = true;
  try {
    const output = await new Promise((resolve, reject) => {
      const child = spawn(OCR_BINARY, pages.map(String), {
        stdio: ['pipe', 'pipe', 'ignore'],
        env: { PATH: '/usr/bin:/bin', LANG: 'en_US.UTF-8' },
      });
      let done = false,
        size = 0;
      const chunks = [];
      const finish = (error, value) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        if (error) {
          child.kill('SIGKILL');
          reject(error);
        } else resolve(value);
      };
      const abort = () => finish(failure('Document processing cancelled.'));
      const timer = setTimeout(
        () => finish(failure('OCR exceeded its 45-second limit. Try one page at a time.')),
        45_000,
      );
      signal?.addEventListener('abort', abort, { once: true });
      child.on('error', () => finish(failure('Local OCR could not start.')));
      child.stdin.on('error', () => {});
      child.stdout.on('data', (chunk) => {
        size += chunk.length;
        if (size > 1024 * 1024) finish(failure('OCR output exceeded its limit.'));
        else chunks.push(chunk);
      });
      child.on('close', (code) =>
        code === 0
          ? finish(null, Buffer.concat(chunks))
          : finish(failure('OCR could not read this PDF. It may be protected or damaged.')),
      );
      child.stdin.end(bytes);
      if (signal?.aborted) abort();
    });
    let result;
    try {
      result = JSON.parse(output.toString('utf8'));
    } catch {
      throw failure('OCR returned an invalid result.');
    }
    if (
      result.engine !== 'apple-vision-v2' ||
      !Array.isArray(result.pages) ||
      result.pages.length !== pages.length ||
      result.pages.some(
        (page, i) =>
          page.page !== pages[i] || typeof page.text !== 'string' || page.text.length > 120_000,
      )
    )
      throw failure('OCR returned an invalid result.');
    if (result.pages.reduce((sum, page) => sum + page.text.length, 0) > 120_000)
      throw failure('OCR text exceeds this reading’s limit.');
    return result;
  } finally {
    ocrBusy = false;
  }
}

// Parsing belongs to the Python worker. Keep only the existing HTTP adapter.
export async function processPresentation(input, { signal } = {}) {
  return runPythonPresentation(bytesOf(input), { signal });
}
