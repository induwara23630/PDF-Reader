// PDF -> Excel (.xlsx), best-effort table reconstruction (see
// docs/export-plan.md). PDF has no cell/table structure either — this
// clusters glyph x-positions into column bins shared across a page's lines,
// which works reasonably on PDFs with a real grid-like table and produces a
// messy, sparse sheet on anything else (plain prose has no shared columns).
// One sheet per exported page.

import { extractDocument, lineText } from './text-layout.js';

// SheetJS is a ~900KB parsed bundle — load it only when an Excel export is
// actually requested, not on every app boot.
let xlsxLibPromise = null;
function loadXlsxLib() {
  if (!xlsxLibPromise) xlsxLibPromise = import('../vendor/xlsx.esm.js');
  return xlsxLibPromise;
}

// Column x-start positions across the whole page, merged into bins within
// `tolerance` points of each other — the shared column grid every row's
// items get snapped to.
function columnBins(lines, tolerance) {
  const xs = [];
  for (const line of lines) for (const run of line.runs) xs.push(run.x0 ?? line.x0);
  xs.sort((a, b) => a - b);
  const bins = [];
  for (const x of xs) {
    if (!bins.length || x - bins[bins.length - 1] > tolerance) bins.push(x);
  }
  return bins;
}

function nearestBin(bins, x) {
  let best = 0, bestDist = Infinity;
  for (let i = 0; i < bins.length; i++) {
    const d = Math.abs(bins[i] - x);
    if (d < bestDist) { bestDist = d; best = i; }
  }
  return best;
}

function pageToSheet(page) {
  const bodySize = page.lines.length
    ? page.lines.reduce((a, l) => a + l.size, 0) / page.lines.length
    : 10;
  const bins = columnBins(page.lines, Math.max(8, bodySize * 1.2));
  if (!bins.length) return null;

  const aoa = [];
  for (const line of page.lines) {
    if (!lineText(line)) continue;
    const row = new Array(bins.length).fill('');
    for (const run of line.runs) {
      const text = run.text.trim();
      if (!text) continue;
      const col = nearestBin(bins, run.x0);
      row[col] = row[col] ? `${row[col]} ${text}` : text;
    }
    if (row.some((c) => c !== '')) aoa.push(row);
  }
  return aoa.length ? aoa : null;
}

export async function buildXlsx(pdfDoc, pageNumbers) {
  const [XLSX, pages] = await Promise.all([loadXlsxLib(), extractDocument(pdfDoc, pageNumbers)]);
  const wb = XLSX.utils.book_new();
  let sheetCount = 0;

  pages.forEach((page) => {
    const aoa = pageToSheet(page);
    if (!aoa) return;
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    sheetCount += 1;
    XLSX.utils.book_append_sheet(wb, ws, `Page ${page.pageNumber}`);
  });

  if (!sheetCount) {
    XLSX.utils.book_append_sheet(
      wb,
      XLSX.utils.aoa_to_sheet([['No extractable text was found on the selected pages.']]),
      'Sheet1'
    );
  }

  // {type:'array'} actually returns an ArrayBuffer (not a plain Array,
  // despite the name) — wrap it so every builder in this folder returns a
  // Uint8Array consistently.
  return new Uint8Array(XLSX.write(wb, { type: 'array', bookType: 'xlsx' }));
}
