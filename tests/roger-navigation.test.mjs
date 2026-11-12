import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveNavigation } from '../src/client/roger-navigation.mjs';
const index = {
  courses: [
    {
      id: '1',
      code: 'FIN3515-01 Corporate Financial Management Fall 2026',
      name: 'Corporate Financial Modeling',
    },
    { id: '2', code: 'OIM 3641', name: 'AI Application Development' },
  ],
  assignments: [
    { id: 'a', courseId: '1', name: 'Final Project' },
    { id: 'b', courseId: '2', name: 'Final Project' },
  ],
};
test('class code, natural title, and course-constrained assignment navigation', () => {
  assert.equal(resolveNavigation('pull up FIN3515 syllabus', index).target.section, 'syllabus');
  assert.equal(
    resolveNavigation('question about corporate financial modeling', index).target.courseId,
    '1',
  );
  assert.equal(
    resolveNavigation('open final project for OIM 3641', index).target.assignmentId,
    'b',
  );
});
test('ambiguous assignments offer choices and unrelated questions do not navigate', () => {
  assert.equal(resolveNavigation('open final project', index).choices.length, 2);
  assert.equal(resolveNavigation('how do I calculate interest?', index), null);
  assert.equal(
    resolveNavigation('pull up this class', index, { courseId: '1' }).target.courseId,
    '1',
  );
});

test('Roman numeral assignment names require full words', () => {
  const index = {
    courses: [],
    assignments: [
      { id: '1', courseId: 'a', name: 'Milestone I' },
      { id: '2', courseId: 'a', name: 'Milestone II' },
    ],
  };
  assert.equal(
    resolveNavigation('What do I submit for Milestone II?', index).target.assignmentId,
    '2',
  );
});
