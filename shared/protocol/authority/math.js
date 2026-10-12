// shared/protocol/authority/math.js — rotation, frames, boxes and surfaces (refactor C11, 2026-10-12; moved from
// authority.js's "math" section unchanged). A leaf: it reads a thing's geometry through the catalogue and rounds a
// rotation through storage's qr3, and nothing here reaches the index or the gate.
import { COMPONENTS } from "../componentspec.js";
import { r3 } from "../round.js";
import { boxOfM, geomE } from "./catalogue.js";
import { qr3 } from "./storage.js";
const yawQ = (y) => [0, Math.sin(y / 2), 0, Math.cos(y / 2)];
const qYaw = (q) => 2 * Math.atan2(q[1], q[3]);
function qmul(a, b) {
  return [a[3]*b[0]+a[0]*b[3]+a[1]*b[2]-a[2]*b[1], a[3]*b[1]-a[0]*b[2]+a[1]*b[3]+a[2]*b[0],
          a[3]*b[2]+a[0]*b[1]-a[1]*b[0]+a[2]*b[3], a[3]*b[3]-a[0]*b[0]-a[1]*b[1]-a[2]*b[2]];
}
function qrot(q, v) {
  const [x, y, z, w] = q; const [vx, vy, vz] = v;
  const tx = 2*(y*vz - z*vy), ty = 2*(z*vx - x*vz), tz = 2*(x*vy - y*vx);
  return [vx + w*tx + (y*tz - z*ty), vy + w*ty + (z*tx - x*tz), vz + w*tz + (x*ty - y*tx)];
}
const qinv = (q) => [-q[0], -q[1], -q[2], q[3]];

function worldT(st, id, depth = 0) {
  const e = st.entities[id]; if (!e) return null;
  const t = { ...COMPONENTS.transform.defaults, ...(e.c.transform ?? {}) };
  const p = e.c.parent?.to;
  if (!p || depth > 32 || !st.entities[p]) return t;
  const pt = worldT(st, p, depth + 1);
  const off = qrot(pt.q, t.pos.map((v, i) => v * pt.scale[i]));
  return { pos: pt.pos.map((v, i) => v + off[i]), q: qmul(pt.q, t.q), scale: t.scale.map((v, i) => v * pt.scale[i]) };
}
function localFrom(st, parentId, wt) {
  const pt = worldT(st, parentId);
  const d = qrot(qinv(pt.q), wt.pos.map((v, i) => v - pt.pos[i]));
  return { pos: d.map((v, i) => r3(v / pt.scale[i])), q: qr3(qmul(qinv(pt.q), wt.q)), scale: wt.scale.map((v, i) => r3(v / pt.scale[i])) };
}
function aabb(st, id) {
  const e = st.entities[id]; const m = geomE(e); if (!m) return null;
  const t = worldT(st, id); const [lo0, hi0] = boxOfM(m);
  const corners = [];
  for (const x of [lo0[0], hi0[0]]) for (const y of [lo0[1], hi0[1]]) for (const z of [lo0[2], hi0[2]]) {
    const p = qrot(t.q, [x * t.scale[0], y * t.scale[1], z * t.scale[2]]);
    corners.push(p.map((v, i) => v + t.pos[i]));
  }
  const min = [0, 1, 2].map((i) => Math.min(...corners.map((c) => c[i])));
  const max = [0, 1, 2].map((i) => Math.max(...corners.map((c) => c[i])));
  return { min, max };
}
function solids(st, id) {
  const e = st.entities[id]; const m = geomE(e); if (!m) return [];
  if (!m.solids) { const b = aabb(st, id); return b ? [b] : []; }
  const t = worldT(st, id);
  return m.solids.map(([lo, hi]) => { const cs = [];
    for (const x of [lo[0], hi[0]]) for (const y of [lo[1], hi[1]]) for (const z of [lo[2], hi[2]]) { const p = qrot(t.q, [x * t.scale[0], y * t.scale[1], z * t.scale[2]]); cs.push(p.map((v, i) => v + t.pos[i])); }
    return { min: [0, 1, 2].map((i) => Math.min(...cs.map((c) => c[i]))), max: [0, 1, 2].map((i) => Math.max(...cs.map((c) => c[i]))) }; });
}
// Oriented boxes + the separating-axis test (F21): world-AABBs of rotated solids fatten into false overlaps.
function obbs(st, id) {
  const e = st.entities[id]; const m = geomE(e); if (!m) return [];
  const t = worldT(st, id); const boxes = m.solids ?? [boxOfM(m)];
  const ax = [qrot(t.q, [1, 0, 0]), qrot(t.q, [0, 1, 0]), qrot(t.q, [0, 0, 1])];
  return boxes.map(([lo, hi]) => { const lc = [0, 1, 2].map((i) => (lo[i] + hi[i]) / 2 * t.scale[i]);
    const off = qrot(t.q, lc); return { c: t.pos.map((v, i) => v + off[i]), ax, h: [0, 1, 2].map((i) => Math.abs(hi[i] - lo[i]) / 2 * Math.abs(t.scale[i])) }; });
}
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const crs = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const satCost = (A, B) => (isI(A.ax) && isI(B.ax) ? 1 : 10);   // work units (the spatial index's budget): measured 0.1 / 1 µs
const NONE = new Set();
const isI = (ax) => ax[0][0] === 1 && ax[0][1] === 0 && ax[0][2] === 0 && ax[1][0] === 0 && ax[1][1] === 1 && ax[1][2] === 0 && ax[2][0] === 0 && ax[2][1] === 0 && ax[2][2] === 1;
function satDepth(A, B) { // smallest penetration over the 15 axes; <= 0 means separated
  // two unrotated boxes (most pairs): the 15 axes are the world's three, so the same numbers in the same order, without
  // building them (a place's search tests thousands of pairs)
  if (isI(A.ax) && isI(B.ax)) { let b = Infinity; for (let i = 0; i < 3; i++) { const p = A.h[i] + B.h[i] - Math.abs(B.c[i] - A.c[i]); if (p < b) b = p; if (b <= 0) return b; } return b; }
  // the general case: the same axes in the same order (A's, B's, then their normalized cross products) and the same
  // sums in the same order as ever (ra and rb summed from 0), without allocating them (a rotated pair cost ~8 µs)
  const Ah = A.h, Bh = B.h, Aa = A.ax, Ba = B.ax; const d0 = B.c[0] - A.c[0], d1 = B.c[1] - A.c[1], d2 = B.c[2] - A.c[2]; let best = Infinity;
  const p = (L0, L1, L2) => (0 + Ah[0] * Math.abs(Aa[0][0] * L0 + Aa[0][1] * L1 + Aa[0][2] * L2) + Ah[1] * Math.abs(Aa[1][0] * L0 + Aa[1][1] * L1 + Aa[1][2] * L2) + Ah[2] * Math.abs(Aa[2][0] * L0 + Aa[2][1] * L1 + Aa[2][2] * L2))
    + (0 + Bh[0] * Math.abs(Ba[0][0] * L0 + Ba[0][1] * L1 + Ba[0][2] * L2) + Bh[1] * Math.abs(Ba[1][0] * L0 + Ba[1][1] * L1 + Ba[1][2] * L2) + Bh[2] * Math.abs(Ba[2][0] * L0 + Ba[2][1] * L1 + Ba[2][2] * L2))
    - Math.abs(d0 * L0 + d1 * L1 + d2 * L2);
  for (const ax of [Aa, Ba]) for (let i = 0; i < 3; i++) { const q = p(ax[i][0], ax[i][1], ax[i][2]); if (q < best) best = q; if (best <= 0) return best; }
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) { const a = Aa[i], b = Ba[j];
    const c0 = a[1] * b[2] - a[2] * b[1], c1 = a[2] * b[0] - a[0] * b[2], c2 = a[0] * b[1] - a[1] * b[0]; const n = Math.hypot(c0, c1, c2); if (!(n > 1e-6)) continue;
    const q = p(c0 / n, c1 / n, c2 / n); if (q < best) best = q; if (best <= 0) return best; }
  return best;
}
const boxToObb = (b) => ({ c: [0, 1, 2].map((i) => (b.min[i] + b.max[i]) / 2), ax: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], h: [0, 1, 2].map((i) => (b.max[i] - b.min[i]) / 2) });
const hits = (box, st, id, eps) => { const B = boxToObb(box); return obbs(st, id).some((o) => satDepth(B, o) > eps); };
const overlap = (a, b, eps = 0.01) => [0, 1, 2].every((i) => a.min[i] < b.max[i] - eps && b.min[i] < a.max[i] - eps);
const descendants = (st, id) => Object.keys(st.entities).filter((k) => {
  let p = st.entities[k].c.parent?.to, n = 0; while (p && n++ < 32) { if (p === id) return true; p = st.entities[p]?.c.parent?.to; } return false;
});
const ancestors = (st, id) => { const out = []; let p = st.entities[id]?.c.parent?.to, n = 0; while (p && n++ < 32) { out.push(p); p = st.entities[p]?.c.parent?.to; } return out; };

// A surface is where something can stand. The model's measured surfaces are in its own frame with its own up, so they
// hold while the thing stands (its up within UPRIGHT of the world's); a thing a tumbling engine laid on its side or upside
// down has instead the face of each oriented box that now faces up (none, balanced on an edge). Heights and footprints
// come from the full rotation (yaw-only reading put a tumbled crate's top half its height off).
const UPRIGHT = Math.cos(10 * Math.PI / 180);
function surfacesOf(st, id) {
  const e = st.entities[id]; const m = geomE(e); const b = aabb(st, id); if (!m || !b) return [];
  const t = worldT(st, id);
  const at = (x, y, z) => { const p = qrot(t.q, [x * t.scale[0], y * t.scale[1], z * t.scale[2]]); return [p[0] + t.pos[0], p[1] + t.pos[1], p[2] + t.pos[2]]; };
  if (qrot(t.q, [0, 1, 0])[1] * Math.sign(t.scale[1] || 1) < UPRIGHT) {
    if (m.round) return [];   // a round thing (a ball, a bell) offers no face in any pose; an empty UPRIGHT list (a door, a wall) says nothing about lying
    const out = []; const boxes = obbs(st, id);
    // a point inside one of the thing's own boxes (a face flush under its back panel is no place to put anything)
    const buried = (p, self) => boxes.some((o, k) => k !== self && o.ax.every((ax, i) => Math.abs(dot([p[0] - o.c[0], p[1] - o.c[1], p[2] - o.c[2]], ax)) < o.h[i] - 1e-6));
    for (const [bi, o] of boxes.entries()) for (let j = 0; j < 3; j++) {
      const u = o.ax[j][1]; if (Math.abs(u) < UPRIGHT) continue;
      const n = o.ax[j].map((v) => v * Math.sign(u)); const top = o.c.map((v, i) => v + n[i] * o.h[j]);
      if (buried([top[0] + n[0] * 0.002, top[1] + n[1] * 0.002, top[2] + n[2] * 0.002], bi)) continue;
      const [a, c] = [0, 1, 2].filter((k) => k !== j);
      const cs = [[-1, -1], [-1, 1], [1, -1], [1, 1]].map(([sa, sc]) => [0, 2].map((i) => top[i] + o.ax[a][i] * o.h[a] * sa + o.ax[c][i] * o.h[c] * sc));
      out.push({ id, level: 0, y: top[1], ar: 4 * o.h[a] * o.h[c], min: [Math.min(...cs.map((p) => p[0])), Math.min(...cs.map((p) => p[1]))], max: [Math.max(...cs.map((p) => p[0])), Math.max(...cs.map((p) => p[1]))] });
    }
    // levels go bottom to top, as standing ones do (place's default, the last level, is the top)
    // Faces within 1e-6 of each other are one height (float noise): each group takes its highest y, so the levels stay
    // bottom to top however they're rounded, and orders by the face's own area (not its footprint, which grows with
    // yaw), larger last: a shelf face-down offers its back, not its 3 cm side strips (reviews r7, r8)
    out.sort((p, q) => p.y - q.y);
    for (let i = 0; i < out.length;) { let k = i + 1; while (k < out.length && out[k].y - out[i].y <= 1e-6) k++;
      const y = out[k - 1].y; const g = out.slice(i, k).map((x) => ({ ...x, y })).sort((p, q) => p.ar - q.ar); out.splice(i, k - i, ...g); i = k; }
    return out.map(({ ar, ...x }, i) => ({ ...x, level: i }));
  }
  const yawOnly = t.q[0] === 0 && t.q[2] === 0;   // the common case keeps its exact arithmetic
  const yOf = (sy) => (yawOnly ? t.pos[1] + sy * t.scale[1] : at(0, sy, 0)[1]);
  return (m.surfaces ?? []).map((s, i) => { const k = s.inset ?? 0;
    if (s.x && s.z) { // a measured zone: its own rectangle, carried into the world (the axis-aligned box of its corners)
      const cs = [[s.x[0], s.z[0]], [s.x[0], s.z[1]], [s.x[1], s.z[0]], [s.x[1], s.z[1]]].map(([x, z]) => at(x, s.y, z));
      return { id, level: i, y: yawOnly ? yOf(s.y) : Math.max(...cs.map((c) => c[1])), min: [Math.min(...cs.map((c) => c[0])) + k, Math.min(...cs.map((c) => c[2])) + k], max: [Math.max(...cs.map((c) => c[0])) - k, Math.max(...cs.map((c) => c[2])) - k] };
    }
    return { id, level: i, y: yOf(s.y), min: [b.min[0] + k, b.min[2] + k], max: [b.max[0] - k, b.max[2] - k] }; });
}
export { NONE, UPRIGHT, aabb, ancestors, boxToObb, crs, descendants, dot, hits, isI, localFrom, obbs, overlap, qYaw, qinv, qmul, qrot, satCost, satDepth, solids, surfacesOf, worldT, yawQ };
