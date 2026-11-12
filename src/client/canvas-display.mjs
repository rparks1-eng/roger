const LABELS = Object.freeze({
  submitted: 'Submitted',
  missing: 'Missing',
  locked: 'Locked',
  excused: 'Excused',
  redo: 'Resubmission requested',
  unsubmitted: 'Not submitted',
  unknown: 'Status unavailable',
});

export function agendaGroup(dueAt, now = Date.now()) {
  const due = new Date(dueAt),
    today = new Date(now);
  if (!Number.isFinite(due.getTime())) return 'No due date';
  const start = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const tomorrow = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1);
  const afterTomorrow = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 2);
  const nextWeek = new Date(
    today.getFullYear(),
    today.getMonth(),
    today.getDate() + (7 - ((today.getDay() + 6) % 7)),
  );
  if (due < start) return 'Past due';
  if (due < tomorrow) return 'Today';
  if (due < afterTomorrow) return 'Tomorrow';
  return due < nextWeek ? 'This week' : 'Later';
}

/** Local calendar wording and a live duration; the source timestamp remains unchanged. */
export function deadlinePresentation(dueAt, now = Date.now()) {
  const due = new Date(dueAt);
  if (!dueAt || !Number.isFinite(due.getTime()))
    return { relative: 'No due date', named: 'No due date', exact: '', overdue: false };
  const delta = due.getTime() - now;
  const absolute = Math.abs(delta);
  let duration;
  if (absolute < 60_000) duration = `${Math.max(1, Math.ceil(absolute / 1000))} sec`;
  else {
    const minutes = Math.ceil(absolute / 60_000);
    const days = Math.floor(minutes / 1440);
    const hours = Math.floor((minutes % 1440) / 60);
    const remaining = minutes % 60;
    duration = [
      days ? `${days} ${days === 1 ? 'day' : 'days'}` : '',
      hours ? `${hours} hr` : '',
      remaining ? `${remaining} min` : '',
    ]
      .filter(Boolean)
      .join(' ');
  }
  const group = agendaGroup(dueAt, now);
  const clock = due.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  const day =
    group === 'Today'
      ? 'today'
      : group === 'Tomorrow'
        ? 'tomorrow'
        : due.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  return {
    relative:
      absolute < 1000 ? 'Due now' : delta < 0 ? `Overdue by ${duration}` : `Due in ${duration}`,
    named: `${delta < 0 ? 'Was due' : 'Due'} ${day} at ${clock}`,
    exact: due.toLocaleString(undefined, {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      ...(due.getSeconds() ? { second: '2-digit' } : {}),
      timeZoneName: 'short',
    }),
    overdue: delta < 0,
  };
}

/** Surface the next known unfinished deadline; keep old missing work in its own review list. */
export function nextUnfinishedAssignment(items, now = Date.now()) {
  const unfinished = items.filter(
    (item) =>
      ['unsubmitted', 'redo', 'missing'].includes(assignmentPresentation(item, now).status) &&
      Number.isFinite(Date.parse(item.dueAt)),
  );
  const upcoming = unfinished
    .filter((item) => Date.parse(item.dueAt) >= now)
    .sort((a, b) => Date.parse(a.dueAt) - Date.parse(b.dueAt) || a.name.localeCompare(b.name));
  return (
    upcoming[0] ||
    unfinished.sort(
      (a, b) => Date.parse(b.dueAt) - Date.parse(a.dueAt) || a.name.localeCompare(b.name),
    )[0] ||
    null
  );
}

export function calendarDays(month) {
  const first = new Date(month.getFullYear(), month.getMonth(), 1);
  const offset = (first.getDay() + 6) % 7;
  const last = new Date(first.getFullYear(), first.getMonth() + 1, 0);
  const length = Math.ceil((offset + last.getDate()) / 7) * 7;
  return Array.from(
    { length },
    (_, index) => new Date(first.getFullYear(), first.getMonth(), index - offset + 1),
  );
}

/** Keep Canvas's explicit status authoritative; infer overdue only when submission is known. */
export function assignmentPresentation(item, now = Date.now()) {
  let status = Object.hasOwn(LABELS, item.status) ? item.status : null;
  status ||= item.submitted
    ? 'submitted'
    : item.locked
      ? 'locked'
      : item.submitted === false
        ? 'unsubmitted'
        : 'unknown';
  const due = Date.parse(item.dueAt);
  const pending = ['unsubmitted', 'redo'].includes(status);
  const overdue = pending && Number.isFinite(due) && due < now;
  const soon = pending && Number.isFinite(due) && due >= now && due - now <= 48 * 60 * 60_000;
  const tone =
    status === 'missing' || overdue
      ? 'danger'
      : status === 'submitted' || status === 'excused'
        ? 'success'
        : soon || status === 'redo'
          ? 'warning'
          : 'neutral';
  return {
    status,
    tone,
    label: overdue ? 'Overdue · not submitted' : LABELS[status],
    dueLabel: overdue || status === 'missing' ? 'Past due' : soon ? 'Due soon' : '',
    overdue,
    soon,
  };
}

/** Bounded, account-session-only JSON cache. Errors and cancelled replies are never retained. */
export function createCanvasReadCache({
  clock = Date.now,
  maxEntries = 24,
  maxBytes = 4 * 1024 * 1024,
} = {}) {
  const entries = new Map();
  let bytes = 0;
  function remove(key) {
    const entry = entries.get(key);
    if (entry) bytes -= entry.bytes;
    entries.delete(key);
  }
  function get(key) {
    const entry = entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= clock()) {
      remove(key);
      return undefined;
    }
    entries.delete(key);
    entries.set(key, entry);
    return entry.value;
  }
  function set(key, value, ttl) {
    if (!Number.isFinite(ttl) || ttl <= 0) return;
    const size = JSON.stringify(value).length * 2;
    remove(key);
    if (size > maxBytes) return;
    while (entries.size >= maxEntries || bytes + size > maxBytes)
      remove(entries.keys().next().value);
    entries.set(key, { value, bytes: size, expiresAt: clock() + ttl });
    bytes += size;
  }
  async function read(key, loader, { ttl = 60_000, force = false, signal } = {}) {
    signal?.throwIfAborted();
    const existing = force ? undefined : get(key);
    if (existing !== undefined) return existing;
    const value = await loader();
    signal?.throwIfAborted();
    set(key, value, ttl);
    return value;
  }
  return {
    get,
    read,
    clear() {
      entries.clear();
      bytes = 0;
    },
    get size() {
      return entries.size;
    },
    get bytes() {
      return bytes;
    },
  };
}
