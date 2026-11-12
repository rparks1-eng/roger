// Development dependencies only. No runtime provider/account configuration.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
if (Number(process.versions.node.split('.')[0]) !== 24)
  throw new Error('Select Node 24 before setup.');
function run(command, args) {
  const result = spawnSync(command, args, { stdio: 'inherit', timeout: 180_000 });
  if (result.error || result.status !== 0)
    throw result.error || new Error(`${command} failed (${result.status}).`);
}
run(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['ci', '--ignore-scripts', '--no-fund']);
const python = process.platform === 'win32' ? '.venv/Scripts/python.exe' : '.venv/bin/python';
if (!existsSync(python)) run(process.env.READER_SETUP_PYTHON || 'python3', ['-m', 'venv', '.venv']);
run(python, [
  '-m',
  'pip',
  'install',
  '--disable-pip-version-check',
  '--require-hashes',
  '-r',
  'requirements-dev.txt',
]);
console.log(
  'Development checks installed. Run npm run check. Runtime data/accounts are unchanged.',
);
