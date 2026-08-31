// Two export modes, per the annotations plan (docs/annotations-plan.md, §7):
//
//   A. flattenToPdf()    — draw annotations onto page content. Universal,
//      renders identically everywhere, not re-editable outside this app.
//   B. buildInteropPdf() — real PDF annotation objects (/Annots) with proper
//      appearance streams (/AP), editable in Acrobat / Preview / etc.
//
// Both share the store's coordinate convention: PDF points, page user space,
// top-left origin. pdf-lib itself is bottom-left origin, so every y is
// flipped once against the page height (no scaling, since the store already
// holds real point values — see docs/annotations-plan.md §2).
//
// buildInteropPdf() draws each annotation's appearance onto its own tiny
// scratch page (sized to the annotation's padded bounding box) using the
// exact same pdf-lib drawing calls as the flatten path, then embeds that
// scratch page as a Form XObject (`doc.embedPage`) and wires it up as an
// indirect /Annots entry's /AP /N — pdf-lib's own technique for stamping one
// page's content onto another, repurposed here to build appearance streams
// without hand-writing PDF content-stream operators.

// pdf-lib (~500 KB) is only needed when the user actually exports an
// annotated copy — loaded on demand via vendor-lazy.js, not at tab boot.
// These bindings are filled in by ensurePdfLib(), which every exported entry
// point below awaits before touching them (the helper functions that use
// them are only ever called from inside those awaited paths).
import { loadPdfLib } from '../vendor-lazy.js';

let PDFDocument, StandardFonts, rgb, PDFString, PDFHexString, breakTextIntoLines;
let pdfLibReady = null;
function ensurePdfLib() {
  if (!pdfLibReady) {
    pdfLibReady = loadPdfLib().then((m) => {
      ({ PDFDocument, StandardFonts, rgb, PDFString, PDFHexString, breakTextIntoLines } = m);
    });
  }
  return pdfLibReady;
}

function hexColor(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '#000000');
  const n = m ? parseInt(m[1], 16) : 0;
  return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
}

function colorComponents(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '#000000');
  const n = m ? parseInt(m[1], 16) : 0;
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

const round2 = (v) => Math.round(v * 100) / 100;

function groupByPage(annotations) {
  const byPage = new Map();
  for (const a of annotations) {
    if (!byPage.has(a.page)) byPage.set(a.page, []);
    byPage.get(a.page).push(a);
  }
  return byPage;
}

function dataUrlToBytes(dataUrl) {
  const comma = dataUrl.indexOf(',');
  const bin = atob(comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

// freetext's family/bold/italic style -> the matching pdf-lib standard font.
// Helvetica/Courier's italic variant is called "Oblique"; Times' is "Italic".
function standardFontFor(family, bold, italic) {
  if (family === 'times') {
    if (bold && italic) return StandardFonts.TimesRomanBoldItalic;
    if (bold) return StandardFonts.TimesRomanBold;
    if (italic) return StandardFonts.TimesRomanItalic;
    return StandardFonts.TimesRoman;
  }
  if (family === 'courier') {
    if (bold && italic) return StandardFonts.CourierBoldOblique;
    if (bold) return StandardFonts.CourierBold;
    if (italic) return StandardFonts.CourierOblique;
    return StandardFonts.Courier;
  }
  if (bold && italic) return StandardFonts.HelveticaBoldOblique;
  if (bold) return StandardFonts.HelveticaBold;
  if (italic) return StandardFonts.HelveticaOblique;
  return StandardFonts.Helvetica;
}

async function embedFontVariant(doc, shared, standardFont) {
  if (!shared.fonts) shared.fonts = new Map();
  if (!shared.fonts.has(standardFont)) shared.fonts.set(standardFont, await doc.embedFont(standardFont));
  return shared.fonts.get(standardFont);
}

async function embedStampImage(doc, shared, dataUrl) {
  if (!shared.imgCache) shared.imgCache = new Map();
  if (shared.imgCache.has(dataUrl)) return shared.imgCache.get(dataUrl);
  const img = await doc.embedPng(dataUrlToBytes(dataUrl)); // always normalized to PNG at capture time
  shared.imgCache.set(dataUrl, img);
  return img;
}

/* ------------------------------------------------------------------ *
 *  Shared per-type drawing — used by both export modes. `ctx.X`/`ctx.Y` *
 *  translate store coordinates (points, top-left origin) into whatever *
 *  page the caller is drawing on: the real page at (0,0) for flatten,  *
 *  or a padded-bbox-sized scratch page for an appearance stream.       *
 * ------------------------------------------------------------------ */

function makeDrawContext(doc, H, ox, oy, shared, drawNoteText) {
  return {
    doc, shared, drawNoteText,
    X: (v) => v - ox,
    Y: (v) => (H - v) - oy, // v is a store (top-left-origin) y
  };
}

async function drawAnnotationOn(page, a, ctx) {
  const { X, Y } = ctx;
  const color = hexColor(a.color);
  const opacity = a.opacity ?? 1;
  const sw = a.strokeWidth || 2;

  switch (a.type) {
    case 'highlight': {
      for (const q of a.quads || []) {
        const xs = [q[0], q[2], q[4], q[6]];
        const ys = [q[1], q[3], q[5], q[7]];
        const x = Math.min(...xs);
        const y = Math.min(...ys);
        const w = Math.max(...xs) - x;
        const h = Math.max(...ys) - y;
        page.drawRectangle({
          x: X(x), y: Y(y + h), width: w, height: h,
          color, opacity: Math.min(opacity, 0.5),
        });
      }
      break;
    }
    case 'underline':
    case 'strike': {
      for (const q of a.quads || []) {
        const y = a.type === 'underline'
          ? Math.max(q[5], q[7]) - 1
          : (q[1] + q[7]) / 2;
        page.drawLine({
          start: { x: X(q[0]), y: Y(y) },
          end: { x: X(q[2]), y: Y(y) },
          thickness: sw, color, opacity,
        });
      }
      break;
    }
    case 'ink': {
      const pts = a.points || [];
      for (let i = 1; i < pts.length; i++) {
        page.drawLine({
          start: { x: X(pts[i - 1][0]), y: Y(pts[i - 1][1]) },
          end: { x: X(pts[i][0]), y: Y(pts[i][1]) },
          thickness: sw, color, opacity,
        });
      }
      break;
    }
    case 'rect': {
      const b = a.rect;
      page.drawRectangle({
        x: X(b.x), y: Y(b.y + b.h), width: b.w, height: b.h,
        borderColor: color, borderWidth: sw, borderOpacity: opacity,
      });
      break;
    }
    case 'ellipse': {
      const b = a.rect;
      page.drawEllipse({
        x: X(b.x + b.w / 2), y: Y(b.y + b.h / 2),
        xScale: Math.abs(b.w / 2), yScale: Math.abs(b.h / 2),
        borderColor: color, borderWidth: sw, borderOpacity: opacity,
      });
      break;
    }
    case 'line':
    case 'arrow': {
      const [p1, p2] = a.points;
      page.drawLine({
        start: { x: X(p1[0]), y: Y(p1[1]) },
        end: { x: X(p2[0]), y: Y(p2[1]) },
        thickness: sw, color, opacity,
      });
      if (a.type === 'arrow') {
        const ang = Math.atan2(p2[1] - p1[1], p2[0] - p1[0]);
        const len = 4 + sw * 2.5;
        for (const off of [Math.PI - 0.42, Math.PI + 0.42]) {
          const hx = p2[0] + Math.cos(ang + off) * len;
          const hy = p2[1] + Math.sin(ang + off) * len;
          page.drawLine({
            start: { x: X(p2[0]), y: Y(p2[1]) },
            end: { x: X(hx), y: Y(hy) },
            thickness: sw, color, opacity,
          });
        }
      }
      break;
    }
    case 'freetext': {
      if (!a.text) break;
      const standardFont = standardFontFor(a.fontFamily, a.bold, a.italic);
      const font = await embedFontVariant(ctx.doc, ctx.shared, standardFont);
      const size = a.fontSize || 14;
      const lineHeight = size * 1.2;
      const maxWidth = a.rect.w || undefined;
      const lines = maxWidth
        ? breakTextIntoLines(a.text, ctx.doc.defaultWordBreaks, maxWidth, (t) => font.widthOfTextAtSize(t, size))
        : [a.text];
      let cy = a.rect.y + size;
      for (const line of lines) {
        const lw = font.widthOfTextAtSize(line, size);
        let lx = a.rect.x;
        if (a.align === 'center') lx = a.rect.x + Math.max(0, ((a.rect.w || lw) - lw) / 2);
        else if (a.align === 'right') lx = a.rect.x + Math.max(0, (a.rect.w || lw) - lw);
        page.drawText(line, { x: X(lx), y: Y(cy), size, font, color });
        if (a.underline && line.trim()) {
          const uy = cy + size * 0.12;
          page.drawLine({
            start: { x: X(lx), y: Y(uy) }, end: { x: X(lx + lw), y: Y(uy) },
            thickness: Math.max(0.75, size * 0.06), color, opacity,
          });
        }
        cy += lineHeight;
      }
      break;
    }
    case 'note': {
      const b = a.rect;
      page.drawRectangle({
        x: X(b.x), y: Y(b.y + 14), width: 14, height: 14,
        color: hexColor(a.color || '#ffd54a'),
        borderColor: rgb(0.6, 0.5, 0.1), borderWidth: 0.5,
      });
      // Flatten has no popup mechanism, so bake the note body next to the
      // icon; a real Text annotation instead carries it in /Contents and
      // relies on the viewer's own popup chrome (see buildAnnotFields).
      if (a.text && ctx.drawNoteText) {
        const font = await embedFontVariant(ctx.doc, ctx.shared, StandardFonts.Helvetica);
        page.drawText(a.text, {
          x: X(b.x + 18), y: Y(b.y + 10),
          size: 9, font, color: rgb(0.15, 0.15, 0.15),
          lineHeight: 11, maxWidth: 180,
        });
      }
      break;
    }
    case 'image': {
      if (!a.data) break;
      let img;
      try { img = await embedStampImage(ctx.doc, ctx.shared, a.data); } catch { break; }
      const b = a.rect;
      page.drawImage(img, { x: X(b.x), y: Y(b.y + b.h), width: b.w, height: b.h, opacity });
      break;
    }
  }
}

/* ------------------------------------------------------------------ *
 *  A. Flatten                                                         *
 * ------------------------------------------------------------------ */

export async function flattenToPdf(originalBytes, annotations) {
  await ensurePdfLib();
  const doc = await PDFDocument.load(originalBytes, { ignoreEncryption: true });
  const pages = doc.getPages();
  const shared = { font: null };

  for (const [pageNum, list] of groupByPage(annotations)) {
    const page = pages[pageNum - 1];
    if (!page) continue;
    const H = page.getHeight();
    const ctx = makeDrawContext(doc, H, 0, 0, shared, /* drawNoteText */ true);
    for (const a of list) await drawAnnotationOn(page, a, ctx);
  }

  return doc.save();
}

/* ------------------------------------------------------------------ *
 *  B. Real annotation objects (interoperable)                         *
 * ------------------------------------------------------------------ */

// Bounding box (store space, top-left origin) an annotation's geometry
// occupies, padded so its drawn appearance (stroke width, arrowheads) isn't
// clipped by the appearance stream's /BBox.
function annotBoundsOriginal(a) {
  if (a.rect) return { ...a.rect };
  const pts = [];
  if (a.points) pts.push(...a.points);
  if (a.quads) for (const q of a.quads) for (let i = 0; i < 8; i += 2) pts.push([q[i], q[i + 1]]);
  if (!pts.length) return { x: 0, y: 0, w: 0, h: 0 };
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of pts) {
    minX = Math.min(minX, x); minY = Math.min(minY, y);
    maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

// Same box, padded and converted to PDF space (bottom-left origin) — this is
// exactly the annotation's eventual /Rect.
function annotBBoxPdf(a, H) {
  const b = annotBoundsOriginal(a);
  const pad = a.type === 'note' ? 2 : a.type === 'freetext' ? 4
    : (a.strokeWidth || 2) / 2 + (a.type === 'arrow' ? 10 : 2);
  const x0 = b.x - pad, y0 = b.y - pad, x1 = b.x + b.w + pad, y1 = b.y + b.h + pad;
  return { minX: x0, minY: H - y1, maxX: x1, maxY: H - y0 };
}

// PDF markup QuadPoints order is TL, TR, BL, BR (§8.4.5, Table 179) — note
// the swap of the last two corners vs. reading them off a rectangle in order.
function quadPointsPdf(quads, H) {
  const out = [];
  for (const q of quads) {
    const left = Math.min(q[0], q[6]);
    const right = Math.max(q[2], q[4]);
    const top = H - Math.min(q[1], q[3]);
    const bottom = H - Math.max(q[5], q[7]);
    out.push(round2(left), round2(top), round2(right), round2(top), round2(left), round2(bottom), round2(right), round2(bottom));
  }
  return out;
}

function buildAnnotFields(a, bbox, apRef, H) {
  const common = {
    Type: 'Annot',
    Rect: [round2(bbox.minX), round2(bbox.minY), round2(bbox.maxX), round2(bbox.maxY)],
    F: 4, // Print
    CA: a.opacity ?? 1,
    C: colorComponents(a.color),
    M: PDFString.fromDate(new Date(a.updatedAt || Date.now())),
    CreationDate: PDFString.fromDate(new Date(a.createdAt || Date.now())),
    AP: { N: apRef },
  };
  if (a.author) common.T = PDFHexString.fromText(String(a.author));

  switch (a.type) {
    case 'highlight':
      return { ...common, Subtype: 'Highlight', QuadPoints: quadPointsPdf(a.quads || [], H) };
    case 'underline':
      return { ...common, Subtype: 'Underline', QuadPoints: quadPointsPdf(a.quads || [], H) };
    case 'strike':
      return { ...common, Subtype: 'StrikeOut', QuadPoints: quadPointsPdf(a.quads || [], H) };
    case 'ink':
      return {
        ...common, Subtype: 'Ink',
        InkList: [(a.points || []).flatMap(([x, y]) => [round2(x), round2(H - y)])],
      };
    case 'rect':
      return { ...common, Subtype: 'Square', BS: { W: a.strokeWidth || 2 } };
    case 'ellipse':
      return { ...common, Subtype: 'Circle', BS: { W: a.strokeWidth || 2 } };
    case 'line':
    case 'arrow': {
      const [p1, p2] = a.points;
      const fields = {
        ...common, Subtype: 'Line',
        L: [round2(p1[0]), round2(H - p1[1]), round2(p2[0]), round2(H - p2[1])],
        BS: { W: a.strokeWidth || 2 },
      };
      if (a.type === 'arrow') fields.LE = ['None', 'OpenArrow'];
      return fields;
    }
    case 'freetext':
      // DA / DR (the font resource it names) are filled in by the caller,
      // which is where the actual font gets embedded — see buildInteropPdf.
      return { ...common, Subtype: 'FreeText', Contents: PDFHexString.fromText(a.text || '') };
    case 'note':
      // Real Text (sticky-note) annotations are icon-only appearances; the
      // body lives in /Contents and viewers show it in their own popup UI.
      return { ...common, Subtype: 'Text', Name: 'Comment', Open: false, Contents: PDFHexString.fromText(a.text || '') };
    case 'image':
      return { ...common, Subtype: 'Stamp', Name: 'ImageStamp' };
    default:
      return { ...common, Subtype: 'Square' };
  }
}

export async function buildInteropPdf(originalBytes, annotations) {
  await ensurePdfLib();
  const doc = await PDFDocument.load(originalBytes, { ignoreEncryption: true });
  const pages = doc.getPages();
  // A scratch document hosts one small page per annotation; each page is
  // drawn on with the normal high-level pdf-lib API (so opacity, fonts and
  // images are all handled the same way as flatten), then embedded into the
  // real document as a Form XObject via `embedPage` and wired up as that
  // annotation's /AP /N. Never saved — only used as a source for embedPage.
  const scratch = await PDFDocument.create();
  const apShared = {}; // fonts/images embedded on the scratch doc, for appearance streams
  const drShared = {}; // fonts embedded on the real doc, for FreeText's /DR

  for (const [pageNum, list] of groupByPage(annotations)) {
    const page = pages[pageNum - 1];
    if (!page) continue;
    const H = page.getHeight();

    for (const a of list) {
      const bbox = annotBBoxPdf(a, H);
      const w = Math.max(1, round2(bbox.maxX - bbox.minX));
      const h = Math.max(1, round2(bbox.maxY - bbox.minY));
      const scratchPage = scratch.addPage([w, h]);
      const ctx = makeDrawContext(scratch, H, bbox.minX, bbox.minY, apShared, /* drawNoteText */ false);
      await drawAnnotationOn(scratchPage, a, ctx);

      const embedded = await doc.embedPage(scratchPage);
      const fields = buildAnnotFields(a, bbox, embedded.ref, H);
      if (a.type === 'freetext') {
        const standardFont = standardFontFor(a.fontFamily, a.bold, a.italic);
        const font = await embedFontVariant(doc, drShared, standardFont);
        fields.DR = { Font: { Fnt: font.ref } };
        fields.DA = PDFString.of(`${colorComponents(a.color).join(' ')} rg /Fnt ${a.fontSize || 14} Tf`);
      }

      const ref = doc.context.register(doc.context.obj(fields));
      page.node.addAnnot(ref);
    }
  }

  return doc.save();
}
