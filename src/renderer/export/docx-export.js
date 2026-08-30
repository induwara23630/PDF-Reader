// PDF -> Word (.docx), best-effort layout reconstruction (see
// docs/export-plan.md). Reuses the line/run extraction in text-layout.js and
// layers paragraph/heading/alignment heuristics on top, entirely from glyph
// positions and pdf.js's own font bold/italic flags — PDF has no structural
// paragraph or heading markup to read.

import { extractDocument, lineText } from './text-layout.js';

// `docx` is a ~1MB parsed bundle — load it only when a Word export is
// actually requested, not on every app boot (this module's own tiny wrapper
// code is still fine to import eagerly from export/index.js).
let docxLibPromise = null;
function loadDocxLib() {
  if (!docxLibPromise) docxLibPromise = import('../vendor/docx.esm.js');
  return docxLibPromise;
}

const FAMILY_TO_WORD_FONT = { helvetica: 'Arial', times: 'Times New Roman', courier: 'Courier New' };

// A paragraph break is "a gap noticeably bigger than normal single-line
// spacing" — this factor is how much bigger counts as noticeable.
const PARA_GAP_FACTOR = 1.6;
// A line whose size is at least this many times the body size is a heading
// (index into HeadingLevel.HEADING_1/2/3, resolved once the lib is loaded).
const HEADING_RATIOS = [[1.6, 0], [1.3, 1], [1.15, 2]];

function detectBodySize(pages) {
  const counts = new Map();
  for (const p of pages) for (const line of p.lines) {
    const s = Math.round(line.size);
    counts.set(s, (counts.get(s) || 0) + 1);
  }
  let bodySize = 12, best = -1;
  for (const [s, c] of counts) if (c > best) { best = c; bodySize = s; }
  return bodySize;
}

function detectLineGap(pages, bodySize) {
  const gaps = [];
  for (const p of pages) {
    for (let i = 1; i < p.lines.length; i++) {
      const gap = p.lines[i - 1].y - p.lines[i].y;
      if (gap > 0 && gap < bodySize * 3) gaps.push(gap);
    }
  }
  if (!gaps.length) return bodySize * 1.2;
  gaps.sort((a, b) => a - b);
  return gaps[Math.floor(gaps.length / 2)];
}

function headingFor(size, bodySize, HeadingLevel) {
  const ratio = size / bodySize;
  const levels = [HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3];
  for (const [min, idx] of HEADING_RATIOS) if (ratio >= min) return levels[idx];
  return undefined;
}

// Grouping is a single pass over every line from every page (flattened) —
// a page's first line always forces a new paragraph, so exported pages stay
// roughly aligned with the source PDF's pages.
function groupParagraphs(pages, bodySize, lineGap) {
  const paragraphs = [];
  let current = null;
  let prevY = null;
  for (const page of pages) {
    page.lines.forEach((line, i) => {
      if (!lineText(line)) return;
      const isHeading = line.size / bodySize >= 1.15;
      const bigGap = prevY != null && (prevY - line.y) > lineGap * PARA_GAP_FACTOR;
      const newPage = i === 0;
      const currentIsHeading = current && current.lines[0].size / bodySize >= 1.15;
      if (newPage || isHeading || bigGap || !current || currentIsHeading) {
        if (current) paragraphs.push(current);
        current = { lines: [{ ...line, pageWidth: page.pageWidth }], newPage };
      } else {
        current.lines.push({ ...line, pageWidth: page.pageWidth });
      }
      prevY = line.y;
    });
    prevY = null; // a fresh page never joins the previous page's last paragraph
  }
  if (current) paragraphs.push(current);
  return paragraphs;
}

function buildParagraph(para, bodySize, isFirst, lib) {
  const { Paragraph, TextRun, AlignmentType, HeadingLevel } = lib;
  const runs = [];
  para.lines.forEach((line, idx) => {
    if (idx > 0) runs.push(new TextRun({ text: ' ' }));
    for (const r of line.runs) {
      if (!r.text.trim()) continue;
      runs.push(new TextRun({
        text: r.text,
        bold: r.bold,
        italics: r.italic,
        font: FAMILY_TO_WORD_FONT[r.family] || 'Arial',
        size: Math.max(2, Math.round(r.size * 2)), // docx sizes are half-points
      }));
    }
  });
  if (!runs.length) return null;

  const first = para.lines[0];
  const heading = headingFor(first.size, bodySize, HeadingLevel);

  // Center only short, single-line, visibly-centered paragraphs (titles) —
  // deliberately conservative so ordinary left/justified body copy is never
  // misjudged as centered.
  let alignment;
  if (para.lines.length === 1) {
    const mid = (first.x0 + first.x1) / 2;
    const pageMid = first.pageWidth / 2;
    if (Math.abs(mid - pageMid) < first.pageWidth * 0.06 && first.x0 > first.pageWidth * 0.12) {
      alignment = AlignmentType.CENTER;
    }
  }

  return new Paragraph({
    children: runs,
    heading,
    alignment,
    pageBreakBefore: para.newPage && !isFirst,
  });
}

export async function buildDocx(pdfDoc, pageNumbers) {
  const [lib, pages] = await Promise.all([loadDocxLib(), extractDocument(pdfDoc, pageNumbers)]);
  const { Document, Packer, Paragraph, TextRun } = lib;
  const bodySize = detectBodySize(pages);
  const lineGap = detectLineGap(pages, bodySize);
  const paragraphs = groupParagraphs(pages, bodySize, lineGap);

  const children = paragraphs
    .map((para, i) => buildParagraph(para, bodySize, i === 0, lib))
    .filter(Boolean);

  if (!children.length) {
    children.push(new Paragraph({
      children: [new TextRun({ text: 'No extractable text was found on the selected pages (they may be scanned images).', italics: true })],
    }));
  }

  const doc = new Document({ sections: [{ children }] });
  return Packer.toBlob(doc);
}
