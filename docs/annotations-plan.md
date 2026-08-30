# PDF Annotations — Implementation Plan

Status: **Phases 1–3 shipped** (2026-08-29) — store + undo/redo, per-page SVG/HTML
render layer, full tool set (select/move/resize/delete, highlight/underline/
strike, pen, rect, ellipse, line, arrow, text, note, eraser, image stamp),
style popover, sidecar autosave, flatten export, real PDF annotation objects
with appearance streams (`buildInteropPdf`), apply-to-original, and
file-changed reconciliation (banner on open when the PDF moved on since the
sidecar was last saved).

Implementation lives in `src/renderer/annotations/` (`store.js`, `layer.js`,
`tools.js`, `export.js`, `index.js`).
Last updated: 2026-08-29.

Goal: annotation tools comparable to mainstream PDF editors — highlight/underline/
strikethrough, freehand pen, shapes, text boxes, sticky notes — that persist,
are editable inside this app, and can be written back into a PDF.

---

## 1. Core architectural constraint

`src/renderer/viewer.js` **destroys and recreates page DOM continuously**:

- `releasePage()` (`viewer.js` ~369) tears down any page more than `RENDER_BUFFER`
  (2) pages outside the viewport.
- `rerenderVisible()` wipes and re-renders every live page on zoom / fit change.

So annotations **cannot** use the page DOM as their source of truth. Required
shape:

1. A **model** that outlives page DOM (nothing in the app does this today).
2. A **render layer** rebuilt from the model each time a page renders — the exact
   pattern `renderTextLayer()` already establishes (`viewer.js` ~341).

Everything below follows from this.

---

## 2. Coordinate system

Store **all** geometry in **PDF points, page user space, top-left origin** — the
units already captured in `baseViewports[n]` (`viewer.js` ~148, viewport at
`scale: 1`).

- **Render:** each page gets
  `<svg class="annot-layer" viewBox="0 0 {baseW} {baseH}" preserveAspectRatio="xMidYMid meet">`
  sized by CSS to the page's pixel box (`position:absolute; inset:0`).
  → Zoom / fit need **zero** rescaling: the viewBox handles it.
  → Stroke widths are in points and scale uniformly.
- **Export:** pdf-lib uses bottom-left origin, same point units, so
  `pdfY = pageHeight - y`. One flip, no scale math.

Text-bearing annotations (freetext, note popups) are HTML elements positioned
with percentages (`left: x / baseW * 100%`); their `font-size` is the only value
that must be recomputed on zoom (in `relayoutPages()`, `viewer.js` ~241).

---

## 3. Data model — `src/renderer/annotations/store.js` (new)

```js
Annotation = {
  id,                 // nanoid / crypto.randomUUID()
  page,               // 1-based page number
  type,               // 'highlight' | 'underline' | 'strike' | 'ink'
                      // | 'rect' | 'ellipse' | 'line' | 'arrow'
                      // | 'freetext' | 'note'

  // geometry — points, top-left origin; which field is set depends on type:
  quads,              // [[x1,y1,x2,y2,x3,y3,x4,y4], ...]  text markup (per line)
  points,             // [[x,y], ...]                      ink / line / arrow
  rect,               // { x, y, w, h }                    rect/ellipse/freetext/note

  // style:
  color,              // '#rrggbb'
  opacity,            // 0..1
  strokeWidth,        // points
  text,               // freetext / note body
  fontSize,           // points
  data,               // image: PNG data URL (see §7, image stamps)

  // freetext only — whole-annotation (not per-run) rich text:
  bold, italic, underline, // booleans
  align,              // 'left' | 'center' | 'right'
  fontFamily,         // 'helvetica' | 'times' | 'courier' — see export.js
                      // `standardFontFor` (-> pdf-lib StandardFonts) and
                      // layer.js `FONT_STACKS` (-> CSS font stack)

  // meta:
  author,             // from window user / OS username via IPC
  createdAt,
  updatedAt,
}
```

Store responsibilities:

- `Map<pageNumber, Annotation[]>`.
- CRUD + `subscribe(pageNumber, cb)` — a mounted layer re-renders when its page's
  annotations change.
- **Undo/redo**: snapshot the affected page's array before each mutation onto an
  undo stack (counts are small; snapshots are simpler and more correct than
  inverse-op replay).
- `dirty` flag + debounced (~1s) autosave to the sidecar (section 6).

---

## 4. Render layer — `src/renderer/annotations/layer.js` (new)

`mountAnnotationLayer(pageNumber, pageDiv, baseViewport)` builds an SVG plus an
HTML sibling for text-bearing annotations.

| Type                        | Rendered as |
|-----------------------------|-------------|
| highlight                   | `<rect>` per quad, `fill=color`, `mix-blend-mode: multiply` so canvas text shows through |
| underline / strike          | `<line>` per quad (baseline / mid) |
| ink                         | `<path>` with Catmull-Rom smoothing; simplify points (Douglas–Peucker) on commit |
| rect / ellipse              | native SVG elements |
| line / arrow                | `<line>` (+ `<marker>` for the arrowhead) |
| freetext                    | HTML `<div contenteditable>` over the SVG (SVG text editing is unusable) |
| note                        | small SVG pin + an HTML popup panel toggled on click |

**Selection / manipulation** (Select tool): clicking an annotation shows a
bounding box with 8 resize handles + a move region; drag updates the model;
`Delete` / `Backspace` removes. Handles stay a fixed screen size via a
counter-scaled `<g>` or `vector-effect="non-scaling-stroke"` + fixed-radius
circles drawn in screen units.

**viewer.js hooks** (small, additive):

- `pageState` entries gain `annotLayer: null` (`viewer.js` ~229).
- `renderPage()`: after `renderTextLayer(...)`, `mountAnnotationLayer(...)`
  (`viewer.js` ~329).
- `releasePage()`: unmount the layer; **model is untouched** (`viewer.js` ~369).
- `closeDocument()`: flush autosave, clear the store (`viewer.js` ~169).
- `loadDocument()`: load the sidecar for the newly opened file (`viewer.js` ~99).

**z-order per page:** canvas (bottom) → text layer → annotation SVG → freetext/
note HTML (top). Highlights use `multiply` blending so they read as sitting under
the text.

---

## 5. Tools & toolbar — `src/renderer/annotations/tools.js` (new)

A second toolbar row (or a left rail) in `index.html`, visible only with a
document open:

`Select · Highlight · Underline · Strikethrough · Pen · Rectangle · Ellipse ·
Line · Arrow · Text · Note · Eraser`

plus a **style popover**: colour swatches, stroke width, opacity, font size —
edits the active tool's defaults and the current selection.

- Each tool is a small pointer state-machine. When a drawing tool is active, the
  **top** visible page's annotation SVG gets `pointer-events: all` and captures
  `pointerdown/move/up`. In Select mode the SVG is click-through except over
  existing annotations.
- **Text-markup tools reuse the existing text layer.** On `mouseup` with a range
  inside `.textLayer`: take `range.getClientRects()`, convert each to a page
  quad, create the annotation, clear the selection. Add Highlight / Underline /
  Strike buttons to the existing floating selection bar (`viewer.js` ~806) — the
  most natural entry point, low cost.
- **Eraser** v1 = delete whole stroke on hit (stroke-splitting later).
- `Esc` / right-click → back to Select.

---

## 6. Persistence

### Live editing → sidecar JSON (non-destructive, survives restart)

`userData/annotations/<sha1(absolutePath)>.json`:

```json
{ "path": "...", "size": 12345, "mtimeMs": 1699999999999, "annotations": [ ... ] }
```

On open: load it. If `size` / `mtimeMs` differ from the file on disk, keep the
annotations but show a "file changed since these notes were made" banner.
Debounced autosave via new IPC.

### Write into a PDF — new `File` menu items

- **Save Annotated Copy As…** → pdf-lib builds a new file → save dialog → open it.
- **Apply Annotations to Original** (confirm dialog) → overwrite in place.
- Unsaved *sidecar* state is silent (autosaved). Unsaved-vs-PDF state gets a dot
  indicator, no nagging.

### New IPC (`src/main/main.js`, `src/main/preload.js`)

- `annots:load(path)` → sidecar contents or `null`
- `annots:save(path, payload)` → write sidecar
- `annots:export({ defaultName, data })` → save dialog + write + open
  (reuse the `build:save` pattern, `main.js` ~365)

---

## 7. Export — `src/renderer/annotations/export.js` (new)

Two modes; "like all PDF editors" means both eventually matter.

### A. Flatten (default, universal)

Draw annotations onto page content with pdf-lib: `drawRectangle`, `drawEllipse`,
`drawLine`, `drawSvgPath` (ink), `drawText` (freetext). Renders identically in
every viewer; not re-editable outside this app. ~1 day.

### B. Real annotation objects (interoperable, re-editable in Acrobat/Preview)

Hand-build annotation dictionaries into each page's `/Annots` array via pdf-lib's
low-level `context.obj` / `PDFDict`. Feasible for `Highlight`, `Ink`, `Square`,
`Circle`, `Line`, `FreeText`, `Text`. Each needs a correct dict **and** an
appearance stream (`/AP`) so non-Acrobat viewers render it. This is the bulk of
the effort (~3–4 days, fiddly, needs cross-viewer testing).

**Decision:** ship **A** in Phase 1; add **B** in Phase 3. The sidecar keeps
annotations editable in this app regardless.

---

## 8. Phasing

| Phase | Scope | Rough effort |
|-------|-------|--------------|
| **1** | Store + undo/redo; SVG layer; viewer.js hooks; Select/move/delete; Highlight (via selection bar); Pen; Note; sidecar persistence; flatten export | ~3–4 days |
| **2** | Rect / ellipse / line / arrow; FreeText; underline / strikethrough; style popover; eraser; full annotation toolbar | ~2–3 days |
| **3** | ✅ Real PDF annotation dicts + appearance streams (interop); image stamps; "apply to original"; file-changed reconciliation | ~4–5 days |

---

## 9. New / touched files

```
NEW  src/renderer/annotations/store.js    model, undo/redo, persistence bridge
NEW  src/renderer/annotations/layer.js    per-page SVG/HTML render + manipulation
NEW  src/renderer/annotations/tools.js    toolbar + per-tool pointer state machines
NEW  src/renderer/annotations/export.js   pdf-lib flatten (P1) + real dicts (P3)

EDIT src/renderer/viewer.js     ~4 lifecycle hooks + selection-bar markup buttons
EDIT src/renderer/index.html    annotation toolbar, style popover
EDIT src/renderer/styles.css    toolbar, layer, handles, popover
EDIT src/main/main.js           3 IPC handlers + File-menu items
EDIT src/main/preload.js        expose the 3 IPC calls
```

pdf-lib is already a dependency (vendored to `src/renderer/vendor/pdf-lib.esm.js`
by `scripts/copy-pdfjs.js`).

---

## 10. Open questions

1. **Export default** — ✅ resolved: `Export…` (toolbar) and File ▸ *Save
   Annotated Copy As…* now default to real annotation objects
   (`buildInteropPdf`); flatten lives on as File ▸ *Save Flattened Copy As…*
   for the "must render identically everywhere, don't care about
   re-editability" case.
2. **Persistence location** — ✅ resolved: sidecar in `userData/annotations/`,
   keyed by `sha1(absolutePath)` — automatic, non-destructive, invisible.
3. **Toolbar placement** — ✅ resolved: second toolbar row.
4. **Ink input** — not revisited; still plain pointer events (no coalesced
   events / pressure). Fine in practice — leave as a future polish item.

---

## 11. Risks / notes

- Selection-handle hit targets vs. the viewBox scaling — needs the counter-scale
  trick; get this right early.
- Highlight quads from `getClientRects()` can be split oddly across styled spans;
  merge adjacent rects on the same text line before storing.
- Large ink strokes: simplify on commit or the SVG path data and the flattened
  output both bloat.
- `mix-blend-mode: multiply` interaction with the page `box-shadow` / white page
  background — verify it composites against the page, not the canvas backdrop.
- Rotation: the viewer has no page-rotation feature today, so ignore rotation for
  now; revisit if it lands.

## 12. Phase 3 implementation notes

- **`buildInteropPdf` (export.js)** builds real `/Annots` entries with
  appearance streams by drawing each annotation's appearance onto its own
  tiny scratch page (sized to a padded bounding box, via a throwaway
  `PDFDocument.create()`), using the *same* high-level pdf-lib drawing calls
  as `flattenToPdf` (`drawRectangle`, `drawText`, etc. — shared via
  `drawAnnotationOn`), then embedding that scratch page into the real
  document as a Form XObject with `doc.embedPage()` and wiring it up as the
  annotation dict's `/AP /N`. This sidesteps hand-writing PDF content-stream
  operators entirely — pdf-lib already handles opacity (`ExtGState`), fonts,
  and images correctly through the normal drawing API.
  Verified by round-tripping a generated PDF back through `PDFDocument.load`
  and inspecting `/Annots`, `/Subtype`, `/Rect`, and the `/AP /N` Form
  XObject's `/BBox` / `/Resources` / content stream.
- Text-bearing fields that must be a PDF string (`/Contents`, `/T`) are
  wrapped in `PDFHexString.fromText()` (safe for arbitrary/Unicode text —
  `PDFString.of()` does *not* escape parens/backslashes); `/DA` is
  `PDFString.of()` since we generate that string ourselves. Everything else
  goes through `context.obj()`, where a bare JS string becomes a `PDFName`
  — exactly what `/Type`, `/Subtype`, `/Name`, `/LE` etc. need.
  Markup `/QuadPoints` order is TL, TR, **BL, BR** (spec Table 179) — easy
  to get backwards reading corners off a rectangle in the obvious order.
- A real `Text` (sticky-note) annotation's `/AP` is icon-only; the note body
  goes in `/Contents` for the viewer's own popup chrome. `flattenToPdf` keeps
  baking the body next to the icon since flatten has no popup mechanism —
  see the `drawNoteText` flag threaded through `drawAnnotationOn`.
- **Image stamps**: picked via `annots:pickImage` (main-process file dialog,
  image-only filter) → read as bytes → drawn through an offscreen `<canvas>`
  and re-encoded as PNG (`pickAndArmImage`, index.js) so the stored
  annotation `data` is always a PNG data URL regardless of source format —
  export never has to branch on mime type (`doc.embedPng` only). Placement
  is pick-then-place: the Image toolbar button requests a pick
  (`onPickImageRequest`), and only arms the `image` tool
  (`tools.armImage`) once a file is actually chosen.
- **Apply to Original** (`annots:applyToOriginal`, main.js) writes a
  `buildInteropPdf` build over the original file after a `window.confirm`,
  keeping a best-effort `.bak` alongside. Since this app never renders a
  PDF's native `/Annots` (only its own sidecar-driven overlay), the on-screen
  page content is unaffected — only the sidecar's own change-detection
  baseline (`size`/`mtimeMs`) needs an explicit re-save afterward
  (`_persistMetaOnly`), or the next open would wrongly flag the file as
  changed against its own annotations.
- **File-changed reconciliation**: `annots:load` now stats the PDF and
  compares against the sidecar's recorded `size`/`mtimeMs`, returning a
  `fileChanged` flag; `setDocument()` shows a dismissible banner
  (`#annot-banner`) when it's set and there are annotations to warn about.
  Annotations are kept either way — this is advisory, not a diff/reconcile.

## 13. FreeText rich text (bold/italic/underline/align/font, per-box)

Formatting is whole-annotation, not per-run/character — matches most
lightweight PDF text-box tools (Preview.app, Acrobat's basic Text Box) and
avoids the complexity of a real rich-text editing model in a
`contenteditable` div. Style popover gains a `.asp-text-group` (font family
select, B/I/U toggle buttons, alignment buttons), visible only when the Text
tool is active or a freetext annotation is selected (`tools._isTextContext`).

- `fontFamily` is one of 3 keys (`helvetica`/`times`/`courier`) — enough
  variety without loading real font files; each resolves to a pdf-lib
  `StandardFonts` variant (`export.js` `standardFontFor`, combining with
  `bold`/`italic` — note Helvetica/Courier's italic is called "Oblique",
  Times' is "Italic") and to a CSS stack for the live preview (`layer.js`
  `FONT_STACKS`).
- Both export paths draw freetext manually now (no more relying on
  `page.drawText`'s built-in wrapping/alignment, which is always left-aligned
  and has no underline): line-break with pdf-lib's own exported
  `breakTextIntoLines(text, doc.defaultWordBreaks, maxWidth, widthFn)`
  (the same wrapper `drawText` uses internally), then per line compute an
  x-offset from `font.widthOfTextAtSize()` for center/right alignment, and
  draw a manual underline stroke under each non-blank line.
- Interop's `/DA` (default appearance, used if a viewer regenerates its own
  appearance on edit) and `/DR` (the font resource `/DA` names) are built by
  the caller (`buildInteropPdf`), not `buildAnnotFields`, since they need the
  actual embedded font ref — `buildAnnotFields` only handles the parts that
  don't need an async embed.

Two bugs fixed after the initial pass:

- The popover's text-only control group used `element.hidden = …` to show/
  hide itself, but also had its own `display: flex` CSS rule — a plain
  author-stylesheet `display` always beats the UA stylesheet's
  `[hidden] { display: none }` (no `!important` there), so the toggle was a
  silent no-op and the group just stayed visible. Fixed by using a dedicated
  `.asp-text-group-collapsed { display: none }` class instead of `.hidden`.
- Placing a freetext box auto-deletes it on blur if it's still empty (so
  clicking away without typing anything doesn't leave a stray box) — but
  that also fired when the user clicked the style popover to set color/font/
  bold *before* typing a word, deleting the box out from under them. Fixed
  in `layer.js`'s blur handler: check `e.relatedTarget` and skip the
  empty-delete when focus is moving into `#annot-style` / `#annot-style-btn`.
