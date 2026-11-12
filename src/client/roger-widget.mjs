const POSITION_KEY = 'roger.companion.position.v1';
const MARGIN = 12;
const PAW_SIZE = 48;

function bounded(value, minimum, maximum) {
  return Math.max(minimum, Math.min(value, Math.max(minimum, maximum)));
}

export function readCompanionPosition(storage) {
  try {
    const value = JSON.parse(storage?.getItem(POSITION_KEY) || 'null');
    if (
      value &&
      Number.isFinite(value.x) &&
      Number.isFinite(value.y) &&
      value.x >= 0 &&
      value.x <= 1 &&
      value.y >= 0 &&
      value.y <= 1
    )
      return { x: value.x, y: value.y };
  } catch {
    /* A blocked storage area must not prevent asking Roger. */
  }
  return { x: 1, y: 1 };
}

/** Anchor the composer to the paw, then keep its content inside the viewport. */
export function companionBounds(position, viewport, size, open = false) {
  const availableX = Math.max(0, viewport.width - MARGIN * 2 - PAW_SIZE);
  const availableY = Math.max(0, viewport.height - MARGIN * 2 - PAW_SIZE);
  const pawLeft = MARGIN + bounded(position.x, 0, 1) * availableX;
  const pawTop = MARGIN + bounded(position.y, 0, 1) * availableY;
  const width = Math.min(size.width, Math.max(PAW_SIZE, viewport.width - MARGIN * 2));
  const height = Math.min(size.height, Math.max(PAW_SIZE, viewport.height - MARGIN * 2));
  return {
    left: bounded(pawLeft + PAW_SIZE - width, MARGIN, viewport.width - width - MARGIN),
    top: bounded(
      pawTop + PAW_SIZE - height,
      open ? Math.min(74, Math.max(MARGIN, viewport.height - height - MARGIN)) : MARGIN,
      viewport.height - height - MARGIN,
    ),
  };
}

export function moveCompanion(position, delta, viewport) {
  return {
    x: bounded(position.x + delta.x / Math.max(1, viewport.width - MARGIN * 2 - PAW_SIZE), 0, 1),
    y: bounded(position.y + delta.y / Math.max(1, viewport.height - MARGIN * 2 - PAW_SIZE), 0, 1),
  };
}

/** Only presentation and movement live here. Requests and provider authority stay in app. */
export function mountRogerWidget({
  root,
  onOpen = () => {},
  onClose = () => {},
  storage,
  host = window,
}) {
  const launch = root.querySelector('#roger-launch');
  const composer = root.querySelector('#roger-composer');
  const input = root.querySelector('#roger-message');
  const grip = root.querySelector('#roger-move');
  const collapse = root.querySelector('#roger-collapse');
  try {
    storage ??= host.localStorage;
  } catch {
    /* Private browsing can disable storage. */
  }
  let position = readCompanionPosition(storage);
  let opened = false;
  let pinned = false;
  let hoverTimer;
  let leaveTimer;
  let closedAt = -Infinity;
  let drag;
  let suppressClickUntil = 0;
  const removers = [];
  const viewport = () => ({
    width: host.visualViewport?.width || host.innerWidth,
    height: host.visualViewport?.height || host.innerHeight,
  });
  const listen = (target, type, handler, options) => {
    target.addEventListener(type, handler, options);
    removers.push(() => target.removeEventListener(type, handler, options));
  };
  function place() {
    root.style.setProperty(
      '--roger-composer-max-height',
      `${Math.max(48, viewport().height - 90)}px`,
    );
    const rect = root.getBoundingClientRect();
    const next = companionBounds(
      position,
      viewport(),
      { width: rect.width, height: rect.height },
      opened,
    );
    root.style.left = `${next.left + (host.visualViewport?.offsetLeft || 0)}px`;
    root.style.top = `${next.top + (host.visualViewport?.offsetTop || 0)}px`;
    root.style.right = 'auto';
    root.style.bottom = 'auto';
  }
  function save() {
    try {
      storage?.setItem(POSITION_KEY, JSON.stringify(position));
    } catch {
      /* Movement still works. */
    }
  }
  function clearTimers() {
    host.clearTimeout(hoverTimer);
    host.clearTimeout(leaveTimer);
  }
  function open(focus = false) {
    if (drag || Date.now() < suppressClickUntil) return;
    clearTimers();
    pinned ||= focus;
    onOpen({ alreadyOpen: opened });
    opened = true;
    composer.hidden = false;
    root.classList.add('is-open');
    launch.setAttribute('aria-expanded', 'true');
    place();
    if (focus) input.focus();
  }
  function close({ focus = true } = {}) {
    clearTimers();
    closedAt = Date.now();
    if (opened) onClose();
    opened = false;
    pinned = false;
    root.classList.remove('is-open');
    composer.hidden = true;
    launch.setAttribute('aria-expanded', 'false');
    place();
    if (focus) launch.focus();
  }
  function startDrag(event) {
    if (event.button !== 0 || drag) return;
    clearTimers();
    drag = {
      id: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      origin: { ...position },
      moved: false,
      target: event.currentTarget,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  }
  function moveDrag(event) {
    if (!drag || drag.id !== event.pointerId) return;
    const delta = { x: event.clientX - drag.startX, y: event.clientY - drag.startY };
    if (!drag.moved && Math.hypot(delta.x, delta.y) < 6) return;
    drag.moved = true;
    root.classList.add('is-dragging');
    event.preventDefault();
    position = moveCompanion(drag.origin, delta, viewport());
    place();
  }
  function finishDrag(event, cancelled = false) {
    if (!drag || drag.id !== event.pointerId) return;
    const finished = drag;
    drag = null;
    root.classList.remove('is-dragging');
    if (finished.moved) {
      suppressClickUntil = Date.now() + 500;
      if (cancelled) position = finished.origin;
      else save();
      place();
    }
    if (finished.target.hasPointerCapture(event.pointerId))
      finished.target.releasePointerCapture(event.pointerId);
  }
  function keyboardMove(event) {
    const direction = {
      ArrowLeft: [-1, 0],
      ArrowRight: [1, 0],
      ArrowUp: [0, -1],
      ArrowDown: [0, 1],
    }[event.key];
    if (!direction) return;
    event.preventDefault();
    clearTimers();
    const distance = event.shiftKey ? 48 : 16;
    position = moveCompanion(
      position,
      { x: direction[0] * distance, y: direction[1] * distance },
      viewport(),
    );
    save();
    place();
  }
  for (const target of [launch, grip]) {
    listen(target, 'pointerdown', startDrag);
    listen(target, 'pointermove', moveDrag);
    listen(target, 'pointerup', (event) => finishDrag(event));
    listen(target, 'pointercancel', (event) => finishDrag(event, true));
    listen(target, 'lostpointercapture', (event) => finishDrag(event, true));
    listen(target, 'keydown', keyboardMove);
  }
  listen(launch, 'click', (event) => {
    if (Date.now() < suppressClickUntil) {
      event.preventDefault();
      return;
    }
    open(true);
  });
  listen(launch, 'pointerenter', (event) => {
    if (event.pointerType === 'mouse' && !drag && Date.now() - closedAt > 700)
      hoverTimer = host.setTimeout(() => open(), 220);
  });
  listen(launch, 'pointerleave', () => host.clearTimeout(hoverTimer));
  listen(root, 'pointerenter', () => host.clearTimeout(leaveTimer));
  listen(root, 'pointerleave', () => {
    if (!opened || pinned || drag) return;
    leaveTimer = host.setTimeout(() => {
      if (
        !composer.contains(root.ownerDocument.activeElement) &&
        !input.value.trim() &&
        !pinned &&
        root.dataset.state !== 'thinking'
      )
        close({ focus: false });
    }, 500);
  });
  listen(composer, 'focusin', () => {
    pinned = true;
  });
  listen(collapse, 'click', () => close());
  listen(root, 'keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
    }
  });
  listen(host, 'resize', place);
  if (host.visualViewport) {
    listen(host.visualViewport, 'resize', place);
    listen(host.visualViewport, 'scroll', place);
  }
  const observer = host.ResizeObserver ? new host.ResizeObserver(place) : null;
  observer?.observe(root);
  // Always begin as a paw, including a fresh visit with a remembered position.
  composer.hidden = true;
  root.classList.remove('is-open');
  launch.setAttribute('aria-expanded', 'false');
  place();
  return {
    open,
    close,
    destroy() {
      clearTimers();
      observer?.disconnect();
      for (const remove of removers) remove();
    },
  };
}
