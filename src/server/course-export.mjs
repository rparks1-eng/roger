/** A portable, read-only course snapshot; not a Canvas IMS content export. */
import { HttpError } from './security.mjs';

const clean = (value, limit = 2000) => (typeof value === 'string' ? value.slice(0, limit) : '');
function safeLink(value) {
  try {
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password
      ? url.href
      : '';
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
export function createCourseExport(course, syllabus, format = 'json', { now = Date.now } = {}) {
  if (
    !['json', 'markdown'].includes(format) ||
    !course?.course?.id ||
    !Array.isArray(course.assignments) ||
    !Array.isArray(course.modules)
  )
    throw new HttpError(400, 'Choose a course and JSON or Markdown export.');
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
  const fileMap = new Map();
  for (const module of exported.modules)
    for (const item of module.items)
      if (item.fileId)
        fileMap.set(item.fileId, {
          fileId: item.fileId,
          title: item.title,
          url: item.url || `${base}/files/${item.fileId}`,
          locked: item.locked,
          included: false,
        });
  for (const source of exported.syllabus)
    if (source.fileId && !fileMap.has(source.fileId))
      fileMap.set(source.fileId, {
        fileId: source.fileId,
        title: source.title,
        url: source.url,
        locked: false,
        included: false,
      });
  exported.files = [...fileMap.values()];
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
