// Per-page annotation render layer: an SVG (shapes) + an HTML sibling
// (freetext / note popups), rebuilt from the store whenever the page's
// annotations change. Also hosts the pointer state-machines for drawing and
// for selecting / moving / resizing existing annotations.
//
// All geometry in the store is PDF points, page user space, top-left origin.
// The SVG viewBox is "0 0 baseW baseH", so zoom needs no rescaling here.

const SVGNS = 'http://www.w3.org/2000/svg';
const HANDLE_PX = 9;
const MIN_SIZE = 6; // points

const round = (v) => Math.round(v * 100) / 100;

// freetext font-family key (tools.js `FONT_FAMILIES`) -> CSS stack. Kept in
// sync with export.js's `standardFontFor`, which maps the same keys to real
// pdf-lib standard fonts.
const FONT_STACKS = {
  helvetica: 'Helvetica, Arial, sans-serif',
  times: '"Times New Roman", Times, serif',
  courier: '"Courier New", Courier, monospace',
};

const svgEl = (name, attrs) => {
  const el = document.createElementNS(SVGNS, name);
  for (const k in attrs) el.setAttribute(k, attrs[k]);
  return el;
};

/* ---- geometry helpers (points) ---- */

function boundsOf(a) {
  if (a.rect) return { ...a.rect };
  const pts = [];
  if (a.points) pts.push(...a.points);
  if (a.quads) for (const q of a.quads) {
    for (let i = 0; i < 8; i += 2) pts.push([q[i], q[i + 1]]);
  }
  if (!pts.length) return { x: 0, y: 0, w: 0, h: 0 };
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of pts) {
    minX = Math.min(minX, x); minY = Math.min(minY, y);
    maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

function translated(a, dx, dy) {
  const patch = {};
  if (a.rect) patch.rect = { ...a.rect, x: a.rect.x + dx, y: a.rect.y + dy };
  if (a.points) patch.points = a.points.map(([x, y]) => [x + dx, y + dy]);
  if (a.quads) patch.quads = a.quads.map((q) => q.map((v, i) => v + (i % 2 ? dy : dx)));
  return patch;
}

function catmullRom(points) {
  if (points.length < 2) return '';
  if (points.length === 2) return `M${points[0][0]},${points[0][1]} L${points[1][0]},${points[1][1]}`;
  let d = `M${points[0][0]},${points[0][1]}`;
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[i - 1] || points[i];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[i + 2] || p2;
    const c1x = p1[0] + (p2[0] - p0[0]) / 6;
    const c1y = p1[1] + (p2[1] - p0[1]) / 6;
    const c2x = p2[0] - (p3[0] - p1[0]) / 6;
    const c2y = p2[1] - (p3[1] - p1[1]) / 6;
    d += ` C${c1x},${c1y} ${c2x},${c2y} ${p2[0]},${p2[1]}`;
  }
  return d;
}

// Ramer–Douglas–Peucker
function simplify(points, tol) {
  if (points.length < 3) return points;
  const sqTol = tol * tol;
  const sqSegDist = (p, a, b) => {
    let [x, y] = a;
    let dx = b[0] - x, dy = b[1] - y;
    if (dx || dy) {
      const t = ((p[0] - x) * dx + (p[1] - y) * dy) / (dx * dx + dy * dy);
      if (t > 1) { x = b[0]; y = b[1]; }
      else if (t > 0) { x += dx * t; y += dy * t; }
    }
    dx = p[0] - x; dy = p[1] - y;
    return dx * dx + dy * dy;
  };
  const rdp = (pts, first, last, out) => {
    let maxD = sqTol, idx = -1;
    for (let i = first + 1; i < last; i++) {
      const d = sqSegDist(pts[i], pts[first], pts[last]);
      if (d > maxD) { idx = i; maxD = d; }
    }
    if (idx > -1) {
      rdp(pts, first, idx, out);
      out.push(pts[idx]);
      rdp(pts, idx, last, out);
    }
  };
  const out = [points[0]];
  rdp(points, 0, points.length - 1, out);
  out.push(points[points.length - 1]);
  return out;
}

/* ---- the layer ---- */

export function mountAnnotationLayer(pageNumber, pageDiv, baseViewport, ctx) {
  const { store, tools, getScale } = ctx;
  const W = baseViewport.width;
  const H = baseViewport.height;

  const svg = svgEl('svg', {
    class: 'annot-layer',
    viewBox: `0 0 ${W} ${H}`,
    preserveAspectRatio: 'xMidYMid meet',
  });
  const html = document.createElement('div');
  html.className = 'annot-html';

  pageDiv.append(svg, html);

  let drag = null; // active pointer interaction

  /* ---- coordinate conversion ---- */

  function toPoint(clientX, clientY) {
    const r = svg.getBoundingClientRect();
    return [
      ((clientX - r.left) / r.width) * W,
      ((clientY - r.top) / r.height) * H,
    ];
  }
  function handleSize() {
    const r = svg.getBoundingClientRect();
    return (HANDLE_PX / Math.max(1, r.width)) * W;
  }

  /* ---- render from model ---- */

  // HTML annotations (freetext / note) are reconciled, not rebuilt, so an
  // element being edited keeps focus and caret across unrelated store changes.
  const htmlEls = new Map(); // id -> element | { pin, panel }

  function render() {
    while (svg.firstChild) svg.removeChild(svg.firstChild);

    const list = store.forPage(pageNumber);
    const live = new Set();
    for (const a of list) {
      const node = renderAnnot(a);
      if (node) svg.appendChild(node);
      if (a.type === 'freetext' || a.type === 'note') { live.add(a.id); upsertHtml(a); }
    }
    for (const [id, el] of htmlEls) {
      if (!live.has(id)) {
        if (el instanceof Element) el.remove();
        else { el.pin.remove(); el.panel.remove(); }
        htmlEls.delete(id);
      }
    }

    if (drag && drag.previewNode) svg.appendChild(drag.previewNode);

    const sel = tools.selection && store.get(tools.selection.id);
    if (sel && sel.page === pageNumber && tools.tool === 'select') renderSelection(sel);

    applyMode();
  }

  function renderAnnot(a) {
    const stroke = a.color || '#ff5252';
    const op = a.opacity ?? 1;
    switch (a.type) {
      case 'highlight': {
        const g = svgEl('g', { 'data-id': a.id, class: 'an an-markup' });
        for (const q of a.quads || []) {
          g.appendChild(svgEl('polygon', {
            points: `${q[0]},${q[1]} ${q[2]},${q[3]} ${q[4]},${q[5]} ${q[6]},${q[7]}`,
            fill: stroke,
            'fill-opacity': op,
            style: 'mix-blend-mode: multiply',
          }));
        }
        return g;
      }
      case 'underline':
      case 'strike': {
        const g = svgEl('g', { 'data-id': a.id, class: 'an an-markup' });
        for (const q of a.quads || []) {
          const y = a.type === 'underline'
            ? Math.max(q[5], q[7]) - 1
            : (q[1] + q[7]) / 2;
          g.appendChild(svgEl('line', {
            x1: q[0], y1: y, x2: q[2], y2: y,
            stroke, 'stroke-opacity': op,
            'stroke-width': a.strokeWidth || 2,
          }));
        }
        return g;
      }
      case 'ink': {
        return svgEl('path', {
          'data-id': a.id, class: 'an',
          d: catmullRom(a.points || []),
          fill: 'none', stroke, 'stroke-opacity': op,
          'stroke-width': a.strokeWidth || 2,
          'stroke-linecap': 'round', 'stroke-linejoin': 'round',
        });
      }
      case 'rect': {
        const b = a.rect;
        return svgEl('rect', {
          'data-id': a.id, class: 'an',
          x: b.x, y: b.y, width: Math.max(0, b.w), height: Math.max(0, b.h),
          fill: 'none', stroke, 'stroke-opacity': op,
          'stroke-width': a.strokeWidth || 2,
        });
      }
      case 'ellipse': {
        const b = a.rect;
        return svgEl('ellipse', {
          'data-id': a.id, class: 'an',
          cx: b.x + b.w / 2, cy: b.y + b.h / 2,
          rx: Math.abs(b.w / 2), ry: Math.abs(b.h / 2),
          fill: 'none', stroke, 'stroke-opacity': op,
          'stroke-width': a.strokeWidth || 2,
        });
      }
      case 'line':
      case 'arrow': {
        const [p1, p2] = a.points;
        const g = svgEl('g', { 'data-id': a.id, class: 'an' });
        g.appendChild(svgEl('line', {
          x1: p1[0], y1: p1[1], x2: p2[0], y2: p2[1],
          stroke, 'stroke-opacity': op, 'stroke-width': a.strokeWidth || 2,
          'stroke-linecap': 'round',
        }));
        if (a.type === 'arrow') g.appendChild(arrowHead(p1, p2, a.strokeWidth || 2, stroke, op));
        return g;
      }
      case 'image': {
        const b = a.rect;
        return svgEl('image', {
          'data-id': a.id, class: 'an',
          x: b.x, y: b.y, width: Math.max(0, b.w), height: Math.max(0, b.h),
          href: a.data, opacity: op, preserveAspectRatio: 'none',
        });
      }
      case 'freetext':
      case 'note':
        return null; // rendered in HTML
      default:
        return null;
    }
  }

  function arrowHead(p1, p2, sw, color, op) {
    const ang = Math.atan2(p2[1] - p1[1], p2[0] - p1[0]);
    const len = 4 + sw * 2.5;
    const a1 = ang + Math.PI - 0.42;
    const a2 = ang + Math.PI + 0.42;
    const x1 = p2[0] + Math.cos(a1) * len;
    const y1 = p2[1] + Math.sin(a1) * len;
    const x2 = p2[0] + Math.cos(a2) * len;
    const y2 = p2[1] + Math.sin(a2) * len;
    return svgEl('polygon', {
      points: `${p2[0]},${p2[1]} ${x1},${y1} ${x2},${y2}`,
      fill: color, 'fill-opacity': op,
    });
  }

  /* ---- HTML annotations (freetext / note), reconciled ---- */

  function enterEditFreetext(div, id) {
    tools.select(id);
    div.contentEditable = 'true';
    div.focus();
    const r = document.createRange();
    r.selectNodeContents(div);
    r.collapse(false);
    const s = window.getSelection();
    s.removeAllRanges();
    s.addRange(r);
  }

  function upsertHtml(a) {
    const scale = getScale();
    const pct = (v, whole) => `${(v / whole) * 100}%`;

    if (a.type === 'freetext') {
      let div = htmlEls.get(a.id);
      if (!div) {
        div = document.createElement('div');
        div.className = 'an-freetext';
        div.dataset.id = a.id;
        div.contentEditable = 'false';
        div.textContent = a.text || '';
        // Click selects; drag moves; click-again / double-click edits.
        div.addEventListener('pointerdown', (e) => {
          if (tools.tool !== 'select' || e.button !== 0) return;
          if (div.isContentEditable) return; // caret / text selection while editing
          e.preventDefault();
          e.stopPropagation();
          const wasSelected = tools.selection && tools.selection.id === a.id;
          startMove(e, a.id, {
            captureEl: div,
            onEnd: (moved) => { if (!moved && wasSelected) enterEditFreetext(div, a.id); },
          });
        });
        div.addEventListener('dblclick', (e) => {
          e.stopPropagation();
          enterEditFreetext(div, a.id);
        });
        div.addEventListener('blur', (e) => {
          // Losing focus to the style popover (color swatch, font, B/I/U,
          // alignment, ...) means the user is setting properties *before*
          // typing anything — a still-empty box must survive that, or
          // there's no way to style text before you've typed it.
          const goingTo = e.relatedTarget;
          if (goingTo && goingTo.closest && (goingTo.closest('#annot-style') || goingTo.closest('#annot-style-btn'))) {
            return;
          }
          div.contentEditable = 'false';
          const cur = store.get(a.id);
          if (!cur) return;
          const text = div.textContent.trim();
          if (!text) { store.remove(a.id); tools.clearSelection(); }
          else if (text !== (cur.text || '')) store.update(a.id, { text });
        });
        html.appendChild(div);
        htmlEls.set(a.id, div);
      }
      div.style.left = pct(a.rect.x, W);
      div.style.top = pct(a.rect.y, H);
      div.style.width = pct(a.rect.w, W);
      div.style.color = a.color || '#111';
      div.style.fontSize = `${(a.fontSize || 14) * scale}px`;
      div.style.fontFamily = FONT_STACKS[a.fontFamily] || FONT_STACKS.helvetica;
      div.style.fontWeight = a.bold ? '700' : '400';
      div.style.fontStyle = a.italic ? 'italic' : 'normal';
      div.style.textDecoration = a.underline ? 'underline' : 'none';
      div.style.textAlign = a.align || 'left';
      if (document.activeElement !== div && (a.text || '') !== div.textContent) {
        div.textContent = a.text || '';
      }
      if (a._focus) { delete a._focus; setTimeout(() => enterEditFreetext(div, a.id), 0); }
      return;
    }

    // note
    let entry = htmlEls.get(a.id);
    if (!entry) {
      const pin = document.createElement('button');
      pin.className = 'an-note-pin';
      pin.dataset.id = a.id;
      pin.textContent = '💬';
      const panel = document.createElement('div');
      panel.className = 'an-note-panel';
      const ta = document.createElement('textarea');
      ta.placeholder = 'Note…';
      ta.value = a.text || '';
      ta.addEventListener('blur', () => {
        const cur = store.get(a.id);
        if (cur && ta.value !== (cur.text || '')) store.update(a.id, { text: ta.value });
      });
      ta.addEventListener('pointerdown', (e) => e.stopPropagation());
      panel.appendChild(ta);
      // Click selects + toggles the panel; drag moves the pin.
      pin.addEventListener('pointerdown', (e) => {
        if (tools.tool !== 'select' || e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        startMove(e, a.id, {
          captureEl: pin,
          onEnd: (moved) => {
            if (moved) return;
            tools.select(a.id);
            panel.classList.toggle('open');
            if (panel.classList.contains('open')) ta.focus();
          },
        });
      });
      html.append(pin, panel);
      entry = { pin, panel, ta };
      htmlEls.set(a.id, entry);
    }
    entry.pin.style.left = pct(a.rect.x, W);
    entry.pin.style.top = pct(a.rect.y, H);
    entry.pin.style.background = a.color || '#ffd54a';
    entry.pin.title = a.text || 'Note';
    entry.panel.style.left = pct(a.rect.x, W);
    entry.panel.style.top = pct(a.rect.y, H);
    if (document.activeElement !== entry.ta && entry.ta.value !== (a.text || '')) {
      entry.ta.value = a.text || '';
    }
    if (a._focus) {
      delete a._focus;
      entry.panel.classList.add('open');
      setTimeout(() => entry.ta.focus(), 0);
    }
  }

  /* ---- selection overlay ---- */

  function renderSelection(a) {
    const b = boundsOf(a);
    const hs = handleSize();
    const g = svgEl('g', { class: 'annot-sel' });
    g.appendChild(svgEl('rect', {
      x: b.x, y: b.y, width: Math.max(b.w, 0.1), height: Math.max(b.h, 0.1),
      fill: 'none', stroke: '#2563eb', 'stroke-dasharray': '4 3',
      'vector-effect': 'non-scaling-stroke', class: 'annot-sel-box',
    }));

    // Transparent drag surface so the whole body of a selected annotation
    // (not just its 2px outline) can be grabbed and moved. freetext / note
    // are HTML and sit above the SVG, so they move via their own element.
    if (a.type !== 'freetext' && a.type !== 'note') {
      g.appendChild(svgEl('rect', {
        x: b.x - 2, y: b.y - 2, width: Math.max(b.w + 4, 4), height: Math.max(b.h + 4, 4),
        fill: 'transparent', 'pointer-events': 'all', class: 'annot-move',
      }));
    }

    const resizable = a.type === 'rect' || a.type === 'ellipse' || a.type === 'freetext' || a.type === 'image';
    if (resizable) {
      const hx = [b.x, b.x + b.w / 2, b.x + b.w];
      const hy = [b.y, b.y + b.h / 2, b.y + b.h];
      const names = [
        ['nw', 0, 0], ['n', 1, 0], ['ne', 2, 0],
        ['w', 0, 1], ['e', 2, 1],
        ['sw', 0, 2], ['s', 1, 2], ['se', 2, 2],
      ];
      for (const [name, ix, iy] of names) {
        g.appendChild(svgEl('rect', {
          x: hx[ix] - hs / 2, y: hy[iy] - hs / 2, width: hs, height: hs,
          class: 'annot-handle', 'data-handle': name,
          'vector-effect': 'non-scaling-stroke',
        }));
      }
    } else if (a.type === 'line' || a.type === 'arrow') {
      const [p1, p2] = a.points;
      for (const [name, p] of [['p0', p1], ['p1', p2]]) {
        g.appendChild(svgEl('circle', {
          cx: p[0], cy: p[1], r: hs / 1.6,
          class: 'annot-handle', 'data-handle': name,
          'vector-effect': 'non-scaling-stroke',
        }));
      }
    }
    svg.appendChild(g);
  }

  /* ---- pointer mode ---- */

  function applyMode() {
    const t = tools.tool;
    const freeDraw = t === 'pen' || t === 'rect' || t === 'ellipse' || t === 'line' || t === 'arrow';
    svg.classList.toggle('mode-draw', freeDraw);
    svg.classList.toggle('mode-select', t === 'select');
    svg.classList.toggle('mode-eraser', t === 'eraser');
    svg.classList.toggle('mode-markup', tools.isMarkupTool(t));
    // freetext / note / image are placement clicks — capture on the svg background.
    svg.classList.toggle('mode-place', t === 'text' || t === 'note' || t === 'image');
    html.classList.toggle('interactive', t === 'select');
  }

  /* ---- pointer handlers ---- */

  svg.addEventListener('pointerdown', onPointerDown);

  function onPointerDown(e) {
    if (e.button !== 0) return;
    const t = tools.tool;
    const hit = e.target.closest && e.target.closest('[data-handle]');
    const anEl = e.target.closest && e.target.closest('.an');

    if (t === 'select') {
      if (hit) return startResize(e, hit.dataset.handle);
      if (e.target.closest && e.target.closest('.annot-move') && tools.selection) {
        return startMove(e, tools.selection.id);
      }
      if (anEl) return startMove(e, anEl.dataset.id);
      tools.clearSelection();
      render();
      return;
    }
    if (t === 'eraser') {
      if (anEl) store.remove(anEl.dataset.id);
      return;
    }
    if (t === 'text' || t === 'note') return placeText(e, t);
    if (t === 'image') return placeImage(e);
    if (t === 'pen') return startInk(e);
    if (t === 'rect' || t === 'ellipse' || t === 'line' || t === 'arrow') return startShape(e, t);
  }

  function bindDrag(onMove, onUp) {
    const move = (e) => onMove(e);
    const up = (e) => {
      svg.removeEventListener('pointermove', move);
      svg.removeEventListener('pointerup', up);
      svg.removeEventListener('pointercancel', up);
      onUp(e);
    };
    svg.addEventListener('pointermove', move);
    svg.addEventListener('pointerup', up);
    svg.addEventListener('pointercancel', up);
  }

  /* ---- drawing: ink ---- */

  function startInk(e) {
    svg.setPointerCapture(e.pointerId);
    const pts = [toPoint(e.clientX, e.clientY)];
    const path = svgEl('path', {
      fill: 'none', stroke: tools.style.color,
      'stroke-opacity': tools.style.opacity,
      'stroke-width': tools.style.strokeWidth,
      'stroke-linecap': 'round', 'stroke-linejoin': 'round',
    });
    drag = { previewNode: path };
    svg.appendChild(path);
    bindDrag(
      (ev) => {
        const evs = (ev.getCoalescedEvents && ev.getCoalescedEvents()) || [];
        if (!evs.length) evs.push(ev);
        for (const p of evs) pts.push(toPoint(p.clientX, p.clientY));
        path.setAttribute('d', catmullRom(pts));
      },
      () => {
        drag = null;
        if (pts.length > 1) {
          const s = tools.style;
          store.add({
            page: pageNumber, type: 'ink',
            points: simplify(pts, 0.6).map(([x, y]) => [round(x), round(y)]),
            color: s.color, opacity: s.opacity, strokeWidth: s.strokeWidth,
          });
        } else render();
      }
    );
  }

  /* ---- drawing: rect / ellipse / line / arrow ---- */

  function startShape(e, type) {
    svg.setPointerCapture(e.pointerId);
    const start = toPoint(e.clientX, e.clientY);
    const s = tools.style;
    const preview = (type === 'line' || type === 'arrow')
      ? svgEl('line', { stroke: s.color, 'stroke-opacity': s.opacity, 'stroke-width': s.strokeWidth, 'stroke-linecap': 'round' })
      : svgEl(type === 'rect' ? 'rect' : 'ellipse', { fill: 'none', stroke: s.color, 'stroke-opacity': s.opacity, 'stroke-width': s.strokeWidth });
    drag = { previewNode: preview };
    svg.appendChild(preview);
    bindDrag(
      (ev) => {
        const cur = toPoint(ev.clientX, ev.clientY);
        if (type === 'line' || type === 'arrow') {
          preview.setAttribute('x1', start[0]); preview.setAttribute('y1', start[1]);
          preview.setAttribute('x2', cur[0]); preview.setAttribute('y2', cur[1]);
        } else {
          const x = Math.min(start[0], cur[0]);
          const y = Math.min(start[1], cur[1]);
          const w = Math.abs(cur[0] - start[0]);
          const h = Math.abs(cur[1] - start[1]);
          if (type === 'rect') {
            preview.setAttribute('x', x); preview.setAttribute('y', y);
            preview.setAttribute('width', w); preview.setAttribute('height', h);
          } else {
            preview.setAttribute('cx', x + w / 2); preview.setAttribute('cy', y + h / 2);
            preview.setAttribute('rx', w / 2); preview.setAttribute('ry', h / 2);
          }
        }
      },
      (ev) => {
        drag = null;
        const cur = toPoint(ev.clientX, ev.clientY);
        const dist = Math.hypot(cur[0] - start[0], cur[1] - start[1]);
        if (dist < 3) { render(); return; }
        if (type === 'line' || type === 'arrow') {
          store.add({
            page: pageNumber, type,
            points: [[round(start[0]), round(start[1])], [round(cur[0]), round(cur[1])]],
            color: s.color, opacity: s.opacity, strokeWidth: s.strokeWidth,
          });
        } else {
          store.add({
            page: pageNumber, type,
            rect: {
              x: round(Math.min(start[0], cur[0])), y: round(Math.min(start[1], cur[1])),
              w: round(Math.abs(cur[0] - start[0])), h: round(Math.abs(cur[1] - start[1])),
            },
            color: s.color, opacity: s.opacity, strokeWidth: s.strokeWidth,
          });
        }
      }
    );
  }

  /* ---- placement: freetext / note ---- */

  function placeText(e, t) {
    const [x, y] = toPoint(e.clientX, e.clientY);
    const s = tools.style;
    const id = t === 'text'
      ? store.add({
          page: pageNumber, type: 'freetext', text: '', _focus: true,
          rect: { x: round(x), y: round(y), w: round(Math.max(80, Math.min(220, W - x - 8))), h: 24 },
          color: s.color, opacity: 1, fontSize: s.fontSize,
          bold: s.bold, italic: s.italic, underline: s.underline,
          align: s.align, fontFamily: s.fontFamily,
        })
      : store.add({
          page: pageNumber, type: 'note', text: '', _focus: true,
          rect: { x: round(x), y: round(y), w: 18, h: 18 },
          color: s.color, opacity: 1,
        });
    tools.setTool('select');
    tools.select(id);
  }

  /* ---- placement: image stamp ---- */

  function placeImage(e) {
    const img = tools.pendingImage;
    if (!img) { tools.setTool('select'); return; }
    const [cx, cy] = toPoint(e.clientX, e.clientY);
    const w = Math.min(img.w, W - 4);
    const h = w * (img.h / img.w || 1);
    const id = store.add({
      page: pageNumber, type: 'image',
      rect: {
        x: round(Math.min(Math.max(cx - w / 2, 0), Math.max(0, W - w))),
        y: round(Math.min(Math.max(cy - h / 2, 0), Math.max(0, H - h))),
        w: round(w), h: round(h),
      },
      color: '#000000', opacity: 1,
      data: img.dataUrl,
    });
    tools.pendingImage = null;
    tools.setTool('select');
    tools.select(id);
  }

  /* ---- move ---- */

  function startMove(e, id, opts = {}) {
    const a = store.get(id);
    if (!a) return;
    tools.select(id);
    const tgt = opts.captureEl || svg;
    try { tgt.setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ }
    const origin = toPoint(e.clientX, e.clientY);
    const base = JSON.parse(JSON.stringify({ rect: a.rect, points: a.points, quads: a.quads }));
    let moved = false;
    const onMove = (ev) => {
      const cur = toPoint(ev.clientX, ev.clientY);
      const dx = cur[0] - origin[0];
      const dy = cur[1] - origin[1];
      if (!moved && Math.hypot(dx, dy) < 1.5) return;
      if (!moved) { store.beginLive(id); moved = true; }
      store.updateLive(id, translated({ ...a, ...base }, round(dx), round(dy)));
    };
    const onUp = () => {
      tgt.removeEventListener('pointermove', onMove);
      tgt.removeEventListener('pointerup', onUp);
      tgt.removeEventListener('pointercancel', onUp);
      drag = null;
      render();
      if (opts.onEnd) opts.onEnd(moved);
    };
    tgt.addEventListener('pointermove', onMove);
    tgt.addEventListener('pointerup', onUp);
    tgt.addEventListener('pointercancel', onUp);
    render();
  }

  /* ---- resize ---- */

  function startResize(e, handle) {
    const a = store.get(tools.selection && tools.selection.id);
    if (!a) return;
    svg.setPointerCapture(e.pointerId);
    let began = false;
    const begin = () => { if (!began) { store.beginLive(a.id); began = true; } };
    bindDrag(
      (ev) => {
        const [mx, my] = toPoint(ev.clientX, ev.clientY);
        begin();
        if (a.type === 'line' || a.type === 'arrow') {
          const pts = a.points.map((p) => p.slice());
          if (handle === 'p0') pts[0] = [round(mx), round(my)];
          else pts[1] = [round(mx), round(my)];
          store.updateLive(a.id, { points: pts });
          return;
        }
        let { x, y, w, h } = a.rect;
        let x2 = x + w, y2 = y + h;
        if (handle.includes('n')) y = my;
        if (handle.includes('s')) y2 = my;
        if (handle.includes('w')) x = mx;
        if (handle.includes('e')) x2 = mx;
        const nx = Math.min(x, x2), ny = Math.min(y, y2);
        const nw = Math.max(MIN_SIZE, Math.abs(x2 - x));
        const nh = Math.max(MIN_SIZE, Math.abs(y2 - y));
        store.updateLive(a.id, { rect: { x: round(nx), y: round(ny), w: round(nw), h: round(nh) } });
      },
      () => { drag = null; render(); }
    );
  }

  /* ---- store subscription + lifecycle ---- */

  const unsub = store.subscribe(pageNumber, render);
  const unsubTools = tools.onChange(render);
  render();

  return {
    render,
    destroy() {
      unsub();
      unsubTools();
      svg.remove();
      html.remove();
    },
  };
}
