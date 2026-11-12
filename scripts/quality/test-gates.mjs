// Intentional violations are temporary, named, exclusive files; always removed.
import assert from 'node:assert/strict';
import { readFile, writeFile, unlink } from 'node:fs/promises';
import { spawnSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const canary = 'src/client/quality-canary.mjs';
let checks = 0;
const run = (command, args) =>
  spawnSync(command, args, { encoding: 'utf8', timeout: 60_000, maxBuffer: 2 * 1024 * 1024 });
async function failure(source, expected) {
  await writeFile(canary, source, { flag: 'wx' });
  try {
    const result = run(npm, ['start']);
    assert.notEqual(result.status, 0);
    assert.match(result.stdout + result.stderr, expected);
    assert.doesNotMatch(result.stdout, /http:\/\/127\.0\.0\.1:/);
    checks++;
  } finally {
    await unlink(canary);
  }
}
await failure('export const bad={x:1}\n', /Code style issues/);
await failure('export const bad = missingIdentifier;\n', /no-undef/);
await failure("import '../server/security.mjs';\n", /browser-stays-in-browser/);
await failure("import './does-not-exist.mjs';\n", /no-unresolved-imports/);
const a = 'src/python/quality_cycle_a.py',
  b = 'src/python/quality_cycle_b.py';
await writeFile(a, 'import quality_cycle_b\n', { flag: 'wx' });
try {
  await writeFile(b, 'import quality_cycle_a\n', { flag: 'wx' });
  try {
    const result = run(
      process.platform === 'win32' ? '.venv/Scripts/python.exe' : '.venv/bin/python',
      ['scripts/quality/python-architecture.py'],
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /dependency cycle/);
    checks++;
  } finally {
    await unlink(b);
  }
} finally {
  await unlink(a);
}
const original = await readFile('architecture/source-map.json', 'utf8');
await writeFile(canary, 'export const fixture = true;\n', { flag: 'wx' });
try {
  const result = run(npm, ['run', 'map']);
  assert.equal(result.status, 0, result.stderr);
  const updated = JSON.parse(await readFile('architecture/source-map.json', 'utf8'));
  assert.ok(updated.sources.some((source) => source.path === canary));
  assert.notEqual(updated.fingerprint, JSON.parse(original).fingerprint);
  checks++;
} finally {
  await unlink(canary);
  const result = run(npm, ['run', 'map']);
  assert.equal(result.status, 0, result.stderr);
}
assert.equal(await readFile('architecture/source-map.json', 'utf8'), original);
checks++;
const socket = createServer();
socket.listen(0, '127.0.0.1');
await once(socket, 'listening');
const port = socket.address().port;
await new Promise((resolve) => socket.close(resolve));
const child = spawn(npm, ['start'], {
  detached: process.platform !== 'win32',
  env: { ...process.env, READER_PORT: String(port) },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let output = '';
child.stdout.on('data', (value) => {
  output += value;
});
child.stderr.on('data', (value) => {
  output += value;
});
try {
  const response = await Promise.race([
    (async () => {
      for (let attempt = 0; attempt < 100; attempt++) {
        try {
          return await fetch(`http://127.0.0.1:${port}/`);
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      }
      throw new Error('Startup timeout: ' + output);
    })(),
    once(child, 'exit').then(([code]) => {
      throw new Error('Startup exited ' + code + ': ' + output);
    }),
  ]);
  assert.equal(response.status, 200);
  assert.match(await response.text(), /<!doctype html>/i);
  checks++;
} finally {
  if (process.platform === 'win32') child.kill();
  else process.kill(-child.pid, 'SIGTERM');
  await once(child, 'exit');
}
await assert.rejects(fetch(`http://127.0.0.1:${port}/`));
checks++;
console.log(
  JSON.stringify({
    gateChecks: checks,
    startupBlockedOnViolations: true,
    normalStartup: true,
    canariesRemoved: true,
    startupPortClosed: true,
  }),
);
