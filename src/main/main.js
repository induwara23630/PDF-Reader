'use strict';

const {
  app,
  BaseWindow,
  WebContentsView,
  Menu,
  dialog,
  ipcMain,
  shell,
  protocol,
  nativeTheme,
  screen,
} = require('electron');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');

const RECENTS_FILE = () => path.join(app.getPath('userData'), 'recent.json');
const ANNOT_DIR = () => path.join(app.getPath('userData'), 'annotations');
const annotSidecar = (pdfPath) =>
  path.join(ANNOT_DIR(), `${crypto.createHash('sha1').update(path.resolve(pdfPath)).digest('hex')}.json`);
const STATE_FILE = () => path.join(app.getPath('userData'), 'window-state.json');
const SETTINGS_FILE = () => path.join(app.getPath('userData'), 'settings.json');
const MAX_RECENTS = 10;

/* ------------------------------------------------------------------ *
 *  Theme (light / dark, default = follow the OS)                      *
 * ------------------------------------------------------------------ */

const THEMES = new Set(['system', 'light', 'dark']);
// Mirrors nativeTheme.themeSource; persisted in settings.json so the choice
// survives a restart. 'system' means "whatever Windows is set to".
let themeSource = 'system';

function applyThemeSource(src) {
  themeSource = THEMES.has(src) ? src : 'system';
  nativeTheme.themeSource = themeSource;
}

function themeInfo() {
  return { source: themeSource, shouldUseDarkColors: nativeTheme.shouldUseDarkColors };
}

function broadcastTheme() {
  broadcast('theme:changed', themeInfo());
}

// Menu radio / toolbar popup / OS change all land here.
async function setTheme(src) {
  applyThemeSource(src);
  await writeSettings({ theme: themeSource });
  await rebuildMenu();
  broadcastTheme();
}

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

/* ------------------------------------------------------------------ *
 *  Shell windows + tabs                                               *
 * ------------------------------------------------------------------ *
 *  Each "shell" is a BaseWindow (no renderer of its own). It hosts a  *
 *  `chrome` WebContentsView (the tab strip, top TABBAR_H px) plus one *
 *  WebContentsView per open tab — each tab runs the full viewer       *
 *  (index.html), so viewer.js keeps its one-document-per-context      *
 *  state model untouched. Detaching a tab just re-parents the *same*  *
 *  WebContentsView to another shell: no reload, live state kept.      *
 *                                                                     *
 *  main.js is the source of truth for the tab list; it pushes it to   *
 *  each strip via `chrome:tabs`.                                      */

const TABBAR_H = 36; // keep in sync with --tabbar-h / #bar height in chrome.css

// A background tab whose renderer has been idle this long is discarded to free
// its process (~like Edge's sleeping tabs); it reloads on next activation,
// restoring the document + scroll/zoom from its last-reported snapshot.
const SLEEP_AFTER_MS = Number(process.env.TAB_SLEEP_MS) || 15 * 60 * 1000;
const SLEEP_SCAN_MS = Math.min(SLEEP_AFTER_MS, 60 * 1000);

/** @typedef {{ id: string, view: import('electron').WebContentsView|null, doc: string|null,
 *   title: string, sleeping: boolean, busy: boolean, lastShown: number,
 *   snapshot: {page:number, scalePct:number|null, fitMode:string|null, scrollRatio:number}|null }} Tab */
/** @typedef {{ tabs: Tab[], activeId: string|null, chrome: import('electron').WebContentsView, dragging: boolean }} Shell */

/** @type {Set<BaseWindow>} */
const windows = new Set();
/** @type {Map<BaseWindow, Shell>} */
const shells = new Map();
/** Reverse lookup for IPC senders — BrowserWindow.fromWebContents doesn't
 *  resolve the owner for WebContentsView children (electron/electron#42060). */
/** @type {Map<import('electron').WebContents, BaseWindow>} */
const wcOwner = new Map();
/** @type {BaseWindow|null} */
let lastFocusedShell = null;
/** Path passed on the command line before the first shell is ready. */
let pendingOpenPath = null;
/** The command line's PDF (if any) is opened once, in the first window only. */
let firstShellCreated = false;

const themeArg = () => `--start-theme=${nativeTheme.shouldUseDarkColors ? 'dark' : 'light'}`;

function ownerShell(wc) {
  const win = wcOwner.get(wc);
  return win && !win.isDestroyed() ? win : null;
}

function focusedShell() {
  const f = BaseWindow.getFocusedWindow();
  if (f && windows.has(f)) return f;
  if (lastFocusedShell && !lastFocusedShell.isDestroyed() && windows.has(lastFocusedShell)) {
    return lastFocusedShell;
  }
  return [...windows][0] || null;
}

/** @param {BaseWindow} win */
const shellOf = (win) => shells.get(win);
/** @param {BaseWindow} win */
const activeTab = (win) => {
  const s = shells.get(win);
  return s ? s.tabs.find((t) => t.id === s.activeId) || null : null;
};
const tabById = (win, id) => {
  const s = shells.get(win);
  return s ? s.tabs.find((t) => t.id === id) || null : null;
};
/** Find the { win, tab } that owns an IPC sender's webContents. */
function tabByWc(wc) {
  for (const [win, s] of shells) {
    for (const t of s.tabs) if (t.view && t.view.webContents === wc) return { win, tab: t };
  }
  return null;
}

/** The chrome strip must stay above the tab views; every addChildView(tabView)
 *  drops the new view on top, so call this right after. remove+re-add is the
 *  reliable way to move an existing child to the top across Electron builds. */
function raiseChrome(win) {
  const s = shells.get(win);
  if (!s || win.isDestroyed()) return;
  try { win.contentView.removeChildView(s.chrome); } catch { /* not attached yet */ }
  win.contentView.addChildView(s.chrome);
}

/** Position the chrome strip + the active tab view. */
function layoutShell(win) {
  const s = shells.get(win);
  if (!s || win.isDestroyed()) return;
  const { width, height } = win.getContentBounds();
  // While a tab is being dragged the strip is expanded to cover the whole
  // window so it keeps receiving pointer events below the 36px bar. The view
  // is kept fully opaque either way — a transparent WebContentsView region is
  // click-through on Windows, which would send strip clicks nowhere.
  s.chrome.setBounds(
    s.dragging ? { x: 0, y: 0, width, height } : { x: 0, y: 0, width, height: TABBAR_H }
  );

  for (const t of s.tabs) {
    if (!t.view) continue; // sleeping — no view to place
    const on = t.id === s.activeId;
    t.view.setVisible(on);
    if (on) t.view.setBounds({ x: 0, y: TABBAR_H, width, height: Math.max(0, height - TABBAR_H) });
  }
}

function tabListPayload(win) {
  const s = shells.get(win);
  return s
    ? s.tabs.map((t) => ({ id: t.id, title: t.title, active: t.id === s.activeId, sleeping: t.sleeping }))
    : [];
}

function pushTabs(win) {
  const s = shells.get(win);
  if (!s || win.isDestroyed()) return;
  s.chrome.webContents.send('chrome:tabs', tabListPayload(win));
}

/* ------------------------------------------------------------------ *
 *  Single-instance handling (so "open with" opens a new window here,  *
 *  rather than launching a whole separate app instance)               *
 * ------------------------------------------------------------------ */

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    const filePath = pdfPathFromArgv(argv);
    if (filePath) {
      openInWindowOrNew(filePath);
    } else {
      const win = focusedShell();
      if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
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
  // With one window this never mattered (its own welcome screen is gone by
  // the time it has anything to open); with several, another window still
  // on the welcome screen should see the new entry without a restart.
  broadcast('recents:changed', list);
  return list;
}

async function readSettings() {
  try {
    const raw = await fsp.readFile(SETTINGS_FILE(), 'utf8');
    const s = JSON.parse(raw);
    return s && typeof s === 'object' ? s : {};
  } catch {
    return {};
  }
}

async function writeSettings(patch) {
  const next = { ...(await readSettings()), ...patch };
  try {
    await fsp.writeFile(SETTINGS_FILE(), JSON.stringify(next, null, 2), 'utf8');
  } catch (err) {
    console.error('Could not persist settings:', err.message);
  }
  return next;
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

// Saved on every window's close — whichever closed most recently becomes the
// remembered size/position for the next window a future launch opens.
function saveWindowState(win) {
  if (!win || win.isDestroyed()) return;
  const bounds = win.getBounds();
  try {
    fs.writeFileSync(
      STATE_FILE(),
      JSON.stringify({ ...bounds, maximized: win.isMaximized() }, null, 2),
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

// The one place every "open this PDF" trigger funnels through (File ▸ Open,
// Open Recent, Explorer double-click, drag-drop, Create PDF's result):
// reuse the focused window's tab if it's still an empty welcome tab,
// otherwise open a new tab in that window; with no window at all, a new one.
function openInWindowOrNew(filePath) {
  const abs = path.resolve(filePath);
  const win = focusedShell();
  if (!win) {
    if (!app.isReady()) pendingOpenPath = abs;
    else createShellWindow({ initialPath: abs });
    return;
  }
  if (typeof win.isMinimized === 'function' && win.isMinimized()) win.restore();
  win.focus();
  const tab = activeTab(win);
  if (tab && tab.doc == null) {
    tab.doc = abs;
    tab.view.webContents.send('file:open', abs);
  } else {
    createTab(win, { path: abs });
  }
}

/* ------------------------------------------------------------------ *
 *  Renderer -> main channel to trigger the "Open" dialog              *
 * ------------------------------------------------------------------ */

async function openViaDialog(parentWin) {
  const res = await dialog.showOpenDialog(parentWin || undefined, {
    title: 'Open PDF',
    properties: ['openFile'],
    filters: [{ name: 'PDF Documents', extensions: ['pdf'] }],
  });
  if (res.canceled || !res.filePaths.length) return null;
  openInWindowOrNew(res.filePaths[0]);
  return res.filePaths[0];
}

/* ------------------------------------------------------------------ *
 *  Application menu                                                   *
 * ------------------------------------------------------------------ */

// Window-scoped menu actions (zoom, the Tools submenu, ...) go to the active
// tab of whichever shell currently has focus.
function send(channel, ...args) {
  const win = focusedShell();
  const tab = win && activeTab(win);
  if (tab && tab.view && !tab.view.webContents.isDestroyed()) tab.view.webContents.send(channel, ...args);
}

// App-wide state (recent-files list, theme) every tab — and every strip, for
// theme — should reflect, not just the focused one.
function broadcast(channel, ...args) {
  for (const win of windows) {
    const s = shells.get(win);
    if (!s || win.isDestroyed()) continue;
    if (channel === 'theme:changed' && !s.chrome.webContents.isDestroyed()) {
      s.chrome.webContents.send(channel, ...args);
    }
    for (const t of s.tabs) {
      if (t.view && !t.view.webContents.isDestroyed()) t.view.webContents.send(channel, ...args);
    }
  }
}

// "Close Tab" (File menu / Ctrl+W) — closes the focused shell's active tab;
// closing the last tab closes the window.
function closeFocusedDocument() {
  const win = focusedShell();
  const s = win && shells.get(win);
  if (s && s.activeId) closeTab(win, s.activeId);
}

function cycleTab(dir) {
  const win = focusedShell();
  const s = win && shells.get(win);
  if (!s || s.tabs.length < 2) return;
  const i = s.tabs.findIndex((t) => t.id === s.activeId);
  const next = (i + dir + s.tabs.length) % s.tabs.length;
  activateTab(win, s.tabs[next].id);
}

async function buildMenuTemplate() {
  const recents = await readRecents();
  const recentItems = recents.length
    ? recents.map((p) => ({ label: p, click: () => openInWindowOrNew(p) }))
    : [{ label: 'No Recent Files', enabled: false }];

  /** @type {import('electron').MenuItemConstructorOptions[]} */
  const template = [
    {
      label: 'File',
      submenu: [
        { label: 'Open…', accelerator: 'CmdOrCtrl+O', click: () => openViaDialog(focusedShell()) },
        { label: 'New Tab', accelerator: 'CmdOrCtrl+T', click: () => {
          const win = focusedShell();
          if (win) createTab(win); else createShellWindow();
        } },
        { label: 'New Window', accelerator: 'CmdOrCtrl+N', click: () => createShellWindow() },
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
                broadcast('recents:changed', []);
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
        { label: 'Close Tab', accelerator: 'CmdOrCtrl+W', click: () => closeFocusedDocument() },
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
        { type: 'separator' },
        { label: 'Next Tab', accelerator: 'CmdOrCtrl+Tab', click: () => cycleTab(1) },
        { label: 'Previous Tab', accelerator: 'CmdOrCtrl+Shift+Tab', click: () => cycleTab(-1) },
        { type: 'separator' },
        {
          label: 'Theme',
          submenu: [
            { label: 'System (match Windows)', type: 'radio', checked: themeSource === 'system', click: () => setTheme('system') },
            { label: 'Light', type: 'radio', checked: themeSource === 'light', click: () => setTheme('light') },
            { label: 'Dark', type: 'radio', checked: themeSource === 'dark', click: () => setTheme('dark') },
          ],
        },
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
          label: 'About BPDF Reader',
          click: () => {
            dialog.showMessageBox(focusedShell() || undefined, {
              type: 'info',
              title: 'About',
              message: 'BPDF Reader',
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
 *  Shell windows                                                      *
 * ------------------------------------------------------------------ */

const viewPrefs = () => ({
  preload: path.join(__dirname, 'preload.js'),
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: false, // preload needs `require('electron')` for webUtils
});

// Called for the first window at launch, for "New Window", and by
// openInWindowOrNew()/detachTab() when a new window is needed.
async function createShellWindow({ initialPath, withFirstTab = true, bounds } = {}) {
  const state = await loadWindowState();
  const offset = windows.size * 32; // cascade so windows don't stack exactly
  const hasPosition = Number.isFinite(state.x) && Number.isFinite(state.y);

  const win = new BaseWindow({
    width: bounds?.width ?? state.width,
    height: bounds?.height ?? state.height,
    x: bounds?.x ?? (hasPosition ? state.x + offset : undefined),
    y: bounds?.y ?? (hasPosition ? state.y + offset : undefined),
    minWidth: 800,
    minHeight: 600,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1b1c1e' : '#525659',
    title: 'BPDF Reader',
    icon: path.join(__dirname, '..', '..', 'assets', 'icon.ico'),
    show: false,
  });

  const chrome = new WebContentsView({
    webPreferences: { ...viewPrefs(), additionalArguments: [themeArg()] },
  });
  // Opaque — see layoutShell. The page paints the strip + (while dragging) a
  // dim backdrop over the rest.
  chrome.setBackgroundColor(nativeTheme.shouldUseDarkColors ? '#1b1c1e' : '#525659');
  chrome.webContents.loadURL(`${APP_ORIGIN}/chrome.html`);

  /** @type {Shell} */
  const shell_ = { tabs: [], activeId: null, chrome, dragging: false };
  windows.add(win);
  shells.set(win, shell_);
  wcOwner.set(chrome.webContents, win);
  win.contentView.addChildView(chrome);

  if (!bounds && state.maximized) win.maximize();

  const relayout = () => layoutShell(win);
  win.on('resize', relayout);
  win.on('enter-full-screen', relayout);
  win.on('leave-full-screen', relayout);
  win.on('focus', () => { lastFocusedShell = win; });
  win.on('close', () => saveWindowState(win));
  win.on('closed', () => {
    for (const t of shell_.tabs) {
      if (!t.view) continue;
      wcOwner.delete(t.view.webContents);
      try { t.view.webContents.close(); } catch { /* noop */ }
    }
    wcOwner.delete(chrome.webContents);
    windows.delete(win);
    shells.delete(win);
    if (lastFocusedShell === win) lastFocusedShell = null;
  });

  win.show();
  lastFocusedShell = win;
  layoutShell(win);

  chrome.webContents.once('did-finish-load', () => { pushTabs(win); layoutShell(win); });

  if (withFirstTab) {
    // Only the very first window inherits a path from the command line.
    const fromArgv = firstShellCreated ? null : pdfPathFromArgv(process.argv);
    firstShellCreated = true;
    const initial = initialPath || pendingOpenPath || fromArgv;
    pendingOpenPath = null;
    createTab(win, { path: initial || null });
  }

  return win;
}

/* ------------------------------------------------------------------ *
 *  Tabs                                                               *
 * ------------------------------------------------------------------ */

// Build (or rebuild, when waking a sleeping tab) the WebContentsView for a
// tab and attach it to `win`. Loads the viewer, opens the tab's document if
// it has one, and replays the last-known scroll/zoom snapshot.
function buildTabView(win, tab) {
  const view = new WebContentsView({
    webPreferences: { ...viewPrefs(), additionalArguments: [themeArg(), `--tab-id=${tab.id}`] },
  });
  view.setBackgroundColor(nativeTheme.shouldUseDarkColors ? '#1b1c1e' : '#525659');
  tab.view = view;

  const wc = view.webContents;
  wcOwner.set(wc, win);
  win.contentView.addChildView(view);
  raiseChrome(win);

  wc.on('page-title-updated', (_e, title) => {
    tab.title = title.replace(/\s*[—-]\s*BPDF Reader\s*$/, '') || 'New Tab';
    const owner = wcOwner.get(wc);
    if (owner) pushTabs(owner);
  });
  wc.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  wc.loadURL(`${APP_ORIGIN}/index.html`);
  wc.once('did-finish-load', () => {
    if (tab.doc) wc.send('file:open', tab.doc);
    if (tab.snapshot) wc.send('view:restore', tab.snapshot);
  });

  maybeCaptureShot(win, wc);
  return view;
}

function createTab(win, { path: pdfPath } = {}) {
  const s = shells.get(win);
  if (!s || win.isDestroyed()) return null;

  /** @type {Tab} */
  const tab = {
    id: crypto.randomUUID(),
    view: null,
    doc: pdfPath ? path.resolve(pdfPath) : null,
    title: 'New Tab',
    sleeping: false,
    busy: false,
    lastShown: Date.now(),
    snapshot: null,
  };
  s.tabs.push(tab);
  buildTabView(win, tab);
  activateTab(win, tab.id);
  return tab;
}

function activateTab(win, id) {
  const s = shells.get(win);
  if (!s || win.isDestroyed()) return;
  const t = s.tabs.find((x) => x.id === id);
  if (!t) return;

  // Mark the outgoing tab as "last shown now" so the sleep timer starts.
  const prev = s.tabs.find((x) => x.id === s.activeId);
  if (prev && prev !== t) prev.lastShown = Date.now();

  if (t.sleeping) wakeTab(win, t);
  s.activeId = id;
  t.lastShown = Date.now();
  layoutShell(win);
  pushTabs(win);
  if (t.view) t.view.webContents.focus();
}

/* ---- sleeping tabs ---- */

function sleepTab(win, tab) {
  const s = shells.get(win);
  if (!s || tab.sleeping || !tab.view || tab.id === s.activeId) return;
  if (!tab.doc || tab.busy) return; // never discard unsaved / actively-edited work

  try { tab.view.webContents.send('tab:flush'); } catch { /* best effort */ }
  win.contentView.removeChildView(tab.view);
  wcOwner.delete(tab.view.webContents);
  try { tab.view.webContents.close(); } catch { /* noop */ }
  tab.view = null;
  tab.sleeping = true;
  pushTabs(win);
}

function wakeTab(win, tab) {
  if (!tab.sleeping) return;
  tab.sleeping = false;
  buildTabView(win, tab);
}

function scanForSleep() {
  const cutoff = Date.now() - SLEEP_AFTER_MS;
  for (const [win, s] of shells) {
    if (win.isDestroyed()) continue;
    for (const tab of s.tabs) {
      if (tab.id === s.activeId || tab.sleeping || !tab.view) continue;
      if (tab.doc && !tab.busy && tab.lastShown < cutoff) sleepTab(win, tab);
    }
  }
}

function closeTab(win, id) {
  const s = shells.get(win);
  if (!s) return;
  const i = s.tabs.findIndex((t) => t.id === id);
  if (i === -1) return;
  const [tab] = s.tabs.splice(i, 1);
  if (tab.view) {
    win.contentView.removeChildView(tab.view);
    wcOwner.delete(tab.view.webContents);
    try { tab.view.webContents.close(); } catch { /* noop */ }
  }

  if (s.tabs.length === 0) {
    win.close();
    return;
  }
  if (s.activeId === id) {
    activateTab(win, s.tabs[Math.min(i, s.tabs.length - 1)].id);
  } else {
    layoutShell(win);
    pushTabs(win);
  }
}

function reorderTab(win, id, index) {
  const s = shells.get(win);
  if (!s) return;
  const from = s.tabs.findIndex((t) => t.id === id);
  if (from === -1) return;
  const [tab] = s.tabs.splice(from, 1);
  const n = Number.isFinite(index) ? index : from;
  const to = Math.max(0, Math.min(n, s.tabs.length));
  s.tabs.splice(to, 0, tab);
  pushTabs(win);
}

// Re-parent a tab's WebContentsView to another shell — the same live view, no
// reload, so scroll / zoom / annotations / undo history are all preserved.
function moveTabToWindow(fromWin, id, toWin, index) {
  const from = shells.get(fromWin);
  const to = shells.get(toWin);
  if (!from || !to || fromWin === toWin) return;
  const i = from.tabs.findIndex((t) => t.id === id);
  if (i === -1) return;

  const [tab] = from.tabs.splice(i, 1);
  if (tab.view) {
    fromWin.contentView.removeChildView(tab.view);
    wcOwner.set(tab.view.webContents, toWin);
    toWin.contentView.addChildView(tab.view);
    raiseChrome(toWin);
  }
  const at = Math.max(0, Math.min(index ?? to.tabs.length, to.tabs.length));
  to.tabs.splice(at, 0, tab);
  activateTab(toWin, id); // wakes it in the new window if it was sleeping

  if (from.tabs.length === 0) {
    fromWin.close();
  } else {
    if (from.activeId === id) activateTab(fromWin, from.tabs[Math.min(i, from.tabs.length - 1)].id);
    else { layoutShell(fromWin); pushTabs(fromWin); }
  }
}

// Which shell's tab strip (if any) is under this screen point?
function shellAtStrip(screenPt, exclude) {
  for (const win of windows) {
    if (win === exclude || win.isDestroyed()) continue;
    const b = win.getBounds();
    if (
      screenPt.x >= b.x &&
      screenPt.x <= b.x + b.width &&
      screenPt.y >= b.y &&
      screenPt.y <= b.y + TABBAR_H + 8
    ) {
      return win;
    }
  }
  return null;
}

async function detachTab(fromWin, id, screenPt) {
  const from = shells.get(fromWin);
  if (!from || !tabById(fromWin, id)) return;

  const target = screenPt && shellAtStrip(screenPt, fromWin);

  // Tearing out the only tab into a new empty-desktop window would just be
  // "move the window" — skip it. (Dropping it onto another strip is fine.)
  if (!target && from.tabs.length <= 1) return;

  if (target) {
    // Drop index from the cursor x within the target strip.
    const tb = target.getBounds();
    const rel = screenPt.x - tb.x;
    const ts = shells.get(target);
    const idx = Math.round((rel / Math.max(1, tb.width)) * (ts.tabs.length + 1));
    moveTabToWindow(fromWin, id, target, idx);
    target.focus();
    return;
  }

  // A brand-new window near the cursor.
  const cur = screenPt || screen.getCursorScreenPoint();
  const src = fromWin.getBounds();
  const newWin = await createShellWindow({
    withFirstTab: false,
    bounds: {
      width: src.width,
      height: src.height,
      x: Math.round(cur.x - 80),
      y: Math.round(cur.y - 10),
    },
  });
  moveTabToWindow(fromWin, id, newWin, 0);
  newWin.focus();
}

// Dev helper: `SHOT=<file> [DELAY=<ms>]` captures the first tab (and, with
// SHOT_CHROME set, the tab strip), then quits.
let shotArmed = false;
function maybeCaptureShot(win, wc) {
  if (!process.env.SHOT || shotArmed) return;
  shotArmed = true;
  const delay = Number(process.env.DELAY || 3500);
  wc.once('did-finish-load', () => {
    setTimeout(async () => {
      try {
        fs.writeFileSync(process.env.SHOT, (await wc.capturePage()).toPNG());
        console.log('screenshot ->', process.env.SHOT);
        const s = shells.get(win);
        if (s && process.env.SHOT_CHROME) {
          fs.writeFileSync(process.env.SHOT_CHROME, (await s.chrome.webContents.capturePage()).toPNG());
          console.log('screenshot (chrome) ->', process.env.SHOT_CHROME);
        }
      } catch (e) {
        console.error('capture failed', e);
      }
      app.quit();
    }, delay);
  });
}

/* ------------------------------------------------------------------ *
 *  IPC                                                                *
 * ------------------------------------------------------------------ */

ipcMain.handle('dialog:openFile', (e) => openViaDialog(ownerShell(e.sender)));
ipcMain.handle('file:read', async (_e, filePath) => {
  try {
    return await readPdf(filePath);
  } catch (err) {
    return { error: err.message, path: filePath };
  }
});
ipcMain.on('context-menu:show', (e, payload = {}) => {
  const win = ownerShell(e.sender);
  const menu = Menu.buildFromTemplate([
    { role: 'copy', enabled: !!payload.hasSelection },
    { type: 'separator' },
    { role: 'selectAll' },
  ]);
  menu.popup(win ? { window: win } : {});
});

/* --- Tab strip (chrome.html) -> main --- */
ipcMain.on('tab:new', (e) => {
  const win = ownerShell(e.sender);
  if (win) createTab(win);
});
ipcMain.on('tab:activate', (e, id) => {
  const win = ownerShell(e.sender);
  if (win) activateTab(win, id);
});
ipcMain.on('tab:close', (e, id) => {
  const win = ownerShell(e.sender);
  if (win) closeTab(win, id);
});
ipcMain.on('tab:reorder', (e, id, index) => {
  const win = ownerShell(e.sender);
  if (win) reorderTab(win, id, index);
});
ipcMain.on('tab:drag-start', (e) => {
  const win = ownerShell(e.sender);
  const s = win && shells.get(win);
  if (s) { s.dragging = true; layoutShell(win); }
});
ipcMain.on('tab:drag-end', (e) => {
  const win = ownerShell(e.sender);
  const s = win && shells.get(win);
  if (s) { s.dragging = false; layoutShell(win); }
});
ipcMain.on('tab:detach', (e, id, point) => {
  const win = ownerShell(e.sender);
  const s = win && shells.get(win);
  if (!s || typeof id !== 'string') return;
  s.dragging = false;
  layoutShell(win);
  // Clamp the drop point to the desktop area — it's raw screenX/Y from the
  // renderer, so don't trust it into BaseWindow bounds unchecked.
  const area = screen.getDisplayNearestPoint(safePoint(point)).workArea;
  const pt = point && Number.isFinite(point.x) && Number.isFinite(point.y)
    ? {
        x: Math.min(area.x + area.width, Math.max(area.x, point.x)),
        y: Math.min(area.y + area.height, Math.max(area.y, point.y)),
      }
    : null;
  detachTab(win, id, pt);
});

function safePoint(p) {
  return p && Number.isFinite(p.x) && Number.isFinite(p.y)
    ? { x: p.x, y: p.y }
    : screen.getCursorScreenPoint();
}

// Renderer (a tab that already has a doc, receiving a drag-drop) -> open the
// dropped PDF as a new tab in the same window.
ipcMain.on('window:openTab', (e, filePath) => {
  if (typeof filePath !== 'string' || !filePath) return;
  const win = ownerShell(e.sender);
  if (win) createTab(win, { path: filePath });
  else openInWindowOrNew(filePath);
});

// A tab periodically reports where the reader is (for restoring a woken
// sleeping tab) and whether it's mid-edit (so we never discard unsaved work).
// Values are clamped here — never trusted straight from the renderer.
ipcMain.on('tab:view-state', (e, s = {}) => {
  const hit = tabByWc(e.sender);
  if (!hit || !s || typeof s !== 'object') return;
  const num = (v, lo, hi, dflt) => (Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : dflt);
  hit.tab.busy = !!s.busy;
  hit.tab.snapshot = {
    page: num(Math.round(s.page), 1, 100000, 1),
    scalePct: Number.isFinite(s.scalePct) ? num(s.scalePct, 10, 800, 100) : null,
    fitMode: s.fitMode === 'width' || s.fitMode === 'page' ? s.fitMode : null,
    scrollRatio: num(s.scrollRatio, 0, 1, 0),
  };
});
const IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'];

// Multi-select picker for the "Create PDF" tool: PDFs and images together.
ipcMain.handle('build:pickInputs', async (e) => {
  const res = await dialog.showOpenDialog(ownerShell(e.sender) || undefined, {
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

// Write a freshly built PDF, add it to recents, and open it in the viewer
// (a new window, unless the window that built it is still on the welcome
// screen — see openInWindowOrNew).
ipcMain.handle('build:save', async (e, { defaultName, data } = {}) => {
  const res = await dialog.showSaveDialog(ownerShell(e.sender) || undefined, {
    title: 'Save PDF',
    defaultPath: defaultName || 'Combined.pdf',
    filters: [{ name: 'PDF Documents', extensions: ['pdf'] }],
  });
  if (res.canceled || !res.filePath) return { canceled: true };
  try {
    await fsp.writeFile(res.filePath, Buffer.from(data));
    openInWindowOrNew(res.filePath);
    return { path: res.filePath };
  } catch (err) {
    return { error: err.message };
  }
});

// Generic "save this file I built" for the Export dialog (images/PDF pages/
// Word/Excel) — unlike build:save, this never opens the result in the
// viewer, since none of those formats (besides the PDF-subset case) are
// PDFs this app can display.
ipcMain.handle('export:save', async (e, { defaultName, data, filterName, extensions } = {}) => {
  const res = await dialog.showSaveDialog(ownerShell(e.sender) || undefined, {
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
ipcMain.handle('annots:pickImage', async (e) => {
  const res = await dialog.showOpenDialog(ownerShell(e.sender) || undefined, {
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

ipcMain.handle('theme:get', () => themeInfo());
ipcMain.handle('theme:set', async (_e, src) => {
  await setTheme(src);
  return themeInfo();
});

ipcMain.handle('recents:get', () => readRecents());
ipcMain.handle('recents:clear', async () => {
  await writeRecents([]);
  await rebuildMenu();
  return [];
});

// Renderer-initiated "open this in a brand-new window".
ipcMain.handle('window:openNew', (_e, filePath) => {
  createShellWindow({ initialPath: filePath });
});

/* ------------------------------------------------------------------ *
 *  Lifecycle                                                          *
 * ------------------------------------------------------------------ */

// macOS: file opened from Finder.
app.on('open-file', (event, filePath) => {
  event.preventDefault();
  if (app.isReady()) openInWindowOrNew(filePath);
  else pendingOpenPath = filePath;
});

app.whenReady().then(async () => {
  protocol.handle('app', serveRendererFile);
  const settings = await readSettings();
  applyThemeSource(settings.theme || 'system');
  // Windows toggled light/dark while we're running -> tell every window.
  nativeTheme.on('updated', broadcastTheme);
  await rebuildMenu();
  await createShellWindow();

  setInterval(scanForSleep, SLEEP_SCAN_MS);

  app.on('activate', () => {
    if (windows.size === 0) createShellWindow();
  });

  // Dev-only: `SMOKE="a.pdf,b.pdf" npx electron .` runs scripts/smoke.js
  // (not shipped — package.json `files` excludes scripts/).
  if (process.env.SMOKE) {
    try {
      require('../../scripts/smoke.js')({
        app, windows, shells, activeTab, createTab, activateTab, closeTab,
        reorderTab, detachTab, scanForSleep, openInWindowOrNew,
      });
    } catch (e) {
      console.error('smoke harness unavailable:', e.message);
    }
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
