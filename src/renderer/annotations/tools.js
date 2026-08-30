// Annotation toolbar: active tool, style defaults, selection state.
// Pure UI/state — the render layers read `tools.tool` / `tools.style` and
// listen via `tools.onChange`.

const SWATCHES = ['#ffd54a', '#ff5252', '#4caf50', '#2196f3', '#9c27b0', '#111111', '#ffffff'];

// freetext-only: family key -> label. Mapped to real pdf-lib standard fonts
// at export time (export.js `standardFontFor`) and to a CSS stack for the
// live HTML preview (layer.js `FONT_STACKS`).
const FONT_FAMILIES = [['helvetica', 'Helvetica'], ['times', 'Times'], ['courier', 'Courier']];

const ALIGN_ICON_PATHS = {
  left: 'M4 6h16M4 12h10M4 18h13',
  center: 'M4 6h16M7 12h10M6 18h12',
  right: 'M4 6h16M10 12h10M7 18h13',
};

// Per-tool seed style when the tool becomes active.
const TOOL_DEFAULTS = {
  select: {},
  highlight: { color: '#ffd54a', opacity: 0.4 },
  underline: { color: '#ff5252', opacity: 1 },
  strike: { color: '#ff5252', opacity: 1 },
  pen: { color: '#ff5252', opacity: 1, strokeWidth: 2 },
  rect: { color: '#2196f3', opacity: 1, strokeWidth: 2 },
  ellipse: { color: '#2196f3', opacity: 1, strokeWidth: 2 },
  line: { color: '#2196f3', opacity: 1, strokeWidth: 2 },
  arrow: { color: '#2196f3', opacity: 1, strokeWidth: 2 },
  text: {
    color: '#111111', opacity: 1, fontSize: 14,
    bold: false, italic: false, underline: false, align: 'left', fontFamily: 'helvetica',
  },
  note: { color: '#ffd54a', opacity: 1 },
  eraser: {},
  image: {},
};

const DRAW_TOOLS = new Set(['pen', 'rect', 'ellipse', 'line', 'arrow', 'text', 'note', 'eraser', 'image']);
const MARKUP_TOOLS = new Set(['highlight', 'underline', 'strike']);

class Tools {
  constructor() {
    this.tool = 'select';
    this.style = {
      color: '#ffd54a', opacity: 1, strokeWidth: 2, fontSize: 14,
      bold: false, italic: false, underline: false, align: 'left', fontFamily: 'helvetica',
    };
    this.selection = null; // { id }
    this._subs = new Set();
    this.store = null;
    this.onExport = null;
    this.onPickImageRequest = null;
    this.pendingImage = null; // { dataUrl, w, h } armed by index.js before tool 'image' can place
    this.docOpen = false;
    this.el = {};
  }

  init({ store, onExport, onPickImageRequest }) {
    this.store = store;
    this.onExport = onExport;
    this.onPickImageRequest = onPickImageRequest;

    const row = document.getElementById('annot-toolbar');
    this.el.row = row;
    this.el.toolBtns = Array.from(row.querySelectorAll('[data-tool]'));
    this.el.undo = document.getElementById('annot-undo');
    this.el.redo = document.getElementById('annot-redo');
    this.el.styleBtn = document.getElementById('annot-style-btn');
    this.el.styleSwatch = document.getElementById('annot-style-swatch');
    this.el.popover = document.getElementById('annot-style');
    this.el.exportBtn = document.getElementById('annot-export');

    for (const b of this.el.toolBtns) {
      b.addEventListener('click', () => {
        // Image is pick-then-place: arm it (via index.js's file picker) rather
        // than switching straight to a tool with nothing to place yet.
        if (b.dataset.tool === 'image') { this.onPickImageRequest && this.onPickImageRequest(); return; }
        this.setTool(b.dataset.tool);
      });
    }
    this.el.undo.addEventListener('click', () => store.undo());
    this.el.redo.addEventListener('click', () => store.redo());
    this.el.exportBtn.addEventListener('click', () => this.onExport && this.onExport());

    this._buildPopover();
    this.el.styleBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.el.popover.classList.toggle('open');
      this._syncPopover();
    });
    document.addEventListener('click', (e) => {
      if (!this.el.popover.contains(e.target) && e.target !== this.el.styleBtn) {
        this.el.popover.classList.remove('open');
      }
    });

    store.subscribeGlobal(() => this._syncUndoRedo());

    document.addEventListener('keydown', (e) => {
      if (!this.docOpen) return;
      const typing = e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement ||
        (e.target instanceof HTMLElement && e.target.isContentEditable);
      if ((e.ctrlKey || e.metaKey) && (e.key === 'z' || e.key === 'Z')) {
        if (typing) return;
        e.preventDefault();
        if (e.shiftKey) store.redo(); else store.undo();
      } else if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || e.key === 'Y')) {
        if (typing) return;
        e.preventDefault();
        store.redo();
      } else if (e.key === 'Escape' && this.tool !== 'select') {
        this.setTool('select');
      }
    });

    this._syncToolButtons();
    this._syncSwatch();
    this._syncUndoRedo();
  }

  /* ---- tool + style ---- */

  isDrawTool(t = this.tool) { return DRAW_TOOLS.has(t); }
  isMarkupTool(t = this.tool) { return MARKUP_TOOLS.has(t); }

  setTool(name) {
    if (!name) return;
    if (name !== 'image') this.pendingImage = null;
    this.tool = name;
    const d = TOOL_DEFAULTS[name] || {};
    this.style = { ...this.style, ...d };
    if (name !== 'select') this.clearSelection();
    this._syncToolButtons();
    this._syncSwatch();
    this._syncPopover();
    this._emit();
  }

  setStyle(patch) {
    this.style = { ...this.style, ...patch };
    this._syncSwatch();
    // Apply live to the current selection, if any.
    if (this.selection && this.store) {
      const a = this.store.get(this.selection.id);
      if (a) {
        const p = {};
        if ('color' in patch) p.color = patch.color;
        if ('opacity' in patch) p.opacity = patch.opacity;
        if ('strokeWidth' in patch && a.type !== 'highlight') p.strokeWidth = patch.strokeWidth;
        if ('fontSize' in patch && (a.type === 'freetext' || a.type === 'note')) p.fontSize = patch.fontSize;
        if (a.type === 'freetext') {
          for (const k of ['bold', 'italic', 'underline', 'align', 'fontFamily']) {
            if (k in patch) p[k] = patch[k];
          }
        }
        if (Object.keys(p).length) this.store.update(a.id, p);
      }
    }
    this._emit();
  }

  // Seed style for a newly created annotation of `type`.
  seedStyle(type) {
    const s = this.style;
    const base = { color: s.color, opacity: s.opacity };
    if (type === 'highlight') return { ...base, opacity: s.opacity ?? 0.4 };
    if (type === 'underline' || type === 'strike') return { color: s.color, opacity: 1, strokeWidth: Math.max(1.5, s.strokeWidth) };
    if (type === 'ink' || type === 'rect' || type === 'ellipse' || type === 'line' || type === 'arrow') {
      return { ...base, strokeWidth: s.strokeWidth };
    }
    if (type === 'freetext') {
      return {
        color: s.color, opacity: 1, fontSize: s.fontSize,
        bold: s.bold, italic: s.italic, underline: s.underline,
        align: s.align, fontFamily: s.fontFamily,
      };
    }
    if (type === 'note') return { color: s.color, opacity: 1, fontSize: 13 };
    return base;
  }

  // Called by index.js once a picked image is ready; switches to the Image
  // tool with something to place on the next canvas click.
  armImage(dataUrl, w, h) {
    this.pendingImage = { dataUrl, w, h };
    this.setTool('image');
  }

  /* ---- selection ---- */

  select(id) {
    this.selection = id ? { id } : null;
    if (id && this.store) {
      const a = this.store.get(id);
      if (a) {
        this.style = {
          ...this.style,
          color: a.color || this.style.color,
          opacity: a.opacity ?? this.style.opacity,
          strokeWidth: a.strokeWidth ?? this.style.strokeWidth,
          fontSize: a.fontSize ?? this.style.fontSize,
          bold: a.type === 'freetext' ? !!a.bold : this.style.bold,
          italic: a.type === 'freetext' ? !!a.italic : this.style.italic,
          underline: a.type === 'freetext' ? !!a.underline : this.style.underline,
          align: a.type === 'freetext' ? (a.align || 'left') : this.style.align,
          fontFamily: a.type === 'freetext' ? (a.fontFamily || 'helvetica') : this.style.fontFamily,
        };
        this._syncSwatch();
        this._syncPopover();
      }
    }
    this._emit();
  }

  clearSelection() {
    if (!this.selection) return;
    this.selection = null;
    this._emit();
  }

  /* ---- doc open state ---- */

  setDocOpen(open) {
    this.docOpen = open;
    this.el.row.classList.toggle('disabled', !open);
    for (const b of this.el.toolBtns) b.disabled = !open;
    this.el.undo.disabled = !open;
    this.el.redo.disabled = !open;
    this.el.styleBtn.disabled = !open;
    this.el.exportBtn.disabled = !open;
    if (!open) {
      this.setTool('select');
      this.el.popover.classList.remove('open');
    }
    this._syncUndoRedo();
  }

  /* ---- change bus ---- */

  onChange(cb) { this._subs.add(cb); return () => this._subs.delete(cb); }
  _emit() { for (const cb of this._subs) cb(); }

  /* ---- DOM sync ---- */

  _syncToolButtons() {
    for (const b of this.el.toolBtns) {
      b.classList.toggle('active', b.dataset.tool === this.tool);
    }
  }

  _syncSwatch() {
    if (this.el.styleSwatch) this.el.styleSwatch.style.background = this.style.color;
  }

  _syncUndoRedo() {
    const s = this.store;
    this.el.undo.disabled = !this.docOpen || !s || !s.canUndo();
    this.el.redo.disabled = !this.docOpen || !s || !s.canRedo();
    this.el.exportBtn.disabled = !this.docOpen || !s || s.isEmpty();
  }

  _buildPopover() {
    const pop = this.el.popover;
    pop.innerHTML = '';

    const swWrap = document.createElement('div');
    swWrap.className = 'asp-swatches';
    for (const c of SWATCHES) {
      const sw = document.createElement('button');
      sw.type = 'button';
      sw.className = 'asp-swatch';
      sw.style.background = c;
      sw.dataset.color = c;
      sw.addEventListener('click', () => {
        this.setStyle({ color: c });
        this._syncPopover();
      });
      swWrap.appendChild(sw);
    }
    const custom = document.createElement('input');
    custom.type = 'color';
    custom.className = 'asp-custom';
    custom.addEventListener('input', () => this.setStyle({ color: custom.value }));
    this.el.customColor = custom;
    swWrap.appendChild(custom);

    const mkRange = (label, key, min, max, step) => {
      const wrap = document.createElement('label');
      wrap.className = 'asp-range';
      const span = document.createElement('span');
      span.textContent = label;
      const input = document.createElement('input');
      input.type = 'range';
      input.min = min; input.max = max; input.step = step;
      input.addEventListener('input', () => {
        const v = Number(input.value);
        this.setStyle({ [key]: v });
        val.textContent = key === 'opacity' ? `${Math.round(v * 100)}%` : String(v);
      });
      const val = document.createElement('span');
      val.className = 'asp-val';
      wrap.append(span, input, val);
      return { wrap, input, val };
    };

    this.el.rWidth = mkRange('Stroke', 'strokeWidth', 0.5, 12, 0.5);
    this.el.rOpacity = mkRange('Opacity', 'opacity', 0.1, 1, 0.05);
    this.el.rFont = mkRange('Font size', 'fontSize', 8, 48, 1);

    // Text-only controls (font family, bold/italic/underline, alignment) —
    // shown only for the Text tool / a selected freetext annotation, since
    // they're meaningless for shapes, ink, markup, etc.
    const textGroup = document.createElement('div');
    textGroup.className = 'asp-text-group';

    const fontRow = document.createElement('label');
    fontRow.className = 'asp-font-row';
    const fontLabel = document.createElement('span');
    fontLabel.textContent = 'Font';
    const fontSel = document.createElement('select');
    fontSel.className = 'asp-font-select';
    for (const [key, label] of FONT_FAMILIES) {
      const opt = document.createElement('option');
      opt.value = key;
      opt.textContent = label;
      fontSel.appendChild(opt);
    }
    fontSel.addEventListener('change', () => { this.setStyle({ fontFamily: fontSel.value }); this._syncPopover(); });
    fontRow.append(fontLabel, fontSel);
    this.el.fontSel = fontSel;

    const styleRow = document.createElement('div');
    styleRow.className = 'asp-style-row';
    const mkToggle = (label, key, title, extraStyle) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'asp-toggle';
      b.textContent = label;
      b.title = title;
      if (extraStyle) Object.assign(b.style, extraStyle);
      b.addEventListener('click', () => { this.setStyle({ [key]: !this.style[key] }); this._syncPopover(); });
      return b;
    };
    this.el.boldBtn = mkToggle('B', 'bold', 'Bold', { fontWeight: '700' });
    this.el.italicBtn = mkToggle('I', 'italic', 'Italic', { fontStyle: 'italic' });
    this.el.underlineBtn = mkToggle('U', 'underline', 'Underline', { textDecoration: 'underline' });

    const alignWrap = document.createElement('div');
    alignWrap.className = 'asp-align-wrap';
    this.el.alignBtns = [];
    for (const key of ['left', 'center', 'right']) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'asp-toggle';
      b.dataset.align = key;
      b.title = `Align ${key}`;
      b.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${ALIGN_ICON_PATHS[key]}" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`;
      b.addEventListener('click', () => { this.setStyle({ align: key }); this._syncPopover(); });
      this.el.alignBtns.push(b);
      alignWrap.appendChild(b);
    }

    styleRow.append(this.el.boldBtn, this.el.italicBtn, this.el.underlineBtn, alignWrap);
    textGroup.append(fontRow, styleRow);
    this.el.textGroup = textGroup;

    pop.append(swWrap, textGroup, this.el.rWidth.wrap, this.el.rOpacity.wrap, this.el.rFont.wrap);
    pop.addEventListener('click', (e) => e.stopPropagation());
  }

  // Whether the Bold/Italic/Underline/Align/Font controls are relevant right
  // now: the Text tool is active, or a freetext annotation is selected.
  _isTextContext() {
    if (this.selection && this.store) {
      const a = this.store.get(this.selection.id);
      return !!a && a.type === 'freetext';
    }
    return this.tool === 'text';
  }

  _syncPopover() {
    const s = this.style;
    for (const sw of this.el.popover.querySelectorAll('.asp-swatch')) {
      sw.classList.toggle('active', sw.dataset.color.toLowerCase() === String(s.color).toLowerCase());
    }
    if (this.el.customColor && /^#[0-9a-f]{6}$/i.test(s.color)) this.el.customColor.value = s.color;
    this.el.rWidth.input.value = s.strokeWidth;
    this.el.rWidth.val.textContent = String(s.strokeWidth);
    this.el.rOpacity.input.value = s.opacity;
    this.el.rOpacity.val.textContent = `${Math.round(s.opacity * 100)}%`;
    this.el.rFont.input.value = s.fontSize;
    this.el.rFont.val.textContent = String(s.fontSize);
    this.el.fontSel.value = s.fontFamily || 'helvetica';
    this.el.boldBtn.classList.toggle('active', !!s.bold);
    this.el.italicBtn.classList.toggle('active', !!s.italic);
    this.el.underlineBtn.classList.toggle('active', !!s.underline);
    for (const b of this.el.alignBtns) b.classList.toggle('active', b.dataset.align === (s.align || 'left'));
    // Not `.hidden = true` — the UA stylesheet's `[hidden] { display: none }`
    // has no `!important`, so it loses to this group's own `display: flex`
    // rule and the group stays visible regardless. A dedicated class wins on
    // specificity instead.
    this.el.textGroup.classList.toggle('asp-text-group-collapsed', !this._isTextContext());
  }
}

export const tools = new Tools();
