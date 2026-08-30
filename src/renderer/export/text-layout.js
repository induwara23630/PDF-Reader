// Shared PDF -> structured-text extraction for the Word and Excel exporters.
//
// PDF has no concept of paragraphs, headings, or table cells — just glyphs
// positioned in page space. Both exporters need the same reconstruction step
// (cluster glyphs into lines, lines into styled runs), so it lives here once.
//
// Coordinate note: pdf.js text items' `transform` is raw PDF user space
// (bottom-left origin, y increases upward) — matches the page's own
// MediaBox, independent of viewport/zoom.

// pdf.js only resolves a page's font metadata (needed for the real
// bold/italic flags below) as a side effect of running its operator list —
// i.e. rendering. Text-only exports don't otherwise need a canvas, so this
// throwaway render exists purely to populate `page.commonObjs`.
async function primeFonts(page, viewport) {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.ceil(viewport.width));
  canvas.height = Math.max(1, Math.ceil(viewport.height));
  const ctx = canvas.getContext('2d');
  const task = page.render({ canvasContext: ctx, viewport });
  await task.promise;
  task.cancel && task.cancel();
}

const FAMILY_PATTERNS = [
  ['courier', /courier|mono/i],
  ['times', /times|serif|georgia|garamond|cambria/i],
  ['helvetica', /helvetica|arial|sans/i],
];

function classifyFamily(psName) {
  const name = psName || '';
  for (const [key, re] of FAMILY_PATTERNS) if (re.test(name)) return key;
  return 'helvetica';
}

async function fontInfoLookup(page) {
  const cache = new Map();
  return (fontName) => {
    if (cache.has(fontName)) return cache.get(fontName);
    let info = { bold: false, italic: false, family: 'helvetica' };
    try {
      const f = page.commonObjs.get(fontName);
      if (f) info = { bold: !!f.bold, italic: !!f.italic, family: classifyFamily(f.name) };
    } catch { /* not resolved — keep default */ }
    cache.set(fontName, info);
    return info;
  };
}

const round1 = (v) => Math.round(v * 10) / 10;

// One page's items -> lines -> style runs.
//   line = { y, x0, x1, size, runs: [{ text, bold, italic, family, size }] }
async function extractPageLines(page) {
  const viewport = page.getViewport({ scale: 1 });
  await primeFonts(page, viewport);
  const textContent = await page.getTextContent();
  const getFont = await fontInfoLookup(page);

  const items = textContent.items
    .filter((it) => it.str !== '' || it.hasEOL)
    .map((it) => {
      const size = Math.hypot(it.transform[2], it.transform[3]) || Math.abs(it.transform[3]) || 1;
      const font = getFont(it.fontName);
      return {
        str: it.str, x: it.transform[4], y: it.transform[5],
        width: it.width || 0, size, ...font,
      };
    })
    .filter((it) => it.str.trim() !== '');

  // Group into lines by y-proximity (tolerant of the small baseline jitter
  // that mixed font sizes on one visual line can introduce).
  items.sort((a, b) => b.y - a.y || a.x - b.x);
  const lines = [];
  for (const it of items) {
    const tol = Math.max(2, it.size * 0.35);
    let line = lines[lines.length - 1];
    if (!line || Math.abs(line.y - it.y) > tol) {
      line = { y: it.y, x0: it.x, x1: it.x, size: it.size, items: [] };
      lines.push(line);
    }
    line.items.push(it);
    line.x0 = Math.min(line.x0, it.x);
    line.x1 = Math.max(line.x1, it.x + it.width);
    line.size = Math.max(line.size, it.size);
  }

  // Within each line: sort by x, merge into style runs, inserting a space
  // when there's a visible gap between items that isn't already whitespace.
  // Each run keeps its own x0/x1 (real glyph positions, not estimated) —
  // xlsx-export.js needs those to snap runs onto a shared column grid.
  for (const line of lines) {
    line.items.sort((a, b) => a.x - b.x);
    const runs = [];
    let prevEnd = null;
    for (const it of line.items) {
      const gap = prevEnd == null ? 0 : it.x - prevEnd;
      // A small absolute threshold, not proportional to font size: pdf.js
      // gives adjacent glyphs within one word essentially zero gap (kerning
      // happens inside a single item, not between items), so *any* visible
      // gap between two separate items is almost always a real word
      // boundary — and a missed space ("boldand") reads far worse than an
      // extra one, so this errs toward inserting one.
      const needsSpace = prevEnd != null && gap > 0.5;
      // A gap this wide is a column/tab jump, not a word space — keep it a
      // separate run even when the style matches, so table cells (which are
      // very often the same style, e.g. a bold header row) don't collapse
      // into one run and lose their individual x-positions. xlsx-export.js
      // depends on that for column detection.
      const bigGap = prevEnd != null && gap > it.size * 2;
      const last = runs[runs.length - 1];
      const sameStyle = last && !bigGap && last.bold === it.bold && last.italic === it.italic &&
        last.family === it.family && round1(last.size) === round1(it.size);
      const text = (needsSpace ? ' ' : '') + it.str;
      if (sameStyle) {
        last.text += text;
        last.x1 = it.x + it.width;
      } else {
        runs.push({ text, bold: it.bold, italic: it.italic, family: it.family, size: it.size, x0: it.x, x1: it.x + it.width });
      }
      prevEnd = it.x + it.width;
    }
    line.runs = runs;
    delete line.items;
  }

  return { pageWidth: viewport.width, pageHeight: viewport.height, lines };
}

// pdfDoc: a pdf.js PDFDocumentProxy. pageNumbers: 1-based, in export order.
export async function extractDocument(pdfDoc, pageNumbers) {
  const pages = [];
  for (const n of pageNumbers) {
    const page = await pdfDoc.getPage(n);
    const { pageWidth, pageHeight, lines } = await extractPageLines(page);
    pages.push({ pageNumber: n, pageWidth, pageHeight, lines });
    page.cleanup();
  }
  return pages;
}

export function lineText(line) {
  return line.runs.map((r) => r.text).join('').replace(/\s+/g, ' ').trim();
}
