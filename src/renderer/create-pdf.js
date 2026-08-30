// "Create PDF" tool — combine any mix of PDFs and images into one document.
// The list is reorderable (drag the row, or the ▲/▼ buttons); export writes
// the result via a save dialog and opens it in the viewer.

import { PDFDocument } from './vendor/pdf-lib.esm.js';

/* ------------------------------------------------------------------ *
 *  DOM                                                                *
 * ------------------------------------------------------------------ */

const modal = document.getElementById('create-pdf');
const listEl = document.getElementById('cp-list');
const statusEl = document.getElementById('cp-status');
const addBtn = document.getElementById('cp-add');
const clearBtn = document.getElementById('cp-clear');
const exportBtn = document.getElementById('cp-export');
const cancelBtn = document.getElementById('cp-cancel');
const closeBtn = document.getElementById('cp-close');

/* ------------------------------------------------------------------ *
 *  State                                                              *
 * ------------------------------------------------------------------ */

/** @type {{id:number, kind:'pdf'|'image', name:string, bytes:Uint8Array, pageCount?:number, mime?:string}[]} */
let items = [];
let nextId = 1;
let busy = false;

const IMG_EXT = /\.(png|jpe?g|webp|gif|bmp)$/i;
const PDF_EXT = /\.pdf$/i;
const EXT_MIME = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  webp: 'image/webp', gif: 'image/gif', bmp: 'image/bmp',
};

/* ------------------------------------------------------------------ *
 *  Open / close                                                       *
 * ------------------------------------------------------------------ */

export function openModal() {
  modal.classList.add('open');
  modal.setAttribute('aria-hidden', 'false');
  addBtn.focus();
}

function closeModal() {
  if (busy) return;
  modal.classList.remove('open');
  modal.setAttribute('aria-hidden', 'true');
  items = [];
  render();
  setStatus('');
}

closeBtn.addEventListener('click', closeModal);
cancelBtn.addEventListener('click', closeModal);
modal.addEventListener('mousedown', (e) => {
  if (e.target === modal) closeModal();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && modal.classList.contains('open')) closeModal();
});

/* ------------------------------------------------------------------ *
 *  Adding files                                                       *
 * ------------------------------------------------------------------ */

addBtn.addEventListener('click', async () => {
  const paths = await window.api.pickBuildInputs();
  if (!paths || !paths.length) return;
  setStatus('Reading files…');
  for (const p of paths) {
    const res = await window.api.readBytes(p);
    if (res && res.error) {
      setStatus(`Could not read ${p}: ${res.error}`, true);
      continue;
    }
    await addEntry(res.name, res.data);
  }
  setStatus('');
});

clearBtn.addEventListener('click', () => {
  if (busy) return;
  items = [];
  render();
});

// Classify + load metadata, then push onto the list.
async function addEntry(name, bytes) {
  const kind = detectKind(name, bytes);
  if (!kind) {
    setStatus(`Skipped ${name} — not a PDF or supported image.`, true);
    return;
  }
  const entry = { id: nextId++, kind, name, bytes };
  if (kind === 'pdf') {
    try {
      const doc = await PDFDocument.load(bytes, { ignoreEncryption: true });
      entry.pageCount = doc.getPageCount();
    } catch (err) {
      setStatus(`Skipped ${name} — ${err.message}`, true);
      return;
    }
  } else {
    entry.mime = mimeFor(name, bytes);
  }
  items.push(entry);
  render();
}

function detectKind(name, bytes) {
  if (PDF_EXT.test(name)) return 'pdf';
  if (IMG_EXT.test(name)) return 'image';
  // Fall back to magic bytes for extensionless / mislabelled files.
  if (bytes.length >= 4) {
    if (bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46) return 'pdf';
    if (bytes[0] === 0x89 && bytes[1] === 0x50) return 'image'; // PNG
    if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'image'; // JPEG
    if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return 'image'; // GIF
    if (bytes[0] === 0x42 && bytes[1] === 0x4d) return 'image'; // BMP
    if (bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return 'image'; // WEBP
  }
  return null;
}

function mimeFor(name, bytes) {
  const m = name.toLowerCase().match(/\.([a-z0-9]+)$/);
  if (m && EXT_MIME[m[1]]) return EXT_MIME[m[1]];
  if (bytes[0] === 0x89 && bytes[1] === 0x50) return 'image/png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'image/jpeg';
  if (bytes[0] === 0x47 && bytes[1] === 0x49) return 'image/gif';
  if (bytes[0] === 0x42 && bytes[1] === 0x4d) return 'image/bmp';
  return 'image/webp';
}

/* ------------------------------------------------------------------ *
 *  Drag & drop onto the dialog                                        *
 * ------------------------------------------------------------------ */

['dragenter', 'dragover'].forEach((type) => {
  modal.addEventListener(type, (e) => {
    if (!e.dataTransfer || !Array.from(e.dataTransfer.types).includes('Files')) return;
    e.preventDefault();
    e.stopPropagation(); // keep the viewer's window-level drop handler out of it
    e.dataTransfer.dropEffect = 'copy';
    modal.classList.add('drag-over');
  });
});
['dragleave', 'dragend'].forEach((type) => {
  modal.addEventListener(type, (e) => {
    if (e.target === modal || type === 'dragend') modal.classList.remove('drag-over');
  });
});
modal.addEventListener('drop', async (e) => {
  if (!e.dataTransfer || !e.dataTransfer.files.length) return;
  e.preventDefault();
  e.stopPropagation();
  modal.classList.remove('drag-over');
  setStatus('Reading files…');
  for (const file of e.dataTransfer.files) {
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      await addEntry(file.name, bytes);
    } catch (err) {
      setStatus(`Could not read ${file.name}: ${err.message}`, true);
    }
  }
  setStatus('');
});

/* ------------------------------------------------------------------ *
 *  List rendering + reordering                                        *
 * ------------------------------------------------------------------ */

function render() {
  listEl.replaceChildren(...items.map((it, i) => row(it, i)));
  const has = items.length > 0;
  clearBtn.disabled = !has || busy;
  exportBtn.disabled = !has || busy;
}

function row(it, index) {
  const li = document.createElement('li');
  li.className = 'cp-row';
  li.draggable = !busy;
  li.dataset.id = String(it.id);

  const grip = document.createElement('span');
  grip.className = 'cp-grip';
  grip.textContent = '⠿';
  grip.setAttribute('aria-hidden', 'true');

  const badge = document.createElement('span');
  badge.className = `cp-badge ${it.kind === 'pdf' ? 'pdf' : 'img'}`;
  badge.textContent = it.kind === 'pdf' ? 'PDF' : 'IMG';

  const name = document.createElement('span');
  name.className = 'cp-name';
  name.textContent = it.name;
  name.title = it.name;

  const meta = document.createElement('span');
  meta.className = 'cp-meta';
  meta.textContent = it.kind === 'pdf'
    ? `${it.pageCount} ${it.pageCount === 1 ? 'page' : 'pages'}`
    : '1 page';

  const up = moveBtn('▲', 'Move up', index === 0, () => moveItem(index, index - 1));
  const down = moveBtn('▼', 'Move down', index === items.length - 1, () => moveItem(index, index + 1));

  const remove = document.createElement('button');
  remove.className = 'cp-remove';
  remove.type = 'button';
  remove.textContent = '✕';
  remove.title = 'Remove';
  remove.setAttribute('aria-label', `Remove ${it.name}`);
  remove.disabled = busy;
  remove.addEventListener('click', () => {
    items = items.filter((x) => x.id !== it.id);
    render();
  });

  li.append(grip, badge, name, meta, up, down, remove);
  wireDrag(li);
  return li;
}

function moveBtn(glyph, label, disabled, onClick) {
  const b = document.createElement('button');
  b.className = 'cp-move';
  b.type = 'button';
  b.textContent = glyph;
  b.title = label;
  b.setAttribute('aria-label', label);
  b.disabled = disabled || busy;
  b.addEventListener('click', onClick);
  return b;
}

function moveItem(from, to) {
  if (to < 0 || to >= items.length) return;
  const [moved] = items.splice(from, 1);
  items.splice(to, 0, moved);
  render();
}

let dragId = null;

function wireDrag(li) {
  li.addEventListener('dragstart', (e) => {
    dragId = Number(li.dataset.id);
    li.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    // Firefox needs data set for the drag to start; value is unused.
    e.dataTransfer.setData('text/plain', li.dataset.id);
  });
  li.addEventListener('dragend', () => {
    dragId = null;
    listEl.querySelectorAll('.cp-row').forEach((r) =>
      r.classList.remove('dragging', 'drop-before', 'drop-after'));
  });
  li.addEventListener('dragover', (e) => {
    if (dragId === null) return;
    e.preventDefault();
    e.stopPropagation();
    const after = e.clientY > li.getBoundingClientRect().top + li.offsetHeight / 2;
    li.classList.toggle('drop-after', after);
    li.classList.toggle('drop-before', !after);
  });
  li.addEventListener('dragleave', () => {
    li.classList.remove('drop-before', 'drop-after');
  });
  li.addEventListener('drop', (e) => {
    if (dragId === null) return;
    e.preventDefault();
    e.stopPropagation();
    const after = li.classList.contains('drop-after');
    const from = items.findIndex((x) => x.id === dragId);
    let to = items.findIndex((x) => x.id === Number(li.dataset.id));
    if (from < 0 || to < 0 || from === to) return;
    const [moved] = items.splice(from, 1);
    to = items.findIndex((x) => x.id === Number(li.dataset.id));
    items.splice(after ? to + 1 : to, 0, moved);
    render();
  });
}

/* ------------------------------------------------------------------ *
 *  Export                                                             *
 * ------------------------------------------------------------------ */

exportBtn.addEventListener('click', async () => {
  if (busy || !items.length) return;
  setBusy(true);
  setStatus('Building PDF…');
  try {
    const bytes = await buildPdf();
    setStatus('Saving…');
    const res = await window.api.saveBuiltPdf({ defaultName: 'Combined.pdf', data: bytes });
    if (res && res.error) {
      setStatus(`Save failed: ${res.error}`, true);
      setBusy(false);
      return;
    }
    setBusy(false);
    if (res && res.path) closeModal();
    else setStatus(''); // save cancelled — keep the list
  } catch (err) {
    setStatus(`Failed: ${err.message}`, true);
    setBusy(false);
  }
});

async function buildPdf() {
  const out = await PDFDocument.create();
  for (const it of items) {
    if (it.kind === 'pdf') {
      const src = await PDFDocument.load(it.bytes, { ignoreEncryption: true });
      const pages = await out.copyPages(src, src.getPageIndices());
      for (const p of pages) out.addPage(p);
    } else {
      const { bytes, mime } = await toEmbeddable(it.bytes, it.mime);
      const img = mime === 'image/png' ? await out.embedPng(bytes) : await out.embedJpg(bytes);
      const page = out.addPage([img.width, img.height]);
      page.drawImage(img, { x: 0, y: 0, width: img.width, height: img.height });
    }
  }
  if (out.getPageCount() === 0) throw new Error('nothing to export');
  return out.save();
}

// pdf-lib can embed only PNG and JPEG; re-encode anything else through a canvas.
async function toEmbeddable(bytes, mime) {
  if (mime === 'image/png' || mime === 'image/jpeg') return { bytes, mime };
  const blob = new Blob([bytes], { type: mime || 'application/octet-stream' });
  const bmp = await createImageBitmap(blob);
  const canvas = document.createElement('canvas');
  canvas.width = bmp.width;
  canvas.height = bmp.height;
  canvas.getContext('2d').drawImage(bmp, 0, 0);
  if (bmp.close) bmp.close();
  const outBlob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
  return { bytes: new Uint8Array(await outBlob.arrayBuffer()), mime: 'image/png' };
}

/* ------------------------------------------------------------------ *
 *  Helpers                                                            *
 * ------------------------------------------------------------------ */

function setStatus(text, isError = false) {
  statusEl.textContent = text;
  statusEl.classList.toggle('error', isError);
}

function setBusy(on) {
  busy = on;
  addBtn.disabled = on;
  cancelBtn.disabled = on;
  closeBtn.disabled = on;
  render();
}

/* ------------------------------------------------------------------ *
 *  Wiring                                                             *
 * ------------------------------------------------------------------ */

window.api.onCreatePdf(openModal);
document.getElementById('welcome-create')?.addEventListener('click', openModal);
