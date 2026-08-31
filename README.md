# BPDF Reader

A clean, minimal desktop app for reading existing PDF files — built with
[Electron](https://www.electronjs.org/), [Mozilla PDF.js](https://mozilla.github.io/pdf.js/),
and [pdf-lib](https://pdf-lib.js.org/).

## Features

- Open PDFs via **File → Open**, the toolbar button, **drag-and-drop**, or a
  **Recent Files** list on the welcome screen
- Continuous vertical scroll with lazy page rendering (memory stays flat on large
  documents)
- Page navigation: Prev/Next, "page _n_ of _N_" jump box, `PageUp`/`PageDown`,
  `Home`/`End`, arrow keys
- Zoom: toolbar buttons, editable `%` field, `Ctrl`/`Cmd` + mouse wheel to zoom
  toward the cursor, `Ctrl+0` actual size
- **Fit Width** / **Fit Page**
- Collapsible thumbnail sidebar (`Ctrl+B`) with active-page highlight
- **Text selection** — select text in PDFs that contain it; a floating **Copy**
  bar appears above the selection, and `Ctrl/Cmd+C` / **Edit → Copy** also work
- **Annotations** — a second toolbar row (visible with a document open) with
  Select/move/resize/delete, **Highlight / Underline / Strikethrough** (from the
  toolbar or the floating selection bar), **Pen**, **Rectangle**, **Ellipse**,
  **Line**, **Arrow**, **Text box**, **Sticky note**, and **Eraser**, plus a
  colour/stroke/opacity/font-size style popover and undo/redo (`Ctrl/Cmd+Z`,
  `Ctrl/Cmd+Shift+Z`). Annotations autosave to a sidecar file in the app's
  `userData` folder (keyed by the PDF's path) and reload automatically.
  **File → Save Annotated Copy As…** (`Ctrl/Cmd+Shift+S`) writes a flattened copy
  with the annotations baked into the page content.
- **Create PDF** (**Tools → Create PDF…**, `Ctrl/Cmd+Shift+N`) — combine any mix
  of PDF files and images (PNG/JPEG/WebP/GIF/BMP) into one document; add via the
  file picker or drag-and-drop, reorder rows by dragging or the ▲/▼ buttons, then
  export. The result opens in the viewer.
- **Tabs** — PDFs open as tabs in one window (like a browser). **File → New
  Tab** (`Ctrl/Cmd+T`), `Ctrl/Cmd+W` closes the active tab, `Ctrl/Cmd+Tab`
  cycles. Drag a tab **down off the strip** to pop it into its own window, or
  drag it **onto another window's tab strip** to merge it there — the tab
  keeps its exact state (scroll, zoom, annotations) across the move.
  **File → New Window** (`Ctrl/Cmd+N`) opens an empty one. A background tab
  left untouched for a while is put to sleep (its process is freed) and
  reloads where you left off when you click it.
- **Light / dark theme** — follows the Windows setting by default; override
  from the toolbar's theme button or **View → Theme**.
- Remembers window size/position

## Requirements

- Node.js 18+ and npm

## Develop / run

```bash
npm install
npm start
```

`npm start` first copies the vendored runtimes (PDF.js — `pdf.mjs`,
`pdf.worker.mjs`, cmaps, standard fonts — plus `pdf-lib.esm.js`) from
`node_modules` into `src/renderer/vendor/` via `scripts/copy-pdfjs.js`, then
launches Electron.

## Build a Windows installer

```bash
npm run dist        # NSIS installer + portable .exe in dist/
npm run dist:dir    # unpacked build in dist/win-unpacked/ (fast, for testing)
```

`electron-builder` is configured (in `package.json` → `build`) to also register
the app as a `.pdf` file handler; after installing, pick it via Windows
*Settings → Default apps* or *Open with*. See `docs/distribution.md` for the
full walkthrough, including why the installer can't set itself as default
automatically (Windows doesn't allow that — only the user can).

The app icon is `assets/icon.ico` (multi-resolution) / `assets/icon.png`
(1024×1024 source), referenced via `build.win.icon` in `package.json`. To
regenerate it after changing the design, see `docs/distribution.md`.

## Project layout

| Path | Purpose |
| --- | --- |
| `src/main/main.js` | Electron main process: window, native menu, IPC, recent files, "open with" |
| `src/main/preload.js` | `contextBridge` — exposes a minimal `window.api` |
| `src/renderer/index.html` | Toolbar + sidebar + scroll viewport shell |
| `src/renderer/styles.css` | Acrobat-like light theme (colors are CSS variables) |
| `src/renderer/viewer.js` | PDF.js integration: rendering, zoom, navigation, thumbnails, text selection |
| `src/renderer/annotations/` | Annotation store (model + undo/redo + autosave), per-page SVG/HTML render layer, toolbar/tools, and pdf-lib flatten export |
| `src/renderer/create-pdf.js` | "Create PDF" tool: the combine dialog and pdf-lib merge/image logic |
| `scripts/copy-pdfjs.js` | Copies the PDF.js + pdf-lib runtimes into `src/renderer/vendor/` |

## Not included (yet)

In-document find, printing, form filling, page-level editing
(rotate/delete/reorder pages of an open document), and OCR for scanned/image-only
PDFs (text selection needs the PDF to already contain text). The per-page text
layer is a natural anchor for adding find next. Annotation export is
flatten-only for now — real PDF annotation objects (re-editable in
Acrobat/Preview) are a later phase.
