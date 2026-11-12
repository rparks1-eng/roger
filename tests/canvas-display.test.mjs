import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assignmentPresentation,
  createCanvasReadCache,
  calendarDays,
  agendaGroup,
  deadlinePresentation,
  nextUnfinishedAssignment,
} from '../src/client/canvas-display.mjs';

const now = new Date(2026, 10, 11, 12).getTime();
test('Canvas status colors distinguish missing, urgency and success without inventing missing grades', () => {
  const overdue = new Date(now - 3600_000).toISOString();
  const soon = new Date(now + 3600_000).toISOString();
  for (const status of ['missing', 'unsubmitted'])
    assert.equal(assignmentPresentation({ status, dueAt: overdue }, now).tone, 'danger');
  assert.equal(assignmentPresentation({ status: 'missing' }, now).label, 'Missing');
  assert.equal(
    assignmentPresentation({ status: 'unsubmitted', dueAt: overdue }, now).label,
    'Overdue · not submitted',
  );
  for (const status of ['submitted', 'excused'])
    assert.equal(assignmentPresentation({ status, dueAt: overdue }, now).tone, 'success');
  assert.equal(assignmentPresentation({ status: 'locked', dueAt: overdue }, now).tone, 'neutral');
  assert.equal(assignmentPresentation({ status: 'unknown', dueAt: overdue }, now).tone, 'neutral');
  assert.equal(assignmentPresentation({ dueAt: overdue }, now).label, 'Status unavailable');
  assert.equal(assignmentPresentation({ submitted: true, dueAt: overdue }, now).tone, 'success');
  assert.equal(assignmentPresentation({ status: 'unsubmitted', dueAt: soon }, now).tone, 'warning');
  assert.equal(
    assignmentPresentation({ status: 'unsubmitted', dueAt: 'invalid' }, now).tone,
    'neutral',
  );
});

test('warm reads reuse JSON, TTL and explicit refresh fetch again, and clear crosses account boundary', async () => {
  let clock = 1000,
    calls = 0;
  const cache = createCanvasReadCache({ clock: () => clock });
  const loader = async () => ({ call: ++calls });
  const first = await cache.read('course:1', loader, { ttl: 60_000 });
  assert.equal((await cache.read('course:1', loader)).call, first.call);
  assert.equal(calls, 1);
  clock += 60_000;
  assert.equal((await cache.read('course:1', loader)).call, 2);
  assert.equal((await cache.read('course:1', loader, { force: true })).call, 3);
  cache.clear();
  assert.equal(cache.size, 0);
  assert.equal(cache.bytes, 0);
  assert.equal((await cache.read('course:1', loader)).call, 4);
});

test('cache is bounded, uses least-recently-used eviction and never stores failed or cancelled data', async () => {
  const cache = createCanvasReadCache({ maxEntries: 2, maxBytes: 300 });
  await cache.read('one', async () => ({ label: 'one' }));
  await cache.read('two', async () => ({ label: 'two' }));
  cache.get('one');
  await cache.read('three', async () => ({ label: 'three' }));
  assert.equal(cache.get('two'), undefined);
  assert.equal(cache.get('one').label, 'one');
  await cache.read('huge', async () => ({ text: 'x'.repeat(1000) }));
  assert.equal(cache.get('huge'), undefined);
  assert.ok(cache.bytes <= 300);
  await assert.rejects(
    cache.read('failed', async () => {
      throw new Error('offline');
    }),
  );
  assert.equal(cache.get('failed'), undefined);
  const controller = new AbortController();
  await assert.rejects(
    cache.read(
      'cancelled',
      async () => {
        controller.abort();
        return { private: true };
      },
      { signal: controller.signal },
    ),
  );
  assert.equal(cache.get('cancelled'), undefined);
  let called = false;
  await assert.rejects(
    cache.read(
      'cancelled',
      async () => {
        called = true;
      },
      { signal: controller.signal },
    ),
  );
  assert.equal(called, false);
});

test('calendar covers complete Monday-start weeks including leap years and year boundaries', () => {
  for (const month of [
    new Date(2024, 1, 1),
    new Date(2026, 10, 1),
    new Date(2026, 11, 1),
    new Date(2027, 0, 1),
  ]) {
    const days = calendarDays(month);
    assert.equal(days.length % 7, 0);
    assert.equal(days[0].getDay(), 1);
    assert.equal(days.at(-1).getDay(), 0);
    assert.equal(
      days.filter((date) => date.getMonth() === month.getMonth()).length,
      new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate(),
    );
    assert.equal(new Set(days.map((date) => date.toDateString())).size, days.length);
  }
  assert.equal(agendaGroup(new Date(2026, 10, 11, 18), now), 'Today');
  assert.equal(agendaGroup(new Date(2026, 10, 13), now), 'This week');
  assert.equal(agendaGroup(new Date(2026, 10, 16), now), 'Later');
});

test('deadline wording distinguishes minutes, today, tomorrow and the exact local timestamp', () => {
  const reference = new Date(2026, 10, 12, 10, 20).getTime();
  const soon = new Date(2026, 10, 12, 10, 30).toISOString();
  const result = deadlinePresentation(soon, reference);
  assert.equal(result.relative, 'Due in 10 min');
  assert.match(result.named, /^Due today at /);
  assert.match(result.exact, /2026/);
  assert.equal(result.overdue, false);
  assert.match(
    deadlinePresentation(new Date(2026, 10, 13, 10, 30).toISOString(), reference).named,
    /^Due tomorrow at /,
  );
  assert.equal(
    deadlinePresentation(new Date(reference + 45_000).toISOString(), reference).relative,
    'Due in 45 sec',
  );
  assert.equal(
    deadlinePresentation(new Date(reference - 600_000).toISOString(), reference).relative,
    'Overdue by 10 min',
  );
  assert.equal(
    deadlinePresentation(new Date(reference).toISOString(), reference).relative,
    'Due now',
  );
  assert.equal(deadlinePresentation('invalid', reference).relative, 'No due date');
  assert.equal(deadlinePresentation(null, reference).exact, '');
});

test('named deadline groups follow local calendar days across midnight and DST weekends', () => {
  for (const reference of [new Date(2026, 2, 7, 23, 50), new Date(2026, 10, 12, 23, 50)]) {
    const due = new Date(reference.getFullYear(), reference.getMonth(), reference.getDate() + 1);
    assert.equal(agendaGroup(due, reference.getTime()), 'Tomorrow');
    assert.equal(
      deadlinePresentation(due.toISOString(), reference.getTime()).relative,
      'Due in 10 min',
    );
  }
  assert.equal(agendaGroup(new Date(2026, 10, 10), now), 'Past due');
});

test('next deadline excludes completed, locked and unknown work and preserves overdue review', () => {
  const assignment = (id, status, minutes) => ({
    id,
    name: `Assignment ${id}`,
    status,
    dueAt: new Date(now + minutes * 60_000).toISOString(),
  });
  const upcoming = assignment('next', 'unsubmitted', 10);
  const oldMissing = assignment('old', 'missing', -1440);
  const recentOverdue = assignment('recent', 'redo', -5);
  const items = [
    oldMissing,
    recentOverdue,
    assignment('done', 'submitted', 1),
    assignment('excused', 'excused', 2),
    assignment('locked', 'locked', 3),
    assignment('unknown', 'unknown', 4),
    assignment('later', 'unsubmitted', 120),
    upcoming,
  ];
  assert.equal(nextUnfinishedAssignment(items, now).id, 'next');
  assert.equal(nextUnfinishedAssignment([oldMissing, recentOverdue], now).id, 'recent');
  assert.equal(nextUnfinishedAssignment([assignment('done', 'submitted', 1)], now), null);
  assert.equal(
    nextUnfinishedAssignment([{ id: 'undated', name: 'Undated', status: 'unsubmitted' }], now),
    null,
  );
});
