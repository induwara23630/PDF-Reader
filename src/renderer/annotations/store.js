// Annotation model — the source of truth that outlives page DOM.
//
// viewer.js destroys/recreates page elements continuously (releasePage,
// rerenderVisible), so annotations live here as plain data in PDF-point,
// top-left-origin coordinates. A mounted render layer subscribes to its page
// and rebuilds itself whenever that page's annotations change.

const uid = () =>
  (crypto.randomUUID && crypto.randomUUID()) ||
  `a${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

const clone = (v) => (typeof structuredClone === 'function'
  ? structuredClone(v)
  : JSON.parse(JSON.stringify(v)));

const UNDO_LIMIT = 100;

class AnnotationStore {
  constructor() {
    /** @type {Map<number, object[]>} page number -> annotations */
    this.pages = new Map();
    /** @type {Map<number, Set<Function>>} page number -> subscribers */
    this.pageSubs = new Map();
    /** @type {Set<Function>} global subscribers (toolbar, dirty state) */
    this.globalSubs = new Set();
    this.undoStack = [];
    this.redoStack = [];
    this.dirty = false;
    this._suspendDirty = false;
  }

  /* ---- lifecycle ---- */

  reset() {
    this.pages.clear();
    this.undoStack.length = 0;
    this.redoStack.length = 0;
    this.dirty = false;
    this._emitAllPages();
    this._emitGlobal();
  }

  // Replace the whole model from a loaded sidecar. Does not mark dirty.
  load(annotations) {
    this.pages.clear();
    this.undoStack.length = 0;
    this.redoStack.length = 0;
    for (const a of annotations || []) {
      if (!a || !a.page) continue;
      if (!this.pages.has(a.page)) this.pages.set(a.page, []);
      this.pages.get(a.page).push(clone(a));
    }
    this.dirty = false;
    this._emitAllPages();
    this._emitGlobal();
  }

  serialize() {
    const out = [];
    for (const list of this.pages.values()) {
      for (const a of list) {
        const c = clone(a);
        for (const k of Object.keys(c)) if (k[0] === '_') delete c[k]; // drop transient UI flags
        out.push(c);
      }
    }
    out.sort((x, y) => x.page - y.page || (x.createdAt || 0) - (y.createdAt || 0));
    return out;
  }

  markClean() {
    this.dirty = false;
    this._emitGlobal();
  }

  isEmpty() {
    for (const list of this.pages.values()) if (list.length) return false;
    return true;
  }

  /* ---- reads ---- */

  forPage(n) {
    return this.pages.get(n) || [];
  }

  get(id) {
    for (const list of this.pages.values()) {
      const hit = list.find((a) => a.id === id);
      if (hit) return hit;
    }
    return null;
  }

  /* ---- writes (all go through _mutate so undo works) ---- */

  add(annot) {
    const now = Date.now();
    const a = {
      id: uid(),
      opacity: 1,
      createdAt: now,
      updatedAt: now,
      ...annot,
    };
    this._mutate([a.page], () => {
      if (!this.pages.has(a.page)) this.pages.set(a.page, []);
      this.pages.get(a.page).push(a);
    });
    return a.id;
  }

  update(id, patch) {
    const a = this.get(id);
    if (!a) return;
    this._mutate([a.page], () => {
      Object.assign(a, patch, { updatedAt: Date.now() });
    });
  }

  // Like update but coalesces into the previous undo entry — for live drags
  // where every pointermove would otherwise be its own undo step.
  updateLive(id, patch) {
    const a = this.get(id);
    if (!a) return;
    Object.assign(a, patch, { updatedAt: Date.now() });
    this.dirty = true;
    this._emitPage(a.page);
    this._emitGlobal();
  }

  // Call once when a live drag/resize starts, to capture the pre-drag state.
  beginLive(id) {
    const a = this.get(id);
    if (!a) return;
    this._pushUndo([a.page]);
  }

  remove(id) {
    const a = this.get(id);
    if (!a) return;
    this._mutate([a.page], () => {
      const list = this.pages.get(a.page);
      const i = list.indexOf(a);
      if (i >= 0) list.splice(i, 1);
    });
  }

  /* ---- undo / redo ---- */

  _snapshot(pages) {
    const snap = {};
    for (const p of pages) snap[p] = clone(this.pages.get(p) || []);
    return snap;
  }

  _restore(snap) {
    const touched = [];
    for (const p of Object.keys(snap)) {
      const n = Number(p);
      this.pages.set(n, clone(snap[p]));
      touched.push(n);
    }
    return touched;
  }

  _pushUndo(pages) {
    this.undoStack.push(this._snapshot(pages));
    if (this.undoStack.length > UNDO_LIMIT) this.undoStack.shift();
    this.redoStack.length = 0;
  }

  _mutate(pages, fn) {
    this._pushUndo(pages);
    fn();
    this.dirty = true;
    for (const p of pages) this._emitPage(p);
    this._emitGlobal();
  }

  canUndo() { return this.undoStack.length > 0; }
  canRedo() { return this.redoStack.length > 0; }

  undo() {
    if (!this.undoStack.length) return;
    const entry = this.undoStack.pop();
    this.redoStack.push(this._snapshot(Object.keys(entry).map(Number)));
    const touched = this._restore(entry);
    this.dirty = true;
    for (const p of touched) this._emitPage(p);
    this._emitGlobal();
  }

  redo() {
    if (!this.redoStack.length) return;
    const entry = this.redoStack.pop();
    this.undoStack.push(this._snapshot(Object.keys(entry).map(Number)));
    const touched = this._restore(entry);
    this.dirty = true;
    for (const p of touched) this._emitPage(p);
    this._emitGlobal();
  }

  /* ---- subscriptions ---- */

  subscribe(page, cb) {
    if (!this.pageSubs.has(page)) this.pageSubs.set(page, new Set());
    this.pageSubs.get(page).add(cb);
    return () => this.pageSubs.get(page)?.delete(cb);
  }

  subscribeGlobal(cb) {
    this.globalSubs.add(cb);
    return () => this.globalSubs.delete(cb);
  }

  _emitPage(n) {
    const subs = this.pageSubs.get(n);
    if (subs) for (const cb of subs) cb();
  }

  _emitAllPages() {
    for (const subs of this.pageSubs.values()) for (const cb of subs) cb();
  }

  _emitGlobal() {
    for (const cb of this.globalSubs) cb();
  }
}

export const store = new AnnotationStore();
