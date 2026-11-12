import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assignmentPresentation,
  createCanvasReadCache,
  calendarDays,
  agendaGroup,
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
