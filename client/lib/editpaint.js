// editpaint — the edit-mode SURFACE for the VR quad (Hierarchy, Inspector, Console): the same field specs
// panels.js renderCanvas paints, in edit mode's look (edittheme.js), under the VR floor the spec sets:
//
//   - every hit target >= EDIT_VR.minHit canvas px tall (≈ 3.8 cm at 900 px/m);
//   - no line thinner than EDIT_VR.minLine (a 1-px line shimmers on a resampled quad);
//   - every glyph of text >= EDIT_VR.minText px, and no pictograph handed to fillText (the canvas
//     emoji trap: a glyph the viewer's fonts lack paints NOTHING) — they are icons.js paths;
//   - nothing hover-only: a headset has no hover, so what desktop shows on hover is always drawn;
//   - checkbox, select, button, field: the SAME shapes the CSS draws.
//
// The widgets themselves are widgets.js's (WIDGETS[t].edit, one table with the desktop's and the legacy quad's);
// what lives here is the surface they draw on: the geometry (row height, label column, value column), the primitives
// that keep the floor (fill, box, icon, text through the pictograph filter, the sunken field, the quiet button, the
// stepper) and the walk's two hooks (begin: ground + title; prep: a field's label and its value column).
//
// The contract with the rest of the VR seam is panels.js's: returns hit REGIONS in canvas px, each
// {x, y, w, h, action, payload?, slider?}, dispatching exactly what the legacy painter dispatches
// (tools/edittheme-test.ts holds the two to the same action set). Non-edit quads never come here.

import { EDIT as T, EDIT_VR as V, pictoRuns } from './edittheme.js';
import { stroke as strokeIcon, has as hasIcon } from './icons.js';
import { paintFields, FACTS, R2D } from './widgets.js';

const FONT = 'system-ui, sans-serif';
const IN = (V.rowH - V.minHit) / 2;            // a target's inset inside its row → exactly minHit tall
const AXIS_RE = /(?:^|:)(?:pos|rot|scale)\.([xyz])$/;   // a channel's axis — the label wears x/y/z (the desktop's data-axis)
const VALUE_COL = ['num', 'check', 'enum', 'color', 'range', 'ref', 'vec3'];   // widgets that sit in the value column even unlabelled

export function paintEdit(canvas, fields, { width = 522, title = '' } = {}) {
  const g = canvas.getContext('2d');
  const rowH = V.rowH, pad = V.pad;
  const labelW = Math.round(Math.min(V.labelMax, Math.max(V.labelMin, width * V.labelFrac)));
  const vx = pad + labelW + V.gutter;          // values start here
  const vw = width - pad - vx;                 // …and have this much room
  const font = (px = V.minText, w = 400) => { g.font = `${w} ${Math.max(V.minText, px)}px ${FONT}`; };
  const regions = [];
  const S = {
    kind: 'edit', edit: true, g, regions, rowH, pad, width, labelW, vx, vw, font,
    fill, box, icon, text, enumLines, stepper, field, quietButton,
    begin(items) {
      const HEAD = title ? 40 : 0;
      canvas.width = width; canvas.height = HEAD + items.reduce((a, it) => a + it.h, 0) + pad * 2;
      fill(g, T.bg1, 0, 0, width, canvas.height);
      if (title) {
        fill(g, T.bg0, 0, 0, width, HEAD);
        fill(g, T.line, 0, HEAD - V.minLine, width, V.minLine);
        font(V.minText, 600); text(g, title.charAt(0).toUpperCase() + title.slice(1), pad, HEAD / 2, T.text);
      }
      return HEAD + pad;
    },
    prep(f, y, h) {
      const mid = y + rowH / 2;
      if (!f) return { ...S, y, h, mid };
      // the label is the AXIS's (x/y/z) or dim; driven is the FIELD's job (amber edge + ~), never the label's
      const lab = T[AXIS_RE.exec(f.k ?? '')?.[1]] ?? T.dim;
      const word = f.vrLabel ?? f.label;   // vrLabel: the word a quad paints where the desktop row shows none
      const hasLabel = word != null && word !== '' && f.t !== 'btn' && f.t !== 'log';
      if (hasLabel && f.t !== 'vec3') { font(); text(g, word, pad + labelW, mid, lab, labelW, 'right'); }
      const X = hasLabel || VALUE_COL.includes(f.t) ? vx : pad;
      return { ...S, y, h, mid, X, W: width - pad - X };
    },
  };
  return paintFields(fields, S);

  // a number: ONE sunken field, − and + inside its ends (the CSS stepper's shape), unit dim before the +
  function stepper(f, val, x, y, w, k, axis) {
    const bump = V.minHit, top = y + IN;
    field(x, top, w, V.minHit, f.driven ? T.drivenEdge : null);
    if (f.driven) { font(V.minText, 700); text(g, '~', x + bump + 8, top + V.minHit / 2, T.driven, 20); }   // driven: the field's own mark (the label keeps its axis colour)
    icon(g, 'minus', x + bump / 2, top + V.minHit / 2, 16, f.disabled ? T.faint : T.dim);
    icon(g, 'plus', x + w - bump / 2, top + V.minHit / 2, 16, f.disabled ? T.faint : T.dim);
    fill(g, T.line, x + bump, top + 6, V.minLine, V.minHit - 12);
    fill(g, T.line, x + w - bump - V.minLine, top + 6, V.minLine, V.minHit - 12);
    const face = f.mixed ? '—' : f.deg ? `${Math.round(val * R2D)}` : val.toFixed(f.dp ?? 2);   // mixed: the selection differs (Unity's —)
    const unit = f.mixed ? '' : f.deg ? '°' : (f.unit ?? '');
    font(V.minText, 500);
    const uw = unit ? g.measureText(unit).width + 4 : 0;
    text(g, face, x + w - bump - 8 - uw, top + V.minHit / 2, f.disabled ? T.dim : T.text, w - bump * 2 - 16 - uw, 'right');
    if (unit) { font(); text(g, unit, x + w - bump - 6, top + V.minHit / 2, T.dim, uw, 'right'); }   // dim, not faint: faint fails 4.5:1 on the well
    const d = FACTS.delta(f);   // the legacy contract: the dispatcher adds it
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
