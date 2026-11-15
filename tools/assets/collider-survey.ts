// collider-survey — how badly does one bounding box lie, across a real library?
//   bun tools/assets/collider-survey.ts <dir-or-glb> [<dir-or-glb> ...]
// colliders.js decide() gives most things one box whose top face is the only ground it can report. Before changing that
// rule, this measures "is the top of the bounding box where a body would stand?" across every mesh available, so a
// threshold is picked from where real objects fall. Two metrics per mesh:
//   lie_ray   the honest one: a grid of downward rays, median surface height vs bbox.max.y (needs a BVH: fine offline,
//             not at fitCollider time, where the BVH is the thing being decided)
//   lie_cheap the shippable one: vertices bucketed into the same grid, max y per cell, median; one pass, no BVH
// If lie_cheap tracks lie_ray across the library, decide() can afford the test at fit time.

import { readdirSync, statSync } from 'node:fs';
import { join, basename, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const { THREE }: any = await import('../../test/stubs/core-stub.mjs');
const { MeshBVH }: any = await import('../../client/node_modules/three-mesh-bvh/src/index.js');

const GRID = 24;          // columns per axis
const MIN_HITS = 24;      // below this the sample says nothing

// ---- loading ----------------------------------------------------------------

let ioP: Promise<any> | null = null;
async function getIO() {
  ioP ??= (async () => {
    const { NodeIO } = await import('@gltf-transform/core');
    const { ALL_EXTENSIONS } = await import('@gltf-transform/extensions');
    const draco3d = (await import('draco3dgltf')).default;
    return new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
      'draco3d.decoder': await draco3d.createDecoderModule(),
      'draco3d.encoder': await draco3d.createEncoderModule(),
    });
  })();
  return ioP;
}

/** World-space triangle soup for the scene-reachable meshes; unlike colliders.js
 *  buildExact, it keeps parts marked extras.collision === false. */
async function loadTris(path: string): Promise<Float32Array | null> {
  const io = await getIO();
  let doc: any;
  try { doc = await io.read(path); } catch { return null; }
  const inScene = new Set<any>();
  for (const s of doc.getRoot().listScenes()) s.traverse((n: any) => inScene.add(n));
  const out: number[] = [];
  for (const node of doc.getRoot().listNodes()) {
    if (!inScene.has(node)) continue;
    const mesh = node.getMesh();
    if (!mesh) continue;
    const m = node.getWorldMatrix();
    for (const prim of mesh.listPrimitives()) {
      const pos = prim.getAttribute('POSITION');
      if (!pos) continue;
      const idx = prim.getIndices();
      const count = idx ? idx.getCount() : pos.getCount();
      const p = [0, 0, 0];
      for (let t = 0; t < count; t++) {
        pos.getElement(idx ? idx.getScalar(t) : t, p);
        out.push(
          m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
          m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
          m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14],
        );
      }
    }
  }
  return out.length ? new Float32Array(out) : null;
}

const median = (xs: number[]) => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const h = s.length >> 1;
  return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2;
};

// ---- the two metrics --------------------------------------------------------

function measure(v: Float32Array) {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < v.length; i += 3) {
    for (let a = 0; a < 3; a++) {
      if (v[i + a] < min[a]) min[a] = v[i + a];
      if (v[i + a] > max[a]) max[a] = v[i + a];
    }
  }
  const w = max[0] - min[0], d = max[2] - min[2], h = max[1] - min[1];
  const tris = v.length / 9;

  // cheap: max y per (x,z) cell, from vertices alone
  const cell = new Float64Array(GRID * GRID).fill(-Infinity);
  for (let i = 0; i < v.length; i += 3) {
    const cx = Math.min(GRID - 1, Math.max(0, Math.floor(((v[i] - min[0]) / (w || 1)) * GRID)));
    const cz = Math.min(GRID - 1, Math.max(0, Math.floor(((v[i + 2] - min[2]) / (d || 1)) * GRID)));
    const k = cz * GRID + cx;
    if (v[i + 1] > cell[k]) cell[k] = v[i + 1];
  }
  const cheapTops = [...cell].filter((y) => Number.isFinite(y));
  const lieCheap = max[1] - median(cheapTops);

  // honest: the real top surface per column, by raycast
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(v, 3));
  const bvh = new MeshBVH(g);
  const ray = new THREE.Ray();
  ray.direction.set(0, -1, 0);
  const rayTops: number[] = [];
  for (let i = 0; i < GRID; i++) {
    for (let j = 0; j < GRID; j++) {
      ray.origin.set(
        min[0] + (w * (i + 0.5)) / GRID,
        max[1] + Math.max(0.1, h * 0.05),
        min[2] + (d * (j + 0.5)) / GRID,
      );
      const hit = bvh.raycastFirst(ray, THREE.DoubleSide);
      if (hit) rayTops.push(hit.point.y);
    }
  }
  const lieRay = rayTops.length >= MIN_HITS ? max[1] - median(rayTops) : NaN;

  // decide()'s size gates only: its floor-shaped lie exception (also exact) isn't modelled here
  const foot = w * d;
  const kind = foot >= 16 && h >= 2.2 ? 'exact' : h > 2.4 ? 'pillar' : 'box';

  return { tris, w, d, h, foot, kind, lieRay, lieCheap, hits: rayTops.length };
}

// ---- run --------------------------------------------------------------------

const args = process.argv.slice(2);
if (!args.length) {
  console.error('usage: bun tools/assets/collider-survey.ts <dir-or-glb> [...]');
  process.exit(1);
}
const files: string[] = [];
for (const a of args) {
  // plain paths, relative or absolute — no URL round trip. A Windows path
  // starts "C:", which new URL() reads as a scheme.
  const st = statSync(a, { throwIfNoEntry: false });
  if (!st) { console.error(`  skip (not found): ${a}`); continue; }
  if (st.isDirectory()) {
    for (const f of readdirSync(a)) if (extname(f).toLowerCase() === '.glb') files.push(join(a, f));
  } else files.push(a);
}

console.log(`\ncollider-survey — ${files.length} meshes, ${GRID}x${GRID} columns\n`);
console.log('  lie = bbox.max.y - median(top surface). How far above the ground a');
console.log('  body actually stands on, the single box top sits.\n');
console.log('  ' + 'mesh'.padEnd(42) + 'kind   foot    h     lie_ray  lie_cheap  Δ');

type Row = { name: string; kind: string; foot: number; h: number; lieRay: number; lieCheap: number; tris: number };
const rows: Row[] = [];
for (const f of files) {
  const v = await loadTris(f);
  if (!v) { console.log(`  ${basename(f).slice(0, 40).padEnd(42)}(unreadable)`); continue; }
  const m = measure(v);
  if (!Number.isFinite(m.lieRay)) continue;
  rows.push({ name: basename(f, '.glb'), kind: m.kind, foot: m.foot, h: m.h, lieRay: m.lieRay, lieCheap: m.lieCheap, tris: m.tris });
}

rows.sort((a, b) => b.lieRay / (b.h || 1) - a.lieRay / (a.h || 1));
for (const r of rows) {
  const d = r.lieCheap - r.lieRay;
  console.log(`  ${r.name.slice(0, 40).padEnd(42)}${r.kind.padEnd(7)}${r.foot.toFixed(1).padStart(6)}${r.h.toFixed(2).padStart(7)}` +
    `${r.lieRay.toFixed(3).padStart(9)}${r.lieCheap.toFixed(3).padStart(11)}${(d >= 0 ? '+' : '') + d.toFixed(3)}`);
}

// ---- does the cheap proxy track the honest one? -----------------------------
const n = rows.length;
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const mr = mean(rows.map((r) => r.lieRay)), mc = mean(rows.map((r) => r.lieCheap));
let num = 0, dr = 0, dc = 0;
for (const r of rows) {
  num += (r.lieRay - mr) * (r.lieCheap - mc);
  dr += (r.lieRay - mr) ** 2; dc += (r.lieCheap - mc) ** 2;
}
const corr = num / Math.sqrt(dr * dc);
const absErr = rows.map((r) => Math.abs(r.lieCheap - r.lieRay));
console.log(`\n  cheap-vs-ray over ${n} meshes: r=${corr.toFixed(4)}  ` +
  `mean|Δ|=${mean(absErr).toFixed(3)}m  max|Δ|=${Math.max(...absErr).toFixed(3)}m`);

// ---- distribution, for choosing a threshold ---------------------------------
console.log('\n  lie_ray distribution among things that collide as ONE BOX today:');
const boxes = rows.filter((r) => r.kind === 'box').map((r) => r.lieRay).sort((a, b) => a - b);
const q = (p: number) => boxes[Math.min(boxes.length - 1, Math.floor(p * boxes.length))];
console.log(`   n=${boxes.length}  min ${q(0).toFixed(3)}  p25 ${q(0.25).toFixed(3)}  ` +
  `median ${q(0.5).toFixed(3)}  p75 ${q(0.75).toFixed(3)}  p90 ${q(0.9).toFixed(3)}  max ${boxes[boxes.length - 1].toFixed(3)}`);
for (const t of [0.05, 0.10, 0.15, 0.20, 0.30]) {
  const hit = rows.filter((r) => r.kind === 'box' && r.lieRay > t);
  console.log(`   threshold ${t.toFixed(2)}m → ${hit.length}/${boxes.length} boxes become exact`);
}

// ---- the candidate rule -----------------------------------------------------
// A bare lie threshold flags cars, sharks and rubble with the blanket (a rounded thing also sits below its box top).
// A blanket is floor-shaped AND lies: wide enough to stand on, low enough that standing is all you'd do. Shape first.
const FOOT_MIN = 2.0;    // m² — smaller than this and nobody stands on it
const H_MAX = 0.8;       // m  — taller than this it is furniture, not ground
const LIE_MIN = 0.10;    // m  — below this the box top is honest enough

const flat = rows.filter((r) => r.foot >= FOOT_MIN && r.h <= H_MAX);
const flags = flat.filter((r) => r.lieRay > LIE_MIN && r.kind === 'box');
console.log(`\n  candidate rule: footprint >= ${FOOT_MIN}m² AND height <= ${H_MAX}m AND lie > ${LIE_MIN}m`);
console.log(`   ${flat.length} meshes are floor-shaped; ${flags.length} of them are reclassified box -> exact:`);
for (const r of flat) {
  const hit = r.lieRay > LIE_MIN && r.kind === 'box';
  console.log(`     ${hit ? '\x1b[33m->exact\x1b[0m' : '   keep '} ${r.name.slice(0, 38).padEnd(40)}` +
    `foot ${r.foot.toFixed(1).padStart(5)}  h ${r.h.toFixed(2)}  lie ${r.lieRay.toFixed(3)}  (cheap ${r.lieCheap.toFixed(3)})`);
}

// does the cheap proxy hold up within the population the rule applies to? (tall meshes dominate the library-wide error)
if (flat.length) {
  const e = flat.map((r) => Math.abs(r.lieCheap - r.lieRay));
  const worst = flat.reduce((a, b) => (Math.abs(a.lieCheap - a.lieRay) > Math.abs(b.lieCheap - b.lieRay) ? a : b));
  console.log(`\n   cheap-vs-ray among floor-shaped meshes only: mean|Δ|=${mean(e).toFixed(3)}m  ` +
    `max|Δ|=${Math.max(...e).toFixed(3)}m (${worst.name.slice(0, 30)})`);
  const disagree = flat.filter((r) =>
    (r.lieRay > LIE_MIN) !== (r.lieCheap > LIE_MIN));
  console.log(`   meshes where cheap and ray disagree about the ${LIE_MIN}m line: ${disagree.length}` +
    (disagree.length ? ` — ${disagree.map((r) => r.name.slice(0, 24)).join(', ')}` : ''));
}

// ---- sensitivity ------------------------------------------------------------
// H_MAX decides whether "floor-shaped" stops at rugs or reaches sofas and wrecks: show what each setting reclassifies
console.log('\n  sensitivity — what each height gate would reclassify (foot >= 2m², lie > 0.10m):');
for (const hmax of [0.6, 0.8, 1.0, 1.2, 1.5, 2.2]) {
  const hit = rows.filter((r) => r.kind === 'box' && r.foot >= FOOT_MIN && r.h <= hmax && r.lieRay > LIE_MIN);
  const names = hit.map((r) => r.name.slice(0, 22)).slice(0, 6).join(', ');
  console.log(`   h <= ${hmax.toFixed(1)}m → ${String(hit.length).padStart(2)} reclassified` +
    (hit.length ? `: ${names}${hit.length > 6 ? ` +${hit.length - 6} more` : ''}` : ''));
}
