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
  const tomorrow = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1);
  const nextWeek = new Date(
    today.getFullYear(),
    today.getMonth(),
    today.getDate() + (7 - ((today.getDay() + 6) % 7)),
  );
  if (due < tomorrow) return 'Today';
  return due < nextWeek ? 'This week' : 'Later';
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
