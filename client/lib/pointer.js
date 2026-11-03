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
