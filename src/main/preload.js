'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

// Set the theme attribute before the page paints, so there's no light flash
// on a dark-mode launch. main.js passes the resolved theme via additionalArguments.
{
  const arg = process.argv.find((a) => a.startsWith('--start-theme='));
  const startTheme = arg ? arg.slice('--start-theme='.length) : null;
  if (startTheme) {
    const set = () => {
      try {
        document.documentElement.dataset.theme = startTheme;
      } catch {
        /* ignore */
      }
    };
    set();
    document.addEventListener('DOMContentLoaded', set);
  }
}

/**
 * Safe, minimal surface exposed to the renderer as `window.api`.
 * No Node primitives leak across the bridge.
 */
contextBridge.exposeInMainWorld('api', {
  /** Show the native Open dialog. Result arrives via `onFileOpen`. */
  openDialog: () => ipcRenderer.invoke('dialog:openFile'),

  /** Read a PDF by absolute path -> { path, name, data:Uint8Array } | { error }. */
  readFile: (filePath) => ipcRenderer.invoke('file:read', filePath),

  /** Resolve a dropped File object to an absolute filesystem path. */
  getPathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file);
    } catch {
      return '';
    }
  },

  /* --- Theme (light / dark / follow-OS) --- */
  getTheme: () => ipcRenderer.invoke('theme:get'),
  setTheme: (src) => ipcRenderer.invoke('theme:set', src),
  onThemeChanged: (cb) => ipcRenderer.on('theme:changed', (_e, info) => cb(info)),

  getRecents: () => ipcRenderer.invoke('recents:get'),
  clearRecents: () => ipcRenderer.invoke('recents:clear'),

  /** Open a PDF as a new tab in this same window (used when this tab already
      has a document open and receives another via drag-and-drop). */
  openInThisWindow: (filePath) => ipcRenderer.send('window:openTab', filePath),

  /** Open a PDF in a brand-new window. */
  openInNewWindow: (filePath) => ipcRenderer.invoke('window:openNew', filePath),

  /* --- Sleeping-tab support (viewer <-> main) --- */
  reportViewState: (state) => ipcRenderer.send('tab:view-state', state),
  onFlush: (cb) => ipcRenderer.on('tab:flush', () => cb()),
  onRestoreView: (cb) => ipcRenderer.on('view:restore', (_e, state) => cb(state)),

  /* --- Tab strip (chrome.html) --- */
  onTabs: (cb) => ipcRenderer.on('chrome:tabs', (_e, tabs) => cb(tabs)),
  newTab: () => ipcRenderer.send('tab:new'),
  activateTab: (id) => ipcRenderer.send('tab:activate', id),
  closeTab: (id) => ipcRenderer.send('tab:close', id),
  reorderTab: (id, index) => ipcRenderer.send('tab:reorder', id, index),
  tabDragStart: () => ipcRenderer.send('tab:drag-start'),
  tabDragEnd: () => ipcRenderer.send('tab:drag-end'),
  detachTab: (id, point) => ipcRenderer.send('tab:detach', id, point),

  /** Pop the native text context menu (Copy / Select All). */
  showContextMenu: (payload) => ipcRenderer.send('context-menu:show', payload),

  /* --- Create PDF tool --- */
  pickBuildInputs: () => ipcRenderer.invoke('build:pickInputs'),
  readBytes: (filePath) => ipcRenderer.invoke('build:readBytes', filePath),
  saveBuiltPdf: (payload) => ipcRenderer.invoke('build:save', payload),

  /* --- Export dialog (images / PDF pages / Word / Excel) --- */
  exportSave: (payload) => ipcRenderer.invoke('export:save', payload),
  onExportDialog: (cb) => ipcRenderer.on('tools:export', () => cb()),

  /* --- Mode toolbar failsafe (Tools menu) --- */
  onEditModeToggle: (cb) => ipcRenderer.on('tools:edit-mode', () => cb()),
  onOrganizePages: (cb) => ipcRenderer.on('tools:organize-pages', () => cb()),

  /* --- Annotations --- */
  annotsLoad: (pdfPath) => ipcRenderer.invoke('annots:load', pdfPath),
  annotsSave: (pdfPath, payload) => ipcRenderer.invoke('annots:save', pdfPath, payload),
  annotsApplyToOriginal: (pdfPath, data) => ipcRenderer.invoke('annots:applyToOriginal', pdfPath, data),
  pickImage: () => ipcRenderer.invoke('annots:pickImage'),
  onExportAnnotated: (cb) => ipcRenderer.on('annots:export', () => cb()),
  onExportFlattened: (cb) => ipcRenderer.on('annots:export-flatten', () => cb()),
  onApplyAnnotationsToOriginal: (cb) => ipcRenderer.on('annots:apply-original', () => cb()),

  /* --- main -> renderer events --- */
  onFileOpen: (cb) => {
    const listener = (_e, filePath) => cb(filePath);
    ipcRenderer.on('file:open', listener);
    return () => ipcRenderer.removeListener('file:open', listener);
  },
  onRecentsChanged: (cb) => ipcRenderer.on('recents:changed', (_e, list) => cb(list)),
  onZoom: (cb) => ipcRenderer.on('view:zoom', (_e, dir) => cb(dir)),
  onFit: (cb) => ipcRenderer.on('view:fit', (_e, mode) => cb(mode)),
  onToggleSidebar: (cb) => ipcRenderer.on('view:sidebar', () => cb()),
  onCreatePdf: (cb) => ipcRenderer.on('tools:create-pdf', () => cb()),
});
