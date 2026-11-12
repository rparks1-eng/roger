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
const newsGroups = [
  [
    'General news',
    [
      ['AP News', 'https://apnews.com/', 'Breaking news and reporting'],
      ['NPR', 'https://www.npr.org/', 'Public radio, articles, and podcasts'],
      ['The New York Times', 'https://www.nytimes.com/', 'News, analysis, and culture'],
      ['Reuters', 'https://www.reuters.com/', 'World news and business reporting'],
    ],
  ],
  [
    'Business and markets',
    [
      [
        'The Wall Street Journal',
        'https://www.wsj.com/',
        'Business and markets',
        'Babson access',
        'https://libguides.babson.edu/economics/Start',
      ],
      [
        'Financial Times',
        'https://www.ft.com/',
        'Global business and economics',
        'Babson access',
        'https://libguides.babson.edu/economics/Start',
      ],
      ['The Economist', 'https://www.economist.com/', 'Economics and global affairs'],
      [
        'Bloomberg',
        'https://www.bloomberg.com/',
        'Markets and companies',
        'Campus terminals',
        'https://libguides.babson.edu/c.php?g=26345&p=161029',
      ],
      ['Yahoo Finance', 'https://finance.yahoo.com/', 'Quotes, company news, and market data'],
      [
        'PitchBook',
        'https://pitchbook.com/',
        'Private companies, deals, and venture capital',
        'Babson access',
        'https://libguides.babson.edu/supplychain/company',
      ],
      ['SEC EDGAR', 'https://www.sec.gov/edgar/search/', 'Public company filings'],
      ['FRED', 'https://fred.stlouisfed.org/', 'Economic data and charts'],
    ],
  ],
];
function newsDirectory() {
  const directory = el('section', undefined, 'research-directory');
  directory.id = 'resource-news';
  directory.append(
    el('h2', 'News & research'),
    el('p', 'Open a publisher or database. For campus subscriptions, start with Horn Library.'),
    link('Horn Library access and databases', 'https://libguides.babson.edu/HornLibrary'),
  );
  for (const [category, entries] of newsGroups) {
    const grid = el('div', undefined, 'research-grid');
    for (const [title, url, description, access, accessUrl] of entries) {
      const card = el('article', undefined, 'resource-card');
      const heading = el('h4');
      heading.append(link(title, url));
      card.append(heading, el('p', description, 'field-hint'));
      if (access) card.append(link(access, accessUrl));
      grid.append(card);
    }
    directory.append(el('h3', category), grid);
  }
  return directory;
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
  input.placeholder = 'Pride and Prejudice, finance, or an ISBN…';
  const search = el('button', 'Search books', 'button button-primary');
  search.type = 'submit';
  const cancel = el('button', 'Cancel search', 'button button-quiet');
  cancel.type = 'button';
  cancel.hidden = true;
  form.append(label, input, search, cancel);
  const status = el('p', '', 'resources-status');
  status.setAttribute('role', 'status');
  const results = el('div', undefined, 'resource-results');
  const catalogs = el('div', undefined, 'resource-catalogs');
  const bookPanel = el('section');
  bookPanel.id = 'resource-books';
  const booksButton = el('button', 'Books', 'button button-secondary');
  const newsButton = el('button', 'News & research', 'button button-secondary');
  const directory = newsDirectory();
  const nav = el('nav', undefined, 'resource-section-nav');
  nav.setAttribute('aria-label', 'Resource sections');
  nav.append(booksButton, newsButton);
  for (const [button, panel] of [
    [booksButton, bookPanel],
    [newsButton, directory],
  ]) {
    button.type = 'button';
    button.setAttribute('aria-controls', panel.id);
    button.addEventListener('click', () => selectSection(panel));
  }
  function selectSection(panel) {
    bookPanel.hidden = panel !== bookPanel;
    directory.hidden = panel !== directory;
    booksButton.setAttribute('aria-pressed', String(panel === bookPanel));
    newsButton.setAttribute('aria-pressed', String(panel === directory));
  }
  selectSection(bookPanel);
  async function request(query) {
    generation++;
    const ownGeneration = generation;
    controller?.abort();
    controller = new AbortController();
    input.value = query;
    status.textContent = 'Searching for full books…';
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
      catalogs.append(el('h2', 'Search more collections'));
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
    bookPanel.replaceChildren(
      el('p', 'Find novels, plays, nonfiction, and textbooks by title, author, subject, or ISBN.'),
      form,
      status,
      results,
      catalogs,
    );
    container.replaceChildren(el('h1', 'Find books'), nav, bookPanel, directory);
  }
  function dispose() {
    generation++;
    controller?.abort();
  }
  return { render, request, dispose };
}
