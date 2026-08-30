# Document Export — Design Notes

Status: **Shipped** (2026-08-30). Tools ▸ Export… (`Ctrl+E`), or `Tools →
Export…`, opens a dialog with four output formats and a page-range picker.

Implementation lives in `src/renderer/export/`.

## Formats and their fidelity

| Format | File | Fidelity |
|---|---|---|
| Images (PNG/JPEG) | `images.js` | Exact — rasterizes via the same pdf.js render path the viewer already uses. |
| PDF (page subset) | `pdf-pages.js` | Exact — pdf-lib `copyPages`, no re-rendering. |
| Word (.docx) | `docx-export.js` + `text-layout.js` | Best-effort reconstruction — see below. |
| Excel (.xlsx) | `xlsx-export.js` + `text-layout.js` | Best-effort reconstruction — see below. |

PDF has no structural concept of a paragraph, heading, or table cell — it's
just glyphs positioned in page space (`Tj`/`TJ` operators at `Tm`-set
coordinates). Anything claiming to export "correct formatting" to Word/Excel
is therefore always a **guess** at structure, reconstructed from glyph
positions and font metadata. This was an explicit, discussed trade-off (the
user chose "best-effort layout reconstruction" over "plain text only" when
this was scoped) — the dialog's own copy says as much ("not a structural
copy... less reliably on complex layouts, multi-column text, or scanned
pages") so the limitation is visible at the point of use, not just here.

## Shared extraction — `text-layout.js`

Both Word and Excel exporters need the same first step: turn `pdf.js`
`getTextContent()` items into styled lines. Key mechanics:

- **Coordinates**: pdf.js text items' `transform[4]/[5]` are raw PDF user
  space (bottom-left origin) — matches the store convention used elsewhere
  in this app (see `docs/annotations-plan.md` §2), no viewport/zoom
  involved.
- **Bold/italic/font family**: `textContent.styles[fontName].fontFamily` is
  USELESS for this (`pdf.js` collapses it to a generic CSS fallback like
  `"sans-serif"` regardless of the real font). The real per-font flags live
  on `page.commonObjs.get(fontName)` (`.bold`, `.italic`, `.name` — pdf.js's
  own font-flag parsing, not a heuristic we wrote) — but that object is only
  populated as a side effect of running the page's operator list, i.e.
  *rendering*. `primeFonts()` does a throwaway canvas render purely to
  populate `commonObjs` before reading `getTextContent()`.
- **Lines**: cluster items by y-proximity (tolerant of a fraction of the
  item's own font size).
- **Runs**: within a line, sort by x and merge adjacent same-styled items —
  *except* across a gap wider than ~2× the font size, which stays a
  separate run even when the style matches. This matters a lot: a table's
  header row cells are very often the same style (e.g. all bold), and
  without that gap check they'd merge into one run and lose the individual
  x-positions xlsx-export.js needs for column detection.
- **Word-gap insertion**: pdf.js's raw items already include standalone
  whitespace items sometimes, but they're filtered out (unreliable, and the
  gap between two real content items already tells us what we need) — a
  small *absolute* gap threshold (0.5pt, not scaled by font size) between
  consecutive items decides whether to insert a space. Absolute rather than
  proportional because a missed space ("boldand") reads far worse than a
  spurious one — err toward inserting.

## Word (`docx-export.js`)

- **Body size**: the mode (most common) rounded line size across the
  export.
- **Headings**: a line's `size / bodySize` ratio ≥ 1.6 / 1.3 / 1.15 maps to
  Heading 1 / 2 / 3. A heading is always its own paragraph.
- **Paragraphs**: consecutive body-sized lines merge into one paragraph
  unless the vertical gap to the previous line exceeds ~1.6× the page's
  median single-line gap (i.e. "noticeably bigger than normal line
  spacing").
- **Page breaks**: a PDF page's first line always forces a new paragraph
  with `pageBreakBefore`, so exported pages stay roughly aligned to the
  source PDF's.
- **Alignment**: centered only for a short, single-line paragraph that's
  visibly centered on the page (titles) — deliberately conservative, so
  ordinary left/justified body copy is never misjudged as centered.
- **Tables are not reconstructed as Word tables** — that content just reads
  as space-joined text in paragraph form. Scope boundary: real `w:tbl`
  generation from heuristic column detection was judged not worth the
  complexity given Excel already covers the tabular case.
- `/DA` and `/DR`-equivalent concerns don't apply here (that's a PDF
  interop.js thing) — `docx`'s `Packer.toBlob()` is used directly (browser
  API; `toBuffer()` needs Node's `Buffer`, unavailable in the renderer since
  `nodeIntegration: false`).

## Excel (`xlsx-export.js`)

- One sheet per exported page (named `Page N`).
- **Column bins**: every run's `x0` across the whole page, sorted and merged
  into bins within `max(8, bodySize × 1.2)` points of each other — the
  shared column grid every row snaps to.
- Each line becomes a row; each run's text lands in its nearest column bin
  (joined with a space if two runs land in the same bin).
- This works well on a PDF that *is* a real grid-like table. On ordinary
  prose sharing a page with a table (or on prose alone), column bins pick up
  noise from paragraph text and produce a sparse, messy sheet — inherent to
  clustering positions with no real structure to find. Tested against a
  synthetic PDF mixing a title + prose + a 2-column table on one page: the
  table's own columns still separated correctly (`Name`/`Score`,
  `Alice`/`90`, `Bob`/`85`), with an extra empty column as noise from the
  prose above — an acceptable, expected outcome for "best effort."

## Vendoring

`docx` and `xlsx` (SheetJS) both ship self-contained ESM bundles
(`dist/index.mjs`, `xlsx.mjs`) with no bare imports — copied into
`src/renderer/vendor/` by `scripts/copy-pdfjs.js`, same pattern as
`pdf-lib.esm.js`. `Buffer`/`require` references inside both are
feature-detected (`typeof Buffer === "function"`, etc.) and dead in a
browser/renderer context (no Node integration) — verified by grep before
vendoring, not just assumed.

`jszip` (zipping multi-page image exports) only ships a UMD build, no ESM —
loaded as a classic `<script src="./vendor/jszip.js">` in `index.html`
(before the module scripts) and referenced as `window.JSZip`.

`xlsx`'s npm-registry package has two known, unpatched CVEs (prototype
pollution and a ReDoS), both specifically in *parsing* untrusted
xlsx/csv/etc. input. This app never calls `XLSX.read`/`readFile` — only
`utils.aoa_to_sheet` + `write`, building sheets from our own extracted data
— so that surface is unreachable here. (SheetJS's patched builds are only
published to their own CDN, not npm; this environment's npm policy blocks
fetching arbitrary remote tarballs, so the registry version was kept
deliberately rather than routed around that policy.)

## IPC

- `export:save` (`main.js`) — generic "show a save dialog, write these
  bytes" for any of the four formats, parameterized by filter
  name/extensions. Deliberately does **not** call `sendOpenFile()` like
  `build:save` does (Create PDF) — none of these outputs besides the PDF
  subset are something this app can display, and even the PDF-subset
  export is a deliberately separate file the user asked to save, not
  something to jump into.

## UI

One dialog (`#export-dialog`, `src/renderer/export/index.js`), not four
separate flows — format tabs, a page-range picker (all / current / custom
`"1-3, 5"` via `page-range.js`), and image-only options (PNG/JPEG,
1x/2x/4x). Triggered from Tools ▸ Export… (`Ctrl+E`); needs an open
document (`exportDialog.open()` no-ops otherwise, same convention as the
rest of this app's menu items rather than dynamically disabling the menu
entry).
