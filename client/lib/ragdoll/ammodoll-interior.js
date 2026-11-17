// ammodoll-interior — the triangles of an interior collider near a fall, handed to Bullet as static ground.
import { THREE } from '../core.js';
import { why } from '../debuglog.js';

/** How far from a fall an interior's triangles are handed to Bullet (a tumble covers a few metres). */
export const INTERIOR_REACH = 8;
/** At most this many interior triangles per fall, all interiors together: building them is synchronous, and a dense
 *  model would hitch the frame or exhaust Ammo's heap. Past it, nearer (INTERIOR_NEAR), then a floor slab. */
export const INTERIOR_MAX_TRIS = 20_000;
export const INTERIOR_NEAR = 3;
/** a fallback is said once per thing on the console (bounded), and always to the `ragdoll` debuglog topic */
const fallbackWarned = new Set();
export function reportInteriorFallback(id, msg) {
  why('ragdoll', `interior fallback — ${msg}; its walls are left out of this fall`);
  if (fallbackWarned.has(id) || fallbackWarned.size >= 64) return;
  fallbackWarned.add(id);
  console.warn(`[ammodoll] interior fallback — ${msg}; its walls are left out of the fall (further ones: __why('ragdoll') in the console)`);
}

/** Does a triangle's footprint (xz) overlap the square `reach` either side of `at`? Separating axes (the square's
 *  two, the triangle's three edge normals), not corner distance: a big floor is two triangles whose corners can
 *  all be far from a body lying in the middle of it. */
function overlapsSquare(v, at, reach) {
  const x0 = at.x - reach, x1 = at.x + reach, z0 = at.z - reach, z1 = at.z + reach;
  if (Math.max(v[0].x, v[1].x, v[2].x) < x0 || Math.min(v[0].x, v[1].x, v[2].x) > x1) return false;
  if (Math.max(v[0].z, v[1].z, v[2].z) < z0 || Math.min(v[0].z, v[1].z, v[2].z) > z1) return false;
  for (let k = 0; k < 3; k++) {
    const a = v[k], b = v[(k + 1) % 3], c = v[(k + 2) % 3];
    const nx = -(b.z - a.z), nz = b.x - a.x;          // the edge's normal in xz
    if (nx === 0 && nz === 0) continue;
    const side = Math.sign(nx * (c.x - a.x) + nz * (c.z - a.z));
    if (side === 0) continue;                          // seen edge-on: no axis
    // the square lies wholly on the far side of this edge from the triangle?
    let far = true;
    for (const [x, z] of [[x0, z0], [x1, z0], [x0, z1], [x1, z1]]) {
      if (Math.sign(nx * (x - a.x) + nz * (z - a.z)) !== -side) { far = false; break; }
    }
    if (far) return false;
  }
  return true;
}

/** An interior collider's triangles within `reach` of `at` (horizontally), in world space, flat [x,y,z, …]. The
 *  geometry is root-local (colliders.js buildExact); scale, rotation and position place it as colliders.js does.
 *  Asked of the collider's BVH, whose walk stops at the first triangle past `max` kept: a dense interior costs its
 *  budget, never its size. */
export function interiorTriangles(c, at, reach, max = INTERIOR_MAX_TRIS) {
  const o = c.obj, s = o.scale?.x || 1, q = o.quaternion, p = o.position;
  // the reach square in the thing's own frame (a circle of reach·√2 holds it however the thing is turned about Y)
  const l = new THREE.Vector3(at.x - p.x, 0, at.z - p.z);
  if (q) l.applyQuaternion(q.clone().invert());
  l.divideScalar(s);
  const R = reach * Math.SQRT2 / s;
  const qbox = new THREE.Box3(new THREE.Vector3(l.x - R, -1e9, l.z - R), new THREE.Vector3(l.x + R, 1e9, l.z + R));
  const out = [];
  let over = false;
  const v = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
  c.exact.bvh.shapecast({
    intersectsBounds: (box) => box.intersectsBox(qbox),
    intersectsTriangle: (tri) => {
      v[0].copy(tri.a); v[1].copy(tri.b); v[2].copy(tri.c);
      for (const w of v) { w.multiplyScalar(s); if (q) w.applyQuaternion(q); w.add(p); }
      if (!overlapsSquare(v, at, reach)) return false;
      if (out.length / 9 >= max) { over = true; return true; }   // stops the walk
      out.push(v[0].x, v[0].y, v[0].z, v[1].x, v[1].y, v[1].z, v[2].x, v[2].y, v[2].z);
      return false;
    },
  });
  return { tris: out, over };
}
