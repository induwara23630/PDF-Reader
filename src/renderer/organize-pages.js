// "Organize Pages" dialog — reorder or remove pages in the currently open
// PDF, then save the result as a new file (same auto-open-on-save flow as
// the Create PDF tool: window.api.saveBuiltPdf both writes and reopens it).
//
// Thumbnails reuse the live pdf.js document already open in the viewer
// (deps.getPdfDoc()) — no extra parse. The actual rebuild, on Save, re-reads
// fresh bytes and uses pdf-lib's copyPages in the chosen order.

import { loadPdfLib } from './vendor-lazy.js';

const THUMB_WIDTH = 140; // CSS px, matches .op-thumb's rendered size closely enough

class OrganizePages {
  constructor() {
    this.deps = null; // { getPdfDoc, getCurrentPath }
    this.order = []; // 1-based original page numbers, current arrangement
    this.cells = new Map(); // page number -> built <div class="op-cell">
    this.busy = false;
    this.dragId = null;
    this.el = {};
  }

  init(deps) {
    this.deps = deps;
    this.el = {
      modal: document.getElementById('organize-pages'),
      close: document.getElementById('op-close'),
      cancel: document.getElementById('op-cancel'),
      apply: document.getElementById('op-apply'),
      status: document.getElementById('op-status'),
      grid: document.getElementById('op-grid'),
    };
    this.el.close.addEventListener('click', () => this.close());
    this.el.cancel.addEventListener('click', () => this.close());
    this.el.modal.addEventListener('mousedown', (e) => { if (e.target === this.el.modal) this.close(); });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.el.modal.classList.contains('open')) this.close();
    });
    this.el.apply.addEventListener('click', () => this.apply());

    // Modal-wide safety net: a real mouse drag constantly crosses grid gaps,
    // padding, and the modal chrome — not just cell boundaries — and every
    // one of those positions fires its own dragenter/dragover that bubbles
    // past a per-cell-only stopPropagation straight to viewer.js's
    // window-level "drop a PDF file to open" listeners. This catches all of
    // them for the whole modal, cells included, whenever a reorder drag is
    // actually in progress (this.dragId set).
    for (const type of ['dragenter', 'dragover', 'dragleave', 'drop']) {
      this.el.modal.addEventListener(type, (e) => {
        if (this.dragId === null) return;
        if (type !== 'dragleave') e.preventDefault();
        e.stopPropagation();
      });
    }
  }

  open() {
    const pdfDoc = this.deps.getPdfDoc();
    if (!pdfDoc) return; // nothing open — nothing to organize
    this.el.modal.classList.add('open');
    this.el.modal.setAttribute('aria-hidden', 'false');
    this.order = Array.from({ length: pdfDoc.numPages }, (_, i) => i + 1);
    this.cells.clear();
    this.setStatus('');
    this.layout();
  }

  close() {
    if (this.busy) return;
    this.el.modal.classList.remove('open');
    this.el.modal.setAttribute('aria-hidden', 'true');
    this.el.grid.innerHTML = '';
    this.cells.clear();
  }

  // Re-renders the grid from `this.order`, reusing already-built cells
  // (with their already-rendered thumbnail canvas) instead of rebuilding —
  // a drag-reorder or a remove shouldn't cost a re-render.
  layout() {
    const grid = this.el.grid;
    grid.replaceChildren();
    if (!this.order.length) {
      const empty = document.createElement('div');
      empty.className = 'op-empty';
      empty.textContent = 'No pages left — add at least one to save.';
      grid.appendChild(empty);
      this.el.apply.disabled = true;
      return;
    }
    this.el.apply.disabled = this.busy;
    const frag = document.createDocumentFragment();
    for (const pageNum of this.order) {
      let cell = this.cells.get(pageNum);
      if (!cell) {
        cell = this.buildCell(pageNum);
        this.cells.set(pageNum, cell);
      }
      frag.appendChild(cell);
    }
    grid.appendChild(frag);
  }

  buildCell(pageNum) {
    const cell = document.createElement('div');
    cell.className = 'op-cell';
    cell.draggable = !this.busy;
    cell.dataset.page = String(pageNum);

    const thumb = document.createElement('div');
    thumb.className = 'op-thumb';
    const canvas = document.createElement('canvas');
    thumb.appendChild(canvas);

    const num = document.createElement('div');
    num.className = 'op-num';
    num.textContent = `Page ${pageNum}`;

    const remove = document.createElement('button');
    remove.className = 'op-remove';
    remove.type = 'button';
    remove.textContent = '✕';
    remove.title = 'Remove this page';
    remove.setAttribute('aria-label', `Remove page ${pageNum}`);
    remove.addEventListener('click', (e) => {
      e.stopPropagation();
      if (this.busy) return;
      this.order = this.order.filter((n) => n !== pageNum);
      this.cells.delete(pageNum);
      this.layout();
    });

    cell.append(thumb, num, remove);
    this.wireDrag(cell);
    this.renderThumb(pageNum, canvas);
    return cell;
  }

  async renderThumb(pageNum, canvas) {
    const pdfDoc = this.deps.getPdfDoc();
    if (!pdfDoc) return;
    try {
      // pdf.js caches one PDFPageProxy per page number per document, so this
      // is the *same* page object viewer.js's own on-screen rendering uses
      // for a currently-visible page — deliberately never call page.cleanup()
      // here, or an on-screen page can go blank until scrolled away and back.
      const page = await pdfDoc.getPage(pageNum);
      const base = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: THUMB_WIDTH / base.width });
      canvas.width = Math.max(1, Math.ceil(viewport.width));
      canvas.height = Math.max(1, Math.ceil(viewport.height));
      const ctx = canvas.getContext('2d');
      await page.render({ canvasContext: ctx, viewport }).promise;
    } catch { /* thumbnail is best-effort; a blank cell is still usable */ }
  }

  wireDrag(cell) {
    // Every handler stops propagation: viewer.js has its own window-level
    // dragenter/dragover/drop listeners for "drop a PDF file to open", and
    // without this they see every one of these purely-in-page reorder drags
    // too — toggling #app.dragging (the "drop PDF here" overlay) on a drag
    // that was never a file, and leaving its dragDepth counter unbalanced
    // since these fire far more often than a real file drag would.
    cell.addEventListener('dragstart', (e) => {
      if (this.busy) { e.preventDefault(); return; }
      e.stopPropagation();
      this.dragId = Number(cell.dataset.page);
      cell.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', cell.dataset.page); // Firefox needs data set; value unused
    });
    cell.addEventListener('dragend', (e) => {
      e.stopPropagation();
      this.dragId = null;
      for (const c of this.el.grid.querySelectorAll('.op-cell')) c.classList.remove('dragging', 'drop-target');
    });
    cell.addEventListener('dragover', (e) => {
      if (this.dragId === null) return;
      e.preventDefault();
      e.stopPropagation();
      if (this.dragId !== Number(cell.dataset.page)) cell.classList.add('drop-target');
    });
    cell.addEventListener('dragleave', (e) => {
      e.stopPropagation();
      cell.classList.remove('drop-target');
    });
    cell.addEventListener('drop', (e) => {
      if (this.dragId === null) return;
      e.preventDefault();
      e.stopPropagation();
      cell.classList.remove('drop-target');
      const from = this.order.indexOf(this.dragId);
      const targetPage = Number(cell.dataset.page);
      let to = this.order.indexOf(targetPage);
      if (from < 0 || to < 0 || from === to) return;
      const [moved] = this.order.splice(from, 1);
      to = this.order.indexOf(targetPage);
      this.order.splice(to, 0, moved);
      this.layout();
    });
  }

  async apply() {
    if (this.busy || !this.order.length) return;
    const path = this.deps.getCurrentPath();
    if (!path) return;
    this.setBusy(true);
    this.setStatus('Building PDF…');
    try {
      const fresh = await window.api.readBytes(path);
      if (!fresh || fresh.error) throw new Error(fresh ? fresh.error : 'could not read PDF');
      const { PDFDocument } = await loadPdfLib();
      const src = await PDFDocument.load(fresh.data, { ignoreEncryption: true });
      const out = await PDFDocument.create();
      const pages = await out.copyPages(src, this.order.map((n) => n - 1));
      for (const p of pages) out.addPage(p);
      const bytes = await out.save();
      const base = (fresh.name || 'document.pdf').replace(/\.pdf$/i, '');
      this.setStatus('Saving…');
      const res = await window.api.saveBuiltPdf({ defaultName: `${base} (organized).pdf`, data: bytes });
      if (res && res.error) { this.setStatus(`Save failed: ${res.error}`, true); this.setBusy(false); return; }
      this.setBusy(false);
      if (res && res.path) this.close();
      else this.setStatus(''); // save cancelled — keep the dialog open
    } catch (err) {
      this.setStatus(`Failed: ${err.message}`, true);
      this.setBusy(false);
    }
  }

  setStatus(text, isError = false) {
    this.el.status.textContent = text;
    this.el.status.classList.toggle('error', isError);
  }

  setBusy(on) {
    this.busy = on;
    this.el.apply.disabled = on || !this.order.length;
    this.el.cancel.disabled = on;
    for (const c of this.el.grid.querySelectorAll('.op-cell')) {
      c.draggable = !on;
      const rm = c.querySelector('.op-remove');
      if (rm) rm.disabled = on;
    }
  }
}

export const organizePages = new OrganizePages();
