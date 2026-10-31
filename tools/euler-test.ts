// euler-test — the channel box's Rotate math (shared/euler.js), a property
// sweep across all six rotation orders, cross-checked against three.js.
//
//   BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun tools/euler-test.ts
//
// What a rigger's hands will check, stated as properties:
//   1. ORDER NAMES ARE MAYA'S: "XYZ" applies X first (R = Rz·Ry·Rx), which is
//      three.js's Euler order "ZYX" — and that composition equals the explicit
//      axis-angle product, independent of either library's Euler code.
//   2. eulerFromQ ∘ qFromEuler is the identity on the rotation (any order, any q).
//   3. EDIT ONE CHANNEL: decompose, change that angle, recompose — the other two
//      read back unchanged (within float tolerance) away from gimbal lock, the
//      edited one reads back as typed, and the object turns by exactly that.
//   4. NEAR GIMBAL LOCK (defined in euler.js): the inner channel keeps the hint
//      (0 with none), the outer takes the rest; the triple still composes to q,
//      and with the hint passed back the reading is exactly what was typed.
//   5. CHANGING THE ORDER NEVER CHANGES q: the same q, read in every order,
//      recomposes to itself.
import * as THREE from '../client/node_modules/three/build/three.module.js';
import { qFromEuler, eulerFromQ, setEulerChannel, sameRotation, ROT_ORDERS, LOCK_EPS } from '../shared/euler.js';

let pass = 0, fail = 0;
const fails: string[] = [];
const ok = (name: string, cond: boolean, detail = '') => { if (cond) pass++; else { fail++; if (fails.length < 25) fails.push(`${name} ${detail}`); } };
const D = Math.PI / 180;
const rnd = (() => { let s = 987654321; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); })();
const ang = () => (rnd() * 2 - 1) * Math.PI;
const rev = (o: string) => [...o].reverse().join('');
const wrapD = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));       // angular difference → (−π, π]
const close = (a: number, b: number, eps: number) => Math.abs(wrapD(a - b)) <= eps;
const randQ = () => { const q = [rnd() - 0.5, rnd() - 0.5, rnd() - 0.5, rnd() - 0.5]; const n = Math.hypot(...q); return q.map((v) => v / n); };
// three's quaternion product, used to build the reference rotation from axis-angles
const axisAngle = (ax: number, a: number) => new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(...[0, 1, 2].map((i) => (i === ax ? 1 : 0))), a);
const AX: Record<string, number> = { X: 0, Y: 1, Z: 2 };

for (const order of ROT_ORDERS) {
  const [ia, ib, ic] = [...order].map((c) => AX[c]);
  for (let n = 0; n < 300; n++) {
    // ---- 1. the order convention, two independent ways
    const e = [ang(), ang() / 2, ang()];   // middle within ±90° keeps the canonical branch for the identity check below
    const q = qFromEuler(e, order);
    const ref = axisAngle(ic, e[ic]).multiply(axisAngle(ib, e[ib])).multiply(axisAngle(ia, e[ia]));   // C·B·A: A applied first
    ok(`${order} #${n}: qFromEuler = axis-angle product C·B·A`, sameRotation(q, [ref.x, ref.y, ref.z, ref.w], 1e-12));
    const te = new THREE.Euler(e[0], e[1], e[2], rev(order) as THREE.EulerOrder);
    const tq = new THREE.Quaternion().setFromEuler(te);
    ok(`${order} #${n}: = three Euler order ${rev(order)}`, sameRotation(q, [tq.x, tq.y, tq.z, tq.w], 1e-12));

    // ---- 2. decomposition, against three's own decomposition and back
    const rq = randQ();
    const { e: got } = eulerFromQ(rq, order);
    ok(`${order} #${n}: eulerFromQ recomposes to q`, sameRotation(qFromEuler(got, order), rq, 1e-12));
    const t3 = new THREE.Euler().setFromQuaternion(new THREE.Quaternion(...rq), rev(order) as THREE.EulerOrder);
    ok(`${order} #${n}: canonical reading = three's (middle in ±90°)`, close(got[0], t3.x, 1e-9) && close(got[1], t3.y, 1e-9) && close(got[2], t3.z, 1e-9),
      `${got.map((v) => (v / D).toFixed(4))} vs ${[t3.x, t3.y, t3.z].map((v) => (v / D).toFixed(4))}`);
    ok(`${order} #${n}: middle angle reads within ±90° with no hint`, Math.abs(got[ib]) <= Math.PI / 2 + 1e-12);

    // ---- 3. edit one channel: the other two read back unchanged
    const start = eulerFromQ(rq, order).e;
    if (Math.cos(start[ib]) > 1e-3) {
      for (const ax of [0, 1, 2]) {
        const typed = ang() * (ax === ib ? 0.49 : 1);   // keep the middle away from the lock for this property
        const { q: q2, e: composed } = setEulerChannel(rq, order, null, ax, typed);
        const back = eulerFromQ(q2, order, null).e;     // a FRESH viewer, no hint
        const others = [0, 1, 2].filter((x) => x !== ax);
        ok(`${order} #${n}: edit ${'XYZ'[ax]} → the other two unchanged (fresh viewer)`, others.every((x) => close(back[x], start[x], 1e-9)),
          `${start.map((v) => (v / D).toFixed(5))} → ${back.map((v) => (v / D).toFixed(5))}`);
        ok(`${order} #${n}: edit ${'XYZ'[ax]} → reads back as typed`, close(back[ax], typed, 1e-9), `${(typed / D).toFixed(5)} vs ${(back[ax] / D).toFixed(5)}`);
        ok(`${order} #${n}: edit ${'XYZ'[ax]} → composed triple = q`, sameRotation(qFromEuler(composed, order), q2, 1e-12));
        // the object turned by exactly the typed change about that channel's axis
        // in its slot of the order: q2 = C·B'·A when B changed, etc.
        const parts = [ia, ib, ic].map((a) => axisAngle(a, (a === ax ? typed : start[a])));
        const want = parts[2].clone().multiply(parts[1]).multiply(parts[0]);
        ok(`${order} #${n}: edit ${'XYZ'[ax]} → the object is exactly C·B·A with the new angle`, sameRotation(q2, [want.x, want.y, want.z, want.w], 1e-12));
      }
    }
    // a middle angle typed beyond ±90° reads back as typed for the viewer who typed it (the hint)
    const big = (100 + rnd() * 70) * D * (rnd() < 0.5 ? -1 : 1);
    const { q: q3, e: e3 } = setEulerChannel(rq, order, start, ib, big);
    const back3 = eulerFromQ(q3, order, e3).e;
    ok(`${order} #${n}: middle typed at ${(big / D).toFixed(1)}° reads back as typed with the hint`, [0, 1, 2].every((x) => close(back3[x], e3[x], 1e-9)) && Math.abs(back3[ib] - big) < 1e-9,
      `${e3.map((v) => (v / D).toFixed(4))} vs ${back3.map((v) => (v / D).toFixed(4))}`);

    // ---- 5. order never changes q: reading in any other order recomposes to the same q
    for (const other of ROT_ORDERS) ok(`${order} #${n}: read in ${other}, recomposed in ${other} = same q`, sameRotation(qFromEuler(eulerFromQ(rq, other).e, other), rq, 1e-12));
  }

  // ---- 4. gimbal lock, exactly and nearly
  for (const sign of [1, -1]) for (const off of [0, 1e-9, 1e-7]) {
    const e = [0, 0, 0]; e[ia] = 25 * D; e[ib] = sign * (Math.PI / 2 - off); e[ic] = -40 * D;
    const q = qFromEuler(e, order);
    const fresh = eulerFromQ(q, order);
    ok(`${order} lock ${sign > 0 ? '+' : '-'}90°−${off}: reported locked`, fresh.locked === (Math.cos(e[ib]) < LOCK_EPS));
    ok(`${order} lock ${sign > 0 ? '+' : '-'}90°−${off}: the fresh reading still composes to q`, sameRotation(qFromEuler(fresh.e, order), q, 1e-12));
    if (fresh.locked) {
      ok(`${order} lock ${sign > 0 ? '+' : '-'}90°: with no hint the inner channel reads 0`, fresh.e[ia] === 0, `${fresh.e[ia]}`);
      ok(`${order} lock ${sign > 0 ? '+' : '-'}90°−${off}: the middle reads as composed (±90°)`, close(fresh.e[ib], e[ib], 1e-8));
      const hinted = eulerFromQ(q, order, e).e;
      ok(`${order} lock: with the viewer's hint, the reading is the triple they typed`, [0, 1, 2].every((x) => close(hinted[x], e[x], 1e-7)), `${hinted.map((v) => (v / D).toFixed(4))}`);
      // an edit to the inner channel at the lock: the thing turns by exactly that, and the
      // fresh viewer sees the turn on the OUTER channel (inner reads 0 again)
      const { q: q2, e: e2 } = setEulerChannel(q, order, e, ia, 55 * D);
      ok(`${order} lock: an inner edit composes exactly`, sameRotation(q2, qFromEuler(e2, order), 1e-12) && close(e2[ia], 55 * D, 0));
      const f2 = eulerFromQ(q2, order).e;
      ok(`${order} lock: …a fresh viewer reads it on the outer channel`, f2[ia] === 0 && sameRotation(qFromEuler(f2, order), q2, 1e-12));
      const h2 = eulerFromQ(q2, order, e2).e;
      ok(`${order} lock: …and the editor (hint) reads exactly what it typed`, [0, 1, 2].every((x) => close(h2[x], e2[x], 1e-7)));
    } else {
      const hinted = eulerFromQ(q, order, e).e;
      ok(`${order} near lock (cos ${Math.cos(e[ib]).toExponential(1)}): hinted reading ≈ typed (degrades as 1/cos)`, [0, 1, 2].every((x) => close(hinted[x], e[x], 1e-5)), `${hinted.map((v) => (v / D).toFixed(6))}`);
    }
  }
}
// a yaw is Rotate Y in every order (the yaw-only reading the inspector uses)
for (const order of ROT_ORDERS) for (const yaw of [0.3, 2.5, -2.9]) {
  const q = [0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2)];
  const r = eulerFromQ(q, order, [0, yaw, 0]).e;
  ok(`${order}: a pure yaw of ${yaw} reads (0, yaw, 0) with the upright hint`, close(r[0], 0, 1e-12) && close(r[1], yaw, 1e-12) && close(r[2], 0, 1e-12), `${r}`);
}

for (const f of fails) console.log('  ✗', f);
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
