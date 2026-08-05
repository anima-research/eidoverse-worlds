// What SHAPE does a settled body actually take? — the anatomy audit.
//
//   bun tools/rag-pose-audit.mjs            # the fleet, at settle
//   bun tools/rag-pose-audit.mjs --peak     # worst reached at ANY point
//
// rag-tune.mjs answers "is the solver stable"; this answers "is the pose a
// body could hold". They are different questions and the second one is not
// visible in any of the stability numbers: a tumble can settle fast, keep its
// bone lengths and never interpenetrate, and still come to rest with its leg
// behind its own back.
//
// Every angle is reported in ANATOMICAL terms — flexion vs extension, not the
// unsigned cone angle the solver stores — because that is the axis on which a
// pose reads as wrong. Reference ranges in the header of each block are the
// usual clinical figures for a relaxed (not stretched, not athletic) body.

import { plugin } from 'bun';
import { fileURLToPath } from 'node:url';
const STUB = fileURLToPath(new URL('./core-stub.mjs', import.meta.url));
plugin({ name: 'core-stub', setup(b) { b.onResolve({ filter: /^\.\/core\.js$/ }, () => ({ path: STUB })); } });
const { THREE } = await import('./core-stub.mjs');
const { Ragdoll } = await import('../client/lib/ragdoll.js');
const { rigs, makeAvatar, toppleLean } = await import('./rig-load.mjs');

const DEG = 180 / Math.PI;
const PEAK = process.argv.includes('--peak');
const FLEET = rigs().filter((r) => !r.err);

/** Decompose a limb direction into the body's own axes. */
function anat(rd, from, to) {
  const { r, u, f } = rd.frame;
  const d = rd.p[to].clone().sub(rd.p[from]).normalize();
  return {
    down: -d.dot(u),                 // 1 = straight down the body
    fwd: d.dot(f),                   // + = in front of the body
    side: d.dot(r),                  // + = toward the body's left
  };
}
// How far IN FRONT of the body's frontal plane the limb points: + forward,
// − behind, and it never wraps. atan2(fwd, down) does wrap — it reads an arm
// held straight overhead as 180° "behind the body", which is not a pose
// problem at all, and sent me looking for a shoulder bug that did not exist.
const sagittal = (a) => Math.asin(THREE.MathUtils.clamp(a.fwd, -1, 1)) * DEG;
const lateral = (a) => Math.asin(THREE.MathUtils.clamp(a.side, -1, 1)) * DEG;

function measure(rd) {
  const out = {};
  // hips + shoulders: where the limb points relative to the trunk
  for (const [key, from, to] of [
    ['hip.L', 'leftUpperLeg', 'leftLowerLeg'], ['hip.R', 'rightUpperLeg', 'rightLowerLeg'],
    ['sho.L', 'leftUpperArm', 'leftLowerArm'], ['sho.R', 'rightUpperArm', 'rightLowerArm'],
  ]) {
    if (!rd.p[from] || !rd.p[to]) continue;
    const a = anat(rd, from, to);
    // mirror the right side, or "+45° abducted" on the left and the identical
    // pose on the right report as opposite numbers and the range looks twice
    // as wide as it is
    if (key.endsWith('.R')) a.side = -a.side;
    out[key] = { sag: sagittal(a), lat: lateral(a) };
  }
  // knees + elbows: how far folded, and how far out of the hinge plane
  for (const H of rd.hinge) {
    const u = rd.p[H.b].clone().sub(rd.p[H.a]).normalize();
    const v = rd.p[H.c].clone().sub(rd.p[H.b]).normalize();
    const n = H.n.clone().addScaledVector(u, -H.n.dot(u)).normalize();
    const key = (H.b.includes('LowerLeg') ? 'knee.' : 'elb.') + (H.b[0] === 'l' ? 'L' : 'R');
    out[key] = {
      flex: Math.acos(THREE.MathUtils.clamp(u.dot(v), -1, 1)) * DEG,
      lat: Math.asin(THREE.MathUtils.clamp(v.dot(n), -1, 1)) * DEG,
    };
  }
  // spine + neck: forward flexion is positive, BACKBEND is negative
  for (const [key, a, b, c] of [
    ['spine', 'hips', 'spine', 'chest'], ['chest', 'spine', 'chest', 'neck'],
    ['neck', 'chest', 'neck', 'head'],
  ]) {
    if (!rd.p[a] || !rd.p[b] || !rd.p[c]) continue;
    const u = rd.p[b].clone().sub(rd.p[a]).normalize();
    const v = rd.p[c].clone().sub(rd.p[b]).normalize();
    const ang = Math.acos(THREE.MathUtils.clamp(u.dot(v), -1, 1)) * DEG;
    // which way it bent: + if the distal link leans toward the body's front
    const sign = v.clone().addScaledVector(u, -v.dot(u)).dot(rd.frame.f) >= 0 ? 1 : -1;
    out[key] = { bend: ang * sign };
  }
  return out;
}

// ---- run the fleet, keeping either the settled pose or the worst reached
const acc = new Map();
const note = (key, field, v, rig) => {
  const k = `${key}.${field}`;
  const e = acc.get(k) ?? { lo: Infinity, hi: -Infinity, loRig: '', hiRig: '', n: 0, sum: 0 };
  if (v < e.lo) { e.lo = v; e.loRig = rig; }
  if (v > e.hi) { e.hi = v; e.hiRig = rig; }
  e.n++; e.sum += v;
  acc.set(k, e);
};

for (const rig of FLEET) {
  const av = makeAvatar(rig.P);
  const rd = new Ragdoll(av, toppleLean(), av.restBonePositions());
  let steps = 0;
  const take = () => {
    const m = measure(rd);
    for (const [key, v] of Object.entries(m)) {
      for (const [field, val] of Object.entries(v)) note(key, field, val, rig.name);
    }
  };
  while (!rd.done && steps < 900) { rd.step(1 / 60); steps++; if (PEAK && steps > 30) take(); }
  if (!PEAK) take();
}

// ---- report, grouped, against the ranges a relaxed body actually has
const num = (x) => (x >= 0 ? '+' : '') + x.toFixed(0);
function block(title, rows) {
  console.log(`\n${title}`);
  console.log('  ' + 'joint'.padEnd(12) + 'range seen'.padEnd(20) + 'mean'.padEnd(8) + 'reference (relaxed body)');
  for (const [key, ref, note_] of rows) {
    const e = acc.get(key);
    if (!e) continue;
    const span = `${num(e.lo)}° … ${num(e.hi)}°`;
    const flag = note_(e) ? ' \x1b[31m←\x1b[0m ' + note_(e) : '';
    console.log('  ' + key.padEnd(12) + span.padEnd(20) + num(e.sum / e.n).padEnd(8) + ref + flag);
  }
}

console.log(`${FLEET.length} rigs, ${PEAK ? 'WORST REACHED during the tumble' : 'at settle'}`);

block('sagittal — limb in front of / behind the trunk', [
  ['hip.L.sag', 'forward +90, behind -20', (e) => (e.lo < -30 ? `${num(e.lo)}° behind the body (${e.loRig})` : '')],
  ['hip.R.sag', 'forward +90, behind -20', (e) => (e.lo < -30 ? `${num(e.lo)}° behind the body (${e.loRig})` : '')],
  ['sho.L.sag', 'forward +90, behind -60', (e) => (e.lo < -65 ? `${num(e.lo)}° behind the body (${e.loRig})` : '')],
  ['sho.R.sag', 'forward +90, behind -60', (e) => (e.lo < -65 ? `${num(e.lo)}° behind the body (${e.loRig})` : '')],
]);

block('lateral — limb out to the side (abduction)', [
  ['hip.L.lat', 'abduct +45, adduct -25', (e) => (e.hi > 55 || e.lo < -35 ? 'splayed past the hip joint' : '')],
  ['hip.R.lat', 'abduct +45, adduct -25', (e) => (e.hi > 55 || e.lo < -35 ? 'splayed past the hip joint' : '')],
  ['sho.L.lat', 'wide — the shoulder is', () => ''],
  ['sho.R.lat', 'wide — the shoulder is', () => ''],
]);

block('hinges — fold, and sideways bend that a hinge should not have', [
  ['knee.L.flex', '0 … 150', (e) => (e.lo < -5 ? 'HYPEREXTENDS' : '')],
  ['knee.R.flex', '0 … 150', (e) => (e.lo < -5 ? 'HYPEREXTENDS' : '')],
  ['elb.L.flex', '0 … 145', (e) => (e.lo < -5 ? 'HYPEREXTENDS' : '')],
  ['elb.R.flex', '0 … 145', (e) => (e.lo < -5 ? 'HYPEREXTENDS' : '')],
  ['knee.L.lat', '±5 at most', (e) => (Math.max(-e.lo, e.hi) > 12 ? `${num(Math.max(-e.lo, e.hi))}° of sideways knee` : '')],
  ['knee.R.lat', '±5 at most', (e) => (Math.max(-e.lo, e.hi) > 12 ? `${num(Math.max(-e.lo, e.hi))}° of sideways knee` : '')],
  ['elb.L.lat', '±10 at most', (e) => (Math.max(-e.lo, e.hi) > 18 ? `${num(Math.max(-e.lo, e.hi))}° of sideways elbow` : '')],
  ['elb.R.lat', '±10 at most', (e) => (Math.max(-e.lo, e.hi) > 18 ? `${num(Math.max(-e.lo, e.hi))}° of sideways elbow` : '')],
]);

block('trunk — + is curling forward, − is arching BACK', [
  ['spine.bend', 'flex +30, extend -15', (e) => (e.lo < -18 ? `${num(e.lo)}° of backbend (${e.loRig})` : '')],
  ['chest.bend', 'flex +25, extend -15', (e) => (e.lo < -18 ? `${num(e.lo)}° of backbend (${e.loRig})` : '')],
  ['neck.bend', 'flex +45, extend -45', (e) => (e.lo < -50 ? `${num(e.lo)}° of backbend (${e.loRig})` : '')],
]);
console.log();
