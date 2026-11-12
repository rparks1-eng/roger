const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const STORAGE = 'roger.homeworkPlanner.v1';
const MAX_EVENTS = 800;
const MAX_BUSY = 3000;
const MAX_FILE = 1024 * 1024;
const IMPORT_DAYS = 35;
const PLAN_DAYS = 14;
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DAY_CODES = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
const zoneFormats = new Map();
const mod = (value, divisor) => ((value % divisor) + divisor) % divisor;

function daySerial(year, month, day) {
  if (year < 1900 || year > 2200) return null;
  const value = Date.UTC(year, month - 1, day);
  const date = new Date(value);
  return date.getUTCMonth() === month - 1 && date.getUTCDate() === day ? value / DAY : null;
}

function dateParts(day) {
  const date = new Date(day * DAY);
  return [date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()];
}

function localTime(day, minutes = 0) {
  const [year, month, date] = dateParts(day);
  return new Date(year, month, date, 0, minutes).getTime();
}

function localDay(time) {
  const date = new Date(time);
  return daySerial(date.getFullYear(), date.getMonth() + 1, date.getDate());
}

function zoneOffset(time, zone) {
  if (!zoneFormats.has(zone)) {
    if (zoneFormats.size >= 24) zoneFormats.clear();
    zoneFormats.set(
      zone,
      new Intl.DateTimeFormat('en-US', {
        timeZone: zone,
        year: 'numeric',
        month: 'numeric',
        day: 'numeric',
        hour: 'numeric',
        minute: 'numeric',
        second: 'numeric',
        hourCycle: 'h23',
      }),
    );
  }
  const parts = Object.fromEntries(
    zoneFormats
      .get(zone)
      .formatToParts(time)
      .map(({ type, value }) => [type, Number(value)]),
  );
  return (
    Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second) - time
  );
}

function instant(stamp, day = stamp.day) {
  const wall = day * DAY + stamp.clock;
  if (stamp.zone === 'UTC') return wall;
  if (!stamp.zone) return localTime(day, Math.floor(stamp.clock / MINUTE)) + (stamp.clock % MINUTE);
  try {
    const before = zoneOffset(wall - DAY, stamp.zone);
    const after = zoneOffset(wall + DAY, stamp.zone);
    if (before === after || zoneOffset(wall - before, stamp.zone) === before) return wall - before;
    return zoneOffset(wall - after, stamp.zone) === after ? wall - after : wall - before;
  } catch {
    return NaN;
  }
}

function stamp(value, zone = '') {
  const match = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(value);
  if (!match) return null;
  const [, year, month, date, hh = '0', mm = '0', ss = '0', z] = match;
  const day = daySerial(+year, +month, +date);
  if (day === null || +hh > 23 || +mm > 59 || +ss > 59) return null;
  return {
    day,
    clock: (+hh * 3600 + +mm * 60 + +ss) * 1000,
    dateOnly: match[4] === undefined,
    zone: z ? 'UTC' : zone,
  };
}

function duration(value) {
  const week = /^P(\d{1,3})W$/.exec(value);
  if (week) return +week[1] * 7 * DAY;
  const match = /^P(?:(\d{1,3})D)?(?:T(?:(\d{1,3})H)?(?:(\d{1,4})M)?(?:(\d{1,5})S)?)?$/.exec(value);
  if (!match) return NaN;
  const [, days = '0', hours = '0', minutes = '0', seconds = '0'] = match;
  return +days * DAY + (+hours * 3600 + +minutes * 60 + +seconds) * 1000;
}

function readEvents(text) {
  if (typeof text !== 'string' || text.length > MAX_FILE)
    throw Error('Choose an ICS file under 1 MB.');
  const lines = text
    .replace(/^\uFEFF/, '')
    .replace(/\r?\n[ \t]/g, '')
    .split(/\r?\n/);
  if (!lines.some((line) => /^BEGIN:VCALENDAR$/i.test(line.trim())))
    throw Error('This file is not an iCalendar export.');
  const events = [];
  let event = null;
  let nested = 0;
  for (const line of lines) {
    if (/^BEGIN:VEVENT$/i.test(line)) {
      if (event) throw Error('The calendar contains a malformed event.');
      event = new Map();
    } else if (/^END:VEVENT$/i.test(line) && event) {
      events.push(event);
      if (events.length > MAX_EVENTS)
        throw Error('Use a calendar export with no more than 800 events.');
      event = null;
      nested = 0;
    } else if (event && /^BEGIN:/i.test(line)) {
      nested++;
    } else if (event && /^END:/i.test(line) && nested) {
      nested--;
    } else if (event && !nested) {
      const match = /^([A-Z-]+)(;[^:]*)?:(.*)$/i.exec(line);
      if (!match) continue;
      const [, rawName, parameters = '', value] = match;
      const name = rawName.toUpperCase();
      const zone = /(?:^|;)TZID=(?:"([^"]+)"|([^;]+))/i.exec(parameters);
      const values = event.get(name) || [];
      values.push({ value, zone: zone?.[1] || zone?.[2] || '' });
      event.set(name, values);
    }
  }
  if (event) throw Error('The calendar ends in an unfinished event.');
  return events;
}

function recurringDays(start, values, firstDay, lastDay) {
  const parts = Object.fromEntries(
    values
      .toUpperCase()
      .split(';')
      .map((part) => part.split('=')),
  );
  const interval = Number(parts.INTERVAL ?? 1);
  const count = Number(parts.COUNT ?? Infinity);
  const until = parts.UNTIL ? stamp(parts.UNTIL, start.zone) : null;
  const weekStart = DAY_CODES.indexOf(parts.WKST ?? 'MO');
  const startWeekday = mod(start.day + 4, 7);
  const weekdays = (parts.BYDAY || DAY_CODES[startWeekday])
    .split(',')
    .map((day) => DAY_CODES.indexOf(day));
  if (
    !['DAILY', 'WEEKLY'].includes(parts.FREQ) ||
    Object.keys(parts).some(
      (key) => !['FREQ', 'INTERVAL', 'COUNT', 'UNTIL', 'WKST', 'BYDAY'].includes(key),
    ) ||
    !Number.isInteger(interval) ||
    interval < 1 ||
    interval > 366 ||
    (parts.COUNT && (!Number.isInteger(count) || count < 1)) ||
    (parts.UNTIL && !until) ||
    (parts.COUNT && parts.UNTIL) ||
    weekStart < 0 ||
    weekdays.some((day) => day < 0) ||
    (parts.FREQ === 'DAILY' && parts.BYDAY)
  )
    return null;
  const endDay = Math.min(lastDay, until ? until.day + 1 : lastDay);
  const cutoff = until
    ? instant(until) + (until.dateOnly && !start.dateOnly ? DAY - 1 : 0)
    : Infinity;
  if (Number.isNaN(cutoff)) return null;
  const result = [];
  if (parts.FREQ === 'DAILY') {
    const firstIndex = Math.max(0, Math.ceil((firstDay - start.day) / interval));
    for (let index = firstIndex; index < count; index++) {
      const day = start.day + index * interval;
      if (day > endDay || instant(start, day) > cutoff) break;
      result.push(day);
    }
    return result;
  }
  const weekAnchor = start.day - mod(startWeekday - weekStart, 7);
  const offsets = [...new Set(weekdays.map((day) => mod(day - weekStart, 7)))].sort(
    (a, b) => a - b,
  );
  const firstOffsets = [
    ...new Set([start.day - weekAnchor, ...offsets.filter((day) => weekAnchor + day >= start.day)]),
  ].sort((a, b) => a - b);
  const firstWeek = Math.max(0, Math.floor((firstDay - weekAnchor) / (7 * interval)));
  let occurrence = firstWeek ? firstOffsets.length + (firstWeek - 1) * offsets.length : 0;
  for (let index = firstWeek; weekAnchor + index * 7 * interval <= endDay; index++) {
    const anchor = weekAnchor + index * 7 * interval;
    for (const offset of index ? offsets : firstOffsets) {
      if (occurrence++ >= count) return result;
      const day = anchor + offset;
      if (day > endDay || instant(start, day) > cutoff) return result;
      if (day >= firstDay) result.push(day);
    }
  }
  return result;
}

export function parseCalendar(text, now = Date.now()) {
  const firstDay = localDay(now);
  const until = localTime(firstDay + IMPORT_DAYS);
  const busy = [];
  let skipped = 0;
  const events = readEvents(text);
  const overrides = new Map();
  for (const event of events) {
    const uid = event.get('UID')?.[0]?.value;
    const original = event.get('RECURRENCE-ID')?.[0];
    if (!uid || !original) continue;
    const cancelled = stamp(original.value, original.zone);
    if (!cancelled || !Number.isFinite(instant(cancelled))) continue;
    const exceptions = overrides.get(uid) || new Set();
    exceptions.add(instant(cancelled));
    overrides.set(uid, exceptions);
  }
  for (const event of events) {
    const read = (name) => event.get(name)?.[0];
    if (
      read('TRANSP')?.value.toUpperCase() === 'TRANSPARENT' ||
      read('STATUS')?.value.toUpperCase() === 'CANCELLED'
    )
      continue;
    const rawStart = read('DTSTART');
    const rawEnd = read('DTEND');
    const start = rawStart && stamp(rawStart.value, rawStart.zone);
    const end = rawEnd && stamp(rawEnd.value, rawEnd.zone);
    const startAt = start && instant(start);
    const explicitDuration = read('DURATION');
    const span = end
      ? instant(end) - startAt
      : explicitDuration
        ? duration(explicitDuration.value)
        : start?.dateOnly
          ? DAY
          : 0;
    const allDays = start?.dateOnly && (end?.dateOnly ? end.day - start.day : span / DAY);
    if (
      !start ||
      (rawEnd && !end) ||
      !Number.isFinite(startAt) ||
      !Number.isFinite(span) ||
      span < 0
    ) {
      skipped++;
      continue;
    }
    if (!span) continue;
    const first = firstDay - Math.ceil(span / DAY) - 1;
    const rule = read('RRULE');
    const days = rule
      ? recurringDays(start, rule.value, first, firstDay + IMPORT_DAYS + 1)
      : [start.day];
    if (!days || event.has('RDATE') || event.get('RRULE')?.length > 1) skipped++;
    const excluded = new Set(overrides.get(read('UID')?.value));
    for (const exclusion of event.get('EXDATE') || []) {
      for (const value of exclusion.value.split(',')) {
        const entry = stamp(value, exclusion.zone || start.zone);
        if (entry) excluded.add(instant(entry));
        else skipped++;
      }
    }
    for (const day of days || [start.day]) {
      const time = instant(start, day);
      if (!event.has('RECURRENCE-ID') && excluded.has(time)) continue;
      const stop = allDays ? instant(start, day + allDays) : time + span;
      if (time < until && stop > now) busy.push([Math.max(now, time), Math.min(until, stop)]);
      if (busy.length > MAX_BUSY) throw Error('This calendar has too many upcoming busy blocks.');
    }
  }
  busy.sort((a, b) => a[0] - b[0]);
  return { busy, until, skipped };
}

const DEFAULTS = {
  calendar: null,
  blocks: [],
  start: 8 * 60,
  end: 22 * 60,
  length: 45,
  notifications: false,
  reminded: {},
};

function loadSettings() {
  try {
    const raw = localStorage.getItem(STORAGE) || '';
    if (raw.length > 210_000) return structuredClone(DEFAULTS);
    const saved = JSON.parse(raw);
    if (!saved) return structuredClone(DEFAULTS);
    const validMinutes = (value) => Number.isInteger(value) && value >= 0 && value < 1440;
    const validPair = (start, end) => Number.isFinite(start) && Number.isFinite(end) && end > start;
    const calendar =
      saved.calendar && Number.isFinite(saved.calendar.until) && Array.isArray(saved.calendar.busy)
        ? {
            until: saved.calendar.until,
            busy: saved.calendar.busy
              .filter((block) => Array.isArray(block) && validPair(...block))
              .slice(0, MAX_BUSY),
            skipped: Number.isInteger(saved.calendar.skipped)
              ? Math.max(0, saved.calendar.skipped)
              : 0,
          }
        : null;
    return {
      calendar,
      blocks: (Array.isArray(saved.blocks) ? saved.blocks : [])
        .filter((block) => {
          if (!block || typeof block.label !== 'string' || block.label.length > 80) return false;
          if (block.type === 'once') return validPair(block.start, block.end);
          return (
            block.type === 'weekly' &&
            Number.isInteger(block.day) &&
            block.day >= 0 &&
            block.day <= 6 &&
            validMinutes(block.start) &&
            validMinutes(block.end) &&
            block.start < block.end
          );
        })
        .slice(0, 60),
      start: validMinutes(saved.start) && saved.start < saved.end ? saved.start : DEFAULTS.start,
      end: validMinutes(saved.end) && saved.start < saved.end ? saved.end : DEFAULTS.end,
      length: [25, 45, 60, 90].includes(saved.length) ? saved.length : DEFAULTS.length,
      notifications: saved.notifications === true,
      reminded: Object.fromEntries(
        Object.entries(saved.reminded || {})
          .filter(
            ([key, time]) =>
              /^[\w:-]{1,120}$/.test(key) && Number.isFinite(time) && time > Date.now() - 2 * DAY,
          )
          .slice(0, 100),
      ),
    };
  } catch {
    return structuredClone(DEFAULTS);
  }
}

function eligible(assignments, now) {
  return assignments
    .filter(
      (item) =>
        item &&
        item.id &&
        item.courseId &&
        item.name &&
        !item.locked &&
        !['locked', 'excused'].includes(item.status) &&
        ((!item.submitted && item.status !== 'submitted') || item.status === 'redo'),
    )
    .map((item) => ({ assignment: item, deadline: Date.parse(item.dueAt) }))
    .filter(({ deadline }) => Number.isFinite(deadline) && deadline > now)
    .sort((a, b) => a.deadline - b.deadline);
}

export function planHomework(assignments, settings = DEFAULTS, now = Date.now()) {
  const firstDay = localDay(now);
  const planEnd = localTime(firstDay + PLAN_DAYS);
  const horizon = Math.min(planEnd, settings.calendar?.until ?? Infinity);
  const upcoming = eligible(assignments, now)
    .filter(({ deadline }) => deadline < planEnd)
    .slice(0, 10);
  const slots = [];
  const occupied = [...(settings.calendar?.busy || [])];
  for (const block of settings.blocks) {
    if (block.type === 'once') {
      occupied.push([block.start, block.end]);
      continue;
    }
    for (let day = firstDay; day < firstDay + PLAN_DAYS; day++) {
      if (mod(day + 4, 7) === block.day)
        occupied.push([localTime(day, block.start), localTime(day, block.end)]);
    }
  }
  occupied.sort((a, b) => a[0] - b[0]);
  for (const { assignment, deadline } of upcoming) {
    const latest = Math.min(deadline, horizon);
    const span = settings.length * MINUTE;
    let start = null;
    const preferredDay = Math.max(firstDay, localDay(deadline) - 2);
    // Give the next deadline today's time. Save later homework for the days before it is due.
    const days = Array.from(
      { length: PLAN_DAYS },
      (_, offset) => firstDay + ((preferredDay - firstDay + offset) % PLAN_DAYS),
    );
    for (const day of days) {
      const end = Math.min(localTime(day, settings.end), latest);
      let next =
        Math.ceil(Math.max(now, localTime(day, settings.start)) / (15 * MINUTE)) * 15 * MINUTE;
      for (const [busyStart, busyEnd] of occupied) {
        if (busyEnd <= next) continue;
        if (busyStart >= next + span) break;
        next = Math.ceil(busyEnd / (15 * MINUTE)) * 15 * MINUTE;
      }
      if (next + span <= end) {
        start = next;
        break;
      }
    }
    const end = start === null ? null : start + span;
    if (start !== null) {
      occupied.push([start, end]);
      occupied.sort((a, b) => a[0] - b[0]);
    }
    slots.push({ assignment, deadline, start, end });
  }
  return slots;
}

const el = (tag, label, className) => {
  const item = document.createElement(tag);
  if (label !== undefined) item.textContent = label;
  if (className) item.className = className;
  return item;
};

function button(label, type = 'button') {
  const item = el('button', label, 'button button-secondary');
  item.type = type;
  return item;
}

function field(label, input) {
  const wrapper = el('label', undefined, 'planner-field');
  wrapper.append(el('span', label), input);
  return wrapper;
}

function input(type, value = '') {
  const item = el('input');
  item.type = type;
  item.value = value;
  return item;
}

function select(options, selected) {
  const item = el('select');
  for (const [value, label] of options) {
    const option = el('option', label);
    option.value = value;
    item.append(option);
  }
  item.value = selected;
  return item;
}

const clockText = (minutes) =>
  [Math.floor(minutes / 60), minutes % 60].map((part) => String(part).padStart(2, '0')).join(':');
const toMinutes = (value) => {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  return match && +match[1] < 24 && +match[2] < 60 ? +match[1] * 60 + +match[2] : NaN;
};
const dateTime = (value) =>
  new Intl.DateTimeFormat(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(value);
const timeOnly = (value) =>
  new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(value);

export function createHomeworkPlanner({ container, getAssignments, onOpenAssignment }) {
  const state = loadSettings();
  const shell = el('div', undefined, 'homework-planner');
  const status = el('p', '', 'muted');
  status.setAttribute('role', 'status');
  const suggestions = el('ul', undefined, 'planner-list');
  const schedule = el('section', undefined, 'planner-section');
  schedule.append(
    el('h2', 'Suggested study time'),
    el(
      'p',
      'Add your calendar or class times to make these suggestions fit your schedule.',
      'field-hint',
    ),
    suggestions,
  );

  const controls = el('section', undefined, 'planner-section');
  controls.append(el('h2', 'Your availability'));
  const calendarInput = input('file');
  calendarInput.accept = '.ics,text/calendar';
  const clearCalendar = button('Remove calendar');
  const calendarStatus = el('p', '', 'field-hint');
  const calendarActions = el('div', undefined, 'planner-actions');
  calendarActions.append(field('Import an ICS calendar', calendarInput), clearCalendar);
  controls.append(calendarActions, calendarStatus);
  const busyList = el('ul', undefined, 'planner-list');
  const availability = el('details');
  availability.append(el('summary', 'Add a class or busy block'));
  const blockForm = el('form', undefined, 'planner-form');
  const frequency = select(
    [
      ['weekly', 'Every week'],
      ['once', 'One time'],
    ],
    'weekly',
  );
  const name = input('text');
  name.maxLength = 80;
  name.placeholder = 'Class or busy time';
  const weekday = select(
    WEEKDAYS.map((day, index) => [index, day]),
    String(new Date().getDay()),
  );
  const weeklyStart = input('time', '09:00');
  const weeklyEnd = input('time', '10:00');
  const onceStart = input('datetime-local');
  const onceEnd = input('datetime-local');
  const weekly = el('div', undefined, 'planner-actions');
  weekly.append(field('Day', weekday), field('Starts', weeklyStart), field('Ends', weeklyEnd));
  const once = el('div', undefined, 'planner-actions');
  once.append(field('Starts', onceStart), field('Ends', onceEnd));
  once.hidden = true;
  const formStatus = el('p', '', 'field-hint');
  formStatus.setAttribute('role', 'status');
  frequency.addEventListener('change', () => {
    weekly.hidden = frequency.value !== 'weekly';
    once.hidden = !weekly.hidden;
  });
  blockForm.append(
    field('Label', name),
    field('Repeats', frequency),
    weekly,
    once,
    button('Add busy time', 'submit'),
    formStatus,
  );
  availability.append(blockForm, busyList);
  controls.append(availability);

  const hours = el('details');
  hours.append(el('summary', 'Set study hours'));
  const hoursForm = el('form', undefined, 'planner-form');
  const hoursStart = input('time', clockText(state.start));
  const hoursEnd = input('time', clockText(state.end));
  const session = select(
    [25, 45, 60, 90].map((length) => [length, `${length} minutes`]),
    String(state.length),
  );
  hoursForm.append(
    field('Start after', hoursStart),
    field('Finish before', hoursEnd),
    field('Session length', session),
    button('Save study hours', 'submit'),
  );
  hours.append(hoursForm);
  controls.append(hours);

  const reminder = button('Enable due-soon reminders');
  const reminderStatus = el(
    'p',
    'Reminders can appear an hour before a deadline while this tab is visible.',
    'field-hint',
  );
  controls.append(reminder, reminderStatus);
  shell.append(schedule, controls, status);
  container.replaceChildren(shell);

  let timer;
  let importGeneration = 0;
  let destroyed = false;
  let assignmentSnapshot = [];
  function save() {
    try {
      localStorage.setItem(STORAGE, JSON.stringify(state));
      return true;
    } catch {
      status.textContent =
        'These settings are available in this tab only because browser storage is unavailable.';
      return false;
    }
  }

  function renderCalendar() {
    clearCalendar.hidden = !state.calendar;
    if (!state.calendar) {
      calendarStatus.textContent =
        'Imports stay in this browser. Add another export when your schedule changes.';
      return;
    }
    const { busy, until, skipped } = state.calendar;
    const count = busy.filter((block) => block[1] > Date.now()).length;
    const coverage =
      until <= Date.now()
        ? 'Calendar coverage expired. Import a fresh calendar.'
        : `${count} busy ${count === 1 ? 'block' : 'blocks'} through ${dateTime(until)}.`;
    calendarStatus.textContent = skipped
      ? `${coverage} ${skipped} unsupported calendar entries or rules. Check for missing busy times.`
      : coverage;
  }

  function renderBlocks() {
    busyList.replaceChildren();
    for (const [index, block] of state.blocks.entries()) {
      const row = el('li', undefined, 'planner-row');
      const remove = button('Remove');
      remove.setAttribute('aria-label', `Remove ${block.label}`);
      remove.addEventListener('click', () => {
        state.blocks.splice(index, 1);
        save();
        render();
      });
      row.append(
        el('strong', block.label),
        el(
          'span',
          block.type === 'weekly'
            ? `${WEEKDAYS[block.day]} ${clockText(block.start)}–${clockText(block.end)} weekly`
            : `${dateTime(block.start)}–${timeOnly(block.end)}`,
        ),
        remove,
      );
      busyList.append(row);
    }
  }

  function scheduleReminder() {
    clearTimeout(timer);
    if (
      destroyed ||
      !state.notifications ||
      document.hidden ||
      !('Notification' in window) ||
      Notification.permission !== 'granted'
    )
      return;
    const now = Date.now();
    let next = Infinity;
    for (const { assignment, deadline } of eligible(assignmentSnapshot, now)) {
      const key = `${assignment.courseId}:${assignment.id}:${deadline}`;
      if (state.reminded[key]) continue;
      const trigger = deadline - 60 * MINUTE;
      if (trigger > now) {
        next = Math.min(next, trigger);
        continue;
      }
      try {
        const minutes = Math.max(1, Math.ceil((deadline - now) / MINUTE));
        new Notification('A Canvas deadline is coming up', {
          body: `Due in ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}. Open Roger for details.`,
          tag: key,
        });
        state.reminded[key] = deadline;
        state.reminded = Object.fromEntries(
          Object.entries(state.reminded)
            .filter(([, time]) => time > now - 2 * DAY)
            .slice(-100),
        );
        save();
      } catch {
        state.notifications = false;
        reminder.textContent = 'Enable due-soon reminders';
        reminderStatus.textContent = 'Desktop reminders are unavailable in this browser.';
        save();
        return;
      }
    }
    if (Number.isFinite(next))
      timer = setTimeout(scheduleReminder, Math.min(next - now, 2_147_483_647));
  }

  function refresh() {
    if (destroyed) return;
    const current = getAssignments();
    assignmentSnapshot = Array.isArray(current) ? current : [];
    scheduleReminder();
  }

  function render() {
    if (destroyed) return;
    refresh();
    const slots = planHomework(assignmentSnapshot, state);
    suggestions.replaceChildren();
    if (!slots.length)
      suggestions.append(el('li', 'No Canvas deadlines in the next two weeks.', 'muted'));
    for (const { assignment, deadline, start, end } of slots) {
      const row = el('li', undefined, 'planner-row');
      const heading = el('div', undefined, 'planner-row-heading');
      heading.append(el('strong', assignment.name));
      if (onOpenAssignment) {
        const open = button('Open assignment');
        open.setAttribute('aria-label', `Open ${assignment.name}`);
        open.addEventListener('click', () => onOpenAssignment(assignment.courseId, assignment.id));
        heading.append(open);
      }
      row.append(heading);
      if (assignment.course?.name) row.append(el('span', assignment.course.name, 'muted'));
      row.append(
        el('span', `Canvas due ${dateTime(deadline)}`, 'planner-deadline'),
        el(
          'span',
          start === null
            ? 'No session fits before this deadline in the next 14 days.'
            : `Suggested ${dateTime(start)}–${timeOnly(end)}`,
          'planner-slot',
        ),
      );
      suggestions.append(row);
    }
    renderCalendar();
    renderBlocks();
    reminder.disabled = !('Notification' in window);
    reminder.textContent = state.notifications ? 'Turn off reminders' : 'Enable due-soon reminders';
    if (reminder.disabled)
      reminderStatus.textContent = 'Desktop reminders are unavailable in this browser.';
  }

  calendarInput.addEventListener('change', async () => {
    const file = calendarInput.files?.[0];
    const ownGeneration = ++importGeneration;
    calendarInput.value = '';
    if (!file) return;
    try {
      if (file.size > MAX_FILE) throw Error('Choose an ICS file under 1 MB.');
      const result = parseCalendar(await file.text());
      if (destroyed || ownGeneration !== importGeneration) return;
      state.calendar = result;
      if (save()) status.textContent = 'Calendar imported.';
      render();
    } catch (error) {
      if (!destroyed && ownGeneration === importGeneration)
        status.textContent = error.message || 'The calendar could not be imported.';
    }
  });
  clearCalendar.addEventListener('click', () => {
    importGeneration++;
    state.calendar = null;
    if (save()) status.textContent = 'Imported calendar removed.';
    render();
  });
  blockForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const repeats = frequency.value === 'weekly';
    const start = repeats ? toMinutes(weeklyStart.value) : Date.parse(onceStart.value);
    const end = repeats ? toMinutes(weeklyEnd.value) : Date.parse(onceEnd.value);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
      formStatus.textContent = 'Choose a valid start and a later end.';
      return;
    }
    if (state.blocks.length >= 60) {
      formStatus.textContent = 'Remove a busy block before adding another.';
      return;
    }
    state.blocks.push({
      type: repeats ? 'weekly' : 'once',
      label: name.value.trim() || 'Busy time',
      start,
      end,
      day: Number(weekday.value),
    });
    name.value = '';
    formStatus.textContent = 'Busy time added.';
    save();
    render();
  });
  hoursForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const start = toMinutes(hoursStart.value);
    const end = toMinutes(hoursEnd.value);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
      status.textContent = 'Choose a valid start time and a later finish time.';
      return;
    }
    Object.assign(state, { start, end, length: Number(session.value) });
    if (save()) status.textContent = 'Study hours saved.';
    render();
  });
  reminder.addEventListener('click', async () => {
    if (!('Notification' in window)) return;
    try {
      if (state.notifications) state.notifications = false;
      else state.notifications = (await Notification.requestPermission()) === 'granted';
      if (destroyed) return;
      const message = state.notifications
        ? 'Reminders enabled for this browser.'
        : 'Desktop reminders are off.';
      if (save()) status.textContent = message;
      render();
    } catch {
      status.textContent = 'Desktop reminders are unavailable in this browser.';
    }
  });
  document.addEventListener('visibilitychange', scheduleReminder);
  render();
  return {
    render,
    refresh,
    destroy() {
      destroyed = true;
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', scheduleReminder);
      shell.remove();
    },
  };
}
