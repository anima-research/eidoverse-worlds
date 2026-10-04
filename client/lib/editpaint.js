// editpaint — the VR painter for edit mode's frames (Hierarchy, Inspector, Console): the same field specs
// panels.js renderCanvas paints, in edit mode's look (edittheme.js), under the VR floor the spec sets:
//
//   - every hit target >= EDIT_VR.minHit canvas px tall (≈ 3.8 cm at 900 px/m);
//   - no line thinner than EDIT_VR.minLine (a 1-px line shimmers on a resampled quad);
//   - every glyph of text >= EDIT_VR.minText px, and no pictograph handed to fillText (the canvas
//     emoji trap: a glyph the viewer's fonts lack paints NOTHING) — they are icons.js paths;
//   - nothing hover-only: a headset has no hover, so what desktop shows on hover is always drawn;
//   - checkbox, select, button, field: the SAME shapes the CSS draws.
//
// The contract with the rest of the VR seam is panels.js's: returns hit REGIONS in canvas px, each
// {x, y, w, h, action, payload?, slider?}, dispatching exactly what the legacy painter dispatches
// (tools/edittheme-test.ts holds the two to the same action set). Non-edit quads never come here.

import { EDIT as T, EDIT_VR as V, pictoRuns } from './edittheme.js';
import { stroke as strokeIcon, has as hasIcon } from './icons.js';

const R2D = 180 / Math.PI;
const FONT = 'system-ui, sans-serif';
const IN = (V.rowH - V.minHit) / 2;            // a target's inset inside its row → exactly minHit tall
const PAL = [0xffffff, 0xffd9a0, 0xff8a5c, 0xe05a5a, 0x7cc47c, 0x5fa8ff, 0xb48cff, 0x202020];   // the keyboard-free colour picks (same as legacy)
const ACTION_ICON = { '✕': 'x' };             // row-action labels that are glyphs → the icon set
const TILE_COLS = 3;                           // a tiles field: three across (≈ 160 px each on a 522 quad)
const AXIS_RE = /(?:^|:)(?:pos|rot|scale)\.([xyz])$/;   // a channel's axis — the label wears x/y/z (the desktop's data-axis)

export function paintEdit(canvas, fields, { width = 522, title = '' } = {}) {
  const g = canvas.getContext('2d');
  const rowH = V.rowH, pad = V.pad;
  const labelW = Math.round(Math.min(V.labelMax, Math.max(V.labelMin, width * V.labelFrac)));
  const vx = pad + labelW + V.gutter;          // values start here
  const vw = width - pad - vx;                 // …and have this much room
  const font = (px = V.minText, w = 400) => { g.font = `${w} ${Math.max(V.minText, px)}px ${FONT}`; };

  // ---- layout: what rows exist, and how tall each one is (an enum's pills wrap instead of falling off)
  const items = [];
  let folded = false;
  for (const f of fields) {
    if (f.t === 'group') { folded = f.open === false; items.push({ f, h: rowH }); continue; }
    if (folded || f.deskOnly) continue;   // deskOnly: a desktop pop-out the quad has its own rows for
    if (f.t === 'vec3') { items.push({ f, h: rowH * 3 }); continue; }                     // one line per axis, labelled x/y/z
    if (f.t === 'enum') { font(); items.push({ f, h: rowH * enumLines(g, f, vw).length }); continue; }
    if (f.t === 'tiles') { items.push({ f, h: rowH * Math.max(1, Math.ceil((f.options ?? []).length / TILE_COLS)) }); continue; }
    if (f.t === 'list' || f.t === 'tree') {
      if (f.label) items.push({ f, h: rowH });   // a bare list/tree has no header row of its own
      if (!(f.rows ?? []).length && f.empty) items.push({ f: { t: 'info', label: '', value: f.empty }, h: rowH });
      for (const r of f.rows ?? []) items.push({ row: r, parent: f, h: rowH });
      continue;
    }
    items.push({ f, h: rowH });
  }
  const HEAD = title ? 40 : 0;
  canvas.width = width; canvas.height = HEAD + items.reduce((a, it) => a + it.h, 0) + pad * 2;
  const regions = [];
  fill(g, T.bg1, 0, 0, width, canvas.height);

  if (title) {
    fill(g, T.bg0, 0, 0, width, HEAD);
    fill(g, T.line, 0, HEAD - V.minLine, width, V.minLine);
    font(V.minText, 600); text(g, title.charAt(0).toUpperCase() + title.slice(1), pad, HEAD / 2, T.text);
  }
  let y = HEAD + pad;
  for (const it of items) {
    if (it.row) { paintRow(it.row, it.parent, y); y += it.h; continue; }
    paintField(it.f, y, it.h);
    y += it.h;
  }
  return regions;

  // ------------------------------------------------------------------ a list / tree row
  function paintRow(r, parent, y) {
    const tree = parent.t === 'tree';
    const ind = tree ? (r.depth ?? 0) * 18 : 0;
    if (r.active) { fill(g, T.accentBg, 0, y, width, rowH); fill(g, T.accent, 0, y, 3, rowH); }
    else if (r.multi) fill(g, T.accentBg, 0, y, width, rowH);
    if (tree) for (let d = 1; d <= (r.depth ?? 0); d++) fill(g, T.line, pad + d * 18 - 9, y, V.minLine, rowH);   // indent guides
    const x0 = pad + ind + (tree ? 22 : 8);
    font(V.minText, r.active ? 600 : 400);
    const lockW = tree && r.locked != null ? V.minHit + 8 : 0;
    let right = width - pad - lockW;
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
    const lw = text(g, r.label, x0, y + rowH / 2, r.dim ? T.dim : T.text, right - x0 - 8);
    if (tree && (r.sub || r.badges?.length)) {
      font(V.minText); text(g, [r.sub, ...(r.badges ?? [])].filter(Boolean).join(' · '), x0 + lw + 10, y + rowH / 2, T.dim, right - (x0 + lw + 10) - 8);
    }
    regions.push({ x: pad, y, w: width * 0.6, h: rowH, action: parent.k ?? 'row', payload: r.id });
    if (tree && r.kids) {   // the disclosure: its own target ahead of the row's (legacy order)
      icon(g, r.open === false ? 'chevronRight' : 'chevronDown', pad + ind + 9, y + rowH / 2, 18, T.dim);
      regions.unshift({ x: pad + ind - 8, y, w: Math.max(28, 16), h: rowH, action: 'open', payload: r.id });
    }
    if (tree && r.locked != null) {   // always drawn in VR (no hover); ON = accent
      const bx = width - pad - V.minHit, by = y + IN;
      if (r.locked) box(g, bx, by, V.minHit, V.minHit, T.press, null);
      icon(g, r.locked ? 'lock' : 'lockOpen', bx + V.minHit / 2, by + V.minHit / 2, 20, r.locked ? T.accent : T.dim);
      regions.push({ x: bx, y: by, w: V.minHit, h: V.minHit, action: 'lock', payload: r.id });
    }
  }

  // ------------------------------------------------------------------ one field
  function paintField(f, y, h) {
    if (f.t === 'group') {
      fill(g, T.bg2, 0, y + 2, width, rowH - 2);
      fill(g, T.line, 0, y, width, V.minLine);
      icon(g, f.open === false ? 'chevronRight' : 'chevronDown', pad + 9, y + rowH / 2 + 1, 18, T.dim);
      font(V.minText, 600); text(g, f.label, pad + 24, y + rowH / 2 + 1, T.text, width - pad * 2 - 24);
      regions.push({ x: pad, y, w: width - pad * 2, h: rowH, action: 'fold', payload: f.k });
      return;
    }
    const mark = regions.length;               // a disabled field paints but takes no hits
    const mid = y + rowH / 2;
    // the label is the AXIS's (x/y/z) or dim; driven is the FIELD's job (amber edge + ~), never the label's
    const lab = T[AXIS_RE.exec(f.k ?? '')?.[1]] ?? T.dim;
    const hasLabel = f.label != null && f.label !== '' && f.t !== 'btn' && f.t !== 'log';
    if (hasLabel && f.t !== 'vec3') { font(); text(g, f.label, pad + labelW, mid, lab, labelW, 'right'); }
    const X = hasLabel || ['num', 'check', 'enum', 'color', 'range', 'ref', 'vec3'].includes(f.t) ? vx : pad;
    const W = width - pad - X;
    switch (f.t) {
      case 'info': font(); text(g, String(f.value ?? ''), X, mid, T.text, W); break;
      case 'log': font(); text(g, String((f.lines ?? []).at(-1) ?? f.empty ?? ''), pad, mid, T.dim, width - pad * 2); break;   // newest line: a quad has no scrollback
      case 'text': {   // display-only in a headset (no keyboard): a sunken field showing the value, or the placeholder
        field(X, y + IN, W, V.minHit);
        const v = f.value ? String(f.value) : (f.placeholder ?? '—');
        font(); text(g, v, X + 8, mid, f.value ? T.text : T.dim, W - 16);
        break;
      }
      case 'json': font(); text(g, String(f.value ?? '—').replace(/\s+/g, ' '), X, mid, T.dim, W); break;
      case 'num': stepper(f, +(f.value ?? 0), X, y, Math.min(W, 240), f.k, null); break;
      case 'vec3': {
        const AX = ['x', 'y', 'z'];
        (f.value ?? [0, 0, 0]).forEach((c, i) => {
          const yy = y + i * rowH;
          font(); text(g, `${f.label ?? ''} ${AX[i]}`.trim(), pad + labelW, yy + rowH / 2, T[AX[i]], labelW, 'right');
          stepper(f, +c, X, yy, Math.min(W, 240), f.k, f.link ? null : i);
        });
        break;
      }
      case 'enum': {
        const lines = enumLines(g, f, W);
        lines.forEach((line, li) => {
          for (const { o, x, w } of line) {
            const on = o.v === f.value, yy = y + li * rowH + IN;
            box(g, X + x, yy, w, V.minHit, on ? T.accent : T.well, on ? null : T.line);
            font(V.minText, on ? 600 : 400); text(g, String(o.label ?? o.v), X + x + w / 2, yy + V.minHit / 2, on ? '#ffffff' : T.text, w - 8, 'center');
            regions.push({ x: X + x, y: yy, w, h: V.minHit, action: f.k, payload: o.v });
          }
        });
        break;
      }
      case 'check': {
        const s = 24, bx = X, by = mid - s / 2;
        if (f.value) { box(g, bx, by, s, s, T.accent, null, 4); icon(g, 'check', bx + s / 2, by + s / 2, 18, '#ffffff', 3); }
        else box(g, bx, by, s, s, T.well, T.dim, 4);
        regions.push({ x: bx - 4, y: y + IN, w: Math.max(V.minHit, s + 8), h: V.minHit, action: f.k, payload: !f.value });
        break;
      }
      case 'color': {
        const sw = 48;
        box(g, X, y + IN, sw, V.minHit, '#' + (f.value ?? 0xffffff).toString(16).padStart(6, '0'), T.line);
        let bx = X + sw + 10;
        const cw = Math.max(20, Math.min(30, Math.floor((W - sw - 10) / PAL.length) - 4));
        for (const c of PAL) {
          box(g, bx, y + IN + (V.minHit - cw) / 2, cw, cw, '#' + c.toString(16).padStart(6, '0'), c === f.value ? T.accent : T.line);
          regions.push({ x: bx - 2, y: y + IN, w: cw + 4, h: V.minHit, action: f.k, payload: c });   // the target is the row's height, not the chip's
          bx += cw + 4;
        }
        break;
      }
      case 'btn': {
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
        break;
      }
      case 'tiles': {   // the grid the desktop draws, three across; armed = press fill + an accent glyph (the tool rail's look)
        const opts = f.options ?? [];
        if (!opts.length) { font(); text(g, f.empty ?? 'nothing here', pad, mid, T.dim, width - pad * 2); break; }
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
        break;
      }
      case 'ref': {
        const txt = f.arming ? 'click a target…' : (f.value ?? '— pick —');
        const bw = Math.min(W - V.minHit - 8, Math.max(140, (font(), g.measureText(txt).width + 24)));
        box(g, X, y + IN, bw, V.minHit, f.arming ? T.accentBg : T.well, f.arming ? T.accent : T.line);
        font(); text(g, txt, X + 10, mid, T.text, bw - 20);
        regions.push({ x: X, y: y + IN, w: bw, h: V.minHit, action: f.k });
        if (f.value != null && !f.arming) {
          const cx = X + bw + 6;
          quietButton(cx, y + IN, V.minHit, V.minHit, '', true, 'x');
          regions.push({ x: cx, y: y + IN, w: V.minHit, h: V.minHit, action: f.k, payload: null });
        }
        break;
      }
      case 'range': {
        const lo = f.min ?? 0, hi = f.max ?? 1, st = f.step ?? 0.01, dp = f.dp ?? 2;
        const v = Math.min(hi, Math.max(lo, +(f.value ?? lo)));
        const tw = W - 84, frac = (v - lo) / (hi - lo || 1);
        box(g, X, mid - 4, tw, 8, T.well, T.line, 4);
        box(g, X, mid - 4, Math.max(8, tw * frac), 8, T.accent, null, 4);
        g.beginPath(); g.arc(X + tw * frac, mid, 10, 0, Math.PI * 2); g.fillStyle = T.text; g.fill();
        font(); text(g, `${v.toFixed(dp)}${f.unit ?? ''}`, width - pad, mid, T.text, 80, 'right');
        regions.push({ x: X - 6, y: y + IN, w: tw + 12, h: V.minHit, action: f.k, slider: { lo, hi, st } });
        break;
      }
    }
    if (f.disabled) regions.length = mark;
  }

  // a number: ONE sunken field, − and + inside its ends (the CSS stepper's shape), unit dim before the +
  function stepper(f, val, x, y, w, k, axis) {
    const bump = V.minHit, top = y + IN;
    field(x, top, w, V.minHit, f.driven ? T.drivenEdge : null);
    if (f.driven) { font(V.minText, 700); text(g, '~', x + bump + 8, top + V.minHit / 2, T.driven, 20); }   // driven: the field's own mark (the label keeps its axis colour)
    icon(g, 'minus', x + bump / 2, top + V.minHit / 2, 16, f.disabled ? T.faint : T.dim);
    icon(g, 'plus', x + w - bump / 2, top + V.minHit / 2, 16, f.disabled ? T.faint : T.dim);
    fill(g, T.line, x + bump, top + 6, V.minLine, V.minHit - 12);
    fill(g, T.line, x + w - bump - V.minLine, top + 6, V.minLine, V.minHit - 12);
    const face = f.deg ? `${Math.round(val * R2D)}` : val.toFixed(f.dp ?? 2);
    const unit = f.deg ? '°' : (f.unit ?? '');
    font(V.minText, 500);
    const uw = unit ? g.measureText(unit).width + 4 : 0;
    text(g, face, x + w - bump - 8 - uw, top + V.minHit / 2, f.disabled ? T.dim : T.text, w - bump * 2 - 16 - uw, 'right');
    if (unit) { font(); text(g, unit, x + w - bump - 6, top + V.minHit / 2, T.dim, uw, 'right'); }   // dim, not faint: faint fails 4.5:1 on the well
    // deltas on the WIRE scale (radians for a degree field) — the dispatcher adds them (legacy contract)
    const d = f.deg ? (f.step ?? 1) / R2D : (f.step ?? 0.1);
    regions.push({ x, y: top, w: bump, h: V.minHit, action: k, payload: { axis, delta: -d } });
    regions.push({ x: x + w - bump, y: top, w: bump, h: V.minHit, action: k, payload: { axis, delta: +d } });
  }
  function field(x, y, w, h, edge = null) { box(g, x, y, w, h, T.well, edge ?? T.line); }
  function quietButton(x, y, w, h, label, danger, ic) {
    box(g, x, y, w, h, null, danger ? T.danger : T.line);   // quiet: no fill; in VR it keeps an edge (no hover to find it by)
    if (ic) icon(g, ic, x + w / 2, y + h / 2, 18, danger ? T.danger : T.dim);
    else { font(V.minText, 500); text(g, label, x + w / 2, y + h / 2, danger ? T.danger : T.text, w - 10, 'center'); }
  }
}

/** Enum pills laid out in lines that fit `avail` — every option reachable, none clipped away. */
function enumLines(g, f, avail) {
  const lines = [[]]; let x = 0;
  for (const o of f.options ?? []) {
    const w = Math.max(56, g.measureText(String(o.label ?? o.v)).width + 24);
    if (x > 0 && x + w > avail) { lines.push([]); x = 0; }
    lines.at(-1).push({ o, x, w }); x += w + 6;
  }
  return lines;
}

// ---------------------------------------------------------------- primitives (the VR floor lives here)
function fill(g, c, x, y, w, h) { g.fillStyle = c; g.fillRect(x, y, w, h); }
function box(g, x, y, w, h, bg, edge, r = 3) {
  pathRound(g, x + 1, y + 1, w - 2, h - 2, r);
  if (bg) { g.fillStyle = bg; g.fill(); }
  if (edge) { g.strokeStyle = edge; g.lineWidth = V.minLine; g.stroke(); }
}
function pathRound(g, x, y, w, h, r) {
  g.beginPath(); g.moveTo(x + r, y); g.lineTo(x + w - r, y); g.arcTo(x + w, y, x + w, y + r, r);
  g.lineTo(x + w, y + h - r); g.arcTo(x + w, y + h, x + w - r, y + h, r); g.lineTo(x + r, y + h);
  g.arcTo(x, y + h, x, y + h - r, r); g.lineTo(x, y + r); g.arcTo(x, y, x + r, y, r); g.closePath();
}
function icon(g, name, cx, cy, size, color, lw = V.minLine) {
  if (!hasIcon(name)) return;
  g.save(); g.translate(cx, cy); g.strokeStyle = color; strokeIcon(g, name, size, lw); g.restore();
}
/** Text through the pictograph filter: a mapped emoji becomes its icon; the rest is fillText, ellipsised to maxW.
 *  Returns the drawn width. `align` 'left' | 'right' | 'center' about x. */
function text(g, s, x, y, color, maxW = Infinity, align = 'left') {
  const px = parseFloat(/(\d+(?:\.\d+)?)px/.exec(g.font)?.[1] ?? V.minText);
  const runs = pictoRuns(s).map((r) => (typeof r === 'string' ? r : r));
  const widthOf = (rs) => rs.reduce((a, r) => a + (typeof r === 'string' ? g.measureText(r).width : px + 2), 0);
  let rs = runs, w = widthOf(rs);
  if (w > maxW) {   // ellipsis: trim the last text run until it fits
    rs = [...runs];
    while (rs.length && widthOf(rs) + g.measureText('…').width > maxW) {
      const last = rs.at(-1);
      if (typeof last === 'string' && last.length > 1) rs[rs.length - 1] = last.slice(0, -1); else rs.pop();
    }
    rs.push('…'); w = widthOf(rs);
  }
  let cx = align === 'right' ? x - w : align === 'center' ? x - w / 2 : x;
  g.fillStyle = color; g.textBaseline = 'middle'; g.textAlign = 'left';
  for (const r of rs) {
    if (typeof r === 'string') { g.fillText(r, cx, y); cx += g.measureText(r).width; }
    else { icon(g, r.icon, cx + px / 2, y, px, color); cx += px + 2; }
  }
  g.textBaseline = 'alphabetic';
  return w;
}
