// The VR pointer: porch-old's FADING beam (2026-07-14) — a subdivided line whose alpha ramps
// from bright at the hand to nothing at the tip, so it dissolves into space instead of ending in a
// hard dot. porch rode LineBasicMaterial.onBeforeCompile for the per-vertex alpha; node materials
// have no onBeforeCompile, so the fade is an opacityNode read straight off the attribute.
// Geometry runs 0 → -1 on z; the caller scales z to the hit distance (same convention as before).
import * as THREE from 'three';
import { attribute, color, uniform } from 'three/tsl';

export function makePointerLine({ segments = 24, tint = 0x8fb0d6, opacity = 0.85 } = {}) {
  const pos = new Float32Array((segments + 1) * 3), fade = new Float32Array(segments + 1);
  for (let s = 0; s <= segments; s++) { const f = s / segments; pos[s * 3 + 2] = -f; fade[s] = (1 - f) * (1 - f); }   // quadratic fade → gone at the tip
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('aFade', new THREE.BufferAttribute(fade, 1));
  const m = new THREE.LineBasicNodeMaterial({ transparent: true, depthWrite: false });
  m.colorNode = color(tint);
  const u = uniform(opacity);          // live: the caller dims the beam when it points at nothing
  m.opacityNode = attribute('aFade', 'float').mul(u);
  const line = new THREE.Line(g, m);
  line.userData.opacity = u;
  line.frustumCulled = false;
  return line;
}

// THE SURFACE DOT (owner, 10-02): a small mark where the laser meets what it points at — a panel quad, a nameplate, a
// world entity — lying ON the surface and facing out, so you can see exactly what a press would land on. Constant in
// angular size (scaled by its distance from the eye each frame): readable at any distance, never a blob up close. It is
// drawn whenever there is a target, whatever the pointer visibility setting says (in 'never' it is the only mark).
// ONE place: xr.js only ever calls makeSurfaceDot / setSurfaceDotKind / placeSurfaceDot / hideSurfaceDot.
//
// THE CONTEXTUAL ICON (owner, 10-02): the dot becomes an icon for what a press would do there — click (a control), type
// (a text field), scroll (an area that scrolls), move (a panel's handle or background: grip takes it), resize (a corner
// or an edge: grip resizes) — and stays a plain dot where nothing is actionable (a nameplate: resting there is the
// action). Icons are icons.js glyphs (Lucide; Phosphor's arrows-out-cardinal for move) on a dark disc, drawn once per
// kind; constant in angle like the dot, a little larger so a glyph is readable.
import { stroke, fillPath } from './icons.js';
export const DOT_RAD = 0.007;      // its diameter as an angle at the eye: ≈0.4°, 6 mm at arm's length, 2 cm at 3 m
export const ICON_RAD = 0.014;     // an icon's diameter: ≈0.8°, 11 mm at arm's length — a glyph needs about twice a dot
export const DOT_KINDS = { click: 'mouse-pointer-click', type: 'text-cursor', scroll: 'chevrons-up-down', move: 'arrows-out-cardinal',
  'resize-ew': 'move-horizontal', 'resize-ns': 'move-vertical', 'resize-nwse': 'move-diagonal-2', 'resize-nesw': 'move-diagonal' };
const _iconTex = new Map();
function iconTexture(kind) {
  if (_iconTex.has(kind)) return _iconTex.get(kind);
  const cv = document.createElement('canvas'); cv.width = cv.height = 128;
  const g = cv.getContext('2d');
  g.beginPath(); g.arc(64, 64, 60, 0, Math.PI * 2); g.fillStyle = 'rgb(5, 20, 20)'; g.fill();    // the panel ink (#xr-tip, the ring)
  g.lineWidth = 4; g.strokeStyle = 'rgba(143, 232, 200, .8)'; g.stroke();                        // the brand rim
  g.save(); g.translate(64, 64); g.fillStyle = g.strokeStyle = '#f2f7f5';
  const name = DOT_KINDS[kind];
  if (!stroke(g, name, 76)) fillPath(g, name, 76, 'fill');
  g.restore();
  const tex = new THREE.CanvasTexture(cv); tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 4;
  _iconTex.set(kind, tex);
  return tex;
}
export function makeSurfaceDot({ tint = 0xf2f7f5, edge = 0x0b1414 } = {}) {
  const g = new THREE.Group(); g.name = 'xr-dot';
  // a light core in a dark rim: it reads on a dark panel, a white plate and a bright sky alike. Unit diameter; the
  // group's scale is the diameter in metres.
  const mat = (c, o) => new THREE.MeshBasicNodeMaterial({ color: c, transparent: true, opacity: o, depthWrite: false });
  const rim = new THREE.Mesh(new THREE.CircleGeometry(0.5, 24), mat(edge, 0.75));
  const core = new THREE.Mesh(new THREE.CircleGeometry(0.34, 20), mat(tint, 0.95));
  core.position.z = 0.002;   // in unit space; ×diameter it is microns — only the draw order matters, and renderOrder sets it
  for (const [m, o] of [[rim, 1500], [core, 1501]]) { m.renderOrder = o; m.frustumCulled = false; g.add(m); }   // after the plates' sprites and the panels
  const icon = new THREE.Mesh(new THREE.PlaneGeometry(ICON_RAD / DOT_RAD, ICON_RAD / DOT_RAD), new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, alphaTest: 0.02 }));
  icon.renderOrder = 1502; icon.frustumCulled = false; icon.visible = false; icon.name = 'xr-dot-icon'; g.add(icon);
  g.userData.parts = { rim, core, icon }; g.userData.kind = 'dot';
  g.visible = false;
  return g;
}
/** What the mark shows: 'dot' (nothing actionable), or one of DOT_KINDS. */
export function setSurfaceDotKind(dot, kind = 'dot') {
  const k = DOT_KINDS[kind] ? kind : 'dot', { rim, core, icon } = dot.userData.parts;
  if (dot.userData.kind === k) return;
  dot.userData.kind = k;
  rim.visible = core.visible = k === 'dot';
  icon.visible = k !== 'dot';
  if (icon.visible) { icon.material.map = iconTexture(k); icon.material.needsUpdate = true; }
}
/** every icon texture drawn now (the hands' warm compiles the icon with one on) */
export const warmDotIcons = () => Object.keys(DOT_KINDS).forEach(iconTexture);
const _dn = new THREE.Vector3(), _de = new THREE.Vector3(), _dz = new THREE.Vector3(0, 0, 1);
/** Put the dot at world `point` on a surface with world `normal`, sized for an eye at world `eye`. The normal is turned
 *  to face the eye's side, and the dot is lifted off the surface by a hair (scaled with distance) so it never z-fights. */
export function placeSurfaceDot(dot, point, normal, eye) {
  const dist = Math.max(0.05, _de.subVectors(eye, point).length());
  _dn.copy(normal).normalize();
  if (_dn.lengthSq() < 0.5 || _dn.dot(_de) < 0) _dn.copy(_de).normalize();   // no normal, or the back face: face the eye
  dot.position.copy(point).addScaledVector(_dn, Math.max(0.0015, dist * 0.002));
  dot.quaternion.setFromUnitVectors(_dz, _dn);
  dot.scale.setScalar(DOT_RAD * dist);
  dot.visible = true;
}
export function hideSurfaceDot(dot) { if (dot) dot.visible = false; }
