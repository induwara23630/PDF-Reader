// Annotations controller — wires the store, toolbar, per-page layers,
// persistence (sidecar JSON) and export (flatten / real annotation objects /
// apply-to-original) together, and exposes a small surface for viewer.js to
// call from its page lifecycle.

import { store } from './store.js';
import { tools } from './tools.js';
import { mountAnnotationLayer } from './layer.js';
import { flattenToPdf, buildInteropPdf } from './export.js';

const AUTOSAVE_MS = 800;

class Annotations {
  constructor() {
    this.deps = null;
    this.path = null;
    this.meta = { size: 0, mtimeMs: 0 };
    this.layers = new Map(); // page number -> layer handle
    this._saveTimer = 0;
    this._saving = null;
    this.banner = null;
  }

  init(deps) {
    // deps: { getScale, getPageDivs, getBaseViewports }
    this.deps = deps;
    tools.init({
      store,
      onExport: () => this.export(),
      onPickImageRequest: () => this.pickAndArmImage(),
    });

    this.banner = document.getElementById('annot-banner');
    document.getElementById('annot-banner-dismiss').addEventListener('click', () => this._hideBanner());

    store.subscribeGlobal(() => this._scheduleSave());

    // Deselect when clicking outside any annotation while the Select tool is active.
    document.addEventListener('pointerdown', (e) => {
      if (tools.tool !== 'select' || !tools.selection) return;
      const t = e.target;
      if (t.closest && (t.closest('.an') || t.closest('[data-handle]') ||
        t.closest('.an-freetext') || t.closest('.an-note-pin') ||
        t.closest('.an-note-panel') || t.closest('#annot-toolbar') ||
        t.closest('#annot-style') || t.closest('#selection-bar'))) return;
      tools.clearSelection();
    });

    // Delete key removes the selected annotation.
    document.addEventListener('keydown', (e) => {
      if (!this.path || tools.tool !== 'select' || !tools.selection) return;
      const typing = e.target instanceof HTMLElement &&
        (e.target.isContentEditable || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'INPUT');
      if (typing) return;
      if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        store.remove(tools.selection.id);
        tools.clearSelection();
      }
    });

    // Text-markup tools: on mouse-up over a text selection, create the markup.
    document.addEventListener('mouseup', () => {
      if (!this.path || !tools.isMarkupTool()) return;
      setTimeout(() => this.markupFromSelection(tools.tool), 0);
    });
  }

  setEnabled(on) {
    tools.setDocOpen(on);
  }

  // Called when the "Edit PDF" mode toolbar button turns off: the toolbar
  // (and its popover, a DOM child of it) disappears via CSS regardless, but
  // the active tool must be reset too — otherwise a draw tool like "rect"
  // stays armed and keeps eating page clicks meant for normal PDF use even
  // though nothing visibly shows it's still active.
  exitEditMode() {
    tools.setTool('select');
  }

  /* ---- document lifecycle ---- */

  async setDocument(pdfPath) {
    await this._flushSave();
    this.path = pdfPath || null;
    this.layers.clear();
    this._hideBanner();
    if (!this.path) {
      store.reset();
      return;
    }
    let sidecar = null;
    try {
      sidecar = await window.api.annotsLoad(this.path);
    } catch { /* ignore */ }
    if (sidecar && Array.isArray(sidecar.annotations)) {
      this.meta = { size: sidecar.size || 0, mtimeMs: sidecar.mtimeMs || 0 };
      store.load(sidecar.annotations);
      if (sidecar.fileChanged && sidecar.annotations.length) this._showBanner();
    } else {
      this.meta = { size: 0, mtimeMs: 0 };
      store.load([]);
    }
  }

  async closeDocument() {
    await this._flushSave();
    this.path = null;
    for (const l of this.layers.values()) l.destroy();
    this.layers.clear();
    tools.clearSelection();
    store.reset();
    this._hideBanner();
  }

  _showBanner() {
    if (this.banner) this.banner.classList.add('open');
  }

  _hideBanner() {
    if (this.banner) this.banner.classList.remove('open');
  }

  /* ---- per-page layer hooks (called from viewer.js) ---- */

  mountLayer(pageNumber, pageDiv, baseViewport) {
    if (!this.path) return;
    const existing = this.layers.get(pageNumber);
    if (existing) existing.destroy();
    const layer = mountAnnotationLayer(pageNumber, pageDiv, baseViewport, {
      store, tools, getScale: this.deps.getScale,
    });
    this.layers.set(pageNumber, layer);
  }

  unmountLayer(pageNumber) {
    const layer = this.layers.get(pageNumber);
    if (layer) { layer.destroy(); this.layers.delete(pageNumber); }
  }

  reflow() {
    for (const l of this.layers.values()) l.render();
  }

  /* ---- text markup from the live selection ---- */

  markupFromSelection(type) {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return;
    if (!sel.toString().trim()) return;
    const focus = sel.focusNode;
    const el = focus && (focus.nodeType === 1 ? focus : focus.parentElement);
    if (!el || !el.closest || !el.closest('.textLayer')) return;

    const range = sel.getRangeAt(0);
    const rects = Array.from(range.getClientRects()).filter((r) => r.width > 0.5 && r.height > 0.5);
    if (!rects.length) return;

    const divs = this.deps.getPageDivs();
    const scale = this.deps.getScale();
    const perPage = new Map();

    for (const r of rects) {
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      for (let i = 0; i < divs.length; i++) {
        const pr = divs[i].getBoundingClientRect();
        if (cx < pr.left || cx > pr.right || cy < pr.top || cy > pr.bottom) continue;
        const x1 = (r.left - pr.left) / scale;
        const y1 = (r.top - pr.top) / scale;
        const x2 = (r.right - pr.left) / scale;
        const y2 = (r.bottom - pr.top) / scale;
        if (!perPage.has(i + 1)) perPage.set(i + 1, []);
        perPage.get(i + 1).push([x1, y1, x2, y1, x2, y2, x1, y2]);
        break;
      }
    }

    // When a markup tool is active use its live style; otherwise (selection-bar
    // entry) fall back to a sensible per-type default.
    const active = tools.isMarkupTool() && tools.tool === type;
    const DEFAULT = { highlight: '#ffd54a', underline: '#ff5252', strike: '#ff5252' };
    const color = active ? tools.style.color : DEFAULT[type];
    const opacity = type === 'highlight' ? (active ? tools.style.opacity ?? 0.4 : 0.4) : 1;
    const strokeWidth = Math.max(1.5, active ? tools.style.strokeWidth : 2);

    for (const [page, quads] of perPage) {
      store.add({
        page, type,
        quads: mergeQuads(quads),
        color, opacity, strokeWidth,
      });
    }
    sel.removeAllRanges();
  }

  /* ---- export ---- */

  // mode: 'interop' (default) writes real /Annots + appearance streams,
  // editable in Acrobat / Preview / etc.; 'flatten' draws annotations onto
  // page content — universal, but no longer editable anywhere. See
  // docs/annotations-plan.md §7.
  async export(mode = 'interop') {
    if (!this.path || store.isEmpty()) return;
    const btn = tools.el.exportBtn;
    const prev = btn.textContent;
    btn.textContent = 'Saving…';
    btn.disabled = true;
    try {
      const fresh = await window.api.readBytes(this.path);
      if (!fresh || fresh.error) throw new Error(fresh ? fresh.error : 'could not read PDF');
      const build = mode === 'flatten' ? flattenToPdf : buildInteropPdf;
      const out = await build(fresh.data, store.serialize());
      const base = (fresh.name || 'document.pdf').replace(/\.pdf$/i, '');
      const suffix = mode === 'flatten' ? ' (flattened)' : ' (annotated)';
      await window.api.saveBuiltPdf({ defaultName: `${base}${suffix}.pdf`, data: out });
    } catch (err) {
      alert(`Save failed:\n${err.message}`);
    } finally {
      btn.textContent = prev;
      btn.disabled = !this.path || store.isEmpty();
    }
  }

  // Overwrites the original PDF in place with a real-annotation-objects
  // build, after an explicit confirmation (this is destructive; a `.bak`
  // is kept alongside as a safety net — see main.js `annots:applyToOriginal`).
  async applyToOriginal() {
    if (!this.path || store.isEmpty()) return;
    const ok = window.confirm(
      'Apply annotations directly to the original file?\n\n' +
      'This overwrites the PDF on disk. A backup copy (.bak) is kept next to it.'
    );
    if (!ok) return;
    try {
      const fresh = await window.api.readBytes(this.path);
      if (!fresh || fresh.error) throw new Error(fresh ? fresh.error : 'could not read PDF');
      const out = await buildInteropPdf(fresh.data, store.serialize());
      const res = await window.api.annotsApplyToOriginal(this.path, out);
      if (!res || res.error) throw new Error(res ? res.error : 'write failed');
      // The file's bytes changed underneath the open document, so the
      // sidecar's own change-detection baseline (size/mtimeMs) needs
      // updating too, or the next open would wrongly show the "file
      // changed" banner. The on-screen page content is unaffected — this
      // app never renders a PDF's native /Annots, only its own overlay.
      this.meta = { size: res.size, mtimeMs: res.mtimeMs };
      await this._persistMetaOnly();
      this._hideBanner();
    } catch (err) {
      alert(`Apply failed:\n${err.message}`);
    }
  }

  /* ---- image stamp tool ---- */

  async pickAndArmImage() {
    if (!this.path) return;
    const filePath = await window.api.pickImage();
    if (!filePath) return;
    try {
      const res = await window.api.readBytes(filePath);
      if (!res || res.error) throw new Error(res ? res.error : 'could not read image');
      const ext = (filePath.split('.').pop() || '').toLowerCase();
      const mime = ext === 'png' ? 'image/png'
        : ext === 'gif' ? 'image/gif'
        : ext === 'webp' ? 'image/webp'
        : ext === 'bmp' ? 'image/bmp'
        : 'image/jpeg';
      const raw = bytesToDataUrl(res.data, mime);
      const img = await loadImage(raw);
      if (!img) throw new Error('unrecognized image file');
      // Normalize everything to PNG so export (flatten + interop, both via
      // pdf-lib's embedPng) never has to branch on source format.
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth || 1;
      canvas.height = img.naturalHeight || 1;
      canvas.getContext('2d').drawImage(img, 0, 0);
      const pngUrl = canvas.toDataURL('image/png');
      const maxW = 180; // points — a reasonable default stamp size
      const w = Math.min(maxW, canvas.width * 0.75);
      const h = w * (canvas.height / canvas.width || 1);
      tools.armImage(pngUrl, w, h);
    } catch (err) {
      alert(`Could not insert image:\n${err.message}`);
    }
  }

  /* ---- persistence ---- */

  _scheduleSave() {
    if (!this.path || !store.dirty) return;
    clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => this._flushSave(), AUTOSAVE_MS);
  }

  // Re-writes the sidecar with the current meta baseline even when nothing
  // is dirty — used after Apply to Original, where the annotations
  // themselves didn't change but the file's size/mtimeMs did.
  async _persistMetaOnly() {
    if (!this.path) return;
    const payload = {
      path: this.path,
      size: this.meta.size,
      mtimeMs: this.meta.mtimeMs,
      savedAt: Date.now(),
      annotations: store.serialize(),
    };
    try { await window.api.annotsSave(this.path, payload); } catch { /* ignore */ }
  }

  async _flushSave() {
    clearTimeout(this._saveTimer);
    if (this._saving) { try { await this._saving; } catch { /* noop */ } }
    if (!this.path || !store.dirty) return;
    const payload = {
      path: this.path,
      size: this.meta.size,
      mtimeMs: this.meta.mtimeMs,
      savedAt: Date.now(),
      annotations: store.serialize(),
    };
    store.markClean();
    this._saving = window.api.annotsSave(this.path, payload)
      .catch((err) => console.warn('annotation autosave failed:', err))
      .finally(() => { this._saving = null; });
    await this._saving;
  }
}

function bytesToDataUrl(bytes, mime) {
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return `data:${mime};base64,${btoa(binary)}`;
}

function loadImage(dataUrl) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = dataUrl;
  });
}

// Merge quads that sit on the same text line into one wider quad.
function mergeQuads(quads) {
  const sorted = quads.slice().sort((a, b) => a[1] - b[1] || a[0] - b[0]);
  const out = [];
  for (const q of sorted) {
    const last = out[out.length - 1];
    if (last &&
      Math.abs(last[1] - q[1]) < 2 && Math.abs(last[5] - q[5]) < 2 &&
      q[0] - last[2] < 3) {
      last[2] = q[2]; last[4] = q[4]; // extend right edge
    } else {
      out.push(q.slice());
    }
  }
  return out;
}

export const annotations = new Annotations();
