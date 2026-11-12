// Assemble one portable artifact from maintained metadata, browser code and styles.
import { readFileSync } from 'node:fs';
import { descriptions, stories } from './explorer/descriptions.mjs';
import { explorerApp } from './explorer/client.mjs';
export function renderExplorer(map) {
  if (!Array.isArray(map.nodes) || map.nodes.length > 2000 || map.edges.length > 20000)
    throw new Error('Explorer input exceeds its bounded source-map contract.');
  const nodes = map.nodes.map((file) => {
    if (!/^src\/[a-zA-Z0-9_./-]+$/.test(file) || file.split('/').includes('..'))
      throw new Error('Invalid explorer source path.');
    const [label, description] = descriptions[file] || [
      file.split('/').at(-1),
      'A source module in the current generated dependency map.',
    ];
    return { file, label, description, layer: file.split('/')[1] };
  });
  const safe = JSON.stringify({
    nodes,
    edges: map.edges,
    fingerprint: map.fingerprint,
    stories: stories.filter(([, files]) => files.every((file) => map.nodes.includes(file))),
  }).replaceAll('<', '\\u003c');
  const page = readFileSync(new URL('./explorer/page.html', import.meta.url), 'utf8');
  const css = readFileSync(new URL('./explorer/style.css', import.meta.url), 'utf8');
  return page
    .replace('{{FILE_COUNT}}', () => String(nodes.length))
    .replace('{{LINK_COUNT}}', () => String(map.edges.length))
    .replace('/* EXPLORER_STYLE */', () => css)
    .replace(
      '<!-- EXPLORER_SCRIPT -->',
      () => `<script>(${explorerApp.toString()})(window,document,${safe});</script>`,
    );
}
