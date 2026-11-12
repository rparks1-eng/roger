// Optional local Kokoro runtime. No account, browser profile or cloud credentials are used.
import { spawn } from 'node:child_process';
import { readFile, access } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { homedir } from 'node:os';
import { HttpError } from './security.mjs';

const runtime = path.join(
  homedir(),
  'Atlas',
  'Projects',
  'Atlas Product',
  'Browser Shell',
  'voice-runtime',
);
const worker = path.join(runtime, 'worker.mjs');
const reviewedHash = '3bc215f5a2ae2b2f79cc6b97053a80c7695dd38f69d909529f7f6b9adb082f58';
const choices = Object.freeze({
  clear: { voice: 'af_heart', speed: 1, name: 'Clear · Heart' },
  warm: { voice: 'am_michael', speed: 0.95, name: 'Warm · Michael' },
  calm: { voice: 'bf_emma', speed: 0.9, name: 'Calm · Emma' },
  bright: { voice: 'af_bella', speed: 1.05, name: 'Bright · Bella' },
});
async function installed() {
  try {
    const bytes = await readFile(worker);
    if (createHash('sha256').update(bytes).digest('hex') !== reviewedHash) return false;
    await access(
      path.join(runtime, 'models/onnx-community/Kokoro-82M-v1.0-ONNX/onnx/model_quantized.onnx'),
    );
    await access(path.join(runtime, 'node_modules/kokoro-js/package.json'));
    return true;
  } catch {
    return false;
  }
}

export function createNarrationService({
  spawnImpl = spawn,
  checkInstalled = installed,
  deadline = 60_000,
} = {}) {
  let active = false;
  return {
    async status() {
      return {
        available: await checkInstalled(),
        engine: 'kokoro',
        voices: Object.entries(choices).map(([id, value]) => ({ id, name: value.name })),
      };
    },
    async speak(body, signal) {
      if (
        !body ||
        Object.keys(body).some((key) => !['text', 'preset'].includes(key)) ||
        typeof body.text !== 'string' ||
        !body.text.trim() ||
        body.text.length > 1_800 ||
        !Object.hasOwn(choices, body.preset)
      )
        throw new HttpError(400, 'Choose a voice and up to 1,800 characters.');
      signal?.throwIfAborted();
      if (active) throw new HttpError(429, 'Another local voice is working. Stop it or try again.');
      active = true;
      try {
        if (!(await checkInstalled()))
          throw new HttpError(503, 'Natural local voice is unavailable. Choose a device voice.');
        signal?.throwIfAborted();
        return await new Promise((resolve, reject) => {
          const selected = choices[body.preset];
          let child,
            timer,
            killTimer,
            failure,
            count = 0;
          const chunks = [];
          const stop = (error) => {
            if (failure) return;
            failure = error;
            child?.kill('SIGTERM');
            killTimer = setTimeout(() => child?.kill('SIGKILL'), 500);
            killTimer.unref();
          };
          const abort = () => stop(new HttpError(499, 'Narration cancelled.'));
          const cleanup = () => {
            clearTimeout(timer);
            clearTimeout(killTimer);
            signal?.removeEventListener('abort', abort);
          };
          try {
            child = spawnImpl(process.execPath, [worker], {
              cwd: runtime,
              env: {
                PATH: '/usr/bin:/bin',
                LANG: 'en_US.UTF-8',
                HF_HUB_OFFLINE: '1',
                TRANSFORMERS_OFFLINE: '1',
              },
              stdio: ['pipe', 'pipe', 'ignore'],
            });
            signal?.addEventListener('abort', abort, { once: true });
            child.stdout.on('data', (chunk) => {
              count += chunk.length;
              if (count > 8_640_044)
                return stop(new HttpError(502, 'The voice returned too much audio.'));
              if (!failure) chunks.push(chunk);
            });
            child.once('error', () => {
              stop(new HttpError(503, 'Natural local voice could not start.'));
            });
            child.once('close', (code) => {
              cleanup();
              if (failure) return reject(failure);
              const audio = Buffer.concat(chunks);
              if (
                code !== 0 ||
                audio.length <= 44 ||
                audio.toString('ascii', 0, 4) !== 'RIFF' ||
                audio.toString('ascii', 8, 12) !== 'WAVE' ||
                audio.toString('ascii', 12, 16) !== 'fmt ' ||
                audio.toString('ascii', 36, 40) !== 'data' ||
                audio.readUInt32LE(4) !== audio.length - 8 ||
                audio.readUInt32LE(16) !== 16 ||
                audio.readUInt16LE(20) !== 1 ||
                audio.readUInt16LE(22) !== 1 ||
                audio.readUInt32LE(24) !== 24_000 ||
                audio.readUInt32LE(28) !== 48_000 ||
                audio.readUInt16LE(32) !== 2 ||
                audio.readUInt16LE(34) !== 16 ||
                audio.readUInt32LE(40) !== audio.length - 44 ||
                (audio.length - 44) % 2 !== 0
              )
                return reject(
                  new HttpError(
                    502,
                    'Natural local voice could not finish. Try a shorter passage.',
                  ),
                );
              resolve(audio);
            });
            child.stdin.on('error', () => stop(new HttpError(502, 'Natural local voice stopped.')));
            timer = setTimeout(
              () => stop(new HttpError(504, 'Natural local voice took too long.')),
              deadline,
            );
            timer.unref();
            if (signal?.aborted) abort();
            else
              child.stdin.end(
                JSON.stringify({ text: body.text, voice: selected.voice, speed: selected.speed }),
              );
          } catch {
            const error = new HttpError(503, 'Natural local voice could not start.');
            if (child) stop(error);
            else {
              cleanup();
              reject(error);
            }
          }
        });
      } finally {
        active = false;
      }
    },
  };
}
