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
  const search = el('button', 'Find resources', 'button button-primary');
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
    status.textContent = 'Searching book catalogs…';
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
      status.textContent = `${data.results.length} catalog matches${data.cached ? ' · cached for up to five minutes' : ''}.${missing.length ? ` ${missing.join(' and ')} could not be reached; try its catalog below.` : ''}`;
      for (const item of data.results) {
        const card = el('article', undefined, 'resource-card');
        const title = el('h3');
        title.append(link(item.title, item.sourceUrl));
        card.append(
          title,
          el(
            'p',
            [item.authors.join(', '), item.year, item.isbn ? `ISBN ${item.isbn}` : '']
              .filter(Boolean)
              .join(' · '),
          ),
          el('p', `${item.source} · ${item.access}`, 'field-hint'),
        );
        const actions = el('div', undefined, 'resource-actions');
        actions.append(link('Catalog & edition details', item.sourceUrl));
        if (item.previewUrl)
          actions.append(
            link(
              item.access === 'Preview listed' ? 'Open preview' : 'Read online',
              item.previewUrl,
            ),
          );
        if (item.downloadUrl) actions.append(link('Download PDF from provider', item.downloadUrl));
        card.append(actions);
        results.append(card);
      }
      catalogs.append(el('h2', 'More places to look'));
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
      el('h1', 'Find books & readings'),
      el(
        'p',
        'Look across Open Library and Google Books, then check previews, public scans and download options at the source.',
      ),
      form,
      status,
      results,
      catalogs,
      el(
        'p',
        'Your search goes to these public catalogs. Availability can depend on the edition, location and provider account. This searches book records; it does not add or upload your course files.',
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
