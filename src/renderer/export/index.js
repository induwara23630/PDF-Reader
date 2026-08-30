// "Export…" dialog — one open document, four output shapes. Images and the
// PDF-page-subset export are exact (rasterize / copy pages verbatim); Word
// and Excel are a best-effort reconstruction from glyph positions (see
// docs/export-plan.md) since PDF has no paragraph/table structure to read.

import { buildImages } from './images.js';
import { buildPdfSubset } from './pdf-pages.js';
import { buildDocx } from './docx-export.js';
import { buildXlsx } from './xlsx-export.js';
import { parsePageRange } from './page-range.js';

class ExportDialog {
  constructor() {
    this.deps = null; // { getPdfDoc, getCurrentPath, getNumPages, getCurrentPage }
    this.format = 'images';
    this.busy = false;
    this.el = {};
  }

  init(deps) {
    this.deps = deps;
    const modal = document.getElementById('export-dialog');
    this.el = {
      modal,
      close: document.getElementById('ex-close'),
      cancel: document.getElementById('ex-cancel'),
      exportBtn: document.getElementById('ex-export'),
      status: document.getElementById('ex-status'),
      formatBtns: Array.from(modal.querySelectorAll('[data-format]')),
      rangeRadios: Array.from(modal.querySelectorAll('input[name="ex-range"]')),
      rangeInput: document.getElementById('ex-range-input'),
      imageOpts: document.getElementById('ex-image-opts'),
      imageFormat: document.getElementById('ex-image-format'),
      imageScale: document.getElementById('ex-image-scale'),
    };

    for (const b of this.el.formatBtns) b.addEventListener('click', () => this.setFormat(b.dataset.format));
    for (const r of this.el.rangeRadios) r.addEventListener('change', () => this.syncRangeInput());
    this.el.rangeInput.addEventListener('focus', () => {
      const custom = this.el.rangeRadios.find((r) => r.value === 'custom');
      if (custom) custom.checked = true;
      this.syncRangeInput();
    });

    this.el.close.addEventListener('click', () => this.close());
    this.el.cancel.addEventListener('click', () => this.close());
    this.el.modal.addEventListener('mousedown', (e) => { if (e.target === this.el.modal) this.close(); });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.el.modal.classList.contains('open')) this.close();
    });
    this.el.exportBtn.addEventListener('click', () => this.run());

    this.setFormat('images');
    this.syncRangeInput();
  }

  open() {
    if (!this.deps.getPdfDoc()) return; // nothing open — nothing to export
    this.el.modal.classList.add('open');
    this.el.modal.setAttribute('aria-hidden', 'false');
    this.setStatus('');
  }

  close() {
    if (this.busy) return;
    this.el.modal.classList.remove('open');
    this.el.modal.setAttribute('aria-hidden', 'true');
  }

  setFormat(fmt) {
    this.format = fmt;
    for (const b of this.el.formatBtns) b.classList.toggle('active', b.dataset.format === fmt);
    this.el.imageOpts.hidden = fmt !== 'images';
  }

  syncRangeInput() {
    const custom = this.el.rangeRadios.find((r) => r.value === 'custom');
    this.el.rangeInput.disabled = !(custom && custom.checked);
  }

  resolvePages() {
    const numPages = this.deps.getNumPages();
    const checked = this.el.rangeRadios.find((r) => r.checked);
    const mode = checked ? checked.value : 'all';
    if (mode === 'current') return [this.deps.getCurrentPage()];
    if (mode === 'custom') {
      const parsed = parsePageRange(this.el.rangeInput.value, numPages);
      if (!parsed) throw new Error('Enter a valid page range, e.g. "1-3, 5"');
      return parsed;
    }
    return Array.from({ length: numPages }, (_, i) => i + 1);
  }

  async run() {
    if (this.busy) return;
    let pages;
    try { pages = this.resolvePages(); }
    catch (err) { this.setStatus(err.message, true); return; }

    this.setBusy(true);
    this.setStatus('Working…');
    try {
      const pdfDoc = this.deps.getPdfDoc();
      const path = this.deps.getCurrentPath();
      const base = (path ? path.split(/[\\/]/).pop() : 'document.pdf').replace(/\.pdf$/i, '');

      if (this.format === 'images') {
        const result = await buildImages(pdfDoc, pages, {
          format: this.el.imageFormat.value,
          scale: Number(this.el.imageScale.value) || 2,
        });
        if (result.single) {
          const ext = result.single.name.split('.').pop();
          await this.save(result.single.bytes, `${base} (page ${pages[0]}).${ext}`, 'Image', [ext]);
        } else {
          await this.save(result.zip, `${base} (images).zip`, 'Zip Archive', ['zip']);
        }
      } else if (this.format === 'pdf') {
        const fresh = await window.api.readBytes(path);
        if (!fresh || fresh.error) throw new Error(fresh ? fresh.error : 'could not read PDF');
        const bytes = await buildPdfSubset(fresh.data, pages);
        await this.save(bytes, `${base} (pages).pdf`, 'PDF Document', ['pdf']);
      } else if (this.format === 'docx') {
        const blob = await buildDocx(pdfDoc, pages);
        const bytes = new Uint8Array(await blob.arrayBuffer());
        await this.save(bytes, `${base}.docx`, 'Word Document', ['docx']);
      } else if (this.format === 'xlsx') {
        const bytes = await buildXlsx(pdfDoc, pages);
        await this.save(bytes, `${base}.xlsx`, 'Excel Workbook', ['xlsx']);
      }
    } catch (err) {
      this.setStatus(`Export failed: ${err.message}`, true);
    } finally {
      this.setBusy(false);
    }
  }

  async save(bytes, defaultName, filterName, extensions) {
    this.setStatus('Saving…');
    const res = await window.api.exportSave({ defaultName, data: bytes, filterName, extensions });
    if (res && res.error) { this.setStatus(`Save failed: ${res.error}`, true); return; }
    if (res && res.canceled) { this.setStatus(''); return; }
    this.setStatus('Exported.');
    setTimeout(() => this.close(), 700);
  }

  setStatus(text, isError = false) {
    this.el.status.textContent = text;
    this.el.status.classList.toggle('error', isError);
  }

  setBusy(on) {
    this.busy = on;
    this.el.exportBtn.disabled = on;
    this.el.cancel.disabled = on;
    for (const b of this.el.formatBtns) b.disabled = on;
  }
}

export const exportDialog = new ExportDialog();
