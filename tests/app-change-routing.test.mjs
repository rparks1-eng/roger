import test from 'node:test';
import assert from 'node:assert/strict';
import { isAppChangeRequest } from '../src/client/app-changes-ui.mjs';

test('app changes recognize integrated features and existing-page requests', () => {
  for (const request of [
    'Add a button to the Library',
    'Add a filter to assignments',
    'Can you add a GPA calculator to Roger?',
    'Please change the calendar layout',
    'Create a new page for finance',
    'I want to move the sidebar to the right',
    'Feature request: add assignment sorting',
    'Change the layout and colors of the course page',
  ])
    assert.equal(isAppChangeRequest(request), true, request);
});

test('academic questions, separate tools, notes and color controls retain their workflows', () => {
  for (const request of [
    'What is due tomorrow?',
    'What does the assignment mean by build an app?',
    'How would I create a website for this assignment?',
    'Build a standalone calculator',
    'Create a separate tool for the calendar',
    'Create a notes page called Exam plan',
    'Change the app colors',
    'Make the Roger background blue',
    'Build a finance calculator',
  ])
    assert.equal(isAppChangeRequest(request), false, request);
  assert.equal(isAppChangeRequest(null), false);
  assert.equal(isAppChangeRequest('Add a feature to Roger' + 'x'.repeat(6000)), false);
});
