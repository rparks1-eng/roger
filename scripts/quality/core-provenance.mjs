import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const manifest = JSON.parse(await readFile('CORE-SOURCES.json', 'utf8'));
for (const file of manifest.files) {
  const bytes = await readFile(file.destination);
  if (createHash('sha256').update(bytes).digest('hex') !== file.destinationSha256) {
    throw new Error(
      `Reviewed core snapshot changed: ${file.destination}. Refresh provenance explicitly.`,
    );
  }
}
console.log(`Reviewed core provenance: ${manifest.files.length} files passed.`);
