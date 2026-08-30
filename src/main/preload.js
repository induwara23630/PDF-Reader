'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

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

  getRecents: () => ipcRenderer.invoke('recents:get'),
  clearRecents: () => ipcRenderer.invoke('recents:clear'),

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
  onCloseDoc: (cb) => ipcRenderer.on('doc:close', () => cb()),
  onZoom: (cb) => ipcRenderer.on('view:zoom', (_e, dir) => cb(dir)),
  onFit: (cb) => ipcRenderer.on('view:fit', (_e, mode) => cb(mode)),
  onToggleSidebar: (cb) => ipcRenderer.on('view:sidebar', () => cb()),
  onCreatePdf: (cb) => ipcRenderer.on('tools:create-pdf', () => cb()),
});
