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
// ONE place: xr.js only ever calls makeSurfaceDot / placeSurfaceDot / hideSurfaceDot, so the planned contextual icon
// (click / grab / resize / type / scroll) can replace what is drawn here without touching the loop.
export const DOT_RAD = 0.007;      // its diameter as an angle at the eye: ≈0.4°, 6 mm at arm's length, 2 cm at 3 m
export function makeSurfaceDot({ tint = 0xf2f7f5, edge = 0x0b1414 } = {}) {
  const g = new THREE.Group(); g.name = 'xr-dot';
  // a light core in a dark rim: it reads on a dark panel, a white plate and a bright sky alike. Unit diameter; the
  // group's scale is the diameter in metres.
  const mat = (c, o) => new THREE.MeshBasicNodeMaterial({ color: c, transparent: true, opacity: o, depthWrite: false });
  const rim = new THREE.Mesh(new THREE.CircleGeometry(0.5, 24), mat(edge, 0.75));
  const core = new THREE.Mesh(new THREE.CircleGeometry(0.34, 20), mat(tint, 0.95));
  core.position.z = 0.002;   // in unit space; ×diameter it is microns — only the draw order matters, and renderOrder sets it
  for (const [m, o] of [[rim, 1500], [core, 1501]]) { m.renderOrder = o; m.frustumCulled = false; g.add(m); }   // after the plates' sprites and the panels
  g.visible = false;
  return g;
}
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
