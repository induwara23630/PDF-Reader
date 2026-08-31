/* Tab strip for a shell window. Owns nothing about documents — main.js is the
   source of truth for the tab list and pushes it via `chrome:tabs`. This just
   renders it and turns clicks / drags into `tab:*` IPC messages.

   Drag model:
   - Drag a tab left/right within the strip -> reorder (committed on release).
   - Drag it down off the strip and release -> `tab:detach` with the screen
     point; main opens a new window there, or merges into whatever window's
     strip the cursor is over.
   While a drag is active main expands this view to cover the whole window so
   pointer events keep coming even once the cursor leaves the 36px strip. */

const stripEl = document.getElementById('tabstrip');
const newBtn = document.getElementById('tab-new');
const barEl = document.getElementById('bar');
const ghost = document.getElementById('drag-ghost');

const MOVE_THRESHOLD = 6; // px before a press becomes a drag
const TEAR_SLOP = 24; // px past the strip before a drag counts as "tearing out"

let tabs = []; // [{ id, title, active }]
let drag = null;

/* ------------------------------------------------------------------ theme */

function applyTheme(info) {
  document.documentElement.dataset.theme = info.shouldUseDarkColors ? 'dark' : 'light';
}
window.api.onThemeChanged(applyTheme);
window.api.getTheme().then(applyTheme);

/* ----------------------------------------------------------------- render */

function tabEl(id) {
  return stripEl.querySelector(`.tab[data-id="${CSS.escape(id)}"]`);
}

function render() {
  stripEl.textContent = '';
  for (const t of tabs) {
    const el = document.createElement('div');
    el.className = 'tab' + (t.active ? ' active' : '') + (t.sleeping ? ' sleeping' : '');
    el.dataset.id = t.id;
    if (t.sleeping) el.title = 'Sleeping — click to reload';
    el.setAttribute('role', 'tab');
    el.setAttribute('aria-selected', String(!!t.active));

    const title = document.createElement('span');
    title.className = 'tab-title';
    title.textContent = t.title || 'New Tab';
    title.title = t.title || 'New Tab';
    el.appendChild(title);

    const close = document.createElement('button');
    close.className = 'tab-close';
    close.type = 'button';
    close.setAttribute('aria-label', 'Close tab');
    close.innerHTML =
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" fill="none" stroke="currentColor" stroke-width="2"/></svg>';
    el.appendChild(close);

    stripEl.appendChild(el);
  }
}

window.api.onTabs((list) => {
  tabs = Array.isArray(list) ? list : [];
  if (!drag) render();
});

/* ----------------------------------------------------- click / close / new */

stripEl.addEventListener('click', (e) => {
  const el = e.target.closest('.tab');
  if (!el) return;
  if (e.target.closest('.tab-close')) {
    window.api.closeTab(el.dataset.id);
    return;
  }
  window.api.activateTab(el.dataset.id);
});

stripEl.addEventListener('auxclick', (e) => {
  if (e.button !== 1) return; // middle-click closes
  const el = e.target.closest('.tab');
  if (el) window.api.closeTab(el.dataset.id);
});

newBtn.addEventListener('click', () => window.api.newTab());

/* ------------------------------------------------------- drag: reorder/tear */

function barHeight() {
  return barEl.getBoundingClientRect().height || 36;
}

function domOrder() {
  return [...stripEl.querySelectorAll('.tab')].map((n) => n.dataset.id);
}

// Slot the dragged element between siblings based on the cursor x.
function reorderPreview(clientX) {
  const el = tabEl(drag.id);
  if (!el) return;
  const others = [...stripEl.querySelectorAll('.tab')].filter((n) => n !== el);
  let ref = null;
  for (const n of others) {
    const r = n.getBoundingClientRect();
    if (clientX < r.left + r.width / 2) {
      ref = n;
      break;
    }
  }
  if (ref) stripEl.insertBefore(el, ref);
  else stripEl.appendChild(el);
}

stripEl.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  const el = e.target.closest('.tab');
  if (!el || e.target.closest('.tab-close')) return;
  const rect = el.getBoundingClientRect();
  drag = {
    id: el.dataset.id,
    pointerId: e.pointerId,
    startX: e.clientX,
    startY: e.clientY,
    grabX: e.clientX - rect.left,
    grabY: e.clientY - rect.top,
    width: rect.width,
    started: false,
    tearing: false,
    lastScreen: { x: e.screenX, y: e.screenY },
  };
  // NB: don't setPointerCapture here — capturing on pointerdown makes the
  // follow-up `click` event target the strip instead of the tab, so a plain
  // click would never activate the tab. Capture only once a drag begins.
});

window.addEventListener('pointermove', (e) => {
  if (!drag || e.pointerId !== drag.pointerId) return;
  drag.lastScreen = { x: e.screenX, y: e.screenY };
  const dx = e.clientX - drag.startX;
  const dy = e.clientY - drag.startY;

  if (!drag.started) {
    if (Math.abs(dx) < MOVE_THRESHOLD && Math.abs(dy) < MOVE_THRESHOLD) return;
    drag.started = true;
    document.body.classList.add('dragging');
    try { stripEl.setPointerCapture(drag.pointerId); } catch { /* ignore */ }
    window.api.tabDragStart(); // main expands this view to the whole window
    const t = tabs.find((x) => x.id === drag.id);
    ghost.textContent = (t && t.title) || 'New Tab';
    ghost.style.width = drag.width + 'px';
    ghost.classList.add('visible');
    const el = tabEl(drag.id);
    if (el) el.classList.add('dragging');
  }

  ghost.style.transform = `translate(${e.clientX - drag.grabX}px, ${Math.max(2, e.clientY - drag.grabY)}px)`;

  const h = barHeight();
  const tearing = e.clientY > h + TEAR_SLOP || e.clientY < -TEAR_SLOP;
  drag.tearing = tearing;
  document.body.classList.toggle('tearing', tearing);
  if (!tearing) reorderPreview(e.clientX);
});

function finishDrag(e, { cancelled = false } = {}) {
  const d = drag;
  drag = null;
  try {
    stripEl.releasePointerCapture(d.pointerId);
  } catch {
    /* ignore */
  }
  ghost.classList.remove('visible');
  ghost.style.transform = '';
  document.body.classList.remove('tearing', 'dragging');
  const el = tabEl(d.id);
  if (el) el.classList.remove('dragging');

  if (!d.started) return; // a plain click — let the click handler deal with it

  if (cancelled) {
    // nothing committed
  } else if (d.tearing) {
    const pt = e ? { x: e.screenX, y: e.screenY } : d.lastScreen;
    window.api.detachTab(d.id, pt);
  } else {
    window.api.reorderTab(d.id, domOrder().indexOf(d.id));
  }
  window.api.tabDragEnd(); // main restores this view's bounds
  render(); // resync to the authoritative list
}

window.addEventListener('pointerup', (e) => {
  if (!drag || e.pointerId !== drag.pointerId) return;
  finishDrag(e);
});

window.addEventListener('pointercancel', (e) => {
  if (!drag || e.pointerId !== drag.pointerId) return;
  finishDrag(null, { cancelled: !drag.tearing });
});

// Cursor left the window while tearing and released out there — Chromium stops
// sending pointer events, so settle from the last point we saw.
window.addEventListener('blur', () => {
  if (drag && drag.started) finishDrag(null, { cancelled: !drag.tearing });
});
