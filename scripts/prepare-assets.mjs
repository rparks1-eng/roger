import { mkdir, readFile, copyFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const atlas = path.resolve(root, '../../../Atlas Product');
const files = [
  [
    path.join(atlas, 'Browser Shell/ui/assets/mora.png'),
    'public/assets/mora.png',
    'Original Atlas Mora artwork',
  ],
  [
    path.join(atlas, 'Source/node_modules/pdfjs-dist/build/pdf.mjs'),
    'public/vendor/pdf.mjs',
    'Mozilla PDF.js display library',
  ],
  [
    path.join(atlas, 'Source/node_modules/pdfjs-dist/build/pdf.worker.mjs'),
    'public/vendor/pdf.worker.mjs',
    'Mozilla PDF.js worker',
  ],
  [
    path.join(atlas, 'Source/node_modules/pdfjs-dist/LICENSE'),
    'public/vendor/PDFJS-LICENSE.txt',
    'Mozilla PDF.js Apache 2.0 license',
  ],
];
const rows = [];
const manifestPath = path.join(root, 'ASSET-SOURCES.json');
const existing = JSON.parse(await readFile(manifestPath, 'utf8').catch(() => '{}'));
for (const [source, destination, purpose] of files) {
  const bytes = await readFile(source);
  await mkdir(path.dirname(path.join(root, destination)), { recursive: true });
  await copyFile(source, path.join(root, destination));
  rows.push({
    source: `Atlas Product/${path.relative(atlas, source)}`,
    destination,
    purpose,
    bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  });
}
await writeFile(
  manifestPath,
  JSON.stringify({ ...existing, snapshot: true, files: rows }, null, 2) + '\n',
);
console.log(`Prepared ${rows.length} existing assets; no model or image generation.`);
