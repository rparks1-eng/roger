import test from 'node:test';
import assert from 'node:assert/strict';
import { createResourceSearch } from '../src/server/web-resources.mjs';
const response = (value, status = 200) => new Response(JSON.stringify(value), { status });
const openData = {
  data: [
    {
      id: 123,
      title: 'Financial Accounting',
      edition_statement: '2e',
      license: 'Attribution',
      url: 'https://open.umn.edu/opentextbooks/textbooks/financial-accounting',
      isbn13: '9781234567890',
      formats: [
        { type: 'PDF', url: 'https://web.ung.edu/media/book.pdf', price: { cents: 0 } },
        {
          type: 'eBook',
          url: 'https://openstax.org/details/books/accounting',
          price: { cents: 0 },
        },
        { type: 'Hardcopy', url: 'https://example.com/store', price: { cents: 0 } },
        { type: 'EPUB', url: 'https://example.com/store.epub', price: { cents: 799 } },
      ],
    },
  ],
};
const googleData = {
  items: [
    {
      id: 'sample',
      volumeInfo: { title: 'Sample only' },
      accessInfo: {
        publicDomain: true,
        viewability: 'PARTIAL',
        pdf: { isAvailable: true, downloadLink: 'https://books.google.com/sample' },
      },
    },
    {
      id: 'full',
      volumeInfo: { title: 'Complete book' },
      accessInfo: {
        publicDomain: true,
        viewability: 'ALL_PAGES',
        epub: { isAvailable: true, downloadLink: 'https://books.google.com/download' },
      },
    },
  ],
};
const emptyFeed = '<feed xmlns="http://www.w3.org/2005/Atom"/>';
const isGutenberg = (url) => new URL(url).hostname === 'www.gutenberg.org';
const fetcher = async (url) =>
  isGutenberg(url)
    ? new Response(emptyFeed)
    : response(url.includes('open.umn.edu') ? openData : googleData);

test('literary titles appear in results and external archive links carry the search', async () => {
  const service = createResourceSearch({
    fetcher: async (url) =>
      isGutenberg(url)
        ? new Response(`<feed xmlns="http://www.w3.org/2005/Atom"><entry>
          <id>https://www.gutenberg.org/ebooks/1342.opds</id>
          <title>Pride and Prejudice</title><content>Jane Austen</content>
        </entry></feed>`)
        : response({}),
  });
  const query = 'Austen & Pride';
  const result = await service.search({ query });
  assert.equal(result.results[0].title, 'Pride and Prejudice');
  assert.deepEqual(result.results[0].authors, ['Jane Austen']);
  assert.equal(result.results[0].downloads[0].url, 'https://www.gutenberg.org/ebooks/1342');
  const archive = result.catalogs.find(({ name }) => name === 'Anna’s Archive');
  assert.equal(new URL(archive.url).searchParams.get('q'), query);
  assert.match(archive.detail, /LibGen/);
});

test('only free full copies appear with accurate direct and publisher download actions', async () => {
  const result = await createResourceSearch({ fetcher }).search({ query: 'A book' });
  assert.deepEqual(
    result.results.map((item) => item.title),
    ['Financial Accounting', 'Complete book'],
  );
  assert.equal(result.results[0].edition, '2e');
  assert.deepEqual(result.results[0].downloads, [
    { format: 'PDF', url: 'https://web.ung.edu/media/book.pdf', direct: true },
    { format: 'eBook', url: 'https://openstax.org/details/books/accounting', direct: false },
  ]);
  assert.equal(result.results[1].downloads[0].format, 'EPUB');
});

test('metadata cannot inject untrusted download links or choose fetch destinations', async () => {
  const requests = [];
  const service = createResourceSearch({
    fetcher: async (url, options) => {
      requests.push({ url, options });
      if (isGutenberg(url)) return new Response('<!DOCTYPE feed><feed />');
      return response(
        url.includes('open.umn.edu')
          ? {
              data: [
                {
                  ...openData.data[0],
                  formats: [
                    { type: 'PDF', url: 'http://127.0.0.1/private.pdf', price: { cents: 0 } },
                  ],
                },
              ],
            }
          : {
              items: [
                {
                  ...googleData.items[1],
                  accessInfo: {
                    ...googleData.items[1].accessInfo,
                    epub: { isAvailable: true, downloadLink: 'https://evil.example/book.epub' },
                  },
                },
              ],
            },
      );
    },
  });
  const result = await service.search({ query: 'https://internal.example' });
  assert.deepEqual(
    requests.map((item) => new URL(item.url).hostname),
    ['www.gutenberg.org', 'open.umn.edu', 'www.googleapis.com'],
  );
  assert.ok(requests.every((item) => item.options.redirect === 'error'));
  assert.equal(new URL(requests[2].url).searchParams.get('filter'), 'free-ebooks');
  assert.equal(result.results.length, 1);
  assert.deepEqual(result.results[0].downloads, [
    { format: 'PDF', url: openData.data[0].url, direct: false },
  ]);
});

test('ISBN searches return the exact edition or an empty result', async () => {
  const service = createResourceSearch({ fetcher });
  assert.equal(
    (await service.search({ query: '978-1234567890' })).results[0].isbn,
    '9781234567890',
  );
  assert.deepEqual((await service.search({ query: '978-1234567891' })).results, []);
});

test('cache is bounded by freshness and reports partial provider failure honestly', async () => {
  let now = 0,
    calls = 0;
  const service = createResourceSearch({
    clock: () => now,
    fetcher: async (url) => {
      calls++;
      return fetcher(url);
    },
  });
  await service.search({ query: 'same' });
  assert.equal((await service.search({ query: 'SAME' })).cached, true);
  assert.equal(calls, 3);
  now = 300_001;
  assert.equal((await service.search({ query: 'same' })).cached, false);
  assert.equal(calls, 6);
  let failures = 0;
  const partial = createResourceSearch({
    fetcher: async (url) => {
      failures++;
      return isGutenberg(url)
        ? new Response(emptyFeed)
        : url.includes('googleapis')
          ? response({}, 429)
          : response(openData);
    },
  });
  const result = await partial.search({ query: 'book' });
  assert.equal(result.results.length, 1);
  assert.equal(result.sources.find(({ name }) => name === 'Google Books').state, 'unavailable');
  assert.equal((await partial.search({ query: 'book' })).cached, false);
  assert.equal(failures, 6);
});

test('ISBN searches are encoded, cancellation stops results and oversized queries are rejected', async () => {
  const requests = [];
  const service = createResourceSearch({
    fetcher: async (url) => {
      requests.push(new URL(url));
      return response({});
    },
  });
  await service.search({ query: '978-1234567890' });
  assert.equal(requests[0].searchParams.get('q'), '9781234567890');
  assert.equal(requests[1].searchParams.get('q'), 'isbn:9781234567890');
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(service.search({ query: 'book' }, { signal: controller.signal }), {
    status: 408,
  });
  await assert.rejects(service.search({ query: 'x'.repeat(241) }), { status: 400 });
});
