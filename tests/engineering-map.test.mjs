import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync, rmSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createImportMap } from '../scripts/quality/import-map.mjs';
import { qaScratch } from '../scripts/quality/scratch.mjs';

test('map binds locations and both import directions to exact editable source', async () => {
  const owner = await qaScratch();
  const root = mkdtempSync(path.join(owner.work, 'import-map-'));
  try {
    mkdirSync(path.join(root, 'src'));
    writeFileSync(path.join(root, 'package-lock.json'), '{"lockfileVersion":3}\n');
    writeFileSync(
      path.join(root, 'src/a.cjs'),
      "// require('./ghost.mjs') must not become an edge\nconst b = require('./b.mjs');\nrequire('./b.mjs');\nrequire(target);\nmodule.exports = b;\n",
    );
    writeFileSync(path.join(root, 'src/b.mjs'), 'export const value = 1;\n');
    writeFileSync(
      path.join(root, 'src/view.jsx'),
      "import {value} from './b.mjs';\nexport default function View(){return <main>{value}</main>}\n",
    );
    const graph = {
      modules: [
        { source: 'src/a.cjs', dependencies: [{ module: './b.mjs', resolved: 'src/b.mjs' }] },
        { source: 'src/b.mjs', dependencies: [] },
        { source: 'src/view.jsx', dependencies: [{ module: './b.mjs', resolved: 'src/b.mjs' }] },
      ],
    };
    const build = () =>
      createImportMap(graph, { root, include: (file) => file.startsWith('src/') });
    const map = build();
    const a = map.modules.find((module) => module.file === 'src/a.cjs');
    const b = map.modules.find((module) => module.file === 'src/b.mjs');
    assert.deepEqual(
      a.dependencies[0].locations.map((site) => site.line),
      [2, 3],
    );
    assert.deepEqual(a.imports, ['src/b.mjs']);
    assert.deepEqual(b.importedBy, ['src/a.cjs', 'src/view.jsx']);
    assert.equal(a.dynamicImports[0].line, 4);
    assert.equal(a.otherImports.length, 0);
    assert.equal(
      map.modules.find((module) => module.file === 'src/view.jsx').dependencies[0].locations[0]
        .line,
      1,
    );
    assert.equal(
      a.sha256,
      createHash('sha256')
        .update(readFileSync(path.join(root, a.file)))
        .digest('hex'),
    );
    assert.deepEqual(build(), map, 'Unchanged source must produce byte-stable data.');
    writeFileSync(path.join(root, 'src/b.mjs'), 'export const value = 2;\n');
    assert.notEqual(
      build().fingerprint,
      map.fingerprint,
      'A body-only edit must invalidate the snapshot.',
    );
    writeFileSync(
      path.join(root, 'src/a.cjs'),
      '\n' + readFileSync(path.join(root, 'src/a.cjs'), 'utf8'),
    );
    assert.deepEqual(
      build().modules[0].dependencies[0].locations.map((site) => site.line),
      [3, 4],
    );
    assert.throws(
      () =>
        createImportMap(
          { modules: [{ source: '../outside.mjs', dependencies: [] }] },
          { root, include: () => true },
        ),
      /inside its project/,
    );
    symlinkSync(path.join(root, 'src/b.mjs'), path.join(root, 'src/link.mjs'));
    assert.throws(
      () =>
        createImportMap(
          { modules: [{ source: 'src/link.mjs', dependencies: [] }] },
          { root, include: () => true },
        ),
      /symlinks/,
    );
  } finally {
    rmSync(root, { recursive: true });
    await owner.close();
  }
});
