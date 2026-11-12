/** A portable, read-only course snapshot; not a Canvas IMS content export. */
import { crc32 } from 'node:zlib';
import { ARCHIVE_FILE_EXTENSIONS } from './canvas-download.mjs';
import { HttpError } from './security.mjs';

const ARCHIVE_BYTES = 24 * 1024 * 1024;
const FILE_BYTES = 12 * 1024 * 1024;
const FILE_ATTEMPTS = 16;
const ARCHIVE_TIME = 35_000;
const fileId = (value) => /^[1-9]\d{0,15}$/.test(String(value ?? ''));
const clean = (value, limit = 2000) => (typeof value === 'string' ? value.slice(0, limit) : '');
function safeLink(value) {
  try {
    const url = new URL(value);
    if (url.origin !== 'https://babson.instructure.com' || url.username || url.password) return '';
    // Export a stable Canvas page reference. Download credentials can be embedded in query strings.
    return url.origin + url.pathname;
  } catch {
    return '';
  }
}
const markdown = (value) => clean(value, 120_000).replace(/[\\`*_{}[\]<>#!|]/g, '\\$&');
function coverage(value) {
  return {
    complete: value?.complete === true,
    reasons: Array.isArray(value?.reasons) ? value.reasons.map((entry) => clean(entry)) : [],
  };
}
function courseSnapshot(course, syllabus, now) {
  if (!course?.course?.id || !Array.isArray(course.assignments) || !Array.isArray(course.modules))
    throw new HttpError(400, 'Choose a valid Canvas course.');
  const cid = String(course.course.id);
  if (!/^[1-9]\d{0,15}$/.test(cid)) throw new HttpError(400, 'Choose a valid Canvas course.');
  const base = `https://babson.instructure.com/courses/${cid}`;
  const exported = {
    format: 'roger-course-snapshot',
    version: 1,
    exportedAt: new Date(now()).toISOString(),
    scope:
      'Read-only course overview, assignments, module index, syllabus discoveries and file references. Original file bytes, full assignment instructions, grades and external video transcripts are not included. This is not a Canvas IMS export.',
    course: {
      id: cid,
      name: clean(course.course.name, 300),
      code: clean(course.course.code, 200),
      url: base,
    },
    coverage: { course: coverage(course.coverage), syllabus: coverage(syllabus?.coverage) },
    assignments: course.assignments.map((item) => ({
      id: String(item.id),
      name: clean(item.name, 300),
      dueAt: item.dueAt ?? null,
      url: safeLink(item.url),
      locked: Boolean(item.locked),
      submitted: Boolean(item.submitted),
    })),
    modules: course.modules.map((module) => ({
      id: String(module.id),
      name: clean(module.name, 300),
      locked: Boolean(module.locked),
      items: (module.items || []).map((item) => ({
        id: String(item.id),
        title: clean(item.title, 300),
        type: clean(item.type, 100),
        url: safeLink(item.url),
        fileId: item.fileId ? String(item.fileId) : null,
        pageUrl: clean(item.pageUrl, 200),
        locked: Boolean(item.locked),
      })),
    })),
    syllabus: (syllabus?.candidates || []).map((source) => ({
      kind: clean(source.kind, 50),
      title: clean(source.title, 300),
      url: safeLink(source.url),
      foundIn: clean(source.via, 500),
      fileId: source.fileId ? String(source.fileId) : null,
      text: clean(source.text, 120_000),
      status: source.text
        ? 'Extracted page text included; verify the original.'
        : 'File reference only; open or download the original in Canvas.',
    })),
  };
  return exported;
}

function fileReferences(exported, listed = []) {
  const fileMap = new Map();
  const remember = (id, title, locked, location) => {
    if (!fileId(id)) return;
    const fid = String(id);
    const file = fileMap.get(fid) ?? {
      fileId: fid,
      title: clean(title, 300) || `File ${fid}`,
      url: `${exported.course.url}/files/${fid}`,
      locked: false,
      included: false,
      foundIn: [],
    };
    file.locked ||= Boolean(locked);
    if (!file.foundIn.includes(location)) file.foundIn.push(location);
    fileMap.set(fid, file);
  };
  for (const module of exported.modules)
    for (const item of module.items)
      if (item.fileId)
        remember(item.fileId, item.title, module.locked || item.locked, `Module: ${module.name}`);
  for (const source of exported.syllabus)
    if (source.fileId) remember(source.fileId, source.title, false, source.foundIn || 'Syllabus');
  for (const file of listed) remember(file.fileId, file.title, file.locked, 'Course Files');
  return [...fileMap.values()];
}

export function createCourseExport(course, syllabus, format = 'json', { now = Date.now } = {}) {
  if (!['json', 'markdown'].includes(format))
    throw new HttpError(400, 'Choose JSON or Markdown export.');
  const exported = courseSnapshot(course, syllabus, now);
  const { id: cid, url: base } = exported.course;
  exported.files = fileReferences(exported);
  const filename = `roger-course-${cid}`;
  if (format === 'json')
    return {
      fileName: `${filename}.json`,
      mime: 'application/json;charset=utf-8',
      content: JSON.stringify(exported, null, 2),
    };
  const lines = [
    `# ${markdown(exported.course.name)}`,
    '',
    `Exported: ${exported.exportedAt}`,
    '',
    exported.scope,
    '',
    `Canvas: ${base}`,
    '',
    '## Coverage',
    '',
  ];
  for (const [kind, detail] of Object.entries(exported.coverage)) {
    lines.push(
      `- ${kind}: ${detail.complete ? 'Complete for the requested listing.' : 'Partial or not verified complete.'}`,
    );
    lines.push(...detail.reasons.map((reason) => `  - ${markdown(reason)}`));
  }
  lines.push('', '## Assignments', '');
  for (const item of exported.assignments)
    lines.push(
      `- **${markdown(item.name)}** — ${item.dueAt ? markdown(item.dueAt) : 'No due date supplied'} · ${item.submitted ? 'Submitted' : 'Not marked submitted'}${item.locked ? ' · Locked' : ''}`,
      `  ${item.url}`,
    );
  lines.push('', '## Modules and readings', '');
  for (const module of exported.modules) {
    lines.push(`### ${markdown(module.name)}${module.locked ? ' (locked)' : ''}`, '');
    for (const item of module.items)
      lines.push(
        `- ${markdown(item.title)} · ${markdown(item.type)}${item.locked ? ' · Locked' : ''}`,
        `  ${item.url}`,
      );
    lines.push('');
  }
  lines.push('## Syllabus sources', '');
  if (!exported.syllabus.length) lines.push('No syllabus candidate was found.');
  for (const source of exported.syllabus)
    lines.push(
      `### ${markdown(source.title)}`,
      '',
      `Found in: ${markdown(source.foundIn)}`,
      source.url,
      '',
      source.status,
      '',
      markdown(source.text),
      '',
    );
  lines.push(
    '## File manifest',
    '',
    'Original files are linked, not embedded. Availability remains subject to Canvas permissions.',
    '',
  );
  for (const file of exported.files)
    lines.push(`- ${markdown(file.title)}${file.locked ? ' · Locked' : ''}`, `  ${file.url}`);
  return {
    fileName: `${filename}.md`,
    mime: 'text/markdown;charset=utf-8',
    content: lines.join('\n') + '\n',
  };
}

// Store-only ZIP32. The limits below keep offsets, sizes, and entry counts far below ZIP32 limits.
function zip(entries) {
  const data = [];
  const directory = [];
  let offset = 0;
  for (const [path, bytes] of entries) {
    const name = Buffer.from(path);
    const checksum = crc32(bytes);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x21, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(bytes.byteLength, 18);
    local.writeUInt32LE(bytes.byteLength, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50);
    central.writeUInt16LE(20, 4);
    local.copy(central, 6, 4, 28);
    central.writeUInt32LE(offset, 42);
    data.push(local, name, bytes);
    directory.push(central, name);
    offset += local.length + name.length + bytes.byteLength;
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(
    directory.reduce((sum, value) => sum + value.length, 0),
    12,
  );
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...data, ...directory, end]);
}

function archivePath(file, original, extension) {
  const leaf = clean(original || file.title, 300)
    .split(/[/\\]/)
    .at(-1);
  const name = leaf
    .replace(/\.[^.]*$/, '')
    .replace(/[^\w-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120);
  return `files/${file.fileId}-${name || 'original'}.${extension}`;
}

function unavailable(file, reason) {
  file.status = 'unavailable';
  file.reason = reason;
}

const fileErrors = {
  locked: 'Canvas reported the file as locked or hidden.',
  unavailable: 'Canvas did not provide access to this file.',
  unsupported_type: 'This file type is available as a Canvas reference.',
  too_large: 'The file exceeds the 12 MiB per-file limit.',
  unsafe_url: 'The file requires a Canvas download host Roger does not support.',
  aborted: 'The Canvas download did not finish in time.',
};

export async function createCourseArchive(
  course,
  syllabus,
  { listing, readFile, signal, now = Date.now },
) {
  const exported = courseSnapshot(course, syllabus, now);
  exported.scope =
    'Read-only course overview and supported original files. Full assignment instructions, grades, external content and external video transcripts are not included. This is not a Canvas IMS export.';
  exported.coverage.files = coverage(listing?.coverage);
  exported.files = fileReferences(exported, listing?.files);
  const timeout = AbortSignal.timeout(ARCHIVE_TIME);
  const downloadSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const entries = [];
  let attempts = 0;
  let size = 0;
  for (const file of exported.files) {
    signal?.throwIfAborted();
    if (file.locked) unavailable(file, 'This file is marked locked or hidden in Canvas.');
    else if (timeout.aborted) unavailable(file, 'The archive reached its download time limit.');
    else if (attempts >= FILE_ATTEMPTS || size >= ARCHIVE_BYTES)
      unavailable(file, 'The archive reached its file or size limit.');
    else {
      attempts++;
      try {
        const { bytes, mime, name } = await readFile(file.fileId, { signal: downloadSignal });
        const extension =
          Object.hasOwn(ARCHIVE_FILE_EXTENSIONS, mime) && ARCHIVE_FILE_EXTENSIONS[mime];
        if (!extension || !(bytes instanceof Uint8Array))
          unavailable(file, 'Canvas did not return a supported original file.');
        else if (bytes.byteLength > FILE_BYTES)
          unavailable(file, 'The file exceeds the 12 MiB per-file limit.');
        else if (size + bytes.byteLength > ARCHIVE_BYTES)
          unavailable(file, 'This file would exceed the 24 MiB archive limit.');
        else {
          file.path = archivePath(file, name, extension);
          file.included = true;
          file.status = 'included';
          file.bytes = bytes.byteLength;
          file.mime = mime;
          entries.push([file.path, bytes]);
          size += bytes.byteLength;
        }
      } catch (error) {
        if (signal?.aborted || error?.code === 'unauthorized') throw error;
        unavailable(
          file,
          Object.hasOwn(fileErrors, error?.code)
            ? fileErrors[error.code]
            : 'Canvas could not provide the original file.',
        );
      }
    }
  }
  for (const source of exported.syllabus)
    if (exported.files.some((file) => file.fileId === source.fileId && file.included))
      source.status = 'Original file included. See the file manifest for its location.';
  exported.coverage.originals = {
    complete:
      Object.values(exported.coverage).every(({ complete }) => complete) &&
      entries.length === exported.files.length,
    included: entries.length,
    unavailable: exported.files.length - entries.length,
    maxAttempts: FILE_ATTEMPTS,
    maxBytes: ARCHIVE_BYTES,
  };
  signal?.throwIfAborted();
  return {
    fileName: `roger-course-${exported.course.id}.zip`,
    mime: 'application/zip',
    content: zip([['course.json', Buffer.from(JSON.stringify(exported, null, 2))], ...entries]),
  };
}
