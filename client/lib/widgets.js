// widgets — the ONE field → widget table every panel surface reads (C13, 2026-10-12; DEBT-SURVEY §2.12).
//
// A panel declares FIELDS (panels.js's schema) and never owns bespoke DOM or paint. Three surfaces draw a field:
// the desktop frame (DOM), the legacy VR quad (a 2D canvas in the panels' skin) and edit mode's VR quad (the same
// canvas under the VR floor edittheme.js sets). Before C13 each surface was its own switch over f.t, in two files;
// a widget added to one could be missing from another with nothing to say so. Now every field type is ONE entry here:
//
//   WIDGETS[t] = { dom(f, D), legacy(f, P), edit(f, P), editH?(f, S), row? }
//
// dom builds the row's control into D.row and sets row.update; legacy and edit paint into P.g and push hit REGIONS
// ({x, y, w, h, action, payload?, slider?}) that xrpanels.js resolves a laser UV against and dispatches exactly as the
// DOM control dispatches. The SURFACE is the parameter: D is the desktop's (the row, its label, edit(), the frame's
// stepper/pop/menu makers), P is a canvas surface's (its context, geometry, tokens and primitives; panels.js builds
// the legacy one, editpaint.js the edit one). paintFields(fields, S) is the one canvas walk both share: the layout
// (folds, deskOnly, a list's rows), the per-row label the surface paints, the disabled rule (a disabled field paints
// but takes no hits) and the lookup. A type dropped from this table is gone from every surface at once, which is what
// tools/panels-schema-test.ts and tools/edittheme-test.ts go red on together.
//
// The widget bodies are the three renderers' cases moved here verbatim (REFACTOR-C13-2026-10-12.md lists where the
// two canvas looks differ; those differences are kept, not reconciled). The facts a widget reads (step, dp, unit, deg,
// min, max, options, def) are the descriptor's `ui` facts (shared/protocol/descriptors.js) as editschema's rowOf hands
// them on; the shared readers of them are FACTS below.

import { svg as strokeSvg, rsvg, has as hasIcon, fsvg, hasFill, hasLine, stroke as strokeIcon } from './icons.js';
import { EDIT as T, EDIT_VR as V, pictoRuns, hasPicto } from './edittheme.js';
import { KEYHINTS, withKeys } from './keyhints.js';

export const R2D = 180 / Math.PI;
export const iconSvg = (name, size = 18) => (hasIcon(name) ? strokeSvg(name, size) : hasFill(name) ? fsvg(name, size) : '');
const IN = (V.rowH - V.minHit) / 2;            // edit: a target's inset inside its row → exactly minHit tall
const hslInt = (h, s, l) => {
  const a = s * Math.min(l, 1 - l), f = (n) => { const k = (n + h / 30) % 12; return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)))); };
  return (f(0) << 16) | (f(8) << 8) | f(4);
};
export const PICK_GRID = [
  ...Array.from({ length: 12 }, (_, i) => { const v = Math.round(255 * (1 - i / 11)); return (v << 16) | (v << 8) | v; }),
  ...[[0.9, 0.88], [0.85, 0.74], [0.8, 0.58], [0.75, 0.44], [0.7, 0.28]].flatMap(([s, l]) => Array.from({ length: 12 }, (_, i) => hslInt(i * 30, s, l))),
];
const openPickers = new Set();
const RECENT_KEY = 'eido-recent-colours', RECENT_MAX = 12;
let recent = null;
export function recentColours() {
  if (recent) return recent;
  try { const r = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]'); recent = Array.isArray(r) ? r.filter(Number.isInteger).slice(0, RECENT_MAX) : []; } catch { recent = []; }
  return recent;
}
function noteRecent(c) {
  recent = [c, ...recentColours().filter((x) => x !== c)].slice(0, RECENT_MAX);
  try { localStorage.setItem(RECENT_KEY, JSON.stringify(recent)); } catch {}
}
const PAL = [0xffffff, 0xffd9a0, 0xff8a5c, 0xe05a5a, 0x7cc47c, 0x5fa8ff, 0xb48cff, 0x202020];   // the keyboard-free colour picks, both canvas looks
const ACTION_ICON = { '✕': 'x' };             // row-action labels that are glyphs → the icon set (edit)
const TILE_COLS = 3;                           // edit: a tiles field three across (≈ 160 px each on a 522 quad)
const AXIS_RE = /(?:^|:)(?:pos|rot|scale)\.([xyz])$/;   // a channel's axis — the label wears x/y/z (the desktop's data-axis)

/** The descriptor facts every surface reads the same way (step/dp/unit/deg on a number, the slider's range, a colour's
 *  hex, a reference's face, a console's last line). The canvas painters and the DOM stepper all read through here, so a
 *  default (step 0.1, dp 2, a slider 0..1 by 0.01) is stated once. */
export const FACTS = {
  // a stepper's bump is on the WIRE scale (radians for a degree field): the dispatcher adds it to the current value
  delta: (f) => (f.deg ? (f.step ?? 1) / R2D : (f.step ?? 0.1)),
  range: (f) => ({ lo: f.min ?? 0, hi: f.max ?? 1, st: f.step ?? 0.01, dp: f.dp ?? 2, unit: f.unit ?? '' }),
  hex: (v) => '#' + (v ?? 0xffffff).toString(16).padStart(6, '0'),
  ref: (f) => (f.arming ? 'click a target…' : (f.value ?? '— pick —')),
  lastLine: (f) => String((f.lines ?? []).at(-1) ?? f.empty ?? ''),
};

export function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

/** Set an element's text; in edit chrome (ro.icons) a mapped pictograph becomes its icons.js glyph —
 *  the same glyph the VR painter draws, so the two surfaces agree and no emoji font is relied on. */
export function put(e, s, icons) {
  s = String(s ?? '');
  if (!icons || !hasPicto(s)) { e.textContent = s; return e; }
  e.textContent = '';
  for (const r of pictoRuns(s)) {
    if (typeof r === 'string') e.append(r);
    else { const i = document.createElement('span'); i.className = 'sp-ico'; i.innerHTML = iconSvg(r.icon, 13); e.append(i); }
  }
  return e;
}

/** A number as edit mode writes it (R, 10-10, after Maya's channel box): no trailing zeros, a bare 0, a leading 0 before
 *  a fraction: 0.5 not 0.50, 0 not 0.00, 0.15 not .15, 2 not 2.00. `dp` is the most decimals shown. */
export function trimNum(v, dp = 2) {
  let s = (+v).toFixed(dp);
  if (s.includes('.')) s = s.replace(/0+$/, '').replace(/\.$/, '');
  return s === '-0' ? '0' : s;
}

const treeScroll = new Map();   // a tree field's scroll position, by its key, across rebuilds
let treeDrag = null;   // the tree row being dragged (id), across the dragstart → drop pair

// ---------------------------------------------------------------- a list / tree row, per canvas look
const ROW = {
  legacy(r, parent, P) { const { g, regions, C, font, pad, width, rowH, y } = P;
    const tree = parent.t === 'tree';
    const ind = tree ? (r.depth ?? 0) * 18 : 0;
    g.fillStyle = r.active ? 'rgba(143,232,200,0.16)' : C.row;
    g.fillRect(pad, y + 2, width - pad * 2, rowH - 4);
    const lx = pad + 10 + ind + (tree ? 26 : 0);   // a tree row's name starts after its enabled column
    // the text stops short of the row's right-hand targets (the eye and the lock), however deep or long (review 10-12 S3-4)
    const stop = tree ? width - pad - 34 - (r.mine != null ? 40 : 0) - 8 : width - pad;
    const fit = (t, w) => { t = String(t); if (w <= 0) return ''; if (g.measureText(t).width <= w) return t; while (t.length && g.measureText(t + '…').width > w) t = t.slice(0, -1); return t ? t + '…' : ''; };
    font(15, r.active ? 600 : 400); g.fillStyle = r.off ? C.label : C.text;
    const name = fit(String(r.label).slice(0, 34), stop - lx);
    g.fillText(name, lx, y + rowH * 0.62);
    if (tree && (r.sub || r.badges?.length)) {
      const sx = lx + Math.min(220, g.measureText(name).width + 14);
      font(11); g.fillStyle = C.label;
      const sub = fit([r.sub, ...(r.badges ?? [])].filter(Boolean).join(' · ').slice(0, 40), stop - sx);
      if (sub) g.fillText(sub, sx, y + rowH * 0.62);
    }
    regions.push({ x: pad, y, w: width * 0.6, h: rowH, action: parent.k ?? 'row', payload: r.id });
    if (tree && r.kids) {   // a disclosure glyph, its own hit region ahead of the row's
      font(13); g.fillStyle = C.label; g.fillText(r.open === false ? '▸' : '▾', pad + ind - 4, y + rowH * 0.62);
      regions.unshift({ x: pad + ind - 8, y, w: 16, h: rowH, action: 'open', payload: r.id });
    }
    if (tree && r.enabled != null) {   // ☑ ahead of the row's own region, like the disclosure
      const s = 18, bx = pad + 10 + ind, by = y + (rowH - s) / 2;
      g.strokeStyle = C.label; g.lineWidth = 2; g.strokeRect(bx, by, s, s);
      if (r.enabled) { g.strokeStyle = C.accent; g.lineWidth = 3; g.beginPath(); g.moveTo(bx + s * 0.2, by + s * 0.55); g.lineTo(bx + s * 0.45, by + s * 0.8); g.lineTo(bx + s * 0.85, by + s * 0.2); g.stroke(); }
      if (r.offable !== false) regions.unshift({ x: bx - 4, y, w: s + 8, h: rowH, action: 'enable', payload: { id: r.id, on: !r.enabled } });
    }
    if (tree) {
      const bw = 34, bx = width - pad - bw;
      if (r.mine != null) {   // the eye, left of the lock: tinted when on, "only you"
        const ex = bx - bw - 6;
        g.fillStyle = r.mine ? C.mine : '#2a3342'; g.fillRect(ex, y + 7, bw, rowH - 14);
        g.save(); g.translate(ex + bw / 2, y + rowH / 2); g.strokeStyle = r.mine ? '#14100c' : C.text; strokeIcon(g, r.mine ? 'eyeOff' : 'eye', 20, 2); g.restore();
        regions.push({ x: ex, y: y + 7, w: bw, h: rowH - 14, action: 'myhide', payload: r.id });
      }
      g.fillStyle = r.locked ? C.accent : '#2a3342';
      g.fillRect(bx, y + 7, bw, rowH - 14);
      font(13, 600); g.fillStyle = r.locked ? '#14100c' : C.text;
      g.fillText(r.locked ? 'L' : 'l', bx + 12, y + rowH * 0.62);
      if (r.lockable !== false) regions.push({ x: bx, y: y + 7, w: bw, h: rowH - 14, action: 'lock', payload: r.id });
      return;
    }
    let bx = width - pad;
    for (const a of [...(r.actions ?? [])].reverse()) {
      const bw = Math.max(52, a.label.length * 9 + 18);
      bx -= bw + 6;
      g.fillStyle = a.danger ? C.danger : C.well;
      g.fillRect(bx, y + 7, bw, rowH - 14);
      font(13, 500); g.fillStyle = C.text;
      g.fillText(a.label, bx + 9, y + rowH * 0.6);
      regions.push({ x: bx, y: y + 7, w: bw, h: rowH - 14, action: a.k, payload: r.id });
    }
  },
  edit(r, parent, P) { const { g, regions, font, text, fill, box, icon, quietButton, pad, width, rowH, y } = P;
    const tree = parent.t === 'tree';
    const ind = tree ? (r.depth ?? 0) * 18 : 0;
    if (r.active) { fill(g, T.accentBg, 0, y, width, rowH); fill(g, T.accent, 0, y, 3, rowH); }
    else if (r.multi) fill(g, T.accentBg, 0, y, width, rowH);
    if (tree) for (let d = 1; d <= (r.depth ?? 0); d++) fill(g, T.line, pad + d * 18 - 9, y, V.minLine, rowH);   // indent guides
    const x0 = pad + ind + (tree ? 22 + 30 : 8);   // a tree row's name starts after its enabled column, box or not
    font(V.minText, r.active ? 600 : 400);
    const lockW = tree && r.locked != null ? V.minHit + 8 : 0;
    const eyeW = tree && r.mine != null ? V.minHit + 8 : 0;
    let right = width - pad - lockW - eyeW;
    // row actions (lists): quiet buttons at the right end, full-height targets
    if (!tree) {
      for (const a of [...(r.actions ?? [])].reverse()) {
        const ic = ACTION_ICON[a.label];
        font(V.minText, 500);
        const bw = ic ? V.minHit : Math.max(52, g.measureText(a.label).width + 20);
        right -= bw + 6;
        quietButton(right, y + IN, bw, V.minHit, a.label, a.danger, ic);
        regions.push({ x: right, y: y + IN, w: bw, h: V.minHit, action: a.k, payload: r.id });
      }
    }
    font(V.minText, r.active ? 600 : 400);
    const lw = text(g, r.label, x0, y + rowH / 2, r.dim || r.off ? T.dim : T.text, right - x0 - 8);
    if (tree && (r.sub || r.badges?.length)) {
      font(V.minText); text(g, [r.sub, ...(r.badges ?? [])].filter(Boolean).join(' · '), x0 + lw + 10, y + rowH / 2, T.dim, right - (x0 + lw + 10) - 8);
    }
    regions.push({ x: pad, y, w: width * 0.6, h: rowH, action: parent.k ?? 'row', payload: r.id });
    if (tree && r.kids) {   // the disclosure: its own target ahead of the row's (legacy order)
      icon(g, r.open === false ? 'chevronRight' : 'chevronDown', pad + ind + 9, y + rowH / 2, 18, T.dim);
      regions.unshift({ x: pad + ind - 8, y, w: Math.max(28, 16), h: rowH, action: 'open', payload: r.id });
    }
    if (tree && r.enabled != null) {   // ☑ ahead of the row's own target (and after the disclosure's)
      const s = 24, bx = pad + ind + 24, by = y + rowH / 2 - s / 2;
      if (r.enabled) { box(g, bx, by, s, s, T.accent, null, 4); icon(g, 'check', bx + s / 2, by + s / 2, 18, '#ffffff', 3); }
      else box(g, bx, by, s, s, T.well, T.dim, 4);
      if (r.offable !== false) regions.unshift({ x: bx - 4, y: y + IN, w: s + 8, h: V.minHit, action: 'enable', payload: { id: r.id, on: !r.enabled } });
    }
    if (tree && r.mine != null) {   // the eye, left of the lock: tinted when on ("only you")
      const bx = width - pad - lockW - V.minHit, by = y + IN;
      if (r.mine) box(g, bx, by, V.minHit, V.minHit, T.press, null);
      icon(g, r.mine ? 'eyeOff' : 'eye', bx + V.minHit / 2, by + V.minHit / 2, 20, r.mine ? T.mine : T.dim);
      regions.push({ x: bx, y: by, w: V.minHit, h: V.minHit, action: 'myhide', payload: r.id });
    }
    if (tree && r.locked != null) {   // always drawn in VR (no hover); ON = accent
      const bx = width - pad - V.minHit, by = y + IN;
      if (r.locked) box(g, bx, by, V.minHit, V.minHit, T.press, null);
      icon(g, r.locked ? 'lock' : 'lockOpen', bx + V.minHit / 2, by + V.minHit / 2, 20, r.locked ? T.accent : T.dim);
      regions.push({ x: bx, y: by, w: V.minHit, h: V.minHit, action: 'lock', payload: r.id });
    }
  },
};

// ---------------------------------------------------------------- the table
export const WIDGETS = {
  info: {
    dom(f, D) { const { row, setLabel, ro, el, put } = D;
      const s = put(el('span', 'sp-info'), f.value, ro.icons);
      // a long value is cut at the panel's edge: hover shows it whole, a click unfolds it in place (R 10-11: 'reads as')
      // a short value carries no title of its own: an empty one would hide the row's hint (an element's title="" is 'no advice')
      const full = () => { const t = s.textContent ?? ''; if (t.length > 40) s.title = t; else s.removeAttribute('title'); s.classList.toggle('sp-info-long', t.length > 40); };
      full(); s.onclick = () => { if (s.classList.contains('sp-info-long')) s.classList.toggle('sp-info-open'); };
      row.append(s);
      row.update = (nf) => { setLabel(nf); put(s, nf.value, ro.icons); full(); };
    },
    legacy(f, P) { const { g, C, font, vx, rowH, y } = P;
      font(15); g.fillStyle = C.text; g.fillText(String(f.value ?? '').slice(0, 30), vx, y + rowH * 0.6);
    },
    edit(f, P) { const { g, X, W, mid, font, text } = P;
      font(); text(g, String(f.value ?? ''), X, mid, T.text, W);
    },
  },
  log: {
    dom(f, D) { const { row, el } = D;
      // a scrolling monospace tail (a script console): follows the bottom unless you scrolled up to read
      const pre = el('pre', 'sp-log');
      const put = (nf) => {
        const atBottom = pre.scrollHeight - pre.scrollTop - pre.clientHeight < 8;
        pre.textContent = (nf.lines ?? []).length ? nf.lines.join('\n') : (nf.empty ?? '');
        pre.classList.toggle('empty', !(nf.lines ?? []).length);
        if (atBottom) pre.scrollTop = pre.scrollHeight;
      };
      put(f);
      row.append(pre);
      row.update = (nf) => put(nf);
    },
    legacy(f, P) { const { g, C, font, pad, rowH, y } = P;
      font(13); g.fillStyle = C.label; g.fillText(FACTS.lastLine(f).slice(0, 44), pad, y + rowH * 0.6); // newest line only: a quad has no scrollback
    },
    edit(f, P) { const { g, mid, pad, width, font, text } = P;
      font(); text(g, FACTS.lastLine(f), pad, mid, T.dim, width - pad * 2); // newest line: a quad has no scrollback
    },
  },
  num: {
    dom(f, D) { const { row, label, setLabel, edit, ro, el, stepper } = D;
      const st = stepper(f.value ?? 0, f, (v, o) => edit(f.k, v, null, o));
      // driven: the FIELD carries it (edit chrome) — a `~` inside its left end; the label keeps its axis colour
      // …and it leads to its driver (Resonite's drive mark, Unity's animated tint; R 10-04: drivers are ordinary cards,
      // the field points at them — no second list to drift): click goes to the driver's card
      if (f.driven && ro.icons) { const d = el('span', 'sp-drv', '~'); d.title = `driven by ${f.drivenBy ? `its ${f.drivenBy} (${f.driven})` : f.driven} — click to go to its card`;
        d.style.cursor = 'pointer'; d.onpointerdown = (e) => e.stopPropagation(); d.onclick = (e) => { e.stopPropagation(); edit('goto', f.driven); }; st.prepend(d); }
      row.append(st); row._st = st;
      row.update = (nf) => { setLabel(nf); st.update(nf); };
      if (label && ro.icons && !f.disabled) {   // edit chrome: the channel's name is a handle too
        label.classList.add('sp-chan');
        // a scrub on a selected channel moves every selected channel by the same amount (Maya's channel box)
        st.key = f.k; st.commitRun = (pairs) => edit('__run', pairs);
        st.peers = () => (row.classList.contains('chan-sel') ? [...(row.parentElement?.querySelectorAll('.sp-row.chan-sel') ?? [])].map((r) => r._st).filter((x) => x && x !== st) : []);
        // selecting channels, as in Maya's channel box (R 10-10 23:36): a click selects one; Ctrl toggles one; Shift selects
        // the run from the last one clicked; dragging UP or DOWN the names selects the run under the pointer (sideways
        // is still the scrub)
        const chans = () => [...(row.parentElement?.children ?? [])].filter((r) => r.classList?.contains('sp-row') && r.querySelector('.sp-chan'));
        const selectRun = (a, b, keep) => { const L = chans(); const i = L.indexOf(a), j = L.indexOf(b); if (i < 0 || j < 0) return;
          if (!keep) for (const r of L) r.classList.remove('chan-sel'); for (let k = Math.min(i, j); k <= Math.max(i, j); k++) L[k].classList.add('chan-sel'); };
        const selectKey = (e) => {
          const sel = [...(row.parentElement?.querySelectorAll('.sp-row.chan-sel') ?? [])];
          if (e.ctrlKey || e.metaKey) { row.classList.toggle('chan-sel'); row.parentElement._chanAnchor = row; return; }   // keys: selectExtend
          if (e.shiftKey && row.parentElement?._chanAnchor?.isConnected) { selectRun(row.parentElement._chanAnchor, row, false); return; }   // keys: selectExtend
          const only = sel.length === 1 && sel[0] === row;
          for (const r of sel) r.classList.remove('chan-sel');
          if (!only) row.classList.add('chan-sel');
          if (row.parentElement) row.parentElement._chanAnchor = row;
        };
        st.bindScrub(label, (e) => { if (label._ranged) { label._ranged = false; return; } selectKey(e); });   // a click on the name
        st.onSelectKey = selectKey;   // Shift/Ctrl-click on the value box
        // dragging UP or DOWN a name OR a value box selects the run under the pointer (sideways is still the scrub)
        const rangeDrag = (src) => src.addEventListener('pointerdown', (e) => { if (e.button !== 0) return; const y0 = e.clientY, x0 = e.clientX, keep = e.ctrlKey || e.metaKey;   // keys: selectExtend
          const move = (ev) => { if (!src._ranging) { if (Math.abs(ev.clientY - y0) < 6 || Math.abs(ev.clientY - y0) < Math.abs(ev.clientX - x0)) return; src._ranging = true; src._ranged = true; src.blur?.(); }
            const over = document.elementFromPoint(x0, ev.clientY)?.closest?.('.sp-row'); if (over && chans().includes(over)) { selectRun(row, over, keep); row.parentElement._chanAnchor = row; } };
          const up = () => { removeEventListener('pointermove', move, true); removeEventListener('pointerup', up, true); setTimeout(() => { src._ranging = false; src._ranged = false; }, 0); };
          addEventListener('pointermove', move, true); addEventListener('pointerup', up, true); });
        rangeDrag(label); rangeDrag(st.num);
      }
    },
    legacy(f, P) { const { vx, y, paintStepper } = P;
      paintStepper(f, +(f.value ?? 0), vx, y, f.k, null, f.dp);
    },
    edit(f, P) { const { X, W, y, stepper } = P;
      stepper(f, +(f.value ?? 0), X, y, Math.min(W, 240), f.k, null);
    },
  },
  range: {
    dom(f, D) { const { row, setLabel, edit, el } = D;
      // the house's own <input type=range> (index.html styles it globally;
      // --p drives the progress fill) — the same control the desk's dials use
      const { lo, hi, st, dp } = FACTS.range(f);
      const sl = el('input', 'sp-range'); sl.type = 'range'; sl.min = lo; sl.max = hi; sl.step = st; sl.value = f.value ?? lo;
      const out = el('span', 'sp-range-val', `${trimNum(+sl.value, dp)}${f.unit ?? ''}`);
      const paint = () => sl.style.setProperty('--p', `${((sl.value - lo) / (hi - lo || 1)) * 100}%`);
      paint();
      const face = () => { paint(); out.textContent = `${trimNum(+sl.value, dp)}${f.unit ?? ''}`; };
      // the panels contract: a drag PREVIEWS (opts.live), the release commits once
      sl.oninput = () => { face(); edit(f.k, +sl.value, null, { live: true }); };
      sl.onchange = () => { face(); edit(f.k, +sl.value); };
      row.update = (nf) => { setLabel(nf); if (document.activeElement !== sl) { sl.value = nf.value ?? lo; face(); } };
      row.append(sl, out);
    },
    legacy(f, P) { const { g, regions, C, font, pad, vx, width, rowH, y, roundRect } = P;
      const { lo, hi, st, dp } = FACTS.range(f);
      const v = Math.min(hi, Math.max(lo, +(f.value ?? lo)));
      const tw = width - pad - vx - 64, ty = y + rowH / 2, frac = (v - lo) / (hi - lo || 1);
      g.fillStyle = C.well; roundRect(g, vx, ty - 4, tw, 8, 4); g.fill();
      g.fillStyle = C.accent; roundRect(g, vx, ty - 4, Math.max(8, tw * frac), 8, 4); g.fill();
      g.beginPath(); g.arc(vx + tw * frac, ty, 9, 0, Math.PI * 2); g.fillStyle = C.text; g.fill();
      font(15); g.fillStyle = C.text; g.textAlign = 'right'; g.fillText(`${trimNum(v, dp)}${f.unit ?? ''}`, width - pad, y + rowH * 0.62); g.textAlign = 'left';
      // one region for the whole track: the hit's fraction along it is the value
      regions.push({ x: vx - 6, y: y + 4, w: tw + 12, h: rowH - 8, action: f.k, slider: { lo, hi, st } });
    },
    edit(f, P) { const { g, regions, X, W, mid, y, pad, width, font, text, box } = P;
      const { lo, hi, st, dp } = FACTS.range(f);
      const v = Math.min(hi, Math.max(lo, +(f.value ?? lo)));
      const tw = W - 84, frac = (v - lo) / (hi - lo || 1);
      box(g, X, mid - 4, tw, 8, T.well, T.line, 4);
      box(g, X, mid - 4, Math.max(8, tw * frac), 8, T.accent, null, 4);
      g.beginPath(); g.arc(X + tw * frac, mid, 10, 0, Math.PI * 2); g.fillStyle = T.text; g.fill();
      font(); text(g, `${v.toFixed(dp)}${f.unit ?? ''}`, width - pad, mid, T.text, 80, 'right');
      regions.push({ x: X - 6, y: y + IN, w: tw + 12, h: V.minHit, action: f.k, slider: { lo, hi, st } });
    },
  },
  vec3: {
    editH: (_f, S) => S.rowH * 3,                     // one line per axis, labelled x/y/z
    dom(f, D) { const { row, setLabel, edit, el, stepper } = D;
      const box = el('span', 'sp-vec');
      let cur = [...(f.value ?? [0, 0, 0])];
      const parts = cur.map((c, i) => stepper(c, f, (v, o) => {
        if (f.link) { cur = [v, v, v]; edit(f.k, cur, null, o); return; }
        cur = [...cur]; cur[i] = v; edit(f.k, cur, i, o);
      }));
      box.append(...parts);
      row.append(box);
      row.update = (nf) => { setLabel(nf); cur = [...(nf.value ?? cur)]; parts.forEach((p, i) => p.update({ value: cur[i] })); };
    },
    legacy(f, P) { const { pad, vx, width, y, paintStepper } = P;
      const seg = (width - vx - pad) / 3;
      (f.value ?? [0, 0, 0]).forEach((c, i) =>
        paintStepper(f, +c, vx + seg * i, y, f.k, f.link ? null : i, f.dp, seg - 8));
    },
    edit(f, P) { const { g, X, W, y, pad, rowH, labelW, font, text, stepper } = P;
      const AX = ['x', 'y', 'z'];
      (f.value ?? [0, 0, 0]).forEach((c, i) => {
        const yy = y + i * rowH;
        font(); text(g, `${f.label ?? ''} ${AX[i]}`.trim(), pad + labelW, yy + rowH / 2, T[AX[i]], labelW, 'right');
        stepper(f, +c, X, yy, Math.min(W, 240), f.k, f.link ? null : i);
      });
    },
  },
  enum: {
    editH: (f, S) => { S.font(); return S.rowH * S.enumLines(S.g, f, S.vw).length; },   // its pills wrap instead of falling off
    dom(f, D) { const { row, setLabel, edit, el } = D;
      const sel = el('select', 'sp-enum');
      sel.disabled = !!f.disabled;
      for (const o of f.options ?? []) {
        const op = new Option(o.label ?? String(o.v), String(o.v));
        op.selected = o.v === f.value;
        sel.append(op);
      }
      sel.onchange = () => { const o = (f.options ?? []).find((x) => String(x.v) === sel.value); edit(f.k, o ? o.v : sel.value); };
      row.append(sel);
      row.update = (nf) => { setLabel(nf); if (document.activeElement !== sel) sel.value = String(nf.value); };
    },
    legacy(f, P) { const { g, regions, C, font, pad, vx, width, rowH, y } = P;
      let bx = vx;
      for (const o of f.options ?? []) {
        const lab = String(o.label ?? o.v); const bw = Math.max(40, lab.length * 8 + 16);
        const on = o.v === f.value;
        g.fillStyle = on ? C.accent : '#2a3342';
        g.fillRect(bx, y + 7, bw, rowH - 14);
        font(13, on ? 600 : 400); g.fillStyle = on ? '#14100c' : C.text;
        g.fillText(lab, bx + 8, y + rowH * 0.62);
        regions.push({ x: bx, y: y + 7, w: bw, h: rowH - 14, action: f.k, payload: o.v });
        bx += bw + 4;
        if (bx > width - pad - 40) break;
      }
    },
    edit(f, P) { const { g, regions, X, W, y, rowH, font, text, box, enumLines } = P;
      const lines = enumLines(g, f, W);
      lines.forEach((line, li) => {
        for (const { o, x, w } of line) {
          const on = o.v === f.value, yy = y + li * rowH + IN;
          box(g, X + x, yy, w, V.minHit, on ? T.accent : T.well, on ? null : T.line);
          font(V.minText, on ? 600 : 400); text(g, String(o.label ?? o.v), X + x + w / 2, yy + V.minHit / 2, on ? '#ffffff' : T.text, w - 8, 'center');
          regions.push({ x: X + x, y: yy, w, h: V.minHit, action: f.k, payload: o.v });
        }
      });
    },
  },
  color: {
    // R 10-12: a colour field is a picker. The native <input type=color> opened nothing in a headset (the quad's click is
    // synthetic and the dialog would be the desktop's), so the picker is made of what a quad draws and clicks: solid
    // cells. One swatch opens it in place; a cell, a recent or a typed hex commits once.
    dom(f, D) { const { row, setLabel, edit, el } = D;
      const hex = FACTS.hex;
      let cur = f.value ?? 0xffffff, dis = !!f.disabled;
      const sw = el('div', 'sp-color sp-color-sw');
      sw.setAttribute('role', 'button'); sw.tabIndex = 0;
      const pick = el('div', 'sp-picker');
      const recentRow = el('div', 'sp-pick-row sp-pick-recent');
      const grid = el('div', 'sp-pick-grid');
      const hexIn = el('input', 'sp-pick-hex'); hexIn.type = 'text'; hexIn.spellcheck = false; hexIn.maxLength = 7;
      const cell = (c) => { const d = el('div', 'sp-pick-cell'); d.setAttribute('role', 'button'); d.style.background = hex(c); d.title = hex(c); d.dataset.c = c; d.onclick = () => commit(c); return d; };
      grid.append(...PICK_GRID.map(cell));
      const paintRecent = () => { const rc = recentColours(); recentRow.replaceChildren(...rc.map(cell)); recentRow.hidden = !rc.length; mark(); };
      const mark = () => { for (const d of pick.querySelectorAll('.sp-pick-cell')) d.classList.toggle('on', +d.dataset.c === cur); };
      const show = () => { sw.style.background = hex(cur); if (document.activeElement !== hexIn) hexIn.value = hex(cur); mark(); };
      const setOpen = (on) => { if (on && dis) return; openPickers[on ? 'add' : 'delete'](f.k); pick.hidden = !on; sw.classList.toggle('open', on); if (on) paintRecent(); };
      function commit(c) { if (dis || !Number.isInteger(c)) return; cur = c; noteRecent(c); paintRecent(); show(); edit(f.k, c); }
      sw.onclick = () => setOpen(pick.hidden);
      sw.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpen(pick.hidden); } };
      hexIn.onchange = () => { const m = /^#?([0-9a-f]{6}|[0-9a-f]{3})$/i.exec(hexIn.value.trim()); if (!m) { hexIn.value = hex(cur); return; } const h = m[1].length === 3 ? m[1].replace(/./g, '$&$&') : m[1]; commit(parseInt(h, 16)); };
      pick.append(grid, recentRow, hexIn);
      row.append(sw, pick);
      setOpen(openPickers.has(f.k)); show();
      row.update = (nf) => { setLabel(nf); dis = !!nf.disabled; if (dis && !pick.hidden) setOpen(false); cur = nf.value ?? cur; show(); };
    },
    legacy(f, P) { const { g, regions, C, vx, rowH, y } = P;
      const s = rowH - 14;
      g.fillStyle = FACTS.hex(f.value);
      g.fillRect(vx, y + 7, s * 1.6, s);
      g.strokeStyle = C.label; g.lineWidth = 1; g.strokeRect(vx, y + 7, s * 1.6, s);
      // an 8-swatch palette: the keyboard-free way to pick a color
      let bx = vx + s * 1.6 + 8;
      for (const c of PAL) {
        g.fillStyle = FACTS.hex(c);
        g.fillRect(bx, y + 9, s - 4, s - 4);
        regions.push({ x: bx, y: y + 9, w: s - 4, h: s - 4, action: f.k, payload: c });
        bx += s;
      }
    },
    edit(f, P) { const { g, regions, X, W, y, box } = P;
      const sw = 48;
      box(g, X, y + IN, sw, V.minHit, FACTS.hex(f.value), T.line);
      let bx = X + sw + 10;
      const cw = Math.max(20, Math.min(30, Math.floor((W - sw - 10) / PAL.length) - 4));
      for (const c of PAL) {
        box(g, bx, y + IN + (V.minHit - cw) / 2, cw, cw, FACTS.hex(c), c === f.value ? T.accent : T.line);
        regions.push({ x: bx - 2, y: y + IN, w: cw + 4, h: V.minHit, action: f.k, payload: c });   // the target is the row's height, not the chip's
        bx += cw + 4;
      }
    },
  },
  check: {
    dom(f, D) { const { row, setLabel, edit, el } = D;
      const inp = el('input');
      inp.type = 'checkbox';
      inp.checked = !!f.value;
      inp.indeterminate = !!f.mixed;   // mixed: some of the selection are, some aren't (the box shows a dash)
      inp.disabled = !!f.disabled;
      // R 10-10 23:48: in a busy world every frame repaints, and until the authority's answer folded in, each repaint put
      // the box back to the old value: it looked unclicked, so she clicked again and sent it twice. A clicked box keeps what
      // it was clicked to until the record agrees (or 3 s pass: then the record wins, e.g. a refusal).
      // A field that bumps `settle` has had its answer (a refusal too): the record wins from then on, so a refused click
      // can't leave the box lying (review 10-12 S2-1); so does the record once the 3 s are up, repaint or not.
      let pending = null, rec = !!f.value, settle = f.settle;
      inp.onchange = () => { inp.indeterminate = false; pending = { v: inp.checked, until: performance.now() + 3000 }; edit(f.k, inp.checked);
        setTimeout(() => { if (pending && performance.now() >= pending.until) { pending = null; inp.checked = rec; } }, 3050); };
      // a mouse click must not leave focus here: a focused input holds the panel's repaint until blur, and the world's keys
      // (WASD, B, Enter) stop (review 10-12 S2-3). Keyboard focus (Tab) still lands
      inp.onmousedown = (e) => e.preventDefault();
      row.append(inp);
      row.update = (nf) => { setLabel(nf); const v = !!nf.value; rec = v;
        if (nf.settle !== settle) { settle = nf.settle; pending = null; }
        if (pending && v !== pending.v && performance.now() < pending.until) { inp.checked = pending.v; return; }
        pending = null; inp.checked = v; inp.indeterminate = !!nf.mixed; };
    },
    legacy(f, P) { const { g, regions, C, vx, rowH, y } = P;
      const s = rowH - 16;
      g.strokeStyle = C.label; g.lineWidth = 2;
      g.strokeRect(vx, y + 8, s, s);
      if (f.value) {
        g.strokeStyle = C.accent; g.lineWidth = 3;
        g.beginPath();
        g.moveTo(vx + s * 0.2, y + 8 + s * 0.55);
        g.lineTo(vx + s * 0.45, y + 8 + s * 0.8);
        g.lineTo(vx + s * 0.85, y + 8 + s * 0.2);
        g.stroke();
      }
      regions.push({ x: vx, y: y + 8, w: s, h: s, action: f.k, payload: !f.value });
    },
    edit(f, P) { const { g, regions, X, mid, y, box, icon } = P;
      const s = 24, bx = X, by = mid - s / 2;
      if (f.value) { box(g, bx, by, s, s, T.accent, null, 4); icon(g, 'check', bx + s / 2, by + s / 2, 18, '#ffffff', 3); }
      else box(g, bx, by, s, s, T.well, T.dim, 4);
      regions.push({ x: bx - 4, y: y + IN, w: Math.max(V.minHit, s + 8), h: V.minHit, action: f.k, payload: !f.value });
    },
  },
  text: {
    dom(f, D) { const { row, setLabel, edit, el } = D;
      // multiline (a story's text, a sign's words; batch 2): a textarea, committed when it loses focus or on Ctrl+Enter
      const inp = f.multiline ? el('textarea', 'sp-text sp-textarea') : el('input', 'sp-text');
      if (f.multiline) { inp.rows = 4; inp.style.cssText = 'width:100%;min-height:4.5em;resize:vertical;font:inherit;font-size:12px';
        inp.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { inp.blur(); e.stopPropagation(); } else if (e.key !== 'Escape') e.stopPropagation(); });   // keys: jsonCommit
        inp.title = withKeys(f.hint, 'jsonCommit'); }
      else if (f.hint) inp.title = f.hint;
      let base = f.value ?? '';   // what Esc restores — the CURRENT value, refreshed by update() (the closure's f is the value at build time)
      inp.value = base;
      inp.disabled = !!f.disabled;
      if (f.placeholder) inp.placeholder = f.placeholder;
      inp.onchange = () => { edit(f.k, inp.value); inp.blur(); };
      inp.onkeydown = (e) => { if (e.key === 'Escape') { inp.value = base; inp.blur(); e.stopPropagation(); } };
      row.append(inp);
      row.update = (nf) => { setLabel(nf); base = nf.value ?? ''; if (document.activeElement !== inp) inp.value = base; };
    },
    legacy(f, P) { const { g, C, font, vx, rowH, y } = P;
      font(15); g.fillStyle = C.label; g.fillText(String(f.value ?? '—').slice(0, 26), vx, y + rowH * 0.6);
    },
    edit(f, P) { const { g, X, W, mid, y, font, text, field } = P;
      // display-only in a headset (no keyboard): a sunken field showing the value, or the placeholder
      field(X, y + IN, W, V.minHit);
      const v = f.value ? String(f.value) : (f.placeholder ?? '—');
      font(); text(g, v, X + 8, mid, f.value ? T.text : T.dim, W - 16);
    },
  },
  json: {
    dom(f, D) { const { row, setLabel, edit, el } = D;
      // a component as JSON: multi-line, checked as you type (red = won't commit), commits on
      // blur or Ctrl/Cmd+Enter, Esc reverts. `collapsed` tucks it behind a { } toggle — the
      // escape hatch under a typed group, for keys its fields don't speak for.
      const wrap = el('div', 'sp-json');
      const tog = el('button', 'sp-json-tog', '{ } JSON');
      const ta = el('textarea', 'sp-json-ta'); ta.spellcheck = false; ta.disabled = !!f.disabled; ta.title = withKeys(f.hint, 'jsonCommit');
      const err = el('div', 'sp-json-err');
      let base = f.value ?? '', open = !f.collapsed;
      const size = () => { ta.rows = Math.min(14, Math.max(3, ta.value.split('\n').length)); };
      const valid = () => {
        try { if (ta.value.trim()) JSON.parse(ta.value); err.textContent = ''; ta.classList.remove('bad'); return true; }
        catch (e) { err.textContent = String(e.message).replace(/^JSON\.parse: /, ''); ta.classList.add('bad'); return false; }
      };
      const show = () => { ta.hidden = !open; err.hidden = !open; tog.classList.toggle('on', open); };
      ta.value = base; size();
      tog.onclick = () => { open = !open; show(); if (open) ta.focus(); };
      ta.oninput = () => { size(); valid(); };
      ta.onblur = () => { if (ta.value !== base && valid()) edit(f.k, ta.value); };
      ta.onkeydown = (e) => {
        e.stopPropagation();
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); ta.blur(); }   // keys: jsonCommit
        else if (e.key === 'Escape') { ta.value = base; valid(); size(); ta.blur(); }
      };
      if (f.collapsed) wrap.append(tog);
      wrap.append(ta, err); show();
      row.append(wrap);
      row.update = (nf) => { setLabel(nf); base = nf.value ?? ''; ta.disabled = !!nf.disabled; if (document.activeElement !== ta) { ta.value = base; size(); valid(); } };
    },
    legacy(f, P) { const { g, C, font, vx, rowH, y } = P;
      font(13); g.fillStyle = C.label; g.fillText(String(f.value ?? '—').replace(/\s+/g, ' ').slice(0, 34), vx, y + rowH * 0.6); // display-only: no keyboard in a headset
    },
    edit(f, P) { const { g, X, W, mid, font, text } = P;
      font(); text(g, String(f.value ?? '—').replace(/\s+/g, ' '), X, mid, T.dim, W);
    },
  },
  ref: {
    dom(f, D) { const { row, setLabel, edit, el } = D;
      // a reference to another entity: the value is its id (or null). A "pick"
      // button arms the same click-to-name gesture attach uses — the next thing
      // clicked, a tree row or the thing itself in the world, becomes the target.
      const wrap = el('div', 'sp-ref');
      const name = el('button', `sp-btn sp-ref-name${f.arming ? ' arming' : ''}`,
        FACTS.ref(f));
      name.disabled = !!f.disabled;
      name.title = f.value ? `target: ${f.value} — click to re-pick` : 'click, then click the target';
      name.onclick = () => edit(f.k);                       // arm / cancel (editpanels toggles)
      wrap.append(name);
      if (f.value != null && !f.arming) {
        const clr = el('button', 'sp-btn sp-ref-clear', '✕');
        clr.title = 'clear this reference';
        clr.disabled = !!f.disabled;
        clr.onclick = () => edit(f.k, null);
        wrap.append(clr);
      }
      row.append(wrap);
      row.update = (nf) => {
        setLabel(nf);
        name.classList.toggle('arming', !!nf.arming);
        name.textContent = FACTS.ref(nf);
      };
    },
    legacy(f, P) { const { g, regions, C, font, vx, rowH, y } = P;
      // the reference name box arms the laser-pick; the next thing the
      // pointer selects (a row or the thing in the world) names the target.
      const txt = FACTS.ref(f);
      const bw = Math.max(120, txt.length * 8 + 24);
      g.fillStyle = f.arming ? C.accent : C.row;
      g.fillRect(vx, y + 6, bw, rowH - 12);
      font(15); g.fillStyle = f.arming ? '#14100c' : C.text;
      g.fillText(txt, vx + 10, y + rowH * 0.62);
      regions.push({ x: vx, y: y + 6, w: bw, h: rowH - 12, action: f.k });
      if (f.value != null && !f.arming) {                 // a ✕ to clear
        const cx = vx + bw + 8;
        g.fillStyle = C.danger; font(15, 600);
        g.fillText('✕', cx, y + rowH * 0.62);
        regions.push({ x: cx - 4, y: y + 6, w: 24, h: rowH - 12, action: f.k, payload: null });
      }
    },
    edit(f, P) { const { g, regions, X, W, mid, y, font, text, box, quietButton } = P;
      const txt = FACTS.ref(f);
      const bw = Math.min(W - V.minHit - 8, Math.max(140, (font(), g.measureText(txt).width + 24)));
      box(g, X, y + IN, bw, V.minHit, f.arming ? T.accentBg : T.well, f.arming ? T.accent : T.line);
      font(); text(g, txt, X + 10, mid, T.text, bw - 20);
      regions.push({ x: X, y: y + IN, w: bw, h: V.minHit, action: f.k });
      if (f.value != null && !f.arming) {
        const cx = X + bw + 6;
        quietButton(cx, y + IN, V.minHit, V.minHit, '', true, 'x');
        regions.push({ x: cx, y: y + IN, w: V.minHit, h: V.minHit, action: f.k, payload: null });
      }
    },
  },
  btn: {
    dom(f, D) { const { row, edit, el } = D;
      const b = el('button', `sp-btn${f.danger ? ' danger' : ''}${f.icon ? ' sp-btn-ico' : ''}`);
      const txt = el('span', '', f.label); txt.hidden = !f.label;   // an icon-only button: no empty span to push the glyph off centre
      let ico = f.icon ?? null; if (ico) b.innerHTML = iconSvg(ico, 14);
      b.append(txt);
      b.disabled = !!f.disabled; b.classList.toggle('on', !!f.on); if (!f.label && f.hint) b.title = f.hint;
      b.onclick = () => edit(f.k);
      row.append(b);
      // an icon toggle (the eye, the padlock) must redraw its picture, not only its words
      row.update = (nf) => { txt.textContent = nf.label; txt.hidden = !nf.label; b.classList.toggle('on', !!nf.on); if (!nf.label && nf.hint) b.title = nf.hint;
        if ((nf.icon ?? null) !== ico) { ico = nf.icon ?? null; b.querySelector('svg')?.remove(); if (ico) b.insertAdjacentHTML('afterbegin', iconSvg(ico, 14)); } };
    },
    legacy(f, P) { const { g, regions, C, font, pad, rowH, y } = P;
      const bw = Math.max(90, f.label.length * 9 + 24);
      g.fillStyle = f.danger ? C.danger : C.accent;
      g.fillRect(pad, y + 6, bw, rowH - 12);
      font(15, 600); g.fillStyle = f.danger ? C.text : '#14100c';
      g.fillText(f.label, pad + 12, y + rowH * 0.62);
      regions.push({ x: pad, y: y + 6, w: bw, h: rowH - 12, action: f.k });
    },
    edit(f, P) { const { g, regions, mid, y, pad, width, font, text, box, icon, quietButton } = P;
      font(V.minText, 500);
      const iw = f.icon ? 26 : 0;
      const bw = Math.min(width - pad * 2, Math.max(110, g.measureText(f.label).width + 32 + iw));
      if (f.danger) quietButton(pad, y + IN, bw, V.minHit, f.label, true);
      else {
        box(g, pad, y + IN, bw, V.minHit, T.press, null); font(V.minText, 500);
        const tw = Math.min(g.measureText(f.label).width, bw - 12 - iw);
        if (f.icon) icon(g, f.icon, pad + bw / 2 - (tw + iw) / 2 + 9, mid, 18, f.disabled ? T.faint : T.dim);
        text(g, f.label, pad + bw / 2 + iw / 2, mid, f.disabled ? T.dim : T.text, bw - 12 - iw, 'center');
      }
      regions.push({ x: pad, y: y + IN, w: bw, h: V.minHit, action: f.k });
    },
  },
  pop: {
    dom(f, D) { const { row, edit, el, openPop } = D;
      // one button that opens a searchable list (Add Component, R 10-04): {label, items:[{k, label, category, hint,
      // disabled}], recentKey}. Typing filters on name and hint, Enter takes the first, Esc or a click outside closes.
      const b = el('button', `sp-btn sp-pop-btn${f.icon ? ' sp-btn-ico' : ''}`, f.label);
      if (f.icon) b.insertAdjacentHTML('afterbegin', iconSvg(f.icon, 14));
      b.title = f.hint ?? '';
      b.onclick = (e) => { e.stopPropagation(); openPop(b, f, (k) => edit(k)); };
      row.append(b);
      row.update = (nf) => { b.lastChild.textContent = nf.label; f = nf; };
    },
  },
  tiles: {
    editH: (f, S) => S.rowH * Math.max(1, Math.ceil((f.options ?? []).length / TILE_COLS)),
    dom(f, D) { const { row, edit, el } = D;
      const box = el('div', `sp-tiles${(f.options ?? []).some((o) => o.img) ? ' sp-tiles-img' : ''}`);
      if (!f.options?.length) box.append(el('div', 'sp-empty', f.empty ?? 'nothing here'));
      for (const o of f.options ?? []) {
        const b = el('button', `sp-tile${o.v === f.value ? ' on' : ''}`);
        b.dataset.v = String(o.v);
        b.title = o.hint ? `${o.label} — ${o.hint}` : o.label;
        b.disabled = !!f.disabled;
        if (o.img) {
          const pic = el('span', 'sp-tile-pic');
          const img = el('img'); img.alt = ''; img.loading = 'lazy'; img.src = o.img;
          img.onerror = () => { img.style.visibility = 'hidden'; };
          pic.append(img); b.append(pic);
        } else if (o.icon) b.insertAdjacentHTML('beforeend', iconSvg(o.icon, 18));
        b.append(el('span', 'sp-tile-label', o.label));
        b.onclick = () => edit(f.k, o.v);
        box.append(b);
      }
      row.append(box);
      // a hint is not shape (a saved blueprint's "2 copies placed" changes under it): kept current in place
      row.update = (nf) => {
        const byV = new Map((nf.options ?? []).map((o) => [String(o.v), o]));
        for (const b of box.querySelectorAll('.sp-tile')) {
          b.classList.toggle('on', b.dataset.v === String(nf.value));
          const o = byV.get(b.dataset.v);
          if (o) b.title = o.hint ? `${o.label} — ${o.hint}` : o.label;
        }
      };
    },
    legacy(f, P) { const { g, regions, C, font, pad, width, rowH, y } = P;
      // legacy quads: the tiles as one line of pills (edit chrome paints a grid)
      let bx = pad;
      for (const o of f.options ?? []) {
        const lab = String(o.label ?? o.v); const bw = Math.max(40, lab.length * 8 + 16);
        if (bx + bw > width - pad) break;
        const on = o.v === f.value;
        g.fillStyle = on ? C.accent : '#2a3342';
        g.fillRect(bx, y + 7, bw, rowH - 14);
        font(13, on ? 600 : 400); g.fillStyle = on ? '#14100c' : C.text;
        g.fillText(lab, bx + 8, y + rowH * 0.62);
        regions.push({ x: bx, y: y + 7, w: bw, h: rowH - 14, action: f.k, payload: o.v });
        bx += bw + 4;
      }
    },
    edit(f, P) { const { g, regions, mid, y, pad, width, rowH, font, text, box, icon } = P;
      // the grid the desktop draws, three across; armed = press fill + an accent glyph (the tool rail's look)
      const opts = f.options ?? [];
      if (!opts.length) { font(); text(g, f.empty ?? 'nothing here', pad, mid, T.dim, width - pad * 2); return; }
      const gap = 6, tw = Math.floor((width - pad * 2 - gap * (TILE_COLS - 1)) / TILE_COLS);
      opts.forEach((o, i) => {
        const tx = pad + (i % TILE_COLS) * (tw + gap), ty = y + Math.floor(i / TILE_COLS) * rowH + IN;
        const on = o.v === f.value;
        box(g, tx, ty, tw, V.minHit, on ? T.press : T.well, on ? null : T.line);
        const iw = o.icon ? 26 : 0;
        font(V.minText, on ? 600 : 400);
        const lw = Math.min(g.measureText(String(o.label ?? o.v)).width, tw - 16 - iw);
        const x0 = tx + tw / 2 - (lw + iw) / 2;
        if (o.icon) icon(g, o.icon, x0 + 9, ty + V.minHit / 2, 18, on ? T.accent : T.dim);
        text(g, String(o.label ?? o.v), x0 + iw, ty + V.minHit / 2, T.text, tw - 16 - iw);
        regions.push({ x: tx, y: ty, w: tw, h: V.minHit, action: f.k, payload: o.v });
      });
    },
  },
  group: {
    dom(f, D) { const { row, edit, ro, el, put } = D;
      row.classList.add(f.open === false ? 'closed' : 'open');
      // the card's title: the fold arrow, then its provenance pill at the FRONT (R 10-11: "move the draft/server-only
      // component pill to the front of the label row… to make it look more important"), then the name
      const DOT = { draft: ['draft', 'a draft component: not part of the engine yet (it can still change); unproven: this client reads it, the engine doesn\'t'], trusted: ['trusted here', 'not engine-official, but used and trusted in this world (the owner\'s word); the engine still doesn\'t read it'], foreign: ['unknown', 'a component this client has no reader for: kept and replayed, not drawn'] };
      const head = (hh, ff) => { hh.textContent = ''; hh.append(document.createTextNode(`${ff.open === false ? '▸' : '▾'} `));
        if (ff.dot && DOT[ff.dot]) { const d = el('span', `sp-pill sp-pill-${ff.dot}`, DOT[ff.dot][0]); d.title = DOT[ff.dot][1]; hh.append(d); }
        hh.append(put(el('span', 'sp-group-name'), ff.label, ro.icons));
        if (ff.sub) { const d = el('span', 'sp-group-sub', ` · ${ff.sub}`); if (ff.subHint) d.title = ff.subHint; hh.append(d); }   // dim, after the name (the Transform card's 'N m away')
        return hh; };
      const h = head(el('button', 'sp-group'), f);
      h.onclick = () => edit('fold', f.k);
      row.innerHTML = ''; row.append(h);
      // a card's own actions on its title line, shown on hover (R 10-10: 'delete components right from the title line,
      // like an x that shows up on the line when you hover over it'); the VR quad keeps its remove row instead
      if (f.actions?.length) {
        const acts = el('span', 'sp-gacts');
        for (const a of f.actions) { const b = el('button', `sp-gact${a.danger ? ' danger' : ''}`); b.type = 'button'; b.title = a.title ?? a.label ?? ''; b.setAttribute('aria-label', b.title);
          if (a.icon && hasIcon(a.icon)) b.innerHTML = iconSvg(a.icon, 13); else b.textContent = a.label ?? '';
          b.onclick = (e) => { e.stopPropagation(); edit(a.k); }; acts.append(b); }
        row.append(acts); row.classList.add('has-acts');
      }
      row.update = (nf) => { head(h, nf); };
    },
    legacy(f, P) { const { g, regions, C, font, pad, width, rowH, y } = P;
      g.fillStyle = C.line; g.fillRect(pad, y + rowH - 6, width - pad * 2, 1);
      font(14, 600); g.fillStyle = C.accent;
      g.fillText(`${f.open === false ? '▸' : '▾'} ${f.label}${f.sub ? ` · ${f.sub}` : ''}`, pad, y + rowH * 0.62);
      regions.push({ x: pad, y, w: width - pad * 2, h: rowH, action: 'fold', payload: f.k });
    },
    edit(f, P) { const { g, regions, font, text, fill, icon, pad, width, rowH, y } = P;
      fill(g, T.bg2, 0, y + 2, width, rowH - 2);
      fill(g, T.line, 0, y, width, V.minLine);
      icon(g, f.open === false ? 'chevronRight' : 'chevronDown', pad + 9, y + rowH / 2 + 1, 18, T.dim);
      font(V.minText, 600); text(g, f.sub ? `${f.label} · ${f.sub}` : f.label, pad + 24, y + rowH / 2 + 1, T.text, width - pad * 2 - 24);
      regions.push({ x: pad, y, w: width - pad * 2, h: rowH, action: 'fold', payload: f.k });
    },
  },
  list: {
    dom(f, D) { const { row, edit, el } = D;
      const box = el('div', 'sp-list');
      if (!f.rows?.length) box.append(el('div', 'sp-empty', f.empty ?? 'nothing here'));
      for (const r of f.rows ?? []) {
        const line = el('div', `sp-item${r.active ? ' active' : ''}${r.indent ? ' sp-item-sub-row' : ''}`);
        if (r.id != null) line.dataset.id = String(r.id);   // a row is findable by what it IS, not by its label
        const main = el('span', 'sp-item-main');
        if (r.icon) {   // the World row: its glyph, its kind and its name on ONE line
          const head = el('span', 'sp-item-head'), i = el('span', 'sp-ico'); i.innerHTML = (hasIcon(r.icon) ? iconSvg : hasLine(r.icon) || !hasFill(r.icon) ? rsvg : fsvg)(r.icon, 14);   // any of the three sets
          const lab = el('span', 'sp-item-label'); if (r.kind) lab.append(el('span', 'sp-item-kind', r.kind)); lab.append(r.label);
          head.append(i, lab); main.append(head);
        } else main.append(el('span', 'sp-item-label', r.label));
        if (r.sub) main.append(el('span', 'sp-item-sub', r.sub));
        if (r.title) main.title = r.title;
        main.onclick = () => edit(f.k ?? 'row', r.id);   // a keyed list routes its rows; unkeyed lists keep 'row'
        line.append(main);
        for (const a of r.actions ?? []) {
          const b = el('button', `sp-mini${a.danger ? ' danger' : ''}${a.hover ? ' sp-hov' : ''}`, a.label); if (a.title) b.title = a.title;
          b.onclick = (e) => { e.stopPropagation(); edit(a.k, r.id); };
          line.append(b);
        }
        box.append(line);
      }
      row.append(box);
    },
    row: ROW,
  },
  tree: {
    dom(f, D) { const { row, edit, ro, el, put, contextMenu, menuButton } = D;
      const box = el('div', 'sp-tree');
      if (!f.rows?.length) box.append(el('div', 'sp-empty', f.empty ?? 'nothing here'));
      // drag a row onto another to reparent it (edit('drop', {id, onto})); onto
      // the tree's empty space to make it a root ({onto: null}). The dragged
      // id rides a module variable, not dataTransfer — synthetic DragEvents
      // in a headless bench carry no data, and nothing else needs it.
      const dropOn = (onto) => (e) => { e.preventDefault(); e.stopPropagation(); box.querySelectorAll('.drop').forEach((x) => x.classList.remove('drop')); if (treeDrag && treeDrag !== onto) edit('drop', { id: treeDrag, onto }); treeDrag = null; };
      box.ondragover = (e) => { if (treeDrag) { e.preventDefault(); e.dataTransfer && (e.dataTransfer.dropEffect = 'move'); } };
      box.ondrop = dropOn(null);
      const boxes = new Map();   // id → its row's ENABLED box: a same-shape repaint sets them from the record
      let settle = f.settle;
      for (const r of f.rows ?? []) {
        const line = el('div', `sp-item sp-tree-row${r.active ? ' active' : ''}${r.multi ? ' multi' : ''}`);
        if (r.id != null) line.dataset.id = String(r.id);   // every row is findable by what it is (component rows too)
        if (!r.noDrag) {
          line.draggable = true;
          line.ondragstart = (e) => { treeDrag = r.id; line.classList.add('dragging'); box.classList.add('dragging'); e.dataTransfer?.setData('text/plain', String(r.id)); };
          line.ondragend = () => { treeDrag = null; line.classList.remove('dragging'); box.classList.remove('dragging'); box.querySelectorAll('.drop').forEach((x) => x.classList.remove('drop')); };
          line.ondragover = (e) => { if (treeDrag && treeDrag !== r.id) { e.preventDefault(); e.stopPropagation(); line.classList.add('drop'); } };
          line.ondragleave = () => line.classList.remove('drop');
          line.ondrop = dropOn(r.id);
        }
        line.style.paddingLeft = `${4 + (r.depth ?? 0) * 14}px`;
        line.style.setProperty('--d', String(r.depth ?? 0));   // edit chrome draws one indent guide per level
        if (r.dim) line.classList.add('dim');
        // disclosure: a row with children folds them (edit('open', id))
        const disc = el('button', `sp-disc${r.kids ? '' : ' none'}`, r.kids ? (r.open === false ? '▸' : '▾') : '');
        disc.tabIndex = -1;
        // Shift- or Alt-click: this one and everything under it (Maya's and Blender's Shift, Unity's Alt)
        if (r.kids) disc.onclick = (e) => { e.stopPropagation(); edit('open', e.shiftKey || e.altKey ? { id: r.id, deep: true } : r.id); };   // keys: treeFold
        if (r.kids) disc.title = KEYHINTS.treeFold.before;
        line.append(disc);
        // the row's columns, always in this order (R 10-12): [☑ enabled][name …][👁 only you][🔒]. A row without a box keeps
        // its place, so every name starts at the same x for its depth
        if (r.enabled != null) {
          const on = el('input', 'sp-row-on'); on.type = 'checkbox'; on.checked = !!r.enabled; on.tabIndex = -1;
          on.disabled = r.offable === false;
          on.title = r.enabled ? 'enabled: untick to switch it off for everyone (it stays here as a link)' : 'switched off for everyone: tick to switch it back on';
          on.onclick = (e) => e.stopPropagation(); on.onpointerdown = (e) => e.stopPropagation();
          on.onmousedown = (e) => { e.preventDefault(); e.stopPropagation(); };   // no focus from a click (the check widget's reason)
          on._rec = !!r.enabled; boxes.set(String(r.id), on);
          on.onchange = () => { on._pend = { v: on.checked, until: performance.now() + 3000, settle }; edit('enable', { id: r.id, on: on.checked });
            setTimeout(() => { if (on._pend && performance.now() >= on._pend.until) { on._pend = null; on.checked = on._rec; } }, 3050); };
          line.append(on);
        } else line.append(el('span', 'sp-row-on gap'));
        if (r.off) line.classList.add('off');
        const main = el('span', 'sp-item-main');
        main.append(put(el('span', 'sp-item-label'), r.label, ro.icons));
        if (r.sub || r.badges?.length) main.append(put(el('span', 'sp-item-sub'), [r.sub, ...(r.badges ?? [])].filter(Boolean).join(' · '), ro.icons));
        // Ctrl/Cmd toggles one; Shift selects the run from the last row clicked (Ctrl+Shift adds the run); `extend` is either
        main.onclick = (e) => edit(f.k, r.id, f, { extend: e.shiftKey || e.ctrlKey || e.metaKey, toggle: e.ctrlKey || e.metaKey, range: e.shiftKey });   // keys: treeSelect
        main.title = withKeys(r.title ?? (r.sub ? `${r.label} — ${r.sub}` : r.label), 'treeSelect');   // r.title: what the row left out (its id, its kind)
        // inline rename (Godot F2 / Blender double-click): a row that carries `rename` (its
        // current label) swaps the label for an input; Enter or blur commits
        // edit('rename', id, f, {value}), Esc cancels. The panel holds repaints while it's focused.
        let beginRename = null;
        if (r.rename != null) {
          const lab = main.querySelector('.sp-item-label');
          beginRename = () => {
            const inp = el('input', 'sp-rename'); inp.value = r.rename; inp.placeholder = String(r.id);
            lab.replaceWith(inp); line.draggable = false; inp.focus(); inp.select();
            let done = false;
            const end = (commit) => {
              if (done) return; done = true;
              const v = inp.value.trim();
              inp.replaceWith(lab); line.draggable = !r.noDrag;
              if (commit && v !== r.rename) edit('rename', r.id, f, { value: v });
            };
            inp.onkeydown = (e) => { e.stopPropagation(); if (e.key === 'Enter') { e.preventDefault(); end(true); } else if (e.key === 'Escape') { e.preventDefault(); end(false); } };
            inp.onblur = () => end(true);
            inp.onclick = (e) => e.stopPropagation();
          };
          main.ondblclick = (e) => { e.stopPropagation(); beginRename(); };
          line.dataset.id = String(r.id);
          line._rename = beginRename;
        }
        const items = r.menu ?? f.menu;
        if (items?.length) line.oncontextmenu = (e) => { e.preventDefault(); contextMenu(e.clientX, e.clientY, items, (k) => (k === 'rename' && beginRename ? beginRename() : edit(k, r.id))); };
        line.append(main);
        if (r.mine != null) {   // 👁: hidden in MY view only (myview.js), never the shared component; its tint says "only you"
          const eye = el('button', `sp-mini sp-eye${r.mine ? ' on' : ''}`);
          eye.innerHTML = iconSvg(r.mine ? 'eyeOff' : 'eye', 14);
          eye.title = r.mine ? 'Only you: hidden in your view (not drawn, not clickable, still solid). Click to show it again.' : 'Only you: click to hide it in your view. Nobody else is affected.';
          eye.onclick = (e) => { e.stopPropagation(); edit('myhide', r.id); };
          line.append(eye);
        }
        if (r.locked != null) {
          // held: not locked itself, but it rides a locked thing, which holds it just the same (the authority's rule)
          const held = !r.locked && !!r.heldBy;
          const lock = el('button', `sp-mini sp-lock${r.locked ? ' on' : ''}${held ? ' inherited' : ''}`);
          lock.innerHTML = iconSvg(r.locked || held ? 'lock' : 'lockOpen', 14);   // a glyph, not an emoji (the canvas trap; one icon set)
          const lv = r.lockLevel && r.lockLevel !== 'builders and up' ? ` (${r.lockLevel})` : '';   // recut B2: the setter's rank in words
          lock.title = r.locked ? `locked${lv} — click to unlock` : held ? `held by ${r.heldByLabel ?? r.heldBy}'s lock — it moves only with it; unlock that to move this on its own` : 'click to lock in place';
          if (held) lock.dataset.heldBy = r.heldBy;
          // lockable: false = this viewer may not lift locks (a member, §5; or a level above their rank): the icon still says, the click doesn't
          if (r.lockable === false) { lock.disabled = true; lock.title = r.locked ? `locked (${r.lockLevel ?? 'builders and up'} can unlock it)` : held ? lock.title : 'not locked (builders and owners can lock it)'; }
          lock.onclick = (e) => { e.stopPropagation(); if (lock.disabled) return; if (held) edit('find', r.heldBy); else edit('lock', r.id); };
          line.append(lock);
        }
        if (items?.length) line.append(menuButton(line));   // the headset's ⋯ (hidden on desktop) closes the row, after its columns
        box.append(line);
      }
      // the root zone: a full tree has no empty space to drop on, so while a
      // row is in flight a strip at its foot says "no parent" and takes the drop
      if (f.rootDrop && f.rows?.length) {
        const zone = el('div', 'sp-tree-root', f.rootDrop);
        zone.ondragover = (e) => { if (treeDrag) { e.preventDefault(); e.stopPropagation(); zone.classList.add('drop'); } };
        zone.ondragleave = () => zone.classList.remove('drop');
        zone.ondrop = dropOn(null);
        box.append(zone);
      }
      row.append(box);
      // a changed tree is rebuilt (rows are shape), and a new box starts scrolled to the top: in a world where things
      // move, that was every few frames, and the lower rows could not be reached (R 10-10: "entities ... I can't get
      // to in the hierarchy"). The box keeps where it was scrolled to, by the field's key.
      const tkey = f.k ?? 'tree';
      box.addEventListener('scroll', () => treeScroll.set(tkey, box.scrollTop), { passive: true });
      const back = () => { const y = treeScroll.get(tkey); if (y && box.isConnected) box.scrollTop = y; };
      queueMicrotask(back); requestAnimationFrame(back);
      // rows are shape: a changed tree repaints. A same-shape repaint (a refused switch leaves the rows as they were) still
      // owes the boxes the record, past a click still waiting on its answer (review 10-12 S2-1)
      row.update = (nf) => { settle = nf.settle; for (const r of nf.rows ?? []) { const b = boxes.get(String(r.id)); if (!b || r.enabled == null) continue; b._rec = !!r.enabled;
        if (b._pend && b._pend.settle === nf.settle && performance.now() < b._pend.until) { b.checked = b._pend.v; continue; }
        b._pend = null; b.checked = !!r.enabled; } };
    },
    row: ROW,
  },
};

// ---------------------------------------------------------------- the one canvas walk
/** What rows a canvas paints: group markers fold what follows; deskOnly fields are the desktop's; a list or tree
 *  becomes its rows. Each item is {f, h} or {row, parent, h}. The two looks differ in two places, kept as they were:
 *  the legacy quad gives a list/tree field a row of its own whether or not it has a label (its label paints there, or
 *  nothing); the edit quad gives it a header row only when labelled, and an `empty` line when it has no rows. */
function layout(fields, S) {
  const items = [];
  let folded = false;
  for (const f of fields) {
    if (f.t === 'group') { folded = f.open === false; items.push({ f, h: S.rowH }); continue; }
    if (folded || f.deskOnly) continue;   // deskOnly: a desktop pop-out the quad has its own rows for
    if (f.t === 'list' || f.t === 'tree') {
      if (!S.edit || f.label) items.push({ f, h: S.rowH });
      if (S.edit && !(f.rows ?? []).length && f.empty) items.push({ f: { t: 'info', label: '', value: f.empty }, h: S.rowH });
      for (const r of f.rows ?? []) items.push({ row: r, parent: f, h: S.rowH });
      continue;
    }
    items.push({ f, h: (S.edit && WIDGETS[f.t]?.editH?.(f, S)) || S.rowH });
  }
  return items;
}

/** Paint `fields` on a canvas surface S and return its hit regions. S is {kind: 'legacy' | 'edit', edit, g, regions,
 *  rowH, pad, width, begin(items) → y, prep(f, y, h) → P}: begin sizes the canvas and paints its ground and title,
 *  prep paints a field's label and hands back the per-field surface (its y, value column, width) the widget draws in. */
export function paintFields(fields, S) {
  const items = layout(fields, S);
  let y = S.begin(items);
  for (const it of items) {
    if (it.row) { WIDGETS[it.parent.t]?.row?.[S.kind]?.(it.row, it.parent, S.prep(null, y, it.h)); y += it.h; continue; }
    const f = it.f, W = WIDGETS[f.t];
    if (f.t === 'group') { W[S.kind](f, S.prep(null, y, it.h)); y += it.h; continue; }
    const mark = S.regions.length;               // a disabled field paints but takes no hits
    const P = S.prep(f, y, it.h);                // the label paints even where no widget follows (a list's header)
    W?.[S.kind]?.(f, P);
    if (f.disabled) S.regions.length = mark;
    y += it.h;
  }
  return S.regions;
}
