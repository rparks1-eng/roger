/** Small text-only formatter. Model HTML and links never become executable markup. */
export function renderChatText(target, text) {
  target.replaceChildren();
  const doc = target.ownerDocument;
  function inline(node, value) {
    for (const part of value.split(/(\*\*[^*\n]+\*\*|`[^`\n]+`)/g)) {
      if (part.startsWith('**') && part.endsWith('**')) {
        const strong = doc.createElement('strong');
        strong.textContent = part.slice(2, -2);
        node.append(strong);
      } else if (part.startsWith('`') && part.endsWith('`')) {
        const code = doc.createElement('code');
        code.textContent = part.slice(1, -1);
        node.append(code);
      } else node.append(doc.createTextNode(part));
    }
  }
  let list = null;
  for (const line of String(text).split('\n')) {
    if (!line.trim()) {
      list = null;
      continue;
    }
    const item = line.match(/^\s*(?:(\d+)\.|[-*])\s+(.+)$/);
    if (item) {
      const kind = item[1] ? 'ol' : 'ul';
      if (!list || list.tagName.toLowerCase() !== kind) {
        list = doc.createElement(kind);
        target.append(list);
      }
      const entry = doc.createElement('li');
      inline(entry, item[2]);
      list.append(entry);
    } else {
      list = null;
      const paragraph = doc.createElement('p');
      inline(paragraph, line.replace(/^#{1,6}\s+/, ''));
      target.append(paragraph);
    }
  }
}
