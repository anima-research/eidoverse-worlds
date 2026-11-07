// texts — the browser realizer for the `text` component: a sign (batch 2; R 10-06 23:52: plain, first version, on the canvas text
// path, one house font, no rich text). The meaning lives in shared/protocol/componentspec.js (text) and shared/text.js (how it
// wraps); this file only draws it.
//
//   - Layout: shared/text.js layoutLines, by words, falling back to characters for a word wider than a line (CJK, a URL),
//     measured with the canvas's own measureText. Each paragraph's direction is its first strong letter's, so Arabic and
//     Hebrew read right to left (the canvas applies the bidi algorithm to each line).
//   - One house font: the nameplate's stack (avatar.js), plus the system emoji fonts. A missing glyph paints nothing.
//   - A canvas of ~96 px a line (at most 2048 × 2048; the density drops to fit), mipmapped, anisotropy 4: legible at an
//     angle in a headset. Repainted only when the value changes.
//   - Flat (billboard off): two planes back to back facing ±Z, so it reads from behind unmirrored. yaw: it turns about
//     world up toward the viewer. full: it faces the viewer with world up kept (roll-locked: a VR head tilt never tilts it).
//   - Centred on the thing's origin (Godot Label3D). Its world extent is held to 30 m whatever the transform's scale.
import { THREE, camera } from './core.js';
import { bus } from './base.js';
import { entities, bagOf } from './world.js';
import { layoutLines } from '../../shared/text.js';
import { COMPONENTS } from '../../shared/protocol/componentspec.js';

const D = COMPONENTS.text.defaults;
export const LINE_PX = 96, MAX_PX = 2048, MAX_EXTENT = 30;
export const FONT = (px) => `600 ${px}px system-ui, "Segoe UI", "Noto Sans", "Noto Sans CJK JP", "Noto Sans Arabic", sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji"`;
const signs = new Map();     // id → { v, key, group, tex, mats, geo }
const pending = new Map();   // id → value waiting for its entity
export const _signs = signs;  // probes

const lumaOf = (c) => { const r = (c >> 16) & 255, g = (c >> 8) & 255, b = c & 255; return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255; };
const css = (c) => `#${(c >>> 0).toString(16).padStart(6, '0')}`;

/** Paint a sign's canvas: {canvas, w, h} in metres. Pure of the scene (a probe can call it). */
export function paintSign(v) {
  const size = v.size ?? D.size, width = v.width ?? D.width;
  const fontPx = Math.round(LINE_PX * 0.8);
  const cv = document.createElement('canvas'); const ctx = cv.getContext('2d');
  ctx.font = FONT(fontPx);
  const maxW = (width / size) * LINE_PX;
  const lines = layoutLines(v.text ?? '', maxW, (s) => ctx.measureText(s).width);
  const pad = Math.round(LINE_PX * 0.25);
  const textW = Math.min(maxW, Math.max(1, ...lines.map((l) => ctx.measureText(l.text).width)));
  let W = Math.ceil(textW + pad * 2), H = Math.ceil(lines.length * LINE_PX + pad * 2);
  const k = Math.min(1, MAX_PX / Math.max(W, H));
  cv.width = Math.max(2, Math.round(W * k)); cv.height = Math.max(2, Math.round(H * k));
  ctx.scale(k, k); ctx.font = FONT(fontPx); ctx.textBaseline = 'middle';
  if (Number.isInteger(v.background)) {
    ctx.fillStyle = css(v.background); ctx.beginPath(); ctx.roundRect?.(0, 0, W, H, pad) ?? ctx.rect(0, 0, W, H); ctx.fill();
  }
  const color = Number.isInteger(v.color) ? v.color : D.color;
  // the outline's colour: the author's (text.outlineColor, R 10-11), else the contrasting one for the text colour
  const outline = v.outline !== false; const edge = Number.isInteger(v.outlineColor) ? css(v.outlineColor) : lumaOf(color) > 0.5 ? '#000' : '#fff';
  lines.forEach((l, i) => {
    const y = pad + (i + 0.5) * LINE_PX; const align = v.align ?? D.align;
    ctx.direction = l.dir; ctx.textAlign = align === 'center' ? 'center' : (align === 'left') !== (l.dir === 'rtl') ? 'left' : 'right';
    const x = ctx.textAlign === 'center' ? W / 2 : ctx.textAlign === 'left' ? pad : W - pad;
    if (outline) { ctx.lineWidth = fontPx / 6; ctx.lineJoin = 'round'; ctx.strokeStyle = edge; ctx.strokeText(l.text, x, y); }
    ctx.fillStyle = css(color); ctx.fillText(l.text, x, y);
  });
  return { canvas: cv, w: (W / LINE_PX) * size, h: (H / LINE_PX) * size, lines: lines.length };
}

function drop(id) {
  const s = signs.get(id); if (!s) return;
  signs.delete(id); s.group.parent?.remove(s.group); s.geo.dispose(); s.tex.dispose(); for (const m of s.mats) m.dispose();
}
function build(id, v) {
  const root = entities.get(id); if (!root) { pending.set(id, v); return; }
  pending.delete(id);
  const key = JSON.stringify(v);
  if (signs.get(id)?.key === key && signs.get(id).group.parent === root) return;
  drop(id);
  const p = paintSign(v);
  const tex = new THREE.CanvasTexture(p.canvas); tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 4;
  const M = v.lit === 'scene' ? THREE.MeshStandardMaterial : THREE.MeshBasicMaterial;
  const mat = new M({ map: tex, transparent: true, alphaTest: 0.02, ...(M === THREE.MeshStandardMaterial ? { roughness: 0.95, metalness: 0 } : {}) });
  const geo = new THREE.PlaneGeometry(p.w, p.h);
  const group = new THREE.Group(); group.name = 'sign'; group.userData.sign = id;
  const front = new THREE.Mesh(geo, mat); front.position.z = 0.002; group.add(front);
  if ((v.billboard ?? D.billboard) === 'off') { const back = new THREE.Mesh(geo, mat); back.rotation.y = Math.PI; back.position.z = -0.002; group.add(back); }
  root.add(group);
  const s = root.getWorldScale(new THREE.Vector3()); const big = Math.max(p.w, p.h) * Math.max(Math.abs(s.x), Math.abs(s.y), Math.abs(s.z));
  if (big > MAX_EXTENT) group.scale.setScalar(MAX_EXTENT / big);
  signs.set(id, { v, key, group, tex, mats: [mat], geo, w: p.w, h: p.h, lines: p.lines });
}
function applyFrom(id, data) {
  if (data == null || typeof data !== 'object' || typeof data.text !== 'string') { pending.delete(id); drop(id); return; }
  build(id, data);
}

const _q = new THREE.Quaternion(), _pq = new THREE.Quaternion(), _p = new THREE.Vector3(), _c = new THREE.Vector3(), _m = new THREE.Matrix4(), _up = new THREE.Vector3(0, 1, 0);
/** Per frame: billboards turn toward this viewer (yaw: about world up; full: facing, world up kept). */
export function tickTexts() {
  if (!signs.size) return;
  camera.getWorldPosition(_c);
  for (const s of signs.values()) {
    const mode = s.v.billboard ?? D.billboard; if (mode === 'off' || !s.group.parent) continue;
    s.group.getWorldPosition(_p);
    const to = _c.clone().sub(_p); if (mode === 'yaw') to.y = 0;
    if (to.lengthSq() < 1e-8) continue;
    _m.lookAt(to.normalize(), new THREE.Vector3(0, 0, 0), _up);   // +Z toward the viewer, world up kept
    _q.setFromRotationMatrix(_m);
    s.group.parent.getWorldQuaternion(_pq);
    s.group.quaternion.copy(_pq.invert().multiply(_q));
  }
}

bus.on('comp', ({ id, type, data }) => { if (type === 'text') applyFrom(id, data); });
bus.on('entity', ({ id, kind }) => {
  if (kind === 'remove') { pending.delete(id); drop(id); }
  else if (kind === 'demote') { const s = signs.get(id); if (s) { pending.set(id, s.v); drop(id); } }
  else if (kind === 'spawn' || kind === 'placeholder') { const v = pending.get(id) ?? signs.get(id)?.v ?? bagOf(id)?.text; if (v) { drop(id); build(id, v); } }
});
bus.on('world-reset', () => { pending.clear(); for (const id of [...signs.keys()]) drop(id); });
