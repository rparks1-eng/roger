import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { existsSync } from 'node:fs';
const root = fileURLToPath(new URL('../../', import.meta.url));
process.chdir(root);
if (Number(process.versions.node.split('.')[0]) !== 24) {
  throw new Error('Use Node 24, as specified in .node-version.');
}
const python = process.platform === 'win32' ? '.venv/Scripts/python.exe' : '.venv/bin/python';
if (!existsSync(python)) throw new Error('Development tools are missing. Run npm run setup first.');
const runtimePython = process.env.READER_PYTHON || path.resolve(python);
const env = { ...process.env, READER_PYTHON: runtimePython, PYTHONDONTWRITEBYTECODE: '1' };
function run(command, args) {
  console.log(`\n> ${command} ${args.join(' ')}`);
  const result = spawnSync(command, args, { cwd: root, env, stdio: 'inherit', timeout: 180_000 });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
const mode = process.argv[2] || 'static';
const prettier = [
  'node_modules/prettier/bin/prettier.cjs',
  'src/client',
  'src/server',
  'public/index.html',
  'public/styles.css',
  'public/builder.css',
  'public/connections.css',
  'public/appearance.css',
  'public/app-changes.css',
  'public/resources.css',
  'public/memory.css',
  'tests',
  'scripts',
  'package.json',
  'eslint.config.mjs',
  '.dependency-cruiser.cjs',
  '.prettierrc.json',
];
if (mode === 'format') {
  run(process.execPath, [...prettier, '--write']);
  run(python, ['-m', 'ruff', 'format', 'src/python', 'tests', 'scripts/quality']);
  process.exit(0);
}
if (!['static', 'all'].includes(mode)) throw new Error('Use static, all or format.');
run(process.execPath, [...prettier, '--check']);
run(process.execPath, ['node_modules/eslint/bin/eslint.js', '.']);
run(python, ['-m', 'ruff', 'check', 'src/python', 'tests', 'scripts/quality']);
run(python, ['-m', 'ruff', 'format', '--check', 'src/python', 'tests', 'scripts/quality']);
run(process.execPath, [
  'node_modules/dependency-cruiser/bin/dependency-cruiser.mjs',
  'src',
  '--config',
  '.dependency-cruiser.cjs',
  '--output-type',
  'err-long',
]);
run(python, ['-B', 'scripts/quality/python-architecture.py']);
run(process.execPath, ['scripts/quality/core-provenance.mjs']);
run(process.execPath, ['scripts/quality/map.mjs']);
if (mode === 'all') {
  run(process.execPath, ['--test', 'tests/*.test.mjs']);
  run(python, ['-B', '-m', 'unittest', 'discover', '-s', 'tests', '-p', 'test_*.py']);
}
