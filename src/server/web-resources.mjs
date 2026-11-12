import { HttpError } from './security.mjs';

const CACHE_MS = 5 * 60_000;
const MAX_BYTES = 512 * 1024;
const cleanText = (value, max = 300) =>
  typeof value === 'string' ? value.slice(0, max).trim() : '';
function safeUrl(value, hosts) {
  try {
    const url = new URL(value);
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      !hosts.includes(url.hostname) ||
      url.username ||
      url.password ||
      (url.port && url.port !== '443')
    )
      return null;
    url.protocol = 'https:';
    return url.href;
  } catch {
    return null;
  }
}
const ISBN = /^(?:\d{13}|\d{9}[\dX])$/i;
const normalizeIsbn = (value) => cleanText(value, 30).replace(/[\s-]/g, '').toUpperCase();
const publisherHosts = [
  'open.umn.edu',
  'openstax.org',
  'assets.openstax.org',
  'collection.bccampus.ca',
  'opentextbc.ca',
  'pressbooks.bccampus.ca',
  'web.ung.edu',
  'milneopentextbooks.geneseo.edu',
];
function textbookResults(data, isbn) {
  return (Array.isArray(data?.data) ? data.data : []).slice(0, 12).flatMap((item) => {
    const sourceUrl = safeUrl(item?.url, ['open.umn.edu']);
    if (
      !Number.isSafeInteger(item?.id) ||
      !sourceUrl ||
      !/^\/opentextbooks\/textbooks\/[a-z0-9-]+$/.test(new URL(sourceUrl).pathname) ||
      !cleanText(item.title) ||
      !cleanText(item.license)
    )
      return [];
    const formats = Array.isArray(item.formats) ? item.formats.slice(0, 30) : [];
    const isbns = [item.isbn13, item.isbn10, ...formats.map((format) => format?.isbn)]
      .map(normalizeIsbn)
      .filter((value) => ISBN.test(value));
    if (isbn && !isbns.includes(isbn)) return [];
    const downloads = [];
    for (const format of formats) {
      if (format?.price?.cents !== 0 || !['PDF', 'eBook', 'EPUB'].includes(format.type)) continue;
      const url = safeUrl(format.url, publisherHosts) || sourceUrl;
      const direct = /\.(pdf|epub)$/i.test(new URL(url).pathname);
      if (!downloads.some((item) => item.url === url))
        downloads.push({ format: format.type, url, direct });
    }
    if (!downloads.length) return [];
    downloads.sort((a, b) => Number(b.direct) - Number(a.direct));
    return [
      {
        id: `otl:${item.id}`,
        title: cleanText(item.title),
        edition: cleanText(item.edition_statement, 50),
        authors: (Array.isArray(item.contributors) ? item.contributors : [])
          .filter((person) => person?.contribution === 'Author')
          .slice(0, 4)
          .map((person) =>
            [person.first_name, person.last_name]
              .map((part) => cleanText(part, 60))
              .filter(Boolean)
              .join(' '),
          ),
        year: Number.isInteger(item.copyright_year) ? String(item.copyright_year) : '',
        isbn: isbn || isbns[0] || '',
        source: 'Open Textbook Library',
        sourceUrl,
        access: cleanText(item.license, 80),
        downloads,
      },
    ];
  });
}
function googleResults(data, isbn) {
  const hosts = ['books.google.com', 'books.googleusercontent.com'];
  return (Array.isArray(data?.items) ? data.items : []).slice(0, 12).flatMap((item) => {
    const info = item?.volumeInfo,
      access = item?.accessInfo;
    if (
      !/^[\w-]{1,80}$/.test(item?.id || '') ||
      !cleanText(info?.title) ||
      access?.publicDomain !== true ||
      access.viewability !== 'ALL_PAGES'
    )
      return [];
    const isbns = (Array.isArray(info.industryIdentifiers) ? info.industryIdentifiers : [])
      .map((entry) => normalizeIsbn(entry?.identifier))
      .filter((value) => ISBN.test(value));
    if (isbn && !isbns.includes(isbn)) return [];
    const downloads = ['pdf', 'epub'].flatMap((format) => {
      const entry = access[format];
      const url = entry?.isAvailable === true ? safeUrl(entry.downloadLink, hosts) : null;
      return url ? [{ format: format.toUpperCase(), url, direct: true }] : [];
    });
    if (!downloads.length) return [];
    return [
      {
        id: `google:${item.id}`,
        title: cleanText(info.title),
        authors: (Array.isArray(info.authors) ? info.authors : [])
          .slice(0, 4)
          .map((name) => cleanText(name, 100)),
        year: cleanText(info.publishedDate, 20),
        isbn: isbn || isbns[0] || '',
        source: 'Google Books',
        sourceUrl: `https://books.google.com/books?id=${encodeURIComponent(item.id)}`,
        access: 'Public domain',
        downloads,
      },
    ];
  });
}
export function resourceCatalogLinks(query) {
  const encoded = encodeURIComponent(query);
  return [
    {
      name: 'Open Textbook Library',
      url: `https://open.umn.edu/opentextbooks/textbooks?q=${encoded}`,
      detail: 'Search openly licensed college textbooks',
    },
    {
      name: 'Project Gutenberg',
      url: `https://www.gutenberg.org/ebooks/search/?query=${encoded}`,
      detail: 'Find free downloads of public-domain books',
    },
    {
      name: 'Directory of Open Access Books',
      url: `https://directory.doabooks.org/discover?query=${encoded}`,
      detail: 'Find open-access scholarly books',
    },
  ];
}
export function createResourceSearch({ fetcher = fetch, clock = Date.now } = {}) {
  const cache = new Map();
  let active = 0;
  async function metadata(url, signal) {
    const response = await fetcher(url, {
      redirect: 'error',
      cache: 'no-store',
      signal,
      headers: {
        accept: 'application/json',
        'user-agent': 'RogerReader/0.1 (local course resource lookup)',
      },
    });
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      throw new Error('unavailable');
    }
    const reader = response.body.getReader();
    let bytes = 0;
    const chunks = [];
    const abort = () => {
      void reader.cancel().catch(() => {});
    };
    signal.addEventListener('abort', abort, { once: true });
    try {
      while (true) {
        signal.throwIfAborted();
        const next = await reader.read();
        signal.throwIfAborted();
        if (next.done) break;
        bytes += next.value.byteLength;
        if (bytes > MAX_BYTES) {
          await reader.cancel();
          throw new Error('oversized');
        }
        chunks.push(next.value);
      }
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } finally {
      signal.removeEventListener('abort', abort);
      reader.releaseLock();
    }
  }
  return {
    async search(input, { signal } = {}) {
      if (
        !input ||
        typeof input.query !== 'string' ||
        !input.query.trim() ||
        input.query.length > 240
      )
        throw new HttpError(400, 'Enter a title, author, subject or ISBN in up to 240 characters.');
      const query = input.query.trim();
      const cacheKey = query.toLowerCase();
      const now = clock();
      for (const [key, entry] of cache) if (now - entry.created > CACHE_MS) cache.delete(key);
      if (signal?.aborted) throw new HttpError(408, 'Resource search cancelled.');
      const hit = cache.get(cacheKey);
      if (hit) return { ...structuredClone(hit.result), cached: true };
      if (active >= 2)
        throw new HttpError(429, 'Two resource searches are already running. Try again shortly.');
      active++;
      try {
        const timeout = AbortSignal.timeout(10_000);
        const operation = signal ? AbortSignal.any([signal, timeout]) : timeout;
        const candidate = query.replace(/[\s-]/g, '').toUpperCase();
        const isbn = ISBN.test(candidate) ? candidate : '';
        const openUrl = new URL('https://open.umn.edu/opentextbooks/textbooks.json');
        openUrl.searchParams.set('q', isbn || query);
        const googleUrl = new URL('https://www.googleapis.com/books/v1/volumes');
        googleUrl.search = new URLSearchParams({
          q: isbn ? `isbn:${isbn}` : query,
          maxResults: '12',
          printType: 'books',
          filter: 'free-ebooks',
        });
        const attempts = await Promise.allSettled([
          metadata(openUrl.href, operation),
          metadata(googleUrl.href, operation),
        ]);
        if (signal?.aborted) throw new HttpError(408, 'Resource search cancelled.');
        const results = [],
          sources = [];
        for (let index = 0; index < attempts.length; index++) {
          const attempt = attempts[index];
          const name = ['Open Textbook Library', 'Google Books'][index];
          sources.push({
            name,
            state: attempt.status === 'fulfilled' ? 'searched' : 'unavailable',
          });
          if (attempt.status === 'fulfilled')
            results.push(...[textbookResults, googleResults][index](attempt.value, isbn));
        }
        const result = {
          query,
          isbn,
          results,
          sources,
          catalogs: resourceCatalogLinks(query),
          cached: false,
          checkedAt: new Date(now).toISOString(),
        };
        if (attempts.every((attempt) => attempt.status === 'fulfilled')) {
          if (cache.size >= 20) cache.delete(cache.keys().next().value);
          cache.set(cacheKey, { created: now, result });
        }
        return result;
      } finally {
        active--;
      }
    },
    clear() {
      cache.clear();
    },
  };
}
