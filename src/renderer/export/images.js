// PDF pages -> raster images. Pixel-accurate — this just rasterizes with the
// same pdf.js render path the viewer already uses for on-screen pages, so
// there's no reconstruction/heuristics involved (unlike the Word/Excel
// exporters). A single page is returned as one file; more than one is
// zipped so there's still just one thing to save.

import { loadJSZip } from '../vendor-lazy.js';

function mimeFor(format) {
  return format === 'jpg' || format === 'jpeg' ? 'image/jpeg' : 'image/png';
}

async function renderPagePng(pdfDoc, pageNumber, scale, mime, quality) {
  const page = await pdfDoc.getPage(pageNumber);
  try {
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.ceil(viewport.width));
    canvas.height = Math.max(1, Math.ceil(viewport.height));
    const ctx = canvas.getContext('2d');
    await page.render({ canvasContext: ctx, viewport }).promise;
    const blob = await new Promise((resolve, reject) => {
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('canvas.toBlob failed'))), mime, quality);
    });
    return new Uint8Array(await blob.arrayBuffer());
  } finally {
    page.cleanup();
  }
}

// pdfDoc: a pdf.js PDFDocumentProxy. pageNumbers: 1-based.
// opts: { format: 'png'|'jpg', scale: number (render scale, ~DPI/72) }
// Returns { single: { name, bytes } } for one page, or { zip: Uint8Array } for more.
export async function buildImages(pdfDoc, pageNumbers, opts = {}) {
  const { format = 'png', scale = 2 } = opts;
  const mime = mimeFor(format);
  const ext = mime === 'image/jpeg' ? 'jpg' : 'png';
  const pad = String(Math.max(...pageNumbers)).length;

  const files = [];
  for (const n of pageNumbers) {
    const bytes = await renderPagePng(pdfDoc, n, scale, mime, 0.92);
    files.push({ name: `page-${String(n).padStart(pad, '0')}.${ext}`, bytes });
  }

  if (files.length === 1) return { single: files[0] };

  const JSZip = await loadJSZip();
  const zip = new JSZip();
  for (const f of files) zip.file(f.name, f.bytes);
  return { zip: await zip.generateAsync({ type: 'uint8array' }) };
}
