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
});
