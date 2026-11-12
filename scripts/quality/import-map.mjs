// Parse source locations with ESLint; dependency-cruiser still owns resolution.
import { Linter } from 'eslint';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
function sourceFile(root, name) {
  const file = path.resolve(root, name);
  const relative = path.relative(root, file);
  if (path.isAbsolute(name) || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('Map source must stay inside its project.');
  }
  let cursor = root;
  for (const part of relative.split(path.sep)) {
    cursor = path.join(cursor, part);
    if (lstatSync(cursor).isSymbolicLink()) throw new Error('Map source cannot contain symlinks.');
  }
  if (!lstatSync(file).isFile()) throw new Error('Map source must be a regular file.');
  return file;
}

function importSites(source, filename) {
  if (!/\.(?:cjs|mjs|js|jsx)$/.test(filename))
    return { sites: [], dynamic: [], parser: 'unsupported' };
  const linter = new Linter();
  const messages = linter.verify(
    source,
    [
      {
        files: ['**/*.{cjs,mjs,js,jsx}'],
        languageOptions: {
          ecmaVersion: 'latest',
          sourceType: filename.endsWith('.cjs') ? 'commonjs' : 'module',
          parserOptions: { ecmaFeatures: { jsx: true } },
        },
        rules: {},
      },
    ],
    { filename, allowInlineConfig: false },
  );
  if (messages.some((message) => message.fatal))
    throw new Error(`Map parser rejected ${filename}.`);
  const ast = linter.getSourceCode()?.ast;
  if (!ast) throw new Error(`No parsed source for ${filename}.`);
  const sites = [],
    dynamic = [],
    stack = [ast];
  while (stack.length) {
    const node = stack.pop();
    let argument, syntax;
    if (
      ['ImportDeclaration', 'ExportNamedDeclaration', 'ExportAllDeclaration'].includes(node.type) &&
      node.source
    ) {
      argument = node.source;
      syntax = node.type;
    } else if (node.type === 'ImportExpression') {
      argument = node.source;
      syntax = 'dynamic-import';
    } else if (
      node.type === 'CallExpression' &&
      node.callee?.type === 'Identifier' &&
      node.callee.name === 'require'
    ) {
      argument = node.arguments[0];
      syntax = 'require';
    }
    if (syntax) {
      const site = { line: node.loc.start.line, column: node.loc.start.column + 1, syntax };
      if (argument?.type === 'Literal' && typeof argument.value === 'string')
        sites.push({ specifier: argument.value, ...site });
      else dynamic.push({ ...site, target: 'unknown; nonliteral import expression' });
    }
    for (const [key, value] of Object.entries(node)) {
      if (['parent', 'loc', 'range', 'tokens', 'comments'].includes(key)) continue;
      if (Array.isArray(value))
        for (const child of value) {
          if (child?.type) stack.push(child);
        }
      else if (value?.type) stack.push(value);
    }
  }
  sites.sort((a, b) => a.line - b.line || a.column - b.column);
  dynamic.sort((a, b) => a.line - b.line || a.column - b.column);
  return { sites, dynamic, parser: 'ESLint built-in parser; no source config or rules loaded' };
}

export function createImportMap(graph, { root = process.cwd(), include }) {
  root = realpathSync(root);
  const input = graph.modules
    .filter((module) => include(module.source))
    .sort((a, b) => a.source.localeCompare(b.source));
  if (input.length > 2000) throw new Error('Import map exceeds 2,000 source files.');
  const names = new Set(input.map((module) => module.source));
  let bytes = 0;
  const modules = input.map((module) => {
    const file = sourceFile(root, module.source);
    bytes += lstatSync(file).size;
    if (bytes > 30_000_000) throw new Error('Import map exceeds 30 MB of source.');
    const source = readFileSync(file);
    const parsed = importSites(source.toString('utf8'), module.source);
    const dependencies = module.dependencies
      .filter((dependency) => names.has(dependency.resolved))
      .map((dependency) => {
        const locations = parsed.sites.filter((site) => site.specifier === dependency.module);
        return {
          to: dependency.resolved,
          specifier: dependency.module,
          kind: 'source import; not runtime data flow',
          locations,
          locationStatus: locations.length
            ? 'located'
            : `unknown; ${parsed.parser === 'unsupported' ? 'unsupported source language' : 'resolver dependency has no matching literal syntax'}`,
        };
      })
      .sort((a, b) => a.to.localeCompare(b.to));
    const resolvedSpecifiers = new Set(dependencies.map((dependency) => dependency.specifier));
    return {
      file: module.source,
      sha256: sha(source),
      locationParser: parsed.parser,
      imports: [...new Set(dependencies.map((dependency) => dependency.to))].sort(),
      importedBy: [],
      dependencies,
      otherImports: parsed.sites
        .filter((site) => !resolvedSpecifiers.has(site.specifier))
        .map((site) => ({ ...site, resolution: 'outside this source map; not traversed' })),
      dynamicImports: parsed.dynamic,
    };
  });
  const byName = new Map(modules.map((module) => [module.file, module]));
  for (const module of modules)
    for (const target of module.imports) {
      byName.get(target).importedBy.push(module.file);
    }
  const lock = readFileSync(sourceFile(root, 'package-lock.json'));
  const producerSha256 = sha(readFileSync(fileURLToPath(import.meta.url)));
  return {
    schema: 2,
    coverage:
      'Resolved source imports with parsed locations, external syntax and explicit dynamic unknowns. No runtime call/data lineage claim.',
    producer: {
      name: 'Engineering Foundation import-map',
      sha256: producerSha256,
      dependencyLockSha256: sha(lock),
    },
    fingerprint: sha(
      JSON.stringify({
        sources: modules.map(({ file, sha256 }) => ({ file, sha256 })),
        dependencyLockSha256: sha(lock),
        producerSha256,
      }),
    ),
    modules,
  };
}
