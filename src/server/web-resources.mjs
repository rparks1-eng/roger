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
function openLibraryResults(data) {
  return (Array.isArray(data?.docs) ? data.docs : []).slice(0, 12).flatMap((item) => {
    if (!/^\/(?:works\/OL\d+W|books\/OL\d+M)$/.test(item?.key) || !cleanText(item.title)) return [];
    const sourceUrl = `https://openlibrary.org${item.key}`;
    const archiveId =
      Array.isArray(item.ia) &&
      item.ia.find((id) => typeof id === 'string' && /^[\w.-]{1,100}$/.test(id));
    return [
      {
        id: `openlibrary:${item.key}`,
        title: cleanText(item.title),
        authors: (Array.isArray(item.author_name) ? item.author_name : [])
          .slice(0, 4)
          .map((name) => cleanText(name, 100)),
        year: Number.isInteger(item.first_publish_year) ? String(item.first_publish_year) : '',
        isbn:
          (Array.isArray(item.isbn) ? item.isbn : []).find(
            (isbn) => typeof isbn === 'string' && /^(?:\d{13}|\d{9}[\dXx])$/.test(isbn),
          ) ?? '',
        source: 'Open Library',
        sourceUrl,
        access: item.public_scan_b === true ? 'Public scan listed' : 'Catalog record',
        previewUrl:
          item.public_scan_b === true && archiveId
            ? `https://archive.org/details/${archiveId}`
            : null,
        downloadUrl: null,
      },
    ];
  });
}
function googleResults(data) {
  const hosts = ['books.google.com', 'play.google.com', 'books.googleusercontent.com'];
  return (Array.isArray(data?.items) ? data.items : []).slice(0, 12).flatMap((item) => {
    if (
      typeof item?.id !== 'string' ||
      !/^[\w-]{1,80}$/.test(item.id) ||
      !cleanText(item.volumeInfo?.title)
    )
      return [];
    const info = item.volumeInfo,
      access = item.accessInfo ?? {};
    const sourceUrl = `https://books.google.com/books?id=${encodeURIComponent(item.id)}`;
    const viewable = ['PARTIAL', 'ALL_PAGES'].includes(access.viewability);
    return [
      {
        id: `google:${item.id}`,
        title: cleanText(info.title),
        authors: (Array.isArray(info.authors) ? info.authors : [])
          .slice(0, 4)
          .map((name) => cleanText(name, 100)),
        year: cleanText(info.publishedDate, 20),
        isbn:
          (Array.isArray(info.industryIdentifiers) ? info.industryIdentifiers : [])
            .filter((entry) => ['ISBN_10', 'ISBN_13'].includes(entry?.type))
            .map((entry) => cleanText(entry.identifier, 20))[0] ?? '',
        source: 'Google Books',
        sourceUrl,
        access:
          access.viewability === 'ALL_PAGES'
            ? 'Full view listed'
            : access.viewability === 'PARTIAL'
              ? 'Preview listed'
              : 'Catalog record',
        previewUrl: viewable ? safeUrl(access.webReaderLink ?? info.previewLink, hosts) : null,
        downloadUrl:
          access.pdf?.isAvailable === true ? safeUrl(access.pdf.downloadLink, hosts) : null,
      },
    ];
  });
}
export function resourceCatalogLinks(query) {
  const encoded = encodeURIComponent(query);
  return [
    {
      name: 'Project Gutenberg',
      url: `https://www.gutenberg.org/ebooks/search/?query=${encoded}`,
      detail: 'Search public-domain books',
    },
    {
      name: 'Directory of Open Access Books',
      url: `https://directory.doabooks.org/discover?query=${encoded}`,
      detail: 'Search open-access scholarly books',
    },
    {
      name: 'Internet Archive',
      url: `https://archive.org/search?query=${encoded}`,
      detail: 'Check the item’s access and borrowing options',
    },
    {
      name: 'Google Books',
      url: `https://books.google.com/books?q=${encoded}`,
      detail: 'Find editions and publisher previews',
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
        const isbn = query.replace(/[\s-]/g, '');
        const searchQuery = /^(?:\d{13}|\d{9}[\dXx])$/.test(isbn) ? `isbn:${isbn}` : query;
        const openUrl = new URL('https://openlibrary.org/search.json');
        openUrl.search = new URLSearchParams({
          q: searchQuery,
          limit: '12',
          fields: 'key,title,author_name,first_publish_year,isbn,ia,public_scan_b',
        });
        const googleUrl = new URL('https://www.googleapis.com/books/v1/volumes');
        googleUrl.search = new URLSearchParams({
          q: searchQuery,
          maxResults: '12',
          printType: 'books',
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
          const name = ['Open Library', 'Google Books'][index];
          sources.push({
            name,
            state: attempt.status === 'fulfilled' ? 'searched' : 'unavailable',
          });
          if (attempt.status === 'fulfilled')
            results.push(...[openLibraryResults, googleResults][index](attempt.value));
        }
        const result = {
          query,
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
