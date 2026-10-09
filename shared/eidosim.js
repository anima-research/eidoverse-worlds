// eidosim: our own rigid-body engine. Plain JS float64, no build.
// COVENANT (DESIGN.md): only + − × ÷ Math.sqrt, comparisons, Math.abs/min/max/floor. No Math.hypot, no transcendentals
// (simmath.js when they're needed). Fixed iteration order everywhere: creation index, and pairs sorted (a, b).
// Constants are the version.
// Solver: Box3D's soft step, studied from source with credit (erincatto/box3d, MIT; Catto, "Solver2D", 2024; soft
// constraint coefficients after Ross Nordby). Per substep: integrate velocities → warm start → push (normal only, soft)
// → integrate positions → relax (normal rigid + friction). See DESIGN.md "Studied 2026-10-09".
export const VERSION = "eidosim@1.0.0";
export const _test = {};   // internals exposed to the engine's tests only

const LINEAR_SLOP = 0.005, SPECULATIVE = 4 * LINEAR_SLOP;
const CONTACT_HERTZ = 30, CONTACT_ZETA = 10, CONTACT_SPEED = 3;
const JOINT_HERTZ = 60, JOINT_ZETA = 2;   // Box3D joint.c:30 (constraintHertz, constraintDampingRatio)
const SLEEP_LINEAR = 0.05, SLEEP_TIME = 0.5, MIN_FRICTION_WEIGHT = 0.01, WARM_MATCH = 0.05;
const PI = Math.PI;

// ---- small vector kit (arrays; allocation is fine for v0) ----
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const scl = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const crs = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a) => Math.sqrt(dot(a, a));
// quaternion [x, y, z, w]
const qmul = (a, b) => [
  a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
  a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
  a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
  a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2]];
const qconj = (q) => [-q[0], -q[1], -q[2], q[3]];
const qnorm = (q) => { const l = Math.sqrt(q[0] * q[0] + q[1] * q[1] + q[2] * q[2] + q[3] * q[3]); return [q[0] / l, q[1] / l, q[2] / l, q[3] / l]; };
const qrot = (q, v) => { const t = scl(crs(q, v), 2); return add(add(v, scl(t, q[3])), crs(q, t)); };
const axesOf = (q) => [qrot(q, [1, 0, 0]), qrot(q, [0, 1, 0]), qrot(q, [0, 0, 1])];

// GYROSCOPIC term (Box3D solver.c:105–163, after Catto): solve I(ω2 − ω1) + h ω2 × Iω2 = 0 for ω2 in the body frame
// with one Newton step (B3_GYROSCOPIC_ITERATIONS = 1). Our local inertia is diagonal, so the Jacobian's off-diagonal
// inertia terms vanish. Review 10-09 #5: without it ω, not L, was conserved.
function gyro(b, h) {
  if (b.invMass === 0) return;
  const i0 = 1 / b.invIl[0], i1 = 1 / b.invIl[1], i2 = 1 / b.invIl[2], o1 = qrot(qconj(b.q), b.w);
  const [w1, w2, w3] = o1, Iw1 = i0 * w1, Iw2 = i1 * w2, Iw3 = i2 * w3;   // ω2 = ω1 initially, so dω = 0
  const r = [h * (w2 * Iw3 - w3 * Iw2), h * (w3 * Iw1 - w1 * Iw3), h * (w1 * Iw2 - w2 * Iw1)];
  const J = [i0, h * (Iw3 - w3 * i1), h * (w2 * i2 - Iw2),
             h * (w3 * i0 - Iw3), i1, h * (Iw1 - w1 * i2),
             h * (Iw2 - w2 * i0), h * (w1 * i1 - Iw1), i2];
  const d = solve3(J, r);
  b.w = qrot(b.q, [w1 - d[0], w2 - d[1], w3 - d[2]]);
}
function softness(hertz, zeta, h) {
  if (hertz === 0) return { biasRate: 0, massScale: 1, impulseScale: 0 };
  const omega = 2 * PI * hertz, a1 = 2 * zeta + h * omega, a2 = h * omega * a1, a3 = 1 / (1 + a2);
  return { biasRate: omega / a1, massScale: a2 * a3, impulseScale: a3 };
}

// ---- bodies ----
function makeBody(spec, index, density) {
  const st = !!spec.static;
  const b = { index, uid: spec.uid ?? index, shape: spec.shape, half: spec.half, radius: spec.radius, static: st, noSleep: !!spec.noSleep, ccd: !!spec.ccd,
    p: spec.pos.slice(), q: qnorm(spec.rot ?? [0, 0, 0, 1]), v: (spec.vel ?? [0, 0, 0]).slice(), w: (spec.angVel ?? [0, 0, 0]).slice(),
    friction: spec.friction, combine: spec.frictionCombine ?? "average", rolling: spec.rollingResistance ?? 0, invMass: 0, invIl: [0, 0, 0], sleepTime: 0, awake: !st };
  if (!st) {
    let m, I;
    if (b.shape === "sphere") { const r = b.radius; m = spec.mass || density * (4 / 3) * PI * r * r * r; const i = 0.4 * m * r * r; I = [i, i, i]; }
    else { const [x, y, z] = b.half.map((e) => 2 * e); m = spec.mass || density * x * y * z; I = [m * (y * y + z * z) / 12, m * (x * x + z * z) / 12, m * (x * x + y * y) / 12]; }
    b.invMass = 1 / m; b.invIl = I.map((i) => 1 / i);
  }
  b.ext = b.shape === "sphere" ? b.radius : Math.max(...b.half);
  return b;
}
// world-space inverse inertia R diag(invIl) Rᵀ, cached per step in b.iw (row-major 3×3), as Box3D does in prepare
const qmat = (q) => { const [x, y, z, w] = q; return [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w),
  2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w), 2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)]; };
function updateInertia(b) {
  if (b.invMass === 0) { b.iw = [0, 0, 0, 0, 0, 0, 0, 0, 0]; return; }
  const R = qmat(b.q), d = b.invIl, m = new Array(9);
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) m[r * 3 + c] = R[r * 3] * d[0] * R[c * 3] + R[r * 3 + 1] * d[1] * R[c * 3 + 1] + R[r * 3 + 2] * d[2] * R[c * 3 + 2];
  b.iw = m;
}
const mv = (m, x) => [m[0] * x[0] + m[1] * x[1] + m[2] * x[2], m[3] * x[0] + m[4] * x[1] + m[5] * x[2], m[6] * x[0] + m[7] * x[1] + m[8] * x[2]];
const invI = (b, x) => mv(b.iw, x);
// inverse of a symmetric 3×3 (row-major) by cofactors; a singular one gives zero (no constraint)
function inv3(m) {
  const c0 = m[4] * m[8] - m[5] * m[7], c1 = m[5] * m[6] - m[3] * m[8], c2 = m[3] * m[7] - m[4] * m[6], det = m[0] * c0 + m[1] * c1 + m[2] * c2;
  if (!(Math.abs(det) > 0)) return [0, 0, 0, 0, 0, 0, 0, 0, 0];
  const d = 1 / det;
  return [c0 * d, (m[2] * m[7] - m[1] * m[8]) * d, (m[1] * m[5] - m[2] * m[4]) * d,
          c1 * d, (m[0] * m[8] - m[2] * m[6]) * d, (m[2] * m[3] - m[0] * m[5]) * d,
          c2 * d, (m[1] * m[6] - m[0] * m[7]) * d, (m[0] * m[4] - m[1] * m[3]) * d];
}
const skewMS = (r, M) => {   // −[r]× M [r]× (3×3, row-major)
  const S = [0, -r[2], r[1], r[2], 0, -r[0], -r[1], r[0], 0], T = new Array(9), o = new Array(9);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) T[i * 3 + j] = M[i * 3] * S[j] + M[i * 3 + 1] * S[3 + j] + M[i * 3 + 2] * S[6 + j];
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) o[i * 3 + j] = -(S[i * 3] * T[j] + S[i * 3 + 1] * T[3 + j] + S[i * 3 + 2] * T[6 + j]);
  return o;
};
function solve3(m, b) {   // m x = b by Cramer's rule (fixed operation order)
  const [a, bb, c, d, e, f, g, h, i] = m, A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g, det = a * A + bb * B + c * C;
  if (det === 0) return [0, 0, 0];
  const id = 1 / det;
  return [id * (A * b[0] + (c * h - bb * i) * b[1] + (bb * f - c * e) * b[2]),
          id * (B * b[0] + (a * i - c * g) * b[1] + (c * d - a * f) * b[2]),
          id * (C * b[0] + (bb * g - a * h) * b[1] + (a * e - bb * d) * b[2])];
}
const perp = (n) => { const t = Math.abs(n[0]) < 0.57735 ? crs(n, [1, 0, 0]) : crs(n, [0, 1, 0]), l = len(t), u = [t[0] / l, t[1] / l, t[2] / l]; return [u, crs(n, u)]; };

function aabb(b) {
  if (b.shape === "sphere") { const r = b.radius; return [b.p[0] - r, b.p[1] - r, b.p[2] - r, b.p[0] + r, b.p[1] + r, b.p[2] + r]; }
  const ax = axesOf(b.q), e = [0, 1, 2].map((k) => Math.abs(ax[0][k]) * b.half[0] + Math.abs(ax[1][k]) * b.half[1] + Math.abs(ax[2][k]) * b.half[2]);
  return [b.p[0] - e[0], b.p[1] - e[1], b.p[2] - e[2], b.p[0] + e[0], b.p[1] + e[1], b.p[2] + e[2]];
}

// ---- narrowphase: each returns { n (A→B), pts: [{ p (world), s (separation), id }] } or null ----
function sphereSphere(A, B, M) {
  const d = sub(B.p, A.p), dist = len(d), s = dist - A.radius - B.radius;
  if (s > M) return null;
  const n = dist > 1e-12 ? scl(d, 1 / dist) : [0, 1, 0];
  return { n, pts: [{ p: add(A.p, scl(n, A.radius + 0.5 * s)), s, id: 0 }] };
}
function boxSphere(A, B, M) {   // A box, B sphere
  const l = qrot(qconj(A.q), sub(B.p, A.p)), h = A.half;
  const c = [Math.max(-h[0], Math.min(h[0], l[0])), Math.max(-h[1], Math.min(h[1], l[1])), Math.max(-h[2], Math.min(h[2], l[2]))];
  let nl, s, onBox;
  const d = sub(l, c), dl = len(d);
  if (dl > 1e-12) { nl = scl(d, 1 / dl); s = dl - B.radius; onBox = c; }
  else {   // centre inside: push out along the axis of least penetration
    let k = 0, best = Infinity;
    for (let i = 0; i < 3; i++) { const pen = h[i] - Math.abs(l[i]); if (pen < best) { best = pen; k = i; } }
    nl = [0, 0, 0]; nl[k] = l[k] < 0 ? -1 : 1; s = -best - B.radius; onBox = l.slice(); onBox[k] = nl[k] * h[k];
  }
  if (s > M) return null;
  const n = qrot(A.q, nl), pb = add(A.p, qrot(A.q, onBox));
  return { n, pts: [{ p: add(pb, scl(n, 0.5 * s)), s, id: 0 }] };
}

// FEATURE IDS (review 10-09 #4): every polygon vertex is where two LINES cross: an incident-face edge (labels 0–3) or a
// reference side plane (4–7). A clip point lies on the segment's shared line and the clipping plane, so the label pair
// {min, max} names it uniquely and stably: id = min·8 + max ∈ [0, 63].
function clipPoly(poly, axis, offset, label) {   // keep dot(p, axis) <= offset; poly: [{p, l: [line, line]}]
  const out = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length], da = dot(a.p, axis) - offset, db = dot(b.p, axis) - offset;
    if (da <= 0) out.push(a);
    if ((da <= 0) !== (db <= 0)) {
      const t = da / (da - db), shared = a.l[0] === b.l[0] || a.l[0] === b.l[1] ? a.l[0] : a.l[1];
      out.push({ p: add(a.p, scl(sub(b.p, a.p), t)), l: [shared, label] });
    }
  }
  return out;
}
const lineId = (l) => (l[0] < l[1] ? l[0] * 8 + l[1] : l[1] * 8 + l[0]);
function reduce4(pts, n) {
  if (pts.length <= 4) return pts;
  const area = (a, b, c) => dot(crs(sub(b.p, a.p), sub(c.p, a.p)), n);
  let i1 = 0; for (let i = 1; i < pts.length; i++) if (pts[i].s < pts[i1].s) i1 = i;
  let i2 = -1, best = -1; for (let i = 0; i < pts.length; i++) { const d = sub(pts[i].p, pts[i1].p), dd = dot(d, d); if (i !== i1 && dd > best) { best = dd; i2 = i; } }
  let i3 = -1, a3 = 0; best = -1; for (let i = 0; i < pts.length; i++) { if (i === i1 || i === i2) continue; const a = area(pts[i1], pts[i2], pts[i]); if (Math.abs(a) > best) { best = Math.abs(a); i3 = i; a3 = a; } }
  let i4 = -1; best = -Infinity; for (let i = 0; i < pts.length; i++) { if (i === i1 || i === i2 || i === i3) continue; const a = (a3 < 0 ? 1 : -1) * area(pts[i1], pts[i2], pts[i]); if (a > best) { best = a; i4 = i; } }
  return [i1, i2, i3, i4].filter((i) => i >= 0).sort((a, b) => a - b).map((i) => pts[i]);
}
function faceContact(R, I, rf, n, flip, M) {   // reference box R, face axis rf, n = outward normal of R's face toward I
  const ra = axesOf(R.q), ia = axesOf(I.q);
  let k = 0, best = -1; for (let j = 0; j < 3; j++) { const d = Math.abs(dot(ia[j], n)); if (d > best) { best = d; k = j; } }
  const sk = dot(ia[k], n) > 0 ? -1 : 1, inc = add(I.p, scl(ia[k], sk * I.half[k]));
  const u = (k + 1) % 3, v = (k + 2) % 3, eu = scl(ia[u], I.half[u]), ev = scl(ia[v], I.half[v]);
  let poly = [[1, 1], [-1, 1], [-1, -1], [1, -1]].map(([a, b], i) => ({ p: add(inc, add(scl(eu, a), scl(ev, b))), l: [(i + 3) % 4, i] }));   // vertex i joins edges i−1 and i
  const refC = add(R.p, scl(n, R.half[rf]));
  for (let m = 1; m <= 2; m++) {
    const j = (rf + m) % 3, ax = ra[j], c = dot(R.p, ax);
    poly = clipPoly(poly, ax, c + R.half[j], 2 + 2 * m); if (!poly.length) return null;
    poly = clipPoly(poly, scl(ax, -1), -c + R.half[j], 3 + 2 * m); if (!poly.length) return null;
  }
  const pts = [];
  for (const q of poly) { const s = dot(sub(q.p, refC), n); if (s <= M) pts.push({ p: sub(q.p, scl(n, 0.5 * s)), s, id: (((flip ? 3 : 0) + rf) * 3 + k) * 64 + lineId(q.l) }); }   // face ids < 1152; edge ids 4096+
  if (!pts.length) return null;
  return { n: flip ? scl(n, -1) : n, pts: reduce4(pts, n) };
}
function boxBox(A, B, M) {
  const ua = axesOf(A.q), ub = axesOf(B.q), T = sub(B.p, A.p), ea = A.half, eb = B.half;
  const proj = (L, ax, e) => Math.abs(dot(L, ax[0])) * e[0] + Math.abs(dot(L, ax[1])) * e[1] + Math.abs(dot(L, ax[2])) * e[2];
  let fa = { s: -Infinity }, fb = { s: -Infinity }, bestEdge = { s: -Infinity };
  for (let i = 0; i < 3; i++) {
    let L = ua[i], s = Math.abs(dot(T, L)) - ea[i] - proj(L, ub, eb); if (s > M) return null;
    if (s > fa.s) fa = { s, kind: "A", i, L };
    L = ub[i]; s = Math.abs(dot(T, L)) - eb[i] - proj(L, ua, ea); if (s > M) return null;
    if (s > fb.s) fb = { s, kind: "B", i, L };
  }
  // hysteresis (Box2D's rule): A's face is the reference unless B's separates clearly more, so a near-tie between two
  // stacked boxes can't flip the reference face, and with it every feature id, from one step to the next
  const bestFace = fb.s > 0.98 * fa.s + 0.5 * LINEAR_SLOP ? fb : fa;
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
    let L = crs(ua[i], ub[j]); const l = len(L); if (l < 1e-6) continue; L = scl(L, 1 / l);
    const s = Math.abs(dot(T, L)) - proj(L, ua, ea) - proj(L, ub, eb); if (s > M) return null;
    if (s > bestEdge.s) bestEdge = { s, i, j, L };
  }
  // prefer faces unless an edge axis separates clearly more (stable manifolds for resting stacks)
  const edge = () => {
    if (bestEdge.s === -Infinity) return null;
    const { i, j } = bestEdge; let n = bestEdge.L; if (dot(n, T) < 0) n = scl(n, -1);
    let pa = A.p.slice(), pb = B.p.slice();
    for (let k = 0; k < 3; k++) { if (k !== i) pa = add(pa, scl(ua[k], (dot(ua[k], n) > 0 ? 1 : -1) * ea[k])); if (k !== j) pb = add(pb, scl(ub[k], (dot(ub[k], n) > 0 ? -1 : 1) * eb[k])); }
    const d1 = ua[i], d2 = ub[j], r = sub(pa, pb), a = dot(d1, d1), e = dot(d2, d2), f = dot(d2, r), c = dot(d1, r), bb = dot(d1, d2), den = a * e - bb * bb;
    let s1 = den > 1e-12 ? (bb * f - c * e) / den : 0; s1 = Math.max(-ea[i], Math.min(ea[i], s1));
    let s2 = (bb * s1 + f) / e; s2 = Math.max(-eb[j], Math.min(eb[j], s2));
    const ca = add(pa, scl(d1, s1)), cb = add(pb, scl(d2, s2)), s = dot(sub(cb, ca), n);
    if (s > M) return null;
    return { n, pts: [{ p: scl(add(ca, cb), 0.5), s, id: 4096 + i * 3 + j }] };
  };
  if (bestEdge.s > 0.95 * bestFace.s + LINEAR_SLOP && bestEdge.s > bestFace.s) return edge();
  const f = bestFace;
  const face = f.kind === "A" ? faceContact(A, B, f.i, dot(f.L, T) >= 0 ? f.L : scl(f.L, -1), false, M)
    : faceContact(B, A, f.i, dot(f.L, T) <= 0 ? f.L : scl(f.L, -1), true, M);   // B's face normal pointing toward A
  // within reach but clipping kept no point (a face chosen where an edge axis is the true separation, or a corner over an
  // edge): fall back to the edge pair, never to "no contact" (review r2 #2: 2.3% of near poses had no manifold at all)
  return face ?? edge();
}
// a LOWER BOUND on the distance between two shapes (exact for any pair with a sphere; for box–box, the largest SAT
// separation over the 15 axes, ≤ the true distance), so conservative advancement never steps past a surface
function distLB(A, B) {
  if (A.shape === "sphere" && B.shape === "sphere") { const d = sub(B.p, A.p); return len(d) - A.radius - B.radius; }
  if (A.shape !== "sphere" && B.shape !== "sphere") {
    const ua = axesOf(A.q), ub = axesOf(B.q), T = sub(B.p, A.p), ea = A.half, eb = B.half;
    const proj = (L, ax, e) => Math.abs(dot(L, ax[0])) * e[0] + Math.abs(dot(L, ax[1])) * e[1] + Math.abs(dot(L, ax[2])) * e[2];
    let best = -Infinity;
    for (let i = 0; i < 3; i++) { best = Math.max(best, Math.abs(dot(T, ua[i])) - ea[i] - proj(ua[i], ub, eb), Math.abs(dot(T, ub[i])) - eb[i] - proj(ub[i], ua, ea)); }
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) { let L = crs(ua[i], ub[j]); const l = len(L); if (l < 1e-6) continue; L = scl(L, 1 / l); best = Math.max(best, Math.abs(dot(T, L)) - proj(L, ua, ea) - proj(L, ub, eb)); }
    return best;
  }
  return A.shape !== "sphere" ? boxSphere(A, B, Infinity).pts[0].s : boxSphere(B, A, Infinity).pts[0].s;
}
_test.distLB = (A, B) => distLB(A, B);
_test.collide = (A, B, M) => collide(A, B, M);
_test.makeBody = (spec, i) => { const b = makeBody(spec, i, 1); updateInertia(b); return b; };
function collide(A, B, M) {
  if (A.shape === "sphere" && B.shape === "sphere") return sphereSphere(A, B, M);
  if (A.shape !== "sphere" && B.shape !== "sphere") return boxBox(A, B, M);
  if (A.shape !== "sphere") return boxSphere(A, B, M);
  const m = boxSphere(B, A, M); if (!m) return null; m.n = scl(m.n, -1); return m;
}

// ---- ground (a height field) ----
// One normal per manifold, the field's slope under the body's centre (central differences, exact ops); each corner (box) or
// the sphere's lowest point gives a point whose separation is its height above the field measured along that normal. The
// speculative margin grows with how fast the body closes on the ground this step (its normal speed plus its spin's reach),
// so a fast body meets the field before passing it: the field is continuous, so its tangent plane is no phantom.
const FIELD_EPS = 0.01;
function groundContact(height, b, dt) {
  const x = b.p[0], z = b.p[2];
  const gx = (height(x + FIELD_EPS, z) - height(x - FIELD_EPS, z)) / (2 * FIELD_EPS), gz = (height(x, z + FIELD_EPS) - height(x, z - FIELD_EPS)) / (2 * FIELD_EPS);
  const nl = Math.sqrt(gx * gx + 1 + gz * gz), n = [-gx / nl, 1 / nl, -gz / nl];
  const margin = SPECULATIVE + (Math.max(0, -dot(b.v, n)) + len(b.w) * b.ext) * dt;
  const pts = [];
  if (b.shape === "sphere") {
    const s = (b.p[1] - height(x, z)) * n[1] - b.radius;
    if (s < margin) pts.push({ p: sub(b.p, scl(n, b.radius + 0.5 * s)), s, id: 0 });
  } else {
    const ax = axesOf(b.q);
    for (let k = 0; k < 8; k++) {
      const c = [0, 1, 2].map((i) => b.p[i] + (k & 1 ? 1 : -1) * ax[0][i] * b.half[0] + (k & 2 ? 1 : -1) * ax[1][i] * b.half[1] + (k & 4 ? 1 : -1) * ax[2][i] * b.half[2]);
      const s = (c[1] - height(c[0], c[2])) * n[1];
      if (s < margin) pts.push({ p: sub(c, scl(n, 0.5 * s)), s, id: k });
    }
  }
  return pts.length ? { n, pts: reduce4(pts, n) } : null;
}

// ---- world ----
export function createWorld({ gravity = [0, -9.81, 0], substeps = 4, friction = 0.6, density = 1, contactHertz = CONTACT_HERTZ, ground = null } = {}, from = null) {
  const bodies = [], joints = [];
  const WORLD = { index: -1, static: true, invMass: 0, invIl: [0, 0, 0], iw: [0, 0, 0, 0, 0, 0, 0, 0, 0], p: [0, 0, 0], q: [0, 0, 0, 1], v: [0, 0, 0], w: [0, 0, 0], awake: false, dR: [1, 0, 0, 0, 1, 0, 0, 0, 1] };
  const bodyOf = (i) => (i < 0 ? WORLD : bodies[i]);
  // ground: a height function y = height(x, z) (exact ops, so every runtime agrees), a static collider under everything.
  // Not part of exportState: whoever restores a world passes the same function again.
  const GROUND = ground ? { uid: -2, index: -2, shape: "field", height: ground.height, static: true, rolling: ground.rollingResistance ?? 0, invMass: 0, invIl: [0, 0, 0], iw: [0, 0, 0, 0, 0, 0, 0, 0, 0],
    p: [0, 0, 0], q: [0, 0, 0, 1], v: [0, 0, 0], w: [0, 0, 0], awake: false, dR: [1, 0, 0, 0, 1, 0, 0, 0, 1], p0: [0, 0, 0], q0c: [0, 0, 0, 1], ext: 0, half: [0, 0, 0], friction: ground.friction ?? friction, combine: ground.frictionCombine ?? "average" } : null;
  let manifolds = [], prevImpulses = new Map(), prevManifold = new Map(), prevByPair = new Map();
  const W = {
    bodies,
    addBody(spec) { const b = makeBody(spec, bodies.length, density); b.spec = spec; if (b.friction === undefined) b.friction = friction; bodies.push(b); return b.index; },
    setVelocity(i, v, w = [0, 0, 0]) { const b = bodies[i]; b.v = v.slice(); b.w = w.slice(); b.sleepTime = 0; b.awake = true; },
    applyImpulse(i, P, at) { const b = bodies[i]; if (!b.invMass) return; updateInertia(b); b.v = add(b.v, scl(P, b.invMass)); b.w = add(b.w, invI(b, crs(sub(at, b.p), P))); b.sleepTime = 0; b.awake = true; },
    // joints: type "point" | "hinge" (axis) | "fixed"; anchor `at` and `axis` in world space at creation; a or b < 0 = the world
    addJoint({ type, a, b, at, axis }) {
      const A = bodyOf(a), B = bodyOf(b);
      const j = { type, a, b, alive: true, lA: qrot(qconj(A.q), sub(at, A.p)), lB: qrot(qconj(B.q), sub(at, B.p)), lin: [0, 0, 0], ang: [0, 0, 0] };
      if (type === "hinge") { const ax = scl(axis, 1 / len(axis)); j.axA = qrot(qconj(A.q), ax); j.axB = qrot(qconj(B.q), ax); }
      if (type === "fixed") j.rel0 = qmul(qconj(A.q), B.q);   // B's orientation in A's frame at creation
      joints.push(j); for (const x of [A, B]) if (!x.static) { x.awake = true; x.sleepTime = 0; }
      return joints.length - 1;
    },
    removeJoint(k) { const j = joints[k]; if (!j || !j.alive) return; j.alive = false; for (const x of [bodyOf(j.a), bodyOf(j.b)]) if (!x.static) { x.awake = true; x.sleepTime = 0; } },
    step(dt) { stepWorld(dt); },
    state() { return bodies.map((b) => [...b.p, ...b.q, ...b.v]); },
    asleep() { return bodies.map((b) => b.static || !b.awake); },
    // The whole persistent state as plain JSON, exact: a world built from it with createWorld(opts, it) steps bit-identically
    // to this one (warm starts, sleep tags and the step counter included). Everything else is rebuilt every step.
    exportState() {
      const cp = (x) => (x === undefined ? null : JSON.parse(JSON.stringify(x)));
      return { stepNo,
        bodies: bodies.map((b) => ({ spec: cp(b.spec), p: b.p.slice(), q: b.q.slice(), v: b.v.slice(), w: b.w.slice(), awake: b.awake, sleepTime: b.sleepTime, sleepTag: b.sleepTag ?? null })),
        joints: cp(joints), impulses: cp([...prevImpulses]), manifolds: cp([...prevManifold]), pairs: cp([...prevByPair]) };
    },
  };

  function findPairs() {
    const boxes = bodies.map(aabb), order = bodies.map((_, i) => i).sort((a, b) => boxes[a][0] - boxes[b][0] || a - b), pairs = [];
    for (let x = 0; x < order.length; x++) {
      const i = order[x], bi = boxes[i];
      for (let y = x + 1; y < order.length; y++) {
        const j = order[y], bj = boxes[j];
        if (bj[0] > bi[3] + SPECULATIVE) break;
        const A = bodies[i], B = bodies[j];
        if (A.static && B.static) continue;
        if (!A.awake && !B.awake) continue;
        if (bj[1] > bi[4] + SPECULATIVE || bi[1] > bj[4] + SPECULATIVE || bj[2] > bi[5] + SPECULATIVE || bi[2] > bj[5] + SPECULATIVE) continue;
        pairs.push(i < j ? [i, j] : [j, i]);
      }
    }
    return pairs.sort((p, q) => p[0] - q[0] || p[1] - q[1]);
  }

  let stepNo = 0;
  if (from) {
    for (const r of from.bodies) {
      const i = W.addBody(r.spec), b = bodies[i];
      b.p = r.p.slice(); b.q = r.q.slice(); b.v = r.v.slice(); b.w = r.w.slice(); b.awake = r.awake; b.sleepTime = r.sleepTime;
      if (r.sleepTag !== null) b.sleepTag = r.sleepTag;
    }
    for (const j of from.joints) joints.push(JSON.parse(JSON.stringify(j)));
    prevImpulses = new Map(from.impulses); prevManifold = new Map(from.manifolds); prevByPair = new Map(from.pairs); stepNo = from.stepNo;
  }
  function stepWorld(dt) {
    stepNo++;
    const h = dt / substeps;
    const hz = Math.min(contactHertz, 0.125 * substeps / dt);   // Box3D's cap (physics_world.c:1126): stiffness is bounded by the substep rate
    const soft = softness(hz, CONTACT_ZETA, h), softStatic = softness(2 * hz, CONTACT_ZETA, h);
    // narrowphase + prepare
    for (const b of bodies) updateInertia(b);
    manifolds = [];
    const jointed = new Set(joints.filter((j) => j.alive && j.a >= 0 && j.b >= 0).map((j) => `${Math.min(j.a, j.b)}:${Math.max(j.a, j.b)}`));
    // WAKE WHOLE ISLANDS (as Box3D's persistent islands; review 10-09 #3): a sleeping island remembers its tag; if any
    // member was woken (API) or an awake body reaches one (AABB pair or joint), the whole tagged island wakes BEFORE
    // contacts are built, so its internal contacts exist this step and warm-start from their kept impulses
    // wokeBy (transient, read by a host right after the step): the uid of the awake body whose reach woke this one,
    // carried down a cascade to the body that started it; never exported, never an input
    for (const b of bodies) b.wokeBy = undefined;
    const wakeTag = (t, by) => { for (const b of bodies) if (b.sleepTag === t) { b.awake = true; b.sleepTime = 0; b.sleepTag = undefined; b.wokeBy = by; } };
    for (const b of bodies) if (!b.static && b.awake && b.sleepTag !== undefined) wakeTag(b.sleepTag, b.uid);
    let pairs = findPairs();
    for (let changed = true; changed;) {
      changed = false;
      const reach = (x, y) => { if (!x.static && x.awake && !y.static && !y.awake && y.sleepTag !== undefined) { wakeTag(y.sleepTag, x.wokeBy ?? x.uid); changed = true; } };
      // a sleeper wakes when an awake body TOUCHES it: a contact manifold with points (shapes within the speculative
      // distance), as Box3D (contact begins touching → b3LinkContact wakes the set) and Jolt (contact constraint added →
      // bodies activated) both do. Not on box proximity: a rotated box's AABB reaches well past the box.
      const sleeper = (y) => !y.static && !y.awake && y.sleepTag !== undefined;
      for (const [i, j] of pairs) { const A = bodies[i], B = bodies[j];
        const awake = (x) => !x.static && x.awake;
        if (!((awake(A) && sleeper(B)) || (awake(B) && sleeper(A))) || jointed.has(`${i}:${j}`)) continue;
        const m = collide(A, B, SPECULATIVE); if (!m || !m.pts.length) continue;
        reach(A, B); reach(B, A); }
      for (const jt of joints) if (jt.alive && jt.a >= 0 && jt.b >= 0) { reach(bodies[jt.a], bodies[jt.b]); reach(bodies[jt.b], bodies[jt.a]); }
      if (changed) pairs = findPairs();
    }
    const build = (A, B, m) => {
      const n = m.n, t1 = Math.abs(n[0]) < 0.57735 ? scl(crs(n, [1, 0, 0]), 1 / len(crs(n, [1, 0, 0]))) : scl(crs(n, [0, 1, 0]), 1 / len(crs(n, [0, 1, 0]))), t2 = crs(n, t1);
      const mu = combineFriction(A, B), points = [];
      for (const c of m.pts) {
        // each body's anchor on ITS OWN surface (midpoint ∓ n·s/2): with a wide speculative gap a shared midpoint sits outside
        // both bodies, and friction at it torques a ball with a lever longer than its radius (tunnel-1000 case 16)
        const rA = sub(sub(c.p, scl(n, 0.5 * c.s)), A.p), rB = sub(add(c.p, scl(n, 0.5 * c.s)), B.p);
        const kOf = (d) => { const ra = crs(rA, d), rb = crs(rB, d); return A.invMass + B.invMass + dot(ra, invI(A, ra)) + dot(rb, invI(B, rb)); };
        const key = `${A.uid}:${B.uid}:${c.id}`, local = qrot(qconj(A.q), rA);
        let prev = prevImpulses.get(key)?.ln;
        if (prev === undefined) {   // the feature id changed (clipping moved): match the nearest old point in A's frame
          let best = WARM_MATCH * WARM_MATCH;
          for (const o of prevByPair.get(`${A.uid}:${B.uid}`) ?? []) { const d = sub(o.local, local), dd = dot(d, d); if (dd < best) { best = dd; prev = o.ln; } }
        }
        points.push({ key, rA, rB, local, s0: c.s, base: c.s - dot(sub(rB, rA), n), nm: 1 / kOf(n), ln: prev ?? 0 });
      }
      // CENTRAL friction (Box3D contact_solver.c prepare): one coupled 2D tangent impulse at the manifold's weighted
      // centre, plus twist friction about the normal; points well beyond the speculative distance weigh less
      let cA = [0, 0, 0], cB = [0, 0, 0], wsum = 0;
      for (const p of points) { const wgt = Math.max(MIN_FRICTION_WEIGHT, Math.min(1, 2 - p.s0 / SPECULATIVE)); cA = add(cA, scl(p.rA, wgt)); cB = add(cB, scl(p.rB, wgt)); wsum += wgt; }
      cA = scl(cA, 1 / wsum); cB = scl(cB, 1 / wsum);
      for (const p of points) p.lever = len(sub(p.rA, cA));
      const rtA1 = crs(cA, t1), rtA2 = crs(cA, t2), rtB1 = crs(cB, t1), rtB2 = crs(cB, t2), mm = A.invMass + B.invMass;
      const k11 = mm + dot(rtA1, invI(A, rtA1)) + dot(rtB1, invI(B, rtB1)), k22 = mm + dot(rtA2, invI(A, rtA2)) + dot(rtB2, invI(B, rtB2));
      const k12 = dot(rtA1, invI(A, rtA2)) + dot(rtB1, invI(B, rtB2)), det = k11 * k22 - k12 * k12, id = det !== 0 ? 1 / det : 0;
      const tw = dot(n, add(invI(A, n), invI(B, n))), mkey = `${A.uid}:${B.uid}`, pm = prevManifold.get(mkey);
      // rolling resistance (Box3D contact.c:689, contact_solver.c:609): max of the two materials × the rounded radius (a
      // box's is 0), an angular impulse on the relative spin bounded by rr × the normal impulse
      const rr = Math.max(A.rolling, B.rolling) * Math.max(A.shape === "sphere" ? A.radius : 0, B.shape === "sphere" ? B.radius : 0);
      manifolds.push({ A, B, n, t1, t2, mu, points, soft: A.static || B.static ? softStatic : soft, key: mkey,
        cA, cB, tm: [k22 * id, -k12 * id, k11 * id], twm: tw > 0 ? 1 / tw : 0,
        f1: pm ? dot(pm.f, t1) : 0, f2: pm ? dot(pm.f, t2) : 0, twist: pm ? pm.twist : 0,
        rr, ...(rr > 0 ? { rm: inv3(A.iw.map((x, k) => x + B.iw[k])), roll: pm?.roll ? pm.roll.slice() : [0, 0, 0] } : {}),
        pA0: A.p.slice(), qA0: A.q.slice(), pB0: B.p.slice(), qB0: B.q.slice() });
    };
    for (const [i, j] of pairs) {
      if (jointed.has(`${i}:${j}`)) continue;   // course rule: jointed bodies don't collide (Box3D default)
      const m = collide(bodies[i], bodies[j], SPECULATIVE);
      if (m) build(bodies[i], bodies[j], m);
    }
    if (GROUND) for (const b of bodies) if (!b.static && b.awake) { const m = groundContact(GROUND.height, b, dt); if (m) build(GROUND, b, m); }
    // islands → wake/sleep (union-find over touching contacts between dynamic bodies)
    const parent = bodies.map((_, i) => i), find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
    for (const m of manifolds) if (!m.A.static && !m.B.static) { const a = find(m.A.index), b = find(m.B.index); if (a !== b) parent[Math.max(a, b)] = Math.min(a, b); }
    for (const j of joints) if (j.alive && j.a >= 0 && j.b >= 0 && !bodies[j.a].static && !bodies[j.b].static) { const a = find(j.a), b = find(j.b); if (a !== b) parent[Math.max(a, b)] = Math.min(a, b); }
    const islandMin = new Map();
    for (const b of bodies) if (!b.static) { const r = find(b.index), t = b.noSleep ? 0 : b.awake ? b.sleepTime : Infinity; islandMin.set(r, Math.min(islandMin.get(r) ?? Infinity, t)); }
    for (const b of bodies) if (!b.static) { const awake = islandMin.get(find(b.index)) < SLEEP_TIME; if (awake && !b.awake) { b.awake = true; b.sleepTime = 0; } }
    const live = (b) => !b.static && b.awake;
    const act = manifolds.filter((m) => live(m.A) || live(m.B));
    // hot path: scalar, in place (no arrays allocated per impulse)
    const imp = (b, sgn, d, n, r) => {   // apply sgn·d·n at offset r
      if (!live(b)) return; const k = sgn * d, px = n[0] * k, py = n[1] * k, pz = n[2] * k, im = b.invMass, v = b.v, w = b.w, m = b.iw;
      v[0] += px * im; v[1] += py * im; v[2] += pz * im;
      const tx = r[1] * pz - r[2] * py, ty = r[2] * px - r[0] * pz, tz = r[0] * py - r[1] * px;
      w[0] += m[0] * tx + m[1] * ty + m[2] * tz; w[1] += m[3] * tx + m[4] * ty + m[5] * tz; w[2] += m[6] * tx + m[7] * ty + m[8] * tz;
    };
    const apply = (b, P, r) => { const l = Math.sqrt(dot(P, P)); if (l > 0) imp(b, 1, l, [P[0] / l, P[1] / l, P[2] / l], r); };
    const applyAng = (b, L) => { if (!live(b)) return; const m = b.iw, w = b.w; w[0] += m[0] * L[0] + m[1] * L[1] + m[2] * L[2]; w[1] += m[3] * L[0] + m[4] * L[1] + m[5] * L[2]; w[2] += m[6] * L[0] + m[7] * L[1] + m[8] * L[2]; };
    const relv = (m, rA, rB, n) => {   // dot(vB + wB×rB − vA − wA×rA, n)
      const A = m.A, B = m.B, va = A.v, wa = A.w, vb = B.v, wb = B.w;
      return (vb[0] + wb[1] * rB[2] - wb[2] * rB[1] - va[0] - (wa[1] * rA[2] - wa[2] * rA[1])) * n[0]
        + (vb[1] + wb[2] * rB[0] - wb[0] * rB[2] - va[1] - (wa[2] * rA[0] - wa[0] * rA[2])) * n[1]
        + (vb[2] + wb[0] * rB[1] - wb[1] * rB[0] - va[2] - (wa[0] * rA[1] - wa[1] * rA[0])) * n[2];
    };
    // per body: position and rotation (as a matrix) at step start; the delta rotation is rebuilt once per substep
    for (const b of bodies) { b.p0 = b.p.slice(); b.q0c = qconj(b.q); b.dR = [1, 0, 0, 0, 1, 0, 0, 0, 1]; }
    const sepOf = (m, p) => {   // separation from body motion since the step began (no re-collision per substep)
      // a sphere's support point toward n doesn't turn with its spin, so its contact anchor doesn't ride dR (joint anchors do)
      const A = m.A, B = m.B, ra = p.rA, rb = p.rB, n = m.n, Ra = A.shape === "sphere" ? I3 : A.dR, Rb = B.shape === "sphere" ? I3 : B.dR;
      const a0 = Ra[0] * ra[0] + Ra[1] * ra[1] + Ra[2] * ra[2], a1 = Ra[3] * ra[0] + Ra[4] * ra[1] + Ra[5] * ra[2], a2 = Ra[6] * ra[0] + Ra[7] * ra[1] + Ra[8] * ra[2];
      const b0 = Rb[0] * rb[0] + Rb[1] * rb[1] + Rb[2] * rb[2], b1 = Rb[3] * rb[0] + Rb[4] * rb[1] + Rb[5] * rb[2], b2 = Rb[6] * rb[0] + Rb[7] * rb[1] + Rb[8] * rb[2];
      return (B.p[0] - B.p0[0] + b0 - A.p[0] + A.p0[0] - a0) * n[0] + (B.p[1] - B.p0[1] + b1 - A.p[1] + A.p0[1] - a1) * n[1]
        + (B.p[2] - B.p0[2] + b2 - A.p[2] + A.p0[2] - a2) * n[2] + p.base;
    };

    // ---- joints (Box3D spherical/revolute/weld pattern: soft in the biased pass, rigid in relax; anchors ride dR) ----
    const jsoft = softness(Math.min(JOINT_HERTZ, 0.25 * substeps / dt), JOINT_ZETA, h);
    const jact = joints.filter((j) => j.alive && (live(bodyOf(j.a)) || live(bodyOf(j.b))));
    for (const j of jact) { const A = bodyOf(j.a), B = bodyOf(j.b); j.rA0 = qrot(A.q, j.lA); j.rB0 = qrot(B.q, j.lB); }
    const angImp = (A, B, L) => { applyAng(A, scl(L, -1)); applyAng(B, L); };
    const linImp = (A, B, P, rA, rB) => { const l = Math.sqrt(dot(P, P)); if (l > 0) { const u = scl(P, 1 / l); imp(A, -1, l, u, rA); imp(B, 1, l, u, rB); } };
    const warmJoint = (j) => { const A = bodyOf(j.a), B = bodyOf(j.b);
      // a hinge's angular impulse lives in the plane ⟂ its axis; as A turns, drop what now lies ALONG the axis, or the warm
      // start drives the free DOF like a motor (review 10-09 #1; Box3D stores 2 scalars on rebuilt axes, revolute_joint.c:248)
      if (j.type === "hinge") { const aA = qrot(A.q, j.axA); j.ang = sub(j.ang, scl(aA, dot(j.ang, aA))); }
      linImp(A, B, j.lin, mv(A.dR, j.rA0), mv(B.dR, j.rB0)); angImp(A, B, j.ang); };
    function solveJoint(j, useBias) {
      const A = bodyOf(j.a), B = bodyOf(j.b), bs = useBias ? jsoft : { biasRate: 0, massScale: 1, impulseScale: 0 };
      const IAB = A.iw.map((x, k) => x + B.iw[k]);
      if (j.type === "hinge") {   // keep the two hinge axes parallel: 2 angular rows ⟂ A's axis
        const aA = qrot(A.q, j.axA), aB = qrot(B.q, j.axB), [p1, p2] = perp(aA), e = crs(aA, aB), dw = sub(B.w, A.w);
        const k11 = dot(p1, mv(IAB, p1)), k12 = dot(p1, mv(IAB, p2)), k22 = dot(p2, mv(IAB, p2)), det = k11 * k22 - k12 * k12;
        if (det !== 0) {
          const r1 = dot(p1, dw) + bs.biasRate * dot(p1, e), r2 = dot(p2, dw) + bs.biasRate * dot(p2, e), id = 1 / det;
          const x1 = id * (k22 * r1 - k12 * r2), x2 = id * (k11 * r2 - k12 * r1);
          const o1 = dot(j.ang, p1), o2 = dot(j.ang, p2);
          const d1 = -bs.massScale * x1 - bs.impulseScale * o1, d2 = -bs.massScale * x2 - bs.impulseScale * o2;
          const L = add(scl(p1, d1), scl(p2, d2)); j.ang = add(j.ang, L); angImp(A, B, L);
        }
      } else if (j.type === "fixed") {   // relative rotation error as a rotation vector (small-angle), 3 angular rows
        let qe = qmul(qmul(B.q, qconj(qmul(A.q, j.rel0))), [0, 0, 0, 1]); if (qe[3] < 0) qe = qe.map((x) => -x);
        const C = [2 * qe[0], 2 * qe[1], 2 * qe[2]], dw = sub(B.w, A.w);
        const x = solve3(IAB, add(dw, scl(C, bs.biasRate))), L = sub(scl(x, -bs.massScale), scl(j.ang, bs.impulseScale));
        j.ang = add(j.ang, L); angImp(A, B, L);
      }
      // point-to-point (all three types): 3×3 block
      const rA = mv(A.dR, j.rA0), rB = mv(B.dR, j.rB0);
      const cdot = sub(add(B.v, crs(B.w, rB)), add(A.v, crs(A.w, rA))), sep = sub(add(B.p, rB), add(A.p, rA));
      const K = add9(skewMS(rA, A.iw), skewMS(rB, B.iw)), mm = A.invMass + B.invMass; K[0] += mm; K[4] += mm; K[8] += mm;
      const x = solve3(K, add(cdot, scl(sep, bs.biasRate))), P = sub(scl(x, -bs.massScale), scl(j.lin, bs.impulseScale));
      j.lin = add(j.lin, P); linImp(A, B, P, rA, rB);
    }
    for (let s = 0; s < substeps; s++) {
      for (const b of bodies) if (live(b)) { b.v[0] += gravity[0] * h; b.v[1] += gravity[1] * h; b.v[2] += gravity[2] * h; gyro(b, h); }
      for (const j of jact) warmJoint(j);
      for (const m of act) {   // warm start: normal per point, friction at the centre, twist about the normal
        for (const p of m.points) { imp(m.A, -1, p.ln, m.n, p.rA); imp(m.B, 1, p.ln, m.n, p.rB); }
        const F = add(scl(m.t1, m.f1), scl(m.t2, m.f2)); apply(m.A, scl(F, -1), m.cA); apply(m.B, F, m.cB);
        applyAng(m.A, scl(m.n, -m.twist)); applyAng(m.B, scl(m.n, m.twist));
        if (m.rr > 0) { applyAng(m.A, scl(m.roll, -1)); applyAng(m.B, m.roll); }
      }
      for (const j of jact) solveJoint(j, true);
      const rev = s & 1;   // symmetric Gauss-Seidel: alternate point order per substep
      for (const m of act) for (let k = 0, np = m.points.length; k < np; k++) { const p = m.points[rev ? np - 1 - k : k];   // push: normal only, soft
        const sep = sepOf(m, p);
        let bias, ms, is;
        if (sep > 0) { bias = sep / h; ms = 1; is = 0; } else { bias = Math.max(m.soft.massScale * m.soft.biasRate * sep, -CONTACT_SPEED); ms = m.soft.massScale; is = m.soft.impulseScale; }
        const vn = relv(m, p.rA, p.rB, m.n);
        const nl = Math.max(p.ln - p.nm * (ms * vn + bias) - is * p.ln, 0), d = nl - p.ln; p.ln = nl;
        imp(m.A, -1, d, m.n, p.rA); imp(m.B, 1, d, m.n, p.rB);
      }
      for (const b of bodies) if (live(b)) {
        b.p = add(b.p, scl(b.v, h));
        b.q = qnorm(add4(b.q, scl4(qmul([b.w[0], b.w[1], b.w[2], 0], b.q), 0.5 * h)));
        b.dR = qmat(qmul(b.q, b.q0c));
      }
      for (const j of jact) solveJoint(j, false);
      for (const m of act) {   // relax: normal rigid; then twist and central friction against this pass's normal impulse
        let total = 0, twistLimit = 0;
        for (let k = 0, np = m.points.length; k < np; k++) { const p = m.points[rev ? np - 1 - k : k];
          const sep = sepOf(m, p), vn = relv(m, p.rA, p.rB, m.n);
          const nl = Math.max(p.ln - p.nm * (vn + (sep > 0 ? sep / h : 0)), 0), d = nl - p.ln; p.ln = nl; total += nl; twistLimit += p.lever * nl;
          imp(m.A, -1, d, m.n, p.rA); imp(m.B, 1, d, m.n, p.rB);
        }
        { const ts = dot(m.n, sub(m.B.w, m.A.w)), lim = m.mu * twistLimit;
          const nt = Math.max(-lim, Math.min(lim, m.twist - m.twm * ts)), d = nt - m.twist; m.twist = nt;
          applyAng(m.A, scl(m.n, -d)); applyAng(m.B, scl(m.n, d)); }
        if (m.rr > 0) { const dw = sub(m.B.w, m.A.w), r = m.rm, old = m.roll;
          let nr = [old[0] - (r[0] * dw[0] + r[1] * dw[1] + r[2] * dw[2]), old[1] - (r[3] * dw[0] + r[4] * dw[1] + r[5] * dw[2]), old[2] - (r[6] * dw[0] + r[7] * dw[1] + r[8] * dw[2])];
          const lim = m.rr * total, l2 = dot(nr, nr); if (l2 > lim * lim) nr = scl(nr, lim / Math.sqrt(l2));
          const d = sub(nr, old); m.roll = nr; applyAng(m.A, scl(d, -1)); applyAng(m.B, d); }
        { const vt1 = relv(m, m.cA, m.cB, m.t1), vt2 = relv(m, m.cA, m.cB, m.t2);
          let n1 = m.f1 - (m.tm[0] * vt1 + m.tm[1] * vt2), n2 = m.f2 - (m.tm[1] * vt1 + m.tm[2] * vt2);
          const lim = m.mu * total, l2 = n1 * n1 + n2 * n2;
          if (l2 > lim * lim) { const sc = lim / Math.sqrt(l2); n1 *= sc; n2 *= sc; }
          const d1 = n1 - m.f1, d2 = n2 - m.f2; m.f1 = n1; m.f2 = n2;
          imp(m.A, -1, d1, m.t1, m.cA); imp(m.B, 1, d1, m.t1, m.cB); imp(m.A, -1, d2, m.t2, m.cA); imp(m.B, 1, d2, m.t2, m.cB); }
      }
    }
    // ---- CCD: time of impact by conservative advancement, on Box3D's rules (solver.c:556–611, distance.c:1709). Review
    // round 2 (10-09): (1) sweep against STATIC bodies only (a dynamic one frozen at its end pose dragged formation flyers);
    // (2) never defer to the solver for a fast body: one speculative edge point can't stop a box at 20 m/s (it pivots on
    // the point and passes through), and collide() could even return nothing at 1.4 cm; skip only real overlap; (3) a sphere's target lets it sink one slop, so sliding over flush seams never "hits";
    // a hit at t = 0 is ignored (Box3D's 0 < fraction); (4) rotation is swept too: q interpolated, and the advancement
    // bound counts the arc a corner can travel; (5) the time lost to the clamp gives back its gravity (timeLoss·g).
    for (const b of bodies) {
      if (!b.ccd || !live(b)) continue;
      const D = sub(b.p, b.p0), travel = len(D), qEnd = b.q, q0 = qconj(b.q0c);
      let dq = qmul(qEnd, b.q0c); if (dq[3] < 0) dq = dq.map((x) => -x);
      const rad = b.shape === "sphere" ? 0 : len(b.half), arc = 2 * rad * Math.sqrt(dq[0] * dq[0] + dq[1] * dq[1] + dq[2] * dq[2]) * 1.5707963267948966;
      const bound = travel + arc; if (bound < LINEAR_SLOP) continue;
      const qs = dot4(q0, qEnd) < 0 ? q0.map((x) => -x) : q0;
      const pose = (t) => { b.p = add(b.p0, scl(D, t)); b.q = qnorm([qs[0] + (qEnd[0] - qs[0]) * t, qs[1] + (qEnd[1] - qs[1]) * t, qs[2] + (qEnd[2] - qs[2]) * t, qs[3] + (qEnd[3] - qs[3]) * t]); };
      const target = b.shape === "sphere" ? -LINEAR_SLOP : LINEAR_SLOP, end = b.p, r = rad || b.radius;
      const lo = [Math.min(b.p0[0], end[0]) - r, Math.min(b.p0[1], end[1]) - r, Math.min(b.p0[2], end[2]) - r], hi = [Math.max(b.p0[0], end[0]) + r, Math.max(b.p0[1], end[1]) + r, Math.max(b.p0[2], end[2]) + r];
      let tMin = 1;
      for (const o of bodies) {
        if (o === b || (!o.static && live(o))) continue;   // statics and SLEEPING bodies (they don't move this step): a fast body must not pass through a resting one
        const ob = aabb(o); if (ob[0] > hi[0] || ob[3] < lo[0] || ob[1] > hi[1] || ob[4] < lo[1] || ob[2] > hi[2] || ob[5] < lo[2]) continue;
        pose(0); if (distLB(b, o) <= 0) continue;   // already overlapping: not a tunnel
        let t = 0, hit = false;
        for (let k = 0; k < 64 && t < tMin; k++) {
          pose(t); const d = distLB(b, o);
          if (d < target + 0.25 * LINEAR_SLOP) { hit = t > 0; break; }
          t += (d - target) / bound;
        }
        if (hit && t < tMin) tMin = t;
      }
      if (tMin < 1) { pose(tMin); const lost = (1 - tMin) * dt; b.v = [b.v[0] - gravity[0] * lost, b.v[1] - gravity[1] * lost, b.v[2] - gravity[2] * lost]; }
      else { b.p = end; b.q = qEnd; }
    }
    // contacts between bodies that are asleep (or static) keep their impulses while asleep, for warm starting on wake
    const byUid = new Map(bodies.map((b) => [b.uid, b])); if (GROUND) byUid.set(GROUND.uid, GROUND);
    const resting = (key) => { const [i, j] = key.split(":").map(Number), A = byUid.get(i), B = byUid.get(j); return !!A && !!B && !live(A) && !live(B); };
    const seen = new Set(manifolds.map((m) => m.key)), keep = (M) => { const o = new Map(); for (const [k, v] of M) if (!seen.has(k.split(":").slice(0, 2).join(":")) && resting(k)) o.set(k, v); return o; };
    const oldI = keep(prevImpulses), oldP = keep(prevByPair), oldM = keep(prevManifold);
    prevImpulses = oldI; prevManifold = oldM; prevByPair = oldP;
    for (const m of manifolds) {
      for (const p of m.points) prevImpulses.set(p.key, { ln: p.ln });
      prevByPair.set(m.key, m.points.map((p) => ({ local: p.local, ln: p.ln })));
      prevManifold.set(m.key, { f: add(scl(m.t1, m.f1), scl(m.t2, m.f2)), twist: m.twist, ...(m.rr > 0 ? { roll: m.roll } : {}) });
    }
    // sleep bookkeeping
    for (const b of bodies) if (live(b)) {
      const lin = dot(b.v, b.v), ang = dot(b.w, b.w) * b.ext * b.ext, tol = SLEEP_LINEAR * SLEEP_LINEAR;
      b.sleepTime = b.noSleep || lin > tol || ang > tol ? 0 : b.sleepTime + dt;
    }
    const isl = new Map();
    for (const b of bodies) if (!b.static) { const r = find(b.index), t = b.noSleep ? 0 : b.sleepTime; isl.set(r, Math.min(isl.get(r) ?? Infinity, b.awake ? t : Infinity)); }
    for (const b of bodies) if (live(b) && isl.get(find(b.index)) >= SLEEP_TIME) { b.awake = false; b.v = [0, 0, 0]; b.w = [0, 0, 0]; b.sleepTag = `${stepNo}:${find(b.index)}`; }
  }
  return W;
}
// physics.frictionCombine as pinned (componentspec.js): average|min|multiply|max, the higher in that order wins; absent = average
const COMBINE_RANK = { average: 0, min: 1, multiply: 2, max: 3 };
function combineFriction(A, B) {
  const ra = COMBINE_RANK[A.combine] ?? 0, rb = COMBINE_RANK[B.combine] ?? 0, mode = ra >= rb ? A.combine : B.combine, a = A.friction, b = B.friction;
  return mode === "min" ? Math.min(a, b) : mode === "multiply" ? a * b : mode === "max" ? Math.max(a, b) : (a + b) * 0.5;
}
const I3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];
const dot4 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
const add9 = (a, b) => a.map((x, k) => x + b[k]);
const add4 = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2], a[3] + b[3]];
const scl4 = (a, s) => [a[0] * s, a[1] * s, a[2] * s, a[3] * s];
