// A subset of the open PDF's own pages, copied verbatim into a new PDF via
// pdf-lib — no rasterization or reconstruction, so this is exact.

import { loadPdfLib } from '../vendor-lazy.js';

// originalBytes: the source PDF's bytes. pageNumbers: 1-based, in the order
// they should appear in the output.
export async function buildPdfSubset(originalBytes, pageNumbers) {
  const { PDFDocument } = await loadPdfLib();
  const src = await PDFDocument.load(originalBytes, { ignoreEncryption: true });
  const out = await PDFDocument.create();
  const indices = pageNumbers.map((n) => n - 1);
  const copied = await out.copyPages(src, indices);
  for (const p of copied) out.addPage(p);
  return out.save();
}
