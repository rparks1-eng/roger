import test from 'node:test';
import assert from 'node:assert/strict';
import { createResourceSearch } from '../src/server/web-resources.mjs';
const response = (value, status = 200) => new Response(JSON.stringify(value), { status });
const openData = {
  docs: [
    {
      key: '/works/OL123W',
      title: 'Book <script>text only</script>',
      author_name: ['Author'],
      first_publish_year: 1900,
      isbn: ['9781234567890'],
      public_scan_b: true,
      ia: ['public-scan'],
    },
  ],
};
const googleData = {
  items: [
    {
      id: 'volume1',
      volumeInfo: {
        title: 'A second edition',
        authors: ['Author'],
        publishedDate: '2002',
        previewLink: 'http://books.google.com/books?id=volume1',
      },
      accessInfo: { viewability: 'PARTIAL', pdf: { isAvailable: false } },
    },
  ],
};
const fetcher = async (url) => response(url.includes('openlibrary.org') ? openData : googleData);

test('book results preserve source identity and distinguish previews from downloads', async () => {
  const result = await createResourceSearch({ fetcher }).search({ query: 'A book' });
  assert.equal(result.results.length, 2);
  assert.equal(result.results[0].sourceUrl, 'https://openlibrary.org/works/OL123W');
  assert.equal(result.results[0].previewUrl, 'https://archive.org/details/public-scan');
  assert.equal(result.results[1].access, 'Preview listed');
  assert.equal(result.results[1].previewUrl, 'https://books.google.com/books?id=volume1');
  assert.equal(result.results[1].downloadUrl, null);
  assert.equal(
    result.sources.every((item) => item.state === 'searched'),
    true,
  );
});

test('metadata cannot inject external download URLs or arbitrary fetch destinations', async () => {
  const requests = [];
  const service = createResourceSearch({
    fetcher: async (url, options) => {
      requests.push({ url, options });
      const malicious = {
        items: [
          {
            id: 'valid',
            volumeInfo: { title: 'Example', previewLink: 'javascript:alert(1)' },
            accessInfo: {
              viewability: 'ALL_PAGES',
              webReaderLink: 'https://evil.example/private',
              pdf: { isAvailable: true, downloadLink: 'http://127.0.0.1/private' },
            },
          },
        ],
      };
      return response(
        url.includes('openlibrary.org')
          ? { docs: [{ key: '//evil.example/a', title: 'Unsafe' }] }
          : malicious,
      );
    },
  });
  const result = await service.search({ query: 'https://internal.example' });
  assert.deepEqual(
    requests.map((request) => new URL(request.url).hostname),
    ['openlibrary.org', 'www.googleapis.com'],
  );
  assert.ok(requests.every((request) => request.options.redirect === 'error'));
  assert.equal(result.results.length, 1);
  assert.equal(result.results[0].previewUrl, null);
  assert.equal(result.results[0].downloadUrl, null);
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
  assert.equal(calls, 2);
  now = 300_001;
  assert.equal((await service.search({ query: 'same' })).cached, false);
  assert.equal(calls, 4);
  let failures = 0;
  const partial = createResourceSearch({
    fetcher: async (url) => {
      failures++;
      return url.includes('googleapis') ? response({}, 429) : response(openData);
    },
  });
  const result = await partial.search({ query: 'book' });
  assert.equal(result.results.length, 1);
  assert.equal(result.sources[1].state, 'unavailable');
  assert.equal((await partial.search({ query: 'book' })).cached, false);
  assert.equal(failures, 4);
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
  assert.equal(requests[0].searchParams.get('q'), 'isbn:9781234567890');
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(service.search({ query: 'book' }, { signal: controller.signal }), {
    status: 408,
  });
  await assert.rejects(service.search({ query: 'x'.repeat(241) }), { status: 400 });
});
