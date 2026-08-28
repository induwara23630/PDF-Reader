# Simple PDF Viewer

A clean, minimal desktop app for reading existing PDF files — built with
[Electron](https://www.electronjs.org/) and [Mozilla PDF.js](https://mozilla.github.io/pdf.js/).

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
- Remembers window size/position

## Requirements

- Node.js 18+ and npm

## Develop / run

```bash
npm install
npm start
```

`npm start` first copies the PDF.js runtime (`pdf.mjs`, `pdf.worker.mjs`, cmaps,
standard fonts) from `node_modules` into `src/renderer/vendor/` via
`scripts/copy-pdfjs.js`, then launches Electron.

## Build a Windows installer

```bash
npm run dist        # NSIS installer + portable .exe in dist/
npm run dist:dir    # unpacked build in dist/win-unpacked/ (fast, for testing)
```

`electron-builder` is configured (in `package.json` → `build`) to also register
the app as a `.pdf` file handler; after installing, pick it via Windows
*Settings → Default apps* or *Open with*.

To ship a custom app icon, add `assets/icon.ico` (256×256) and set
`build.win.icon` in `package.json`.

## Project layout

| Path | Purpose |
| --- | --- |
| `src/main/main.js` | Electron main process: window, native menu, IPC, recent files, "open with" |
| `src/main/preload.js` | `contextBridge` — exposes a minimal `window.api` |
| `src/renderer/index.html` | Toolbar + sidebar + scroll viewport shell |
| `src/renderer/styles.css` | Acrobat-like light theme (colors are CSS variables) |
| `src/renderer/viewer.js` | PDF.js integration: rendering, zoom, navigation, thumbnails |
| `scripts/copy-pdfjs.js` | Copies the PDF.js runtime into `src/renderer/vendor/` |

## Not included (yet)

Text search/selection, annotations, printing, form filling, editing. The render
pipeline leaves room to add a PDF.js text layer for search later.
