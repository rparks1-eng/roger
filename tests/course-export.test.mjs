import test from 'node:test';
import assert from 'node:assert/strict';
import { createCourseExport } from '../src/server/course-export.mjs';
const course = {
  course: { id: '42', name: 'Corporate Finance', code: 'FIN3515', token: 'must-not-export' },
  assignments: [
    {
      id: '1',
      name: 'Exam 2',
      dueAt: '2026-11-12T15:30:00Z',
      url: 'https://babson.instructure.com/courses/42/assignments/1',
      submitted: false,
    },
  ],
  modules: [
    {
      id: '2',
      name: 'Chapter 8',
      items: [
        {
          id: '3',
          title: 'Slides.pdf',
          type: 'File',
          fileId: '44',
          url: 'https://babson.instructure.com/courses/42/files/44',
        },
      ],
    },
  ],
  coverage: { complete: false, reasons: ['Some module items were not visible.'] },
};
const syllabus = {
  candidates: [
    {
      kind: 'file',
      title: 'Syllabus.pdf',
      fileId: '45',
      url: 'https://babson.instructure.com/courses/42/files/45',
      via: 'Welcome module',
    },
  ],
  coverage: { complete: true, reasons: [] },
};
test('portable JSON snapshot preserves source references, partial coverage and explicit file boundaries', () => {
  const result = createCourseExport(course, syllabus, 'json', { now: () => 0 });
  const value = JSON.parse(result.content);
  assert.equal(value.exportedAt, '1970-01-01T00:00:00.000Z');
  assert.equal(value.course.id, '42');
  assert.equal(value.assignments[0].dueAt, course.assignments[0].dueAt);
  assert.equal(value.coverage.course.complete, false);
  assert.equal(value.files.length, 2);
  assert.equal(
    value.files.every((file) => file.included === false),
    true,
  );
  assert.equal(value.syllabus[0].foundIn, 'Welcome module');
  assert.doesNotMatch(result.content, /must-not-export/);
  assert.match(value.scope, /not a Canvas IMS export/);
});
test('Markdown export escapes source formatting, rejects executable links and labels empty syllabus', () => {
  const modified = structuredClone(course);
  modified.course.name = '[Click](javascript:bad)';
  modified.modules[0].items[0].url = 'javascript:bad';
  const result = createCourseExport(modified, { candidates: [] }, 'markdown', { now: () => 0 });
  assert.match(result.fileName, /\.md$/);
  assert.match(result.content, /\\\[Click\\\]/);
  assert.match(result.content, /No syllabus candidate was found/);
  assert.doesNotMatch(result.content, / {2}javascript:/);
  assert.match(result.content, /Original files are linked, not embedded/);
});
test('export validates course and format instead of producing an official archive', () => {
  assert.throws(() => createCourseExport(course, syllabus, 'ims'), { status: 400 });
  assert.throws(() => createCourseExport({ ...course, course: { id: '../../x' } }, syllabus), {
    status: 400,
  });
});
