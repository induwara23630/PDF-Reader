import * as pdfjsLib from './vendor/pdf.mjs';
import { annotations } from './annotations/index.js';
import { exportDialog } from './export/index.js';
import { organizePages } from './organize-pages.js';
import { openModal as openCreatePdf } from './create-pdf.js';

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('./vendor/pdf.worker.mjs', import.meta.url).href;

const CMAP_URL = new URL('./vendor/cmaps/', import.meta.url).href;
const STANDARD_FONTS_URL = new URL('./vendor/standard_fonts/', import.meta.url).href;

/* ------------------------------------------------------------------ *
 *  Constants                                                          *
 * ------------------------------------------------------------------ */

const ZOOM_LEVELS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5];
const MIN_SCALE = 0.1;
const MAX_SCALE = 8;
const PAGE_PAD_Y = 20; // must match #pages padding-top in styles.css
const RENDER_BUFFER = 2; // pages above/below the viewport kept rendered
const DPR = Math.min(window.devicePixelRatio || 1, 2);

/* ------------------------------------------------------------------ *
 *  DOM refs                                                           *
 * ------------------------------------------------------------------ */

const app = document.getElementById('app');
const viewerEl = document.getElementById('viewer');
const pagesEl = document.getElementById('pages');
const sidebarEl = document.getElementById('sidebar');
const thumbsEl = document.getElementById('thumbs');
const recentListEl = document.getElementById('recent-list');
const docTitleEl = document.getElementById('doc-title');

const pageInput = document.getElementById('page-input');
const pageCountEl = document.getElementById('page-count');
const zoomInput = document.getElementById('zoom-input');

const btn = {
  sidebar: document.getElementById('btn-sidebar'),
  open: document.getElementById('btn-open'),
  prev: document.getElementById('btn-prev'),
  next: document.getElementById('btn-next'),
  zoomIn: document.getElementById('btn-zoom-in'),
  zoomOut: document.getElementById('btn-zoom-out'),
  fitWidth: document.getElementById('btn-fit-width'),
  fitPage: document.getElementById('btn-fit-page'),
  welcomeOpen: document.getElementById('welcome-open'),
  modeEdit: document.getElementById('mode-edit'),
  modeCreate: document.getElementById('mode-create'),
  modeOrganize: document.getElementById('mode-organize'),
  modeExport: document.getElementById('mode-export'),
};

/* ------------------------------------------------------------------ *
 *  State                                                              *
 * ------------------------------------------------------------------ */

/** @type {import('./vendor/pdf.mjs').PDFDocumentProxy | null} */
let pdfDoc = null;
let numPages = 0;
let baseViewports = []; // [n-1] -> { width, height } at scale 1
let scale = 1;
let fitMode = null; // null | 'width' | 'page'
let currentPage = 1;
let currentPath = null; // absolute path of the open document, for annotations
let editMode = false; // "Edit PDF" mode toolbar toggle — gates the annotation toolbar
let loadToken = 0; // bumped whenever the open document changes; guards async races

const pageDivs = []; // [n-1] -> HTMLElement (.page)
const pageState = []; // [n-1] -> { rendered, renderTask, canvas }
const thumbDivs = [];
const thumbState = []; // [n-1] -> { rendered, renderTask }

let thumbObserver = null;

/* ------------------------------------------------------------------ *
 *  Utilities                                                          *
 * ------------------------------------------------------------------ */

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

function availableWidth() {
  return viewerEl.clientWidth - 32 - 6; // minus #pages horizontal padding + fudge
}

function availableHeight() {
  return viewerEl.clientHeight - PAGE_PAD_Y * 2;
}

function setControlsEnabled(on) {
  [btn.prev, btn.next, btn.zoomIn, btn.zoomOut, btn.fitWidth, btn.fitPage, pageInput, zoomInput,
    btn.modeEdit, btn.modeOrganize, btn.modeExport]
    .forEach((el) => (el.disabled = !on));
  if (!on) setEditMode(false); // no document left to edit
}

/* ------------------------------------------------------------------ *
 *  Document loading                                                   *
 * ------------------------------------------------------------------ */

async function openPath(filePath) {
  const res = await window.api.readFile(filePath);
  if (!res || res.error) {
    alert(`Could not open file:\n${res ? res.error : 'unknown error'}`);
    return;
  }
  await loadDocument(res.data, res.name, res.path || filePath);
}

async function loadDocument(data, name, filePath) {
  await closeDocument();
  const token = ++loadToken;

  let doc;
  try {
    doc = await pdfjsLib.getDocument({
      data,
      cMapUrl: CMAP_URL,
      cMapPacked: true,
      standardFontDataUrl: STANDARD_FONTS_URL,
      isEvalSupported: false,
    }).promise;
  } catch (err) {
    if (token === loadToken) alert(`Failed to load PDF:\n${err && err.message}`);
    return;
  }
  if (token !== loadToken) {
    doc.destroy();
    return;
  }

  pdfDoc = doc;
  numPages = doc.numPages;
  currentPath = filePath || null;
  docTitleEl.textContent = name || '';
  document.title = name ? `${name} — Simple PDF Viewer` : 'Simple PDF Viewer';

  baseViewports = new Array(numPages);
  await fetchViewports(token);
  if (token !== loadToken) return;

  app.classList.remove('no-doc');
  setControlsEnabled(true);
  annotations.setEnabled(true);
  pageCountEl.textContent = String(numPages);

  currentPage = 1;
  fitMode = 'width';
  recomputeFitScale();

  buildPageContainers();
  buildThumbContainers();
  await annotations.setDocument(currentPath);
  if (token !== loadToken) return;
  updatePageUI();
  updateZoomUI();
  updateFitButtons();

  viewerEl.scrollTop = 0;
  refreshVisiblePages();
}

async function fetchViewports(token) {
  const CONCURRENCY = 12;
  let next = 1;
  const worker = async () => {
    while (next <= numPages && token === loadToken) {
      const n = next++;
      try {
        const page = await pdfDoc.getPage(n);
        const vp = page.getViewport({ scale: 1 });
        baseViewports[n - 1] = { width: vp.width, height: vp.height };
        page.cleanup();
      } catch {
        baseViewports[n - 1] = { width: 612, height: 792 }; // US Letter fallback
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, numPages || 1) }, worker)
  );
}

async function closeDocument() {
  loadToken++;
  await annotations.closeDocument();
  currentPath = null;
  if (thumbObserver) thumbObserver.disconnect();

  for (const st of pageState) {
    if (st && st.renderTask) try { st.renderTask.cancel(); } catch { /* noop */ }
    if (st && st.textLayer) try { st.textLayer.cancel(); } catch { /* noop */ }
  }
  for (const st of thumbState) {
    if (st && st.renderTask) try { st.renderTask.cancel(); } catch { /* noop */ }
  }

  pageDivs.length = 0;
  pageState.length = 0;
  thumbDivs.length = 0;
  thumbState.length = 0;
  pagesEl.innerHTML = '';
  thumbsEl.innerHTML = '';

  if (pdfDoc) try { await pdfDoc.destroy(); } catch { /* noop */ }
  pdfDoc = null;
  numPages = 0;
  baseViewports = [];

  app.classList.add('no-doc');
  setControlsEnabled(false);
  annotations.setEnabled(false);
  docTitleEl.textContent = '';
  document.title = 'Simple PDF Viewer';
  pageInput.value = '–';
  pageCountEl.textContent = '–';
  zoomInput.value = '–';
  updateFitButtons();
  refreshRecentList();
}

/* ------------------------------------------------------------------ *
 *  Layout                                                             *
 * ------------------------------------------------------------------ */

function pageCssSize(n) {
  const bv = baseViewports[n - 1] || { width: 612, height: 792 };
  return { w: bv.width * scale, h: bv.height * scale };
}

function buildPageContainers() {
  pagesEl.innerHTML = '';
  pageDivs.length = 0;
  pageState.length = 0;

  const frag = document.createDocumentFragment();
  for (let n = 1; n <= numPages; n++) {
    const div = document.createElement('div');
    div.className = 'page';
    div.dataset.page = String(n);
    const { w, h } = pageCssSize(n);
    div.style.width = `${Math.floor(w)}px`;
    div.style.height = `${Math.floor(h)}px`;
    div.appendChild(placeholder(n));
    frag.appendChild(div);
    pageDivs.push(div);
    pageState.push({ rendered: false, renderTask: null, canvas: null, textLayer: null });
  }
  pagesEl.appendChild(frag);
}

function placeholder(n) {
  const el = document.createElement('div');
  el.className = 'page-loading';
  el.textContent = `Page ${n}`;
  return el;
}

function relayoutPages() {
  for (let n = 1; n <= numPages; n++) {
    const { w, h } = pageCssSize(n);
    const div = pageDivs[n - 1];
    div.style.width = `${Math.floor(w)}px`;
    div.style.height = `${Math.floor(h)}px`;
    // The text layer positions its spans with calc(var(--scale-factor) * …),
    // so updating this keeps selectable text aligned during a zoom transient.
    div.style.setProperty('--scale-factor', String(scale));
    const st = pageState[n - 1];
    if (st.canvas) {
      st.canvas.style.width = `${Math.floor(w)}px`;
      st.canvas.style.height = `${Math.floor(h)}px`;
    }
  }
  annotations.reflow();
}

/* ------------------------------------------------------------------ *
 *  Page rendering (lazy window around the viewport)                   *
 * ------------------------------------------------------------------ */

function visiblePageRange() {
  const top = viewerEl.scrollTop;
  const bottom = top + viewerEl.clientHeight;
  let first = 1;
  let last = numPages;
  for (let i = 0; i < numPages; i++) {
    const div = pageDivs[i];
    if (div.offsetTop + div.offsetHeight >= top) {
      first = i + 1;
      break;
    }
  }
  for (let i = first - 1; i < numPages; i++) {
    if (pageDivs[i].offsetTop > bottom) {
      last = i; // previous page was the last one at least partly visible
      break;
    }
  }
  return [first, Math.max(first, last)];
}

function refreshVisiblePages() {
  if (!pdfDoc || !pageDivs.length) return;
  const [first, last] = visiblePageRange();
  const lo = Math.max(1, first - RENDER_BUFFER);
  const hi = Math.min(numPages, last + RENDER_BUFFER);
  for (let n = 1; n <= numPages; n++) {
    if (n >= lo && n <= hi) renderPage(n);
    else releasePage(n);
  }
}

async function renderPage(n) {
  const st = pageState[n - 1];
  if (!pdfDoc || !st || st.rendered || st.renderTask) return;

  const myToken = loadToken;
  let page;
  try {
    page = await pdfDoc.getPage(n);
  } catch {
    return;
  }
  if (myToken !== loadToken) return;

  const vp = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.floor(vp.width * DPR));
  canvas.height = Math.max(1, Math.floor(vp.height * DPR));
  canvas.style.width = `${Math.floor(vp.width)}px`;
  canvas.style.height = `${Math.floor(vp.height)}px`;

  const task = page.render({
    canvasContext: canvas.getContext('2d'),
    viewport: vp,
    transform: DPR !== 1 ? [DPR, 0, 0, DPR, 0, 0] : null,
  });
  st.renderTask = task;

  try {
    await task.promise;
    if (myToken !== loadToken) return;
    const div = pageDivs[n - 1];
    div.style.setProperty('--scale-factor', String(scale));
    div.replaceChildren(canvas);
    st.canvas = canvas;
    st.rendered = true;
    await renderTextLayer(n, page, vp, div, myToken);
    if (myToken === loadToken) annotations.mountLayer(n, div, baseViewports[n - 1] || { width: vp.width, height: vp.height });
  } catch (err) {
    if (err && err.name !== 'RenderingCancelledException') {
      console.warn(`render page ${n} failed:`, err);
    }
  } finally {
    if (st.renderTask === task) st.renderTask = null;
    page.cleanup();
  }
}

// A transparent, selectable text layer positioned over the page canvas.
async function renderTextLayer(n, page, viewport, pageDiv, token) {
  const st = pageState[n - 1];
  const tlDiv = document.createElement('div');
  tlDiv.className = 'textLayer';

  const tl = new pdfjsLib.TextLayer({
    textContentSource: page.streamTextContent({ includeMarkedContent: true }),
    container: tlDiv,
    viewport,
  });
  st.textLayer = tl;

  try {
    await tl.render();
  } catch {
    return; // cancelled or failed — the page stays canvas-only
  }
  if (token !== loadToken || st.textLayer !== tl || !pageDiv.isConnected) {
    tl.cancel();
    return;
  }
  const eoc = document.createElement('div');
  eoc.className = 'endOfContent';
  tlDiv.appendChild(eoc);
  tlDiv.addEventListener('pointerdown', (e) => {
    if (e.button === 0) tlDiv.classList.add('selecting');
  });
  // A secondary-button press must not move the caret / drop an existing
  // selection before our context menu opens.
  tlDiv.addEventListener('mousedown', (e) => {
    if (e.button === 2 && !window.getSelection().isCollapsed) e.preventDefault();
  });
  tlDiv.addEventListener('contextmenu', onTextLayerContextMenu);
  pageDiv.appendChild(tlDiv);
}

function releasePage(n) {
  const st = pageState[n - 1];
  if (!st) return;
  annotations.unmountLayer(n);
  if (st.renderTask) {
    try { st.renderTask.cancel(); } catch { /* noop */ }
    st.renderTask = null;
  }
  if (st.textLayer) {
    try { st.textLayer.cancel(); } catch { /* noop */ }
    st.textLayer = null;
  }
  if (st.rendered || st.canvas) {
    pageDivs[n - 1].replaceChildren(placeholder(n));
    st.canvas = null;
    st.rendered = false;
  }
}

function rerenderVisible() {
  for (let n = 1; n <= numPages; n++) {
    const st = pageState[n - 1];
    if (st && (st.rendered || st.renderTask)) releasePage(n);
  }
  refreshVisiblePages();
}

/* ------------------------------------------------------------------ *
 *  Thumbnails                                                         *
 * ------------------------------------------------------------------ */

function buildThumbContainers() {
  thumbsEl.innerHTML = '';
  thumbDivs.length = 0;
  thumbState.length = 0;

  const frag = document.createDocumentFragment();
  for (let n = 1; n <= numPages; n++) {
    const bv = baseViewports[n - 1] || { width: 612, height: 792 };
    const wrap = document.createElement('div');
    wrap.className = 'thumb';
    wrap.dataset.page = String(n);

    const frame = document.createElement('div');
    frame.className = 'thumb-frame';
    const ph = document.createElement('div');
    ph.className = 'thumb-placeholder';
    ph.style.aspectRatio = `${bv.width} / ${bv.height}`;
    frame.appendChild(ph);

    const label = document.createElement('div');
    label.className = 'thumb-label';
    label.textContent = String(n);

    wrap.append(frame, label);
    wrap.addEventListener('click', () => goToPage(n));

    frag.appendChild(wrap);
    thumbDivs.push(wrap);
    thumbState.push({ rendered: false, renderTask: null });
  }
  thumbsEl.appendChild(frag);

  thumbObserver = new IntersectionObserver(
    (entries) => {
      for (const e of entries) if (e.isIntersecting) renderThumb(Number(e.target.dataset.page));
    },
    { root: sidebarEl, rootMargin: '300px 0px' }
  );
  thumbDivs.forEach((d) => thumbObserver.observe(d));
  syncActiveThumb();
}

async function renderThumb(n) {
  const st = thumbState[n - 1];
  if (!pdfDoc || !st || st.rendered || st.renderTask) return;
  const myToken = loadToken;

  let page;
  try {
    page = await pdfDoc.getPage(n);
  } catch {
    return;
  }
  if (myToken !== loadToken) return;

  const frame = thumbDivs[n - 1].querySelector('.thumb-frame');
  const targetW = frame.clientWidth || 150;
  const base = page.getViewport({ scale: 1 });
  const vp = page.getViewport({ scale: (targetW * DPR) / base.width });

  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.floor(vp.width));
  canvas.height = Math.max(1, Math.floor(vp.height));

  const task = page.render({ canvasContext: canvas.getContext('2d'), viewport: vp });
  st.renderTask = task;
  try {
    await task.promise;
    if (myToken !== loadToken) return;
    frame.replaceChildren(canvas);
    st.rendered = true;
  } catch (err) {
    if (err && err.name !== 'RenderingCancelledException') {
      console.warn(`thumb ${n} failed:`, err);
    }
  } finally {
    if (st.renderTask === task) st.renderTask = null;
    page.cleanup();
  }
}

function syncActiveThumb() {
  thumbDivs.forEach((d, i) => d.classList.toggle('active', i + 1 === currentPage));
}

function ensureThumbVisible(n) {
  const el = thumbDivs[n - 1];
  if (!el || app.classList.contains('sidebar-hidden')) return;
  const top = el.offsetTop;
  const bottom = top + el.offsetHeight;
  if (top < sidebarEl.scrollTop || bottom > sidebarEl.scrollTop + sidebarEl.clientHeight) {
    sidebarEl.scrollTop = top - sidebarEl.clientHeight / 2 + el.offsetHeight / 2;
  }
}

/* ------------------------------------------------------------------ *
 *  Navigation                                                         *
 * ------------------------------------------------------------------ */

const pageTop = (n) => pageDivs[n - 1].offsetTop;

function goToPage(n) {
  n = clamp(Math.round(n), 1, numPages);
  if (!pageDivs[n - 1]) return;
  viewerEl.scrollTop = clamp(pageTop(n) - PAGE_PAD_Y, 0, viewerEl.scrollHeight);
  setCurrentPage(n);
}

function setCurrentPage(n) {
  if (n === currentPage) return;
  currentPage = n;
  updatePageUI();
  syncActiveThumb();
  ensureThumbVisible(n);
  if (fitMode === 'page') applyFit(); // page-fit depends on this page's aspect ratio
}

function updatePageUI() {
  if (document.activeElement !== pageInput) pageInput.value = String(currentPage);
  btn.prev.disabled = !pdfDoc || currentPage <= 1;
  btn.next.disabled = !pdfDoc || currentPage >= numPages;
}

function currentPageFromScroll() {
  const mid = viewerEl.scrollTop + viewerEl.clientHeight / 2;
  let n = 1;
  for (let i = 0; i < numPages; i++) {
    if (pageDivs[i].offsetTop <= mid) n = i + 1;
    else break;
  }
  return n;
}

/* ------------------------------------------------------------------ *
 *  Zoom & fit                                                         *
 * ------------------------------------------------------------------ */

function currentScrollAnchor() {
  const n = currentPage;
  const top = pageTop(n) - PAGE_PAD_Y;
  const h = pageDivs[n - 1].offsetHeight || 1;
  return { n, within: (viewerEl.scrollTop - top) / h };
}

function restoreScrollAnchor(anchor) {
  const top = pageTop(anchor.n) - PAGE_PAD_Y;
  const h = pageDivs[anchor.n - 1].offsetHeight || 1;
  viewerEl.scrollTop = clamp(top + anchor.within * h, 0, viewerEl.scrollHeight);
}

function applyScale(newScale, cursor) {
  newScale = clamp(newScale, MIN_SCALE, MAX_SCALE);
  if (cursor) {
    const factor = newScale / scale;
    const cursorOffset = cursor.clientY - viewerEl.getBoundingClientRect().top;
    const contentY = viewerEl.scrollTop + cursorOffset;
    scale = newScale;
    relayoutPages();
    viewerEl.scrollTop = clamp(contentY * factor - cursorOffset, 0, viewerEl.scrollHeight);
  } else {
    const anchor = currentScrollAnchor();
    scale = newScale;
    relayoutPages();
    restoreScrollAnchor(anchor);
  }
  updateZoomUI();
  rerenderVisible();
}

function setZoom(target, cursor) {
  if (!pdfDoc) return;
  fitMode = null;
  updateFitButtons();
  if (target === 'in') {
    applyScale(ZOOM_LEVELS.find((z) => z > scale + 1e-4) ?? MAX_SCALE, cursor);
  } else if (target === 'out') {
    applyScale([...ZOOM_LEVELS].reverse().find((z) => z < scale - 1e-4) ?? MIN_SCALE, cursor);
  } else if (target === 'actual') {
    applyScale(1, cursor);
  } else if (typeof target === 'number') {
    applyScale(target, cursor);
  }
}

function recomputeFitScale() {
  if (!fitMode || !pdfDoc) return;
  const bv = baseViewports[currentPage - 1] || { width: 612, height: 792 };
  if (fitMode === 'width') {
    scale = clamp(availableWidth() / bv.width, MIN_SCALE, MAX_SCALE);
  } else {
    scale = clamp(
      Math.min(availableWidth() / bv.width, availableHeight() / bv.height),
      MIN_SCALE,
      MAX_SCALE
    );
  }
}

function applyFit() {
  const anchor = currentScrollAnchor();
  const prev = scale;
  recomputeFitScale();
  if (Math.abs(scale - prev) < 1e-3) {
    refreshVisiblePages();
    return;
  }
  relayoutPages();
  restoreScrollAnchor(anchor);
  updateZoomUI();
  rerenderVisible();
}

function setFit(mode) {
  if (!pdfDoc) return;
  fitMode = mode;
  updateFitButtons();
  applyFit();
}

function updateFitButtons() {
  btn.fitWidth.classList.toggle('active', fitMode === 'width');
  btn.fitPage.classList.toggle('active', fitMode === 'page');
}

function updateZoomUI() {
  if (document.activeElement !== zoomInput) zoomInput.value = `${Math.round(scale * 100)}%`;
}

/* ------------------------------------------------------------------ *
 *  Recent files (welcome screen)                                      *
 * ------------------------------------------------------------------ */

async function refreshRecentList() {
  const recents = await window.api.getRecents();
  recentListEl.replaceChildren();
  for (const p of recents) {
    const item = document.createElement('div');
    item.className = 'recent-item';
    const nameEl = document.createElement('span');
    nameEl.className = 'r-name';
    nameEl.textContent = p.split(/[\\/]/).pop();
    const pathEl = document.createElement('span');
    pathEl.className = 'r-path';
    pathEl.textContent = p;
    item.append(nameEl, pathEl);
    item.addEventListener('click', () => openPath(p));
    recentListEl.appendChild(item);
  }
}

/* ------------------------------------------------------------------ *
 *  Events — toolbar                                                   *
 * ------------------------------------------------------------------ */

btn.open.addEventListener('click', () => window.api.openDialog());
btn.welcomeOpen.addEventListener('click', () => window.api.openDialog());
btn.sidebar.addEventListener('click', toggleSidebar);
btn.prev.addEventListener('click', () => goToPage(currentPage - 1));
btn.next.addEventListener('click', () => goToPage(currentPage + 1));
btn.zoomIn.addEventListener('click', () => setZoom('in'));
btn.zoomOut.addEventListener('click', () => setZoom('out'));
btn.fitWidth.addEventListener('click', () => setFit('width'));
btn.fitPage.addEventListener('click', () => setFit('page'));

pageInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    const v = parseInt(pageInput.value, 10);
    if (Number.isFinite(v)) goToPage(v);
    pageInput.blur();
  } else if (e.key === 'Escape') {
    pageInput.value = String(currentPage);
    pageInput.blur();
  }
});
pageInput.addEventListener('blur', () => (pageInput.value = String(currentPage)));

zoomInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    const v = parseFloat(zoomInput.value.replace('%', '').trim());
    if (Number.isFinite(v) && v > 0) setZoom(v / 100);
    zoomInput.blur();
  } else if (e.key === 'Escape') {
    updateZoomUI();
    zoomInput.blur();
  }
});
zoomInput.addEventListener('blur', updateZoomUI);

function toggleSidebar() {
  app.classList.toggle('sidebar-hidden');
  if (!app.classList.contains('sidebar-hidden')) ensureThumbVisible(currentPage);
}

/* ------------------------------------------------------------------ *
 *  Events — viewer interaction                                        *
 * ------------------------------------------------------------------ */

viewerEl.addEventListener(
  'wheel',
  (e) => {
    if (!pdfDoc || !(e.ctrlKey || e.metaKey)) return;
    e.preventDefault();
    const step = e.deltaY < 0 ? 1.1 : 1 / 1.1;
    setZoom(scale * step, { clientY: e.clientY });
  },
  { passive: false }
);

let scrollRaf = 0;
viewerEl.addEventListener('scroll', () => {
  if (scrollRaf) return;
  scrollRaf = requestAnimationFrame(() => {
    scrollRaf = 0;
    if (!pdfDoc) return;
    refreshVisiblePages();
    setCurrentPage(currentPageFromScroll());
  });
});

window.addEventListener('keydown', (e) => {
  if (!pdfDoc) return;
  const el = e.target;
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement ||
    (el instanceof HTMLElement && el.isContentEditable)) return;
  if (e.ctrlKey || e.metaKey) {
    if (e.key === '=' || e.key === '+') { e.preventDefault(); setZoom('in'); }
    else if (e.key === '-') { e.preventDefault(); setZoom('out'); }
    else if (e.key === '0') { e.preventDefault(); setZoom('actual'); }
    return;
  }
  // PageUp/PageDown/Space/arrows keep their native scroll behavior; only add
  // explicit page jumps that don't fight vertical scrolling.
  switch (e.key) {
    case 'ArrowLeft':
      e.preventDefault();
      goToPage(currentPage - 1);
      break;
    case 'ArrowRight':
      e.preventDefault();
      goToPage(currentPage + 1);
      break;
    case 'Home':
      e.preventDefault();
      goToPage(1);
      break;
    case 'End':
      e.preventDefault();
      goToPage(numPages);
      break;
  }
});

/* ------------------------------------------------------------------ *
 *  Drag & drop                                                        *
 * ------------------------------------------------------------------ */

let dragDepth = 0;
window.addEventListener('dragenter', (e) => {
  e.preventDefault();
  dragDepth++;
  app.classList.add('dragging');
});
window.addEventListener('dragover', (e) => {
  e.preventDefault();
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
});
window.addEventListener('dragleave', (e) => {
  e.preventDefault();
  if (--dragDepth <= 0) {
    dragDepth = 0;
    app.classList.remove('dragging');
  }
});
window.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  app.classList.remove('dragging');
  const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
  if (!file) return;
  if (!/\.pdf$/i.test(file.name)) {
    alert('Please drop a PDF file.');
    return;
  }
  const p = window.api.getPathForFile(file);
  if (p) openPath(p);
});

/* ------------------------------------------------------------------ *
 *  Window resize                                                      *
 * ------------------------------------------------------------------ */

// A ResizeObserver on the scroll area catches window resizes, the sidebar
// sliding in/out, and scrollbars appearing — anything that changes the space
// available to the pages — and re-fits. Coalesced to one pass per frame.
let resizeRaf = 0;
const viewerRO = new ResizeObserver(() => {
  if (resizeRaf) return;
  resizeRaf = requestAnimationFrame(() => {
    resizeRaf = 0;
    if (!pdfDoc) return;
    if (fitMode) applyFit();
    else refreshVisiblePages();
  });
});
viewerRO.observe(viewerEl);

/* ------------------------------------------------------------------ *
 *  Text selection — floating action bar                               *
 * ------------------------------------------------------------------ */

const selBar = document.getElementById('selection-bar');
const selCopyBtn = document.getElementById('sel-copy');
const selCopyLabel = selCopyBtn.querySelector('.sel-copy-label');
let selDebounce = 0;

function selectionInsideTextLayer() {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
  if (!sel.toString().trim()) return null;
  const focus = sel.focusNode;
  const el = focus && (focus.nodeType === 1 ? focus : focus.parentElement);
  if (!el || !el.closest || !el.closest('.textLayer')) return null;
  return sel;
}

function positionSelBar() {
  const sel = selectionInsideTextLayer();
  if (!sel) return hideSelBar();
  const rect = sel.getRangeAt(0).getBoundingClientRect();
  if (!rect || (rect.width === 0 && rect.height === 0)) return hideSelBar();
  // Keep it within the viewer's horizontal bounds and below the toolbar.
  const vr = viewerEl.getBoundingClientRect();
  const x = clamp(rect.left + rect.width / 2, vr.left + 80, vr.right - 80);
  const y = Math.max(rect.top, vr.top + 8);
  selBar.style.left = `${x}px`;
  selBar.style.top = `${y}px`;
  selBar.classList.add('visible');
  selBar.setAttribute('aria-hidden', 'false');
}

function hideSelBar() {
  if (!selBar.classList.contains('visible')) return;
  selBar.classList.remove('visible');
  selBar.setAttribute('aria-hidden', 'true');
  selCopyBtn.classList.remove('done');
  selCopyLabel.textContent = 'Copy';
}

document.addEventListener('selectionchange', () => {
  clearTimeout(selDebounce);
  selDebounce = setTimeout(positionSelBar, 100);
});

// While dragging a selection, `.selecting` lets the text layer capture the
// pointer past the last line (see .endOfContent in the CSS); clear it on release.
document.addEventListener('pointerup', () => {
  for (const el of document.querySelectorAll('.textLayer.selecting')) {
    el.classList.remove('selecting');
  }
});

// Reposition (not just hide) while scrolling so the bar tracks the selection.
viewerEl.addEventListener('scroll', () => {
  if (selBar.classList.contains('visible')) positionSelBar();
});

// Don't let interacting with the bar collapse the selection.
selBar.addEventListener('mousedown', (e) => e.preventDefault());

async function copySelection() {
  const sel = selectionInsideTextLayer();
  const text = sel ? sel.toString() : '';
  if (!text) return;
  let ok = false;
  try {
    await navigator.clipboard.writeText(text);
    ok = true;
  } catch {
    try { ok = document.execCommand('copy'); } catch { ok = false; }
  }
  selCopyLabel.textContent = ok ? 'Copied' : 'Press Ctrl+C';
  selCopyBtn.classList.toggle('done', ok);
  setTimeout(hideSelBar, ok ? 650 : 1200);
}

selCopyBtn.addEventListener('click', copySelection);

// Text-markup shortcuts on the floating selection bar.
for (const [id, type] of [
  ['sel-highlight', 'highlight'],
  ['sel-underline', 'underline'],
  ['sel-strike', 'strike'],
]) {
  const b = document.getElementById(id);
  if (b) b.addEventListener('click', () => {
    annotations.markupFromSelection(type);
    hideSelBar();
  });
}

// Native right-click menu over the text layer. Copy is enabled only when
// there is a live selection; the press handler above keeps that selection
// alive across the click.
function onTextLayerContextMenu(e) {
  e.preventDefault();
  const sel = selectionInsideTextLayer();
  window.api.showContextMenu({ hasSelection: !!sel });
  if (sel) positionSelBar();
}

// Explicit Ctrl/Cmd+C anywhere in the document copies the current selection
// (Chromium already does this by default; this also refreshes the bar state).
window.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && (e.key === 'c' || e.key === 'C')) {
    if (selectionInsideTextLayer()) {
      selCopyLabel.textContent = 'Copied';
      selCopyBtn.classList.add('done');
      setTimeout(hideSelBar, 650);
    }
  }
});

/* ------------------------------------------------------------------ *
 *  IPC wiring (menu + main-process events)                            *
 * ------------------------------------------------------------------ */

window.api.onFileOpen((filePath) => openPath(filePath));
window.api.onRecentsChanged(() => refreshRecentList());
window.api.onCloseDoc(() => closeDocument());
window.api.onZoom((dir) => setZoom(dir));
window.api.onFit((mode) => setFit(mode));
window.api.onToggleSidebar(() => toggleSidebar());

/* ------------------------------------------------------------------ *
 *  Init                                                               *
 * ------------------------------------------------------------------ */

app.classList.add('no-doc');
annotations.init({
  getScale: () => scale,
  getPageDivs: () => pageDivs,
  getBaseViewports: () => baseViewports,
});
annotations.setEnabled(false);
// After annotations.init(), which wires up tools.js's DOM refs — setEditMode
// (called by setControlsEnabled) reaches into those via exitEditMode().
setControlsEnabled(false);
window.api.onExportAnnotated(() => annotations.export());
window.api.onExportFlattened(() => annotations.export('flatten'));
window.api.onApplyAnnotationsToOriginal(() => annotations.applyToOriginal());

exportDialog.init({
  getPdfDoc: () => pdfDoc,
  getCurrentPath: () => currentPath,
  getNumPages: () => numPages,
  getCurrentPage: () => currentPage,
});
window.api.onExportDialog(() => exportDialog.open());

organizePages.init({
  getPdfDoc: () => pdfDoc,
  getCurrentPath: () => currentPath,
});
window.api.onOrganizePages(() => organizePages.open());

/* ------------------------------------------------------------------ *
 *  Mode toolbar — pick a tool, only that tool's UI appears            *
 * ------------------------------------------------------------------ */

function setEditMode(on) {
  editMode = on && !!pdfDoc;
  app.classList.toggle('edit-mode', editMode);
  btn.modeEdit.classList.toggle('active', editMode);
  btn.modeEdit.setAttribute('aria-pressed', String(editMode));
  if (!editMode) annotations.exitEditMode();
}

btn.modeEdit.addEventListener('click', () => setEditMode(!editMode));
btn.modeCreate.addEventListener('click', () => openCreatePdf());
btn.modeOrganize.addEventListener('click', () => organizePages.open());
btn.modeExport.addEventListener('click', () => exportDialog.open());

window.api.onEditModeToggle(() => setEditMode(!editMode));

refreshRecentList();
