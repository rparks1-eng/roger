import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// Deliberately no directory walk: only these dependency-free, reviewed modules.
const files = ['cli-runner.ts', 'cli-protocol.ts'];
const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const origin = path.resolve(project, '../../../Atlas Product/Source/src/lib/study');
const digest = (value) => createHash('sha256').update(value).digest('hex');
const records = [];
await mkdir(path.join(project, 'src/core'), { recursive: true });
for (const name of files) {
  const original = await readFile(path.join(origin, name));
  let imported = original.toString('utf8');
  const transformations = [];
  if (name === 'cli-runner.ts') {
    const needle = 'from "./cli-protocol"';
    if (imported.split(needle).length !== 2)
      throw new Error('Unexpected protocol import; review before refreshing.');
    imported = imported.replace(needle, 'from "./cli-protocol.ts"');
    transformations.push(
      'Add explicit .ts extension to cli-protocol import for native Node type stripping.',
    );
  }
  await writeFile(path.join(project, 'src/core', name), imported);
  records.push({
    source: `src/lib/study/${name}`,
    destination: `src/core/${name}`,
    sourceSha256: digest(original),
    destinationSha256: digest(imported),
    transformations,
  });
}
await writeFile(
  path.join(project, 'CORE-SOURCES.json'),
  JSON.stringify(
    {
      schema: 1,
      sourceProject: 'Atlas Product/Source',
      policy:
        'Reviewed source snapshot, not a live import. Never copy application state, environment files, credentials, uploads, or personal content. Refresh explicitly with this allowlist script.',
      files: records,
    },
    null,
    2,
  ) + '\n',
);
console.log(`Imported ${records.length} reviewed Atlas core modules.`);
