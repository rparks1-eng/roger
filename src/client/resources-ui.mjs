const el = (tag, text, className) => {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
};
function link(label, url) {
  const node = el('a', label);
  node.href = url;
  node.target = '_blank';
  node.rel = 'noopener noreferrer';
  return node;
}
export function createResourcesUI({ container, api }) {
  let controller,
    generation = 0;
  const form = el('form', undefined, 'resources-form');
  const label = el('label', 'Title, author, subject or ISBN');
  label.htmlFor = 'resource-query';
  const input = el('input');
  input.id = 'resource-query';
  input.type = 'search';
  input.required = true;
  input.maxLength = 240;
  input.placeholder = 'Pride and Prejudice, Jane Austen, or an ISBN…';
  const search = el('button', 'Find free copies', 'button button-primary');
  search.type = 'submit';
  const cancel = el('button', 'Cancel search', 'button button-quiet');
  cancel.type = 'button';
  cancel.hidden = true;
  form.append(label, input, search, cancel);
  const status = el('p', '', 'resources-status');
  status.setAttribute('role', 'status');
  const results = el('div', undefined, 'resource-results');
  const catalogs = el('div', undefined, 'resource-catalogs');
  async function request(query) {
    generation++;
    const ownGeneration = generation;
    controller?.abort();
    controller = new AbortController();
    input.value = query;
    status.textContent = 'Looking for free full books…';
    search.disabled = true;
    cancel.hidden = false;
    try {
      const data = await api('/api/resources/search', {
        body: { query },
        signal: controller.signal,
      });
      if (ownGeneration !== generation) return;
      results.replaceChildren();
      catalogs.replaceChildren();
      const missing = data.sources
        .filter((source) => source.state === 'unavailable')
        .map((source) => source.name);
      const count = data.results.length;
      const match = data.isbn ? ` for ISBN ${data.isbn}` : '';
      status.textContent =
        (count
          ? `${count} free ${count === 1 ? 'book' : 'books'} found${match}.`
          : `No free full copy found${match}.`) +
        (missing.length ? ` Search unavailable at ${missing.join(' and ')}.` : '');
      for (const item of data.results) {
        const card = el('article', undefined, 'resource-card');
        const title = el('h3');
        title.textContent = item.title;
        card.append(
          title,
          el(
            'p',
            [item.authors.join(', '), item.edition, item.year, item.isbn ? `ISBN ${item.isbn}` : '']
              .filter(Boolean)
              .join(' · '),
          ),
          el('p', `${item.source} · ${item.access}`, 'field-hint'),
        );
        const actions = el('div', undefined, 'resource-actions');
        for (const download of item.downloads) {
          const action = link(
            download.direct ? `Download ${download.format}` : `Get free ${download.format}`,
            download.url,
          );
          action.className = 'button button-primary';
          actions.append(action);
        }
        if (!item.downloads.some((download) => download.url === item.sourceUrl))
          actions.append(link('Edition details', item.sourceUrl));
        card.append(actions);
        results.append(card);
      }
      catalogs.append(el('h2', 'More free book collections'));
      for (const catalog of data.catalogs) {
        const row = el('p');
        row.append(
          link(catalog.name, catalog.url),
          document.createTextNode(` — ${catalog.detail}`),
        );
        catalogs.append(row);
      }
    } catch (error) {
      if (ownGeneration === generation) status.textContent = error.message;
    } finally {
      if (ownGeneration === generation) {
        controller = null;
        search.disabled = false;
        cancel.hidden = true;
      }
    }
  }
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    void request(input.value);
  });
  cancel.addEventListener('click', () => {
    generation++;
    controller?.abort();
    controller = null;
    search.disabled = false;
    cancel.hidden = true;
    status.textContent = 'Search cancelled. Previous results are still available.';
  });
  function render() {
    container.replaceChildren(
      el('h1', 'Find free textbooks'),
      el(
        'p',
        'Search by ISBN for your assigned edition, or by title, author, or subject for free textbooks and readings.',
      ),
      form,
      status,
      results,
      catalogs,
      el(
        'p',
        'Downloads open at the source. For a class reading, check the edition before using it.',
        'field-hint',
      ),
    );
  }
  function dispose() {
    generation++;
    controller?.abort();
  }
  return { render, request, dispose };
}
