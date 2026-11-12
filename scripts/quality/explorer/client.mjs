export function explorerApp(window, document, data) {
  const nodes = data.nodes;
  const byId = new Map(nodes.map((node) => [node.file, node]));
  let selected = nodes.find((node) => node.file === 'src/client/app.mjs')?.file || nodes[0]?.file;
  let overview = true;
  let storyNodes = [];
  const canvas = document.querySelector('.canvas');
  const panel = document.querySelector('aside');
  const query = document.querySelector('input');
  const count = document.querySelector('.count');
  const overviewButton = document.querySelector('#overview');
  const filesButton = document.querySelector('#files');
  const el = (tag, text, className) => {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (className) node.className = className;
    return node;
  };
  const line = (edge) =>
    edge.line ||
    edge.locations?.map((site) => site.line).join(', ') ||
    edge.locationStatus ||
    'location unknown';
  function select(file) {
    selected = file;
    render();
  }
  function list(title, edges, incoming) {
    panel.append(el('h3', title));
    if (!edges.length) {
      panel.append(el('p', 'No recorded internal link.'));
      return;
    }
    const ul = el('ul');
    for (const edge of edges) {
      const file = incoming ? edge.from : edge.to;
      const li = el('li'),
        control = el('button', byId.get(file)?.label || file);
      control.type = 'button';
      control.onclick = () => {
        overview = false;
        storyNodes = [];
        select(file);
      };
      li.append(
        control,
        el(
          'small',
          `${edge.kind === 'declared-worker' ? 'Declared worker' : 'Source import'} · ${edge.from} · line ${line(edge)}`,
        ),
      );
      ul.append(li);
    }
    panel.append(ul);
  }
  function render() {
    document.body.dataset.overview = String(overview);
    document.querySelector('.walkthrough').hidden = !overview;
    overviewButton.setAttribute('aria-pressed', String(overview));
    filesButton.setAttribute('aria-pressed', String(!overview));
    const term = query.value.toLowerCase().trim();
    const visible = nodes.filter((node) =>
      (node.label + ' ' + node.file).toLowerCase().includes(term),
    );
    const adjacent = new Set([selected, ...storyNodes]);
    for (const edge of data.edges) {
      if (edge.from === selected) adjacent.add(edge.to);
      if (edge.to === selected) adjacent.add(edge.from);
    }
    const positions = new Map(),
      groups = ['client', 'server', 'python', 'core'];
    const groupNames = [
      'Browser · what you see',
      'Local server · coordination',
      'Python · document jobs',
      'Optional AI · TypeScript',
    ];
    const max = Math.max(
      1,
      ...groups.map((group) => visible.filter((node) => node.layer === group).length),
    );
    canvas.style.height = `${max * 65 + 70}px`;
    const previousFocus = document.activeElement?.dataset.file;
    canvas.replaceChildren();
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('width', '1200');
    svg.setAttribute('height', String(max * 65 + 70));
    svg.setAttribute('aria-hidden', 'true');
    const defs = document.createElementNS(svg.namespaceURI, 'defs');
    const marker = document.createElementNS(svg.namespaceURI, 'marker');
    marker.id = 'arrow';
    marker.setAttribute('viewBox', '0 0 10 10');
    marker.setAttribute('refX', '9');
    marker.setAttribute('refY', '5');
    marker.setAttribute('markerWidth', '5');
    marker.setAttribute('markerHeight', '5');
    marker.setAttribute('orient', 'auto-start-reverse');
    const arrow = document.createElementNS(svg.namespaceURI, 'path');
    arrow.setAttribute('d', 'M 0 0 L 10 5 L 0 10 z');
    arrow.setAttribute('fill', '#638878');
    marker.append(arrow);
    defs.append(marker);
    svg.append(defs);
    canvas.append(svg);
    groups.forEach((group, column) => {
      const label = el('div', groupNames[column], 'column-title');
      label.style.left = `${column * 275 + 55}px`;
      canvas.append(label);
      visible
        .filter((node) => node.layer === group)
        .forEach((node, row) =>
          positions.set(node.file, { x: column * 275 + 55, y: row * 65 + 44 }),
        );
    });
    for (const edge of data.edges) {
      const a = positions.get(edge.from),
        b = positions.get(edge.to);
      if (!a || !b) continue;
      const focus =
        edge.from === selected ||
        edge.to === selected ||
        (storyNodes.includes(edge.from) && storyNodes.includes(edge.to));
      const path = document.createElementNS(svg.namespaceURI, 'path');
      const forward = b.x > a.x,
        startX = forward ? a.x + 233 : a.x,
        endX = forward || a.x === b.x ? b.x : b.x + 233;
      const control = a.x === b.x ? a.x - 18 - (Math.abs(a.y - b.y) % 31) : (startX + endX) / 2;
      path.setAttribute(
        'd',
        `M${startX},${a.y + 27} C${control},${a.y + 27} ${control},${b.y + 27} ${endX},${b.y + 27}`,
      );
      path.setAttribute(
        'class',
        `edge ${edge.kind === 'declared-worker' ? 'worker' : ''} ${focus ? 'focus' : 'dim'}`,
      );
      path.setAttribute('marker-end', 'url(#arrow)');
      path.dataset.to = edge.to;
      svg.append(path);
    }
    for (const node of visible) {
      const p = positions.get(node.file),
        button = el('button', undefined, 'node' + (adjacent.has(node.file) ? '' : ' dim'));
      button.type = 'button';
      button.dataset.file = node.file;
      button.dataset.layer = node.layer;
      button.setAttribute('aria-pressed', String(node.file === selected));
      button.setAttribute('aria-label', `${node.label} — ${node.file}`);
      button.style.left = `${p.x}px`;
      button.style.top = `${p.y}px`;
      button.append(el('strong', node.label), el('small', node.file.replace(/^src\//, '')));
      button.onclick = () => select(node.file);
      canvas.append(button);
      if (previousFocus === node.file)
        window.requestAnimationFrame(() => button.focus({ preventScroll: true }));
    }
    if (!visible.length)
      canvas.append(el('p', 'No matching file. Try “Python”, “Canvas” or “PDF”.', 'empty'));
    count.textContent = `${visible.length} of ${nodes.length} files shown · arrows point toward the module being used`;
    panel.replaceChildren();
    const node = byId.get(selected);
    if (!node) return;
    panel.append(el('h2', node.label), el('p', node.description));
    const source = el('a');
    source.href = '../' + node.file;
    source.append(el('code', node.file));
    panel.append(source);
    list(
      'Uses →',
      data.edges.filter((edge) => edge.from === selected),
      false,
    );
    list(
      'Used by ←',
      data.edges.filter((edge) => edge.to === selected),
      true,
    );
    const identity = el(
      'p',
      `Source snapshot ${data.fingerprint.slice(0, 16)}. Regenerate with npm run map.`,
      'snapshot',
    );
    panel.append(identity);
  }
  overviewButton.onclick = () => {
    overview = true;
    storyNodes = [];
    render();
  };
  filesButton.onclick = () => {
    overview = false;
    storyNodes = [];
    render();
  };
  query.oninput = () => {
    overview = false;
    storyNodes = [];
    render();
  };
  for (const [label, files] of data.stories) {
    const button = el('button', label);
    button.type = 'button';
    button.onclick = () => {
      overview = false;
      query.value = '';
      storyNodes = files;
      select(files[0]);
      document.querySelector('.graph-panel').scrollIntoView({ block: 'start', behavior: 'smooth' });
    };
    document.querySelector('.stories').append(button);
  }
  render();
}
