import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';
import {
  getDocumentProcessingStatus,
  processPdfOcr,
  processPresentation,
} from '../src/server/document-processing.mjs';

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const value of bytes) {
    crc ^= value;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function archive(files) {
  const locals = [],
    central = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const filename = Buffer.from(name),
      value = Buffer.from(text),
      compressed = deflateRawSync(value);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(value.length, 22);
    local.writeUInt16LE(filename.length, 26);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50);
    entry.writeUInt16LE(8, 10);
    entry.writeUInt32LE(compressed.length, 20);
    entry.writeUInt32LE(value.length, 24);
    entry.writeUInt16LE(filename.length, 28);
    entry.writeUInt32LE(offset, 42);
    local.writeUInt32LE(crc32(value), 14);
    entry.writeUInt32LE(crc32(value), 16);
    locals.push(local, filename, compressed);
    central.push(entry, filename);
    offset += local.length + filename.length + compressed.length;
  }
  const directory = Buffer.concat(central),
    end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}
function deck(extra = {}) {
  return archive({
    'ppt/presentation.xml':
      '<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldIdLst><p:sldId id="2" r:id="rId2"/><p:sldId id="1" r:id="rId1"/></p:sldIdLst></p:presentation>',
    'ppt/_rels/presentation.xml.rels':
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide2.xml"/></Relationships>',
    'ppt/slides/slide1.xml':
      '<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:p><a:r><a:t>First &amp; final</a:t></a:r></a:p></p:sld>',
    'ppt/slides/slide2.xml':
      '<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:p><a:r><a:t>Second</a:t></a:r><a:br/><a:r><a:t>Line &#x32;</a:t></a:r></a:p></p:sld>',
    ...extra,
  });
}
test('PPTX extraction follows declared slide order, paragraphs and XML entities', async () => {
  const result = await processPresentation(deck());
  assert.equal(result.layout, 'text-only');
  assert.deepEqual(result.pages, [
    { page: 1, text: 'Second\nLine 2' },
    { page: 2, text: 'First & final' },
  ]);
  assert.match(result.warnings[0], /images, charts/);
});
test('PPTX malformed, oversized and traversal archives fail closed', async () => {
  await assert.rejects(processPresentation(Buffer.from('bad')), /PowerPoint/);
  await assert.rejects(processPresentation(Buffer.alloc(12 * 1024 * 1024 + 1)), /12 MiB/);
  await assert.rejects(processPresentation(deck({ '../escape': 'bad' })), /limits/);
});
test('PPTX entity declarations and external relationships are rejected', async () => {
  await assert.rejects(
    processPresentation(
      deck({
        'ppt/slides/slide2.xml':
          '<!DOCTYPE x [<!ENTITY test SYSTEM "file:///etc/passwd">]><p:sld/>',
      }),
    ),
    /XML declarations/,
  );
  await assert.rejects(
    processPresentation(
      deck({
        'ppt/_rels/presentation.xml.rels':
          '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId2" Target="https://example.com" TargetMode="External"/></Relationships>',
      }),
    ),
    /readable slides/,
  );
});
test('OCR rejects invalid signature, page budgets and pre-aborted work before spawning', async () => {
  await assert.rejects(processPdfOcr(Buffer.from('invalid'), [1]), /valid PDF pages/);
  await assert.rejects(processPdfOcr(Buffer.from('%PDF-1.4'), [1, 1]), /valid PDF pages/);
  await assert.rejects(processPdfOcr(Buffer.from('%PDF-1.4'), [151]), /valid PDF pages/);
  await assert.rejects(
    processPdfOcr(Buffer.from('%PDF-1.4'), [1], { signal: AbortSignal.abort() }),
    /cancelled/,
  );
  await assert.rejects(processPresentation(deck(), { signal: AbortSignal.abort() }), /cancelled/);
});
test('Document capability status reports local scope and text-only PowerPoint honestly', async () => {
  const status = await getDocumentProcessingStatus();
  assert.equal(typeof status.ocr.available, 'boolean');
  assert.equal(status.ocr.local, true);
  assert.equal(status.presentation.layout, 'text-only');
});
