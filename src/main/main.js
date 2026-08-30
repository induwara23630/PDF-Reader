'use strict';

const { app, BrowserWindow, Menu, dialog, ipcMain, shell, protocol } = require('electron');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');

const RECENTS_FILE = () => path.join(app.getPath('userData'), 'recent.json');
const ANNOT_DIR = () => path.join(app.getPath('userData'), 'annotations');
const annotSidecar = (pdfPath) =>
  path.join(ANNOT_DIR(), `${crypto.createHash('sha1').update(path.resolve(pdfPath)).digest('hex')}.json`);
const STATE_FILE = () => path.join(app.getPath('userData'), 'window-state.json');
const MAX_RECENTS = 10;

// The renderer is served over a custom, standards-compliant scheme instead of
// file:// so that `fetch()` works (PDF.js loads its cmaps / standard fonts that
// way) and the Content-Security-Policy can stay strict.
const RENDERER_DIR = path.resolve(__dirname, '..', 'renderer');
const APP_ORIGIN = 'app://viewer';

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'app',
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
  },
]);

const MIME = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
};

async function serveRendererFile(request) {
  const url = new URL(request.url);
  let rel = decodeURIComponent(url.pathname);
  if (!rel || rel === '/') rel = '/index.html';
  const full = path.normalize(path.join(RENDERER_DIR, rel));
  if (full !== RENDERER_DIR && !full.startsWith(RENDERER_DIR + path.sep)) {
    return new Response('Forbidden', { status: 403 });
  }
  try {
    const data = await fsp.readFile(full);
    return new Response(data, {
      headers: { 'Content-Type': MIME[path.extname(full).toLowerCase()] || 'application/octet-stream' },
    });
  } catch {
    return new Response('Not found', { status: 404 });
  }
}

/** @type {BrowserWindow | null} */
let mainWindow = null;
/** Path passed on the command line before the window is ready. */
let pendingOpenPath = null;

/* ------------------------------------------------------------------ *
 *  Single-instance handling (so "open with" focuses the live window) *
 * ------------------------------------------------------------------ */

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    const filePath = pdfPathFromArgv(argv);
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
      if (filePath) sendOpenFile(filePath);
    }
  });
}

/* ------------------------------------------------------------------ *
 *  Helpers                                                            *
 * ------------------------------------------------------------------ */

function pdfPathFromArgv(argv) {
  // In a packaged app argv[0] is the exe; in dev it is electron + main.js.
  const args = argv.slice(app.isPackaged ? 1 : 2);
  for (const a of args) {
    if (a && !a.startsWith('--') && a.toLowerCase().endsWith('.pdf') && fs.existsSync(a)) {
      return path.resolve(a);
    }
  }
  return null;
}

async function readRecents() {
  try {
    const raw = await fsp.readFile(RECENTS_FILE(), 'utf8');
    const list = JSON.parse(raw);
    if (!Array.isArray(list)) return [];
    // Drop entries whose file no longer exists.
    return list.filter((p) => typeof p === 'string' && fs.existsSync(p));
  } catch {
    return [];
  }
}

async function writeRecents(list) {
  try {
    await fsp.writeFile(RECENTS_FILE(), JSON.stringify(list, null, 2), 'utf8');
  } catch (err) {
    console.error('Could not persist recent files:', err.message);
  }
}

async function pushRecent(filePath) {
  const abs = path.resolve(filePath);
  let list = await readRecents();
  list = [abs, ...list.filter((p) => p !== abs)].slice(0, MAX_RECENTS);
  await writeRecents(list);
  await rebuildMenu();
  return list;
}

async function loadWindowState() {
  try {
    const raw = await fsp.readFile(STATE_FILE(), 'utf8');
    const s = JSON.parse(raw);
    if (s && Number.isFinite(s.width) && Number.isFinite(s.height)) return s;
  } catch {
    /* ignore */
  }
  return { width: 1100, height: 800 };
}

function saveWindowState() {
  if (!mainWindow) return;
  const bounds = mainWindow.getBounds();
  try {
    fs.writeFileSync(
      STATE_FILE(),
      JSON.stringify({ ...bounds, maximized: mainWindow.isMaximized() }, null, 2),
      'utf8'
    );
  } catch {
    /* ignore */
  }
}

async function readPdf(filePath) {
  const abs = path.resolve(filePath);
  const buf = await fsp.readFile(abs);
  await pushRecent(abs);
  return {
    path: abs,
    name: path.basename(abs),
    data: new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength),
  };
}

function sendOpenFile(filePath) {
  if (mainWindow && mainWindow.webContents) {
    mainWindow.webContents.send('file:open', path.resolve(filePath));
  } else {
    pendingOpenPath = filePath;
  }
}

/* ------------------------------------------------------------------ *
 *  Renderer -> main channel to trigger the "Open" dialog              *
 * ------------------------------------------------------------------ */

async function openViaDialog() {
  const res = await dialog.showOpenDialog(mainWindow, {
    title: 'Open PDF',
    properties: ['openFile'],
    filters: [{ name: 'PDF Documents', extensions: ['pdf'] }],
  });
  if (res.canceled || !res.filePaths.length) return null;
  sendOpenFile(res.filePaths[0]);
  return res.filePaths[0];
}

/* ------------------------------------------------------------------ *
 *  Application menu                                                   *
 * ------------------------------------------------------------------ */

function send(channel, ...args) {
  if (mainWindow && mainWindow.webContents) mainWindow.webContents.send(channel, ...args);
}

async function buildMenuTemplate() {
  const recents = await readRecents();
  const recentItems = recents.length
    ? recents.map((p) => ({ label: p, click: () => sendOpenFile(p) }))
    : [{ label: 'No Recent Files', enabled: false }];

  /** @type {import('electron').MenuItemConstructorOptions[]} */
  const template = [
    {
      label: 'File',
      submenu: [
        { label: 'Open…', accelerator: 'CmdOrCtrl+O', click: () => openViaDialog() },
        {
          label: 'Open Recent',
          submenu: [
            ...recentItems,
            { type: 'separator' },
            {
              label: 'Clear Recent',
              enabled: recents.length > 0,
              click: async () => {
                await writeRecents([]);
                await rebuildMenu();
                send('recents:changed', []);
              },
            },
          ],
        },
        { type: 'separator' },
        {
          label: 'Save Annotated Copy As…',
          accelerator: 'CmdOrCtrl+Shift+S',
          click: () => send('annots:export'),
        },
        {
          label: 'Save Flattened Copy As…',
          click: () => send('annots:export-flatten'),
        },
        {
          label: 'Apply Annotations to Original…',
          click: () => send('annots:apply-original'),
        },
        { type: 'separator' },
        { label: 'Close Document', accelerator: 'CmdOrCtrl+W', click: () => send('doc:close') },
        { type: 'separator' },
        { role: 'quit', label: process.platform === 'darwin' ? 'Quit' : 'Exit' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'copy' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { label: 'Zoom In', accelerator: 'CmdOrCtrl+Plus', click: () => send('view:zoom', 'in') },
        { label: 'Zoom Out', accelerator: 'CmdOrCtrl+-', click: () => send('view:zoom', 'out') },
        { label: 'Actual Size', accelerator: 'CmdOrCtrl+0', click: () => send('view:zoom', 'actual') },
        { type: 'separator' },
        { label: 'Fit Width', click: () => send('view:fit', 'width') },
        { label: 'Fit Page', click: () => send('view:fit', 'page') },
        { type: 'separator' },
        { label: 'Toggle Sidebar', accelerator: 'CmdOrCtrl+B', click: () => send('view:sidebar') },
        { role: 'togglefullscreen' },
        ...(app.isPackaged
          ? []
          : [
              { type: 'separator' },
              { role: 'reload' },
              { role: 'toggleDevTools' },
            ]),
      ],
    },
    {
      // Same 4 tools as the mode toolbar (viewer.js), same order — this menu
      // is the failsafe if that toolbar is ever hard to reach.
      label: 'Tools',
      submenu: [
        {
          label: 'Edit PDF',
          click: () => send('tools:edit-mode'),
        },
        {
          label: 'Create PDF…',
          accelerator: 'CmdOrCtrl+Shift+N',
          click: () => send('tools:create-pdf'),
        },
        {
          label: 'Organize Pages…',
          click: () => send('tools:organize-pages'),
        },
        {
          label: 'Export…',
          accelerator: 'CmdOrCtrl+E',
          click: () => send('tools:export'),
        },
      ],
    },
    {
      label: 'Help',
      submenu: [
        {
          label: 'About Simple PDF Viewer',
          click: () => {
            dialog.showMessageBox(mainWindow, {
              type: 'info',
              title: 'About',
              message: 'Simple PDF Viewer',
              detail: `Version ${app.getVersion()}\nBuilt with Electron and Mozilla PDF.js.`,
              buttons: ['OK'],
            });
          },
        },
        {
          label: 'PDF.js Project',
          click: () => shell.openExternal('https://mozilla.github.io/pdf.js/'),
        },
      ],
    },
  ];

  return template;
}

async function rebuildMenu() {
  const template = await buildMenuTemplate();
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/* ------------------------------------------------------------------ *
 *  Window                                                             *
 * ------------------------------------------------------------------ */

async function createWindow() {
  const state = await loadWindowState();

  mainWindow = new BrowserWindow({
    width: state.width,
    height: state.height,
    x: state.x,
    y: state.y,
    minWidth: 800,
    minHeight: 600,
    backgroundColor: '#525659',
    title: 'Simple PDF Viewer',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false, // preload needs `require('electron')` for webUtils
    },
  });

  if (state.maximized) mainWindow.maximize();

  mainWindow.loadURL(`${APP_ORIGIN}/index.html`);

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    const initial = pendingOpenPath || pdfPathFromArgv(process.argv);
    if (initial) {
      pendingOpenPath = null;
      sendOpenFile(initial);
    }
  });

  // Dev helper: `SHOT=<file> [DELAY=<ms>]` captures the window, then quits.
  if (process.env.SHOT) {
    const delay = Number(process.env.DELAY || 3500);
    mainWindow.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        try {
          const img = await mainWindow.webContents.capturePage();
          fs.writeFileSync(process.env.SHOT, img.toPNG());
          console.log('screenshot ->', process.env.SHOT);
        } catch (e) {
          console.error('capture failed', e);
        }
        app.quit();
      }, delay);
    });
  }

  mainWindow.on('close', saveWindowState);
  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // Open target=_blank / external links in the OS browser, never in-app.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

/* ------------------------------------------------------------------ *
 *  IPC                                                                *
 * ------------------------------------------------------------------ */

ipcMain.handle('dialog:openFile', () => openViaDialog());
ipcMain.handle('file:read', async (_e, filePath) => {
  try {
    return await readPdf(filePath);
  } catch (err) {
    return { error: err.message, path: filePath };
  }
});
ipcMain.on('context-menu:show', (e, payload = {}) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  if (!win) return;
  const menu = Menu.buildFromTemplate([
    { role: 'copy', enabled: !!payload.hasSelection },
    { type: 'separator' },
    { role: 'selectAll' },
  ]);
  menu.popup({ window: win });
});
const IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'];

// Multi-select picker for the "Create PDF" tool: PDFs and images together.
ipcMain.handle('build:pickInputs', async () => {
  const res = await dialog.showOpenDialog(mainWindow, {
    title: 'Add PDFs and images',
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: 'PDF & Images', extensions: ['pdf', ...IMAGE_EXTS] },
      { name: 'PDF Documents', extensions: ['pdf'] },
      { name: 'Images', extensions: IMAGE_EXTS },
      { name: 'All Files', extensions: ['*'] },
    ],
  });
  return res.canceled ? [] : res.filePaths;
});

// Read any file's raw bytes (used for builder inputs; does not touch recents).
ipcMain.handle('build:readBytes', async (_e, filePath) => {
  try {
    const abs = path.resolve(filePath);
    const buf = await fsp.readFile(abs);
    return {
      name: path.basename(abs),
      data: new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength),
    };
  } catch (err) {
    return { error: err.message, path: filePath };
  }
});

// Write a freshly built PDF, add it to recents, and open it in the viewer.
ipcMain.handle('build:save', async (_e, { defaultName, data } = {}) => {
  const res = await dialog.showSaveDialog(mainWindow, {
    title: 'Save PDF',
    defaultPath: defaultName || 'Combined.pdf',
    filters: [{ name: 'PDF Documents', extensions: ['pdf'] }],
  });
  if (res.canceled || !res.filePath) return { canceled: true };
  try {
    await fsp.writeFile(res.filePath, Buffer.from(data));
    sendOpenFile(res.filePath);
    return { path: res.filePath };
  } catch (err) {
    return { error: err.message };
  }
});

// Generic "save this file I built" for the Export dialog (images/PDF pages/
// Word/Excel) — unlike build:save, this never opens the result in the
// viewer, since none of those formats (besides the PDF-subset case) are
// PDFs this app can display.
ipcMain.handle('export:save', async (_e, { defaultName, data, filterName, extensions } = {}) => {
  const res = await dialog.showSaveDialog(mainWindow, {
    title: 'Export',
    defaultPath: defaultName || 'export',
    filters: [{ name: filterName || 'File', extensions: extensions && extensions.length ? extensions : ['*'] }],
  });
  if (res.canceled || !res.filePath) return { canceled: true };
  try {
    await fsp.writeFile(res.filePath, Buffer.from(data));
    return { path: res.filePath };
  } catch (err) {
    return { error: err.message };
  }
});

// Multi-select picker restricted to images, for the annotation image-stamp tool.
ipcMain.handle('annots:pickImage', async () => {
  const res = await dialog.showOpenDialog(mainWindow, {
    title: 'Insert Image',
    properties: ['openFile'],
    filters: [{ name: 'Images', extensions: IMAGE_EXTS }],
  });
  return res.canceled || !res.filePaths.length ? null : res.filePaths[0];
});

/* --- Annotations sidecar (userData/annotations/<sha1(path)>.json) --- */

ipcMain.handle('annots:load', async (_e, pdfPath) => {
  try {
    const raw = await fsp.readFile(annotSidecar(pdfPath), 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.annotations)) return null;
    // Flag when the PDF on disk has moved on since these annotations were
    // captured, so the renderer can show a "file changed" banner.
    let fileChanged = false;
    try {
      const st = await fsp.stat(path.resolve(pdfPath));
      fileChanged = parsed.size !== st.size || parsed.mtimeMs !== st.mtimeMs;
    } catch { /* file missing; nothing to compare against */ }
    return { ...parsed, fileChanged };
  } catch {
    return null;
  }
});

ipcMain.handle('annots:save', async (_e, pdfPath, payload = {}) => {
  try {
    await fsp.mkdir(ANNOT_DIR(), { recursive: true });
    let size = payload.size || 0;
    let mtimeMs = payload.mtimeMs || 0;
    try {
      const st = await fsp.stat(path.resolve(pdfPath));
      size = st.size;
      mtimeMs = st.mtimeMs;
    } catch { /* file may be gone; keep what we were given */ }
    const record = {
      path: path.resolve(pdfPath),
      size,
      mtimeMs,
      savedAt: Date.now(),
      annotations: Array.isArray(payload.annotations) ? payload.annotations : [],
    };
    // Remove the sidecar entirely once there's nothing left to store.
    if (!record.annotations.length) {
      await fsp.rm(annotSidecar(pdfPath), { force: true });
      return { ok: true, removed: true };
    }
    await fsp.writeFile(annotSidecar(pdfPath), JSON.stringify(record), 'utf8');
    return { ok: true };
  } catch (err) {
    return { error: err.message };
  }
});

// Overwrite the original PDF with an annotated copy built in the renderer.
// Keeps a best-effort `.bak` of what was there immediately before.
ipcMain.handle('annots:applyToOriginal', async (_e, pdfPath, data) => {
  try {
    const abs = path.resolve(pdfPath);
    try { await fsp.copyFile(abs, `${abs}.bak`); } catch { /* best-effort */ }
    await fsp.writeFile(abs, Buffer.from(data));
    const st = await fsp.stat(abs);
    return { ok: true, size: st.size, mtimeMs: st.mtimeMs };
  } catch (err) {
    return { error: err.message };
  }
});

ipcMain.handle('recents:get', () => readRecents());
ipcMain.handle('recents:clear', async () => {
  await writeRecents([]);
  await rebuildMenu();
  return [];
});

/* ------------------------------------------------------------------ *
 *  Lifecycle                                                          *
 * ------------------------------------------------------------------ */

// macOS: file opened from Finder.
app.on('open-file', (event, filePath) => {
  event.preventDefault();
  if (app.isReady()) sendOpenFile(filePath);
  else pendingOpenPath = filePath;
});

app.whenReady().then(async () => {
  protocol.handle('app', serveRendererFile);
  await rebuildMenu();
  await createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
