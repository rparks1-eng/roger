import test from 'node:test';
import assert from 'node:assert/strict';
import {
  companionBounds,
  mountRogerWidget,
  moveCompanion,
  readCompanionPosition,
} from '../src/client/roger-widget.mjs';

function fixture(savedStorage) {
  class Element extends EventTarget {
    hidden = false;
    style = {
      setProperty: (name, value) => {
        this.style[name] = value;
      },
    };
    dataset = {};
    value = '';
    attributes = {};
    captured = new Set();
    classes = new Set();
    classList = {
      add: (name) => this.classes.add(name),
      remove: (name) => this.classes.delete(name),
      contains: (name) => this.classes.has(name),
    };
    setAttribute(name, value) {
      this.attributes[name] = value;
    }
    focus() {
      root.ownerDocument.activeElement = this;
    }
    setPointerCapture(id) {
      this.captured.add(id);
    }
    hasPointerCapture(id) {
      return this.captured.has(id);
    }
    releasePointerCapture(id) {
      this.captured.delete(id);
    }
    getBoundingClientRect() {
      return {
        width: this.classes.has('is-open') ? 380 : 48,
        height: this.classes.has('is-open') ? 90 : 48,
      };
    }
    emit(type, values = {}) {
      const event = new Event(type, { cancelable: true });
      Object.assign(event, values);
      this.dispatchEvent(event);
      return event;
    }
  }
  const root = new Element();
  const elements = Object.fromEntries(
    ['launch', 'composer', 'message', 'move', 'collapse'].map((name) => [name, new Element()]),
  );
  root.ownerDocument = { activeElement: null };
  root.contains = (element) => Object.values(elements).includes(element);
  elements.composer.contains = (element) =>
    Object.entries(elements).some(([name, item]) => name !== 'launch' && item === element);
  root.querySelector = (selector) => elements[selector.replace('#roger-', '')];
  const host = new Element();
  host.innerWidth = 1000;
  host.innerHeight = 800;
  const timers = new Map();
  let serial = 0;
  host.setTimeout = (callback) => {
    timers.set(++serial, callback);
    return serial;
  };
  host.clearTimeout = (id) => timers.delete(id);
  const values = new Map();
  const storage = savedStorage || {
    getItem: (key) => values.get(key),
    setItem: (key, value) => values.set(key, value),
  };
  let opened = 0;
  let closed = 0;
  const widget = mountRogerWidget({
    root,
    host,
    storage,
    onOpen: () => opened++,
    onClose: () => closed++,
  });
  return {
    root,
    elements,
    host,
    widget,
    storage,
    values,
    counts: () => ({ opened, closed }),
    flush: () => {
      const pending = [...timers.values()];
      timers.clear();
      for (const callback of pending) callback();
    },
    timers,
  };
}

test('invalid or inaccessible saved positions cannot move the companion offscreen', () => {
  for (const value of ['null', '{}', '{"x":3,"y":0.5}', '{"x":"0.5","y":0.5}', 'broken'])
    assert.deepEqual(readCompanionPosition({ getItem: () => value }), { x: 1, y: 1 });
  assert.deepEqual(
    readCompanionPosition({
      getItem() {
        throw new Error('blocked');
      },
    }),
    { x: 1, y: 1 },
  );
  assert.deepEqual(readCompanionPosition({ getItem: () => '{"x":0.1,"y":0.7}' }), {
    x: 0.1,
    y: 0.7,
  });
  assert.deepEqual(
    moveCompanion({ x: 0.5, y: 0.5 }, { x: -5000, y: 5000 }, { width: 390, height: 700 }),
    { x: 0, y: 1 },
  );
});

test('open and closed placement stay within phone and desktop viewports at every corner', () => {
  for (const viewport of [
    { width: 390, height: 700 },
    { width: 1400, height: 850 },
  ]) {
    for (const x of [0, 0.5, 1])
      for (const y of [0, 0.5, 1])
        for (const open of [false, true]) {
          const size = {
            width: open ? Math.min(380, viewport.width - 24) : 48,
            height: open ? 400 : 48,
          };
          const placed = companionBounds({ x, y }, viewport, size, open);
          assert.ok(placed.left >= 12 && placed.top >= 12);
          assert.ok(placed.left + size.width <= viewport.width - 12);
          assert.ok(placed.top + size.height <= viewport.height - 12);
        }
  }
});

test('fresh mount stays a paw; hover opens and leaving closes without stealing focus', () => {
  const f = fixture();
  assert.equal(f.elements.composer.hidden, true);
  f.elements.launch.emit('pointerenter', { pointerType: 'mouse' });
  assert.equal(f.elements.composer.hidden, true);
  f.flush();
  assert.equal(f.elements.composer.hidden, false);
  f.root.emit('pointerleave');
  f.flush();
  assert.equal(f.elements.composer.hidden, true);
  assert.equal(f.root.ownerDocument.activeElement, null);
  assert.deepEqual(f.counts(), { opened: 1, closed: 1 });
});

test('dragging cancels hover, persists position and suppresses the trailing click', () => {
  const f = fixture();
  f.elements.launch.emit('pointerenter', { pointerType: 'mouse' });
  f.elements.launch.emit('pointerdown', { button: 0, pointerId: 1, clientX: 950, clientY: 750 });
  f.flush();
  assert.equal(f.elements.composer.hidden, true);
  f.elements.launch.emit('pointermove', { pointerId: 1, clientX: 650, clientY: 450 });
  f.elements.launch.emit('pointerup', { pointerId: 1 });
  f.elements.launch.emit('click');
  assert.equal(f.elements.composer.hidden, true);
  assert.equal(f.values.size, 1);
  const saved = readCompanionPosition(f.storage);
  assert.ok(saved.x < 1 && saved.y < 1);
  const fresh = fixture(f.storage);
  assert.equal(fresh.root.style.left, f.root.style.left);
  assert.equal(fresh.root.style.top, f.root.style.top);
  assert.equal(fresh.elements.composer.hidden, true);
  assert.equal(f.root.classList.contains('is-dragging'), false);
  assert.equal(f.elements.launch.captured.size, 0);
});

test('cancelled drag restores position; keyboard movement persists and Escape closes', () => {
  const f = fixture();
  const initial = f.root.style.left;
  f.elements.launch.emit('pointerdown', { button: 0, pointerId: 3, clientX: 950, clientY: 750 });
  f.elements.launch.emit('pointermove', { pointerId: 3, clientX: 200, clientY: 200 });
  f.elements.launch.emit('pointercancel', { pointerId: 3 });
  assert.equal(f.root.style.left, initial);
  assert.equal(f.values.size, 0);
  f.elements.launch.emit('keydown', { key: 'ArrowLeft', shiftKey: true });
  assert.notEqual(f.root.style.left, initial);
  assert.equal(f.values.size, 1);
  const clean = fixture();
  clean.elements.launch.emit('click');
  assert.equal(clean.root.ownerDocument.activeElement, clean.elements.message);
  clean.root.emit('keydown', { key: 'Escape' });
  assert.equal(clean.elements.composer.hidden, true);
  assert.equal(clean.root.ownerDocument.activeElement, clean.elements.launch);
});

test('destroy removes listeners and pending hover work', () => {
  const f = fixture();
  f.elements.launch.emit('pointerenter', { pointerType: 'mouse' });
  f.widget.destroy();
  f.flush();
  f.elements.launch.emit('click');
  assert.equal(f.elements.composer.hidden, true);
  assert.deepEqual(f.counts(), { opened: 0, closed: 0 });
});
