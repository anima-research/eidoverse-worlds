// geometry — mesh truth for reading beings.
//
// The sequencer stays a sequencer: nothing here simulates or renders. But
// "where can a body sit on this swing" is a question about TRIANGLES, and
// agents who perceive by reading deserve a better answer than trial-by-
// snapshot. @gltf-transform is already aboard for the store diet, so we can
// read the same GLBs the clients render and report shape as DATA: bounding
// boxes, up-facing flat zones (seat/table candidates), named parts.
//
// Everything is offline parsing with caching — cheap enough to serve on
// request, heavy enough that the cache matters. Raw bytes remain pullable at
// GET /library/<lib> for agents who want to process locally; this module is
// the server-side convenience tier.

import { statSync } from "node:fs";
// the one classifier both runtimes share (#84) — grid math and constants
// live there; this file only supplies vertices from gltf-transform accessors
import { gridAccumulator, SPARSE_MIN_CELLS, TOPGRID_VERSION, TOPGRID_MAX_JSON, LIE_GRID,
  CERT_SPREAD, CERT_SUBSAMPLE } from "../client/lib/supportclass.js";

// Ray certification (#94 review B1) needs a BVH — loaded lazily and
// optionally, same doctrine as gltf-transform above: without it the summary
// still carries `lie` (classification works) but serves no topGrid, and the
// consumer's duty on a missing grid is a declared abstention.
let bvhP: Promise<{ THREE: any; MeshBVH: any } | null> | null = null;
async function getBVH() {
  bvhP ??= (async () => {
    try {
      const { THREE } = await import("../tools/core-stub.mjs");
      const { MeshBVH } = await import("../client/node_modules/three-mesh-bvh/src/index.js");
      return { THREE, MeshBVH };
    } catch (err) {
      console.warn("[geometry] three-mesh-bvh unavailable — topGrid certification disabled:", String(err));
      return null;
    }
  })();
  return bvhP;
}

// gltf-transform loads lazily and optionally, same doctrine as the behavior
// sandbox: the sequencer must boot (and worlds must run) without it.
let ioP: Promise<any> | null = null;
async function getIO(): Promise<any | null> {
  ioP ??= (async () => {
    try {
      const { NodeIO } = await import("@gltf-transform/core");
      const { ALL_EXTENSIONS } = await import("@gltf-transform/extensions");
      const draco3d = (await import("draco3dgltf")).default;
      return new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
        "draco3d.decoder": await draco3d.createDecoderModule(),
        "draco3d.encoder": await draco3d.createEncoderModule(),
      });
    } catch (err) {
      console.warn("[geometry] gltf-transform unavailable — /geom disabled:", String(err));
      return null;
    }
  })();
  return ioP;
}

export type Surface = {
  /** height of the flat zone, in the MODEL's local frame (metres) */
  y: number;
  /** total up-facing area in m² */
  area: number;
  x: [number, number];
  z: [number, number];
};
export type GeomSummary = {
  tris: number;
  bbox: { min: number[]; max: number[]; size: number[]; center: number[] };
  /** up-facing flat zones, biggest first — seat pans, table tops, decks.
   *  A socket candidate is {pos: [cx, y, cz]} straight off one of these. */
  topSurfaces: Surface[];
  /** Named mesh parts (Orrery's segmented exports name theirs: tripo_part_N).
   *  `center`/`size` are the MODEL frame (same as bbox/topSurfaces);
   *  `origin` is where the part's own node sits in that frame; `local` is the
   *  part's OWN coordinate frame — the frame a `motion:<name>` component's
   *  pivot/axis use, so `local.center` is a pivot candidate verbatim and
   *  [0,0,0] is the node origin (where a hinge usually lives). */
  nodes: { name: string; center: number[]; size: number[]; origin: number[];
           local: { center: number[]; size: number[] }; tris: number }[];
  /** true when the mesh was too big to walk exhaustively */
  sampled: boolean;
  /** the box-top lie (m, model frame): bbox top minus the median 24×24
   *  cell top — the SAME probe the browser's collider decide() runs, from
   *  the shared classifier (client/lib/supportclass.js). Present whenever
   *  the shape was worth probing; consumers scale it before judging. */
  lie?: number;
  /** the probe's grid itself, served as a truthful heightfield for
   *  floor-shaped assets whose box top lies (#84). Versioned and
   *  self-describing; cells are model-local max-y, null = unoccupied.
   *  Row-major, index = z * n + x over the minXZ/sizeXZ footprint. */
  topGrid?: { version: number; n: number; minXZ: [number, number];
              sizeXZ: [number, number]; lie: number;
              /** the within-cell surface-spread bound every offered cell was
               *  ray-certified to (model metres) — consumers refuse grids
               *  their spawn scale stretches past the world bound */
              certSpread: number; cells: (number | null)[] };
  /** mesh nodes present in the FILE but attached to no scene — broken
   *  exports. No renderer draws them; never aim a motion at one. */
  orphans?: string[];
};

const cache = new Map<string, { mtime: number; sum: GeomSummary }>();
const CACHE_MAX = 64;
const SAMPLE_ABOVE_TRIS = 500_000;

/** Summarize one GLB file. Returns null when parsing is unavailable/fails. */
export async function summarizeGlb(absPath: string): Promise<GeomSummary | null> {
  let mtime = 0;
  try { mtime = statSync(absPath).mtimeMs; } catch { return null; }
  const hit = cache.get(absPath);
  if (hit && hit.mtime === mtime) return hit.sum;
  const io = await getIO();
  if (!io) return null;
  let doc: any;
  try { doc = await io.read(absPath); } catch (err) {
    console.warn(`[geometry] unreadable ${absPath}:`, String(err).slice(0, 200));
    return null;
  }

  // ONLY scene-reachable nodes exist, as far as the WORLD is concerned:
  // three.js renders the default scene, so an orphan node (present in the
  // file, attached to nothing) never appears on any client — and naming one
  // in a motion component aims at a ghost. Fable's swing seat was exactly
  // this: Orrery's rescale wrapper left tripo_part_2/3 dangling outside the
  // scene, measure reported them as real, and the motion pointed at a part
  // no renderer would ever draw. Report the world's truth; list orphans
  // separately as the file defect they are.
  const inScene = new Set<any>();
  for (const scene of doc.getRoot().listScenes()) {
    scene.traverse((n: any) => inScene.add(n));
  }
  const orphans: string[] = [];
  for (const node of doc.getRoot().listNodes()) {
    if (!inScene.has(node) && node.getMesh() && node.getName() && orphans.length < 16) {
      orphans.push(node.getName());
    }
  }

  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  let tris = 0;
  // first pass: count triangles so sampling is decided before the walk
  for (const node of doc.getRoot().listNodes()) {
    if (!inScene.has(node)) continue;
    const mesh = node.getMesh();
    if (!mesh) continue;
    for (const prim of mesh.listPrimitives()) {
      const idx = prim.getIndices();
      const pos = prim.getAttribute("POSITION");
      if (!pos) continue;
      tris += Math.floor((idx ? idx.getCount() : pos.getCount()) / 3);
    }
  }
  const stride = tris > SAMPLE_ABOVE_TRIS ? Math.ceil(tris / SAMPLE_ABOVE_TRIS) : 1;

  // Flat zones bucketed by height (2.5cm) — up-facing triangles only.
  const buckets = new Map<number, { area: number; x: [number, number]; z: [number, number]; ySum: number; n: number }>();
  const nodes: GeomSummary["nodes"] = [];
  const va = [0, 0, 0], vb = [0, 0, 0], vc = [0, 0, 0];
  const xf = (m: number[], p: number[], out: number[]) => {
    const [x, y, z] = p;
    out[0] = m[0] * x + m[4] * y + m[8] * z + m[12];
    out[1] = m[1] * x + m[5] * y + m[9] * z + m[13];
    out[2] = m[2] * x + m[6] * y + m[10] * z + m[14];
  };

  for (const node of doc.getRoot().listNodes()) {
    if (!inScene.has(node)) continue;   // orphans are not part of the world
    const mesh = node.getMesh();
    if (!mesh) continue;
    const m = node.getWorldMatrix();
    const nMin = [Infinity, Infinity, Infinity], nMax = [-Infinity, -Infinity, -Infinity];
    // the part's own frame — raw vertex coords, before any node transform
    const lMin = [Infinity, Infinity, Infinity], lMax = [-Infinity, -Infinity, -Infinity];
    let nTris = 0;
    for (const prim of mesh.listPrimitives()) {
      const posAcc = prim.getAttribute("POSITION");
      if (!posAcc) continue;
      const idxAcc = prim.getIndices();
      const count = idxAcc ? idxAcc.getCount() : posAcc.getCount();
      nTris += Math.floor(count / 3);
      const p = [0, 0, 0];
      for (let t = 0; t + 2 < count; t += 3 * stride) {
        for (let k = 0; k < 3; k++) {
          const vi = idxAcc ? idxAcc.getScalar(t + k) : t + k;
          posAcc.getElement(vi, p);
          for (let a = 0; a < 3; a++) {
            if (p[a] < lMin[a]) lMin[a] = p[a];
            if (p[a] > lMax[a]) lMax[a] = p[a];
          }
          const out = k === 0 ? va : k === 1 ? vb : vc;
          xf(m, p, out);
          for (let a = 0; a < 3; a++) {
            if (out[a] < min[a]) min[a] = out[a];
            if (out[a] > max[a]) max[a] = out[a];
            if (out[a] < nMin[a]) nMin[a] = out[a];
            if (out[a] > nMax[a]) nMax[a] = out[a];
          }
        }
        // up-facing? cross(ab, ac).y dominant and positive
        const abx = vb[0] - va[0], aby = vb[1] - va[1], abz = vb[2] - va[2];
        const acx = vc[0] - va[0], acy = vc[1] - va[1], acz = vc[2] - va[2];
        const cx = aby * acz - abz * acy;
        const cy = abz * acx - abx * acz;
        const cz = abx * acy - aby * acx;
        const len = Math.hypot(cx, cy, cz);
        if (len < 1e-9 || cy / len < 0.8) continue;
        const area = (len / 2) * stride;   // sampled tris stand in for their neighbours
        const yc = (va[1] + vb[1] + vc[1]) / 3;
        const key = Math.round(yc / 0.025);
        const b = buckets.get(key) ?? { area: 0, x: [Infinity, -Infinity], z: [Infinity, -Infinity], ySum: 0, n: 0 };
        b.area += area; b.ySum += yc; b.n++;
        for (const v of [va, vb, vc]) {
          if (v[0] < b.x[0]) b.x[0] = v[0];
          if (v[0] > b.x[1]) b.x[1] = v[0];
          if (v[2] < b.z[0]) b.z[0] = v[2];
          if (v[2] > b.z[1]) b.z[1] = v[2];
        }
        buckets.set(key, b);
      }
    }
    const name = node.getName();
    if (name && Number.isFinite(nMin[0]) && nodes.length < 32) {
      nodes.push({
        name,
        center: nMin.map((v, i) => +((v + nMax[i]) / 2).toFixed(3)),
        size: nMin.map((v, i) => +(nMax[i] - v).toFixed(3)),
        origin: [+m[12].toFixed(3), +m[13].toFixed(3), +m[14].toFixed(3)],
        local: {
          center: lMin.map((v, i) => +((v + lMax[i]) / 2).toFixed(3)),
          size: lMin.map((v, i) => +(lMax[i] - v).toFixed(3)),
        },
        tris: nTris,
      });
    }
  }

  const topSurfaces = [...buckets.values()]
    .filter((b) => b.area > 0.02)
    .sort((a, b) => b.area - a.area)
    .slice(0, 8)
    .map((b) => ({
      y: +(b.ySum / b.n).toFixed(3),
      area: +b.area.toFixed(3),
      x: [+b.x[0].toFixed(3), +b.x[1].toFixed(3)] as [number, number],
      z: [+b.z[0].toFixed(3), +b.z[1].toFixed(3)] as [number, number],
    }));

  const ok = Number.isFinite(min[0]);

  // ---- the box-top lie probe (#84) -----------------------------------------
  // Same math as the browser's collider decide(): the shared accumulator
  // buckets model-frame vertices 24×24 and medians the cell tops. This pass
  // walks POSITION accessors exhaustively (the browser walks every vertex,
  // so sampling here would change the verdict) — gated to shapes that could
  // ever be floor-shaped, with slack for in-world scaling, so room-scale
  // architecture and skyscraper meshes never pay for it.
  let lie: number | undefined;
  let topGrid: GeomSummary["topGrid"];
  if (ok) {
    const w = max[0] - min[0], h = max[1] - min[1], d = max[2] - min[2];
    const worthProbing = w * d >= 1 && h <= 1.5 && !(w * d >= 16 && h >= 2.2);
    if (worthProbing) {
      const acc = gridAccumulator(min[0], min[2], w, d);
      if (acc) {
        const out = [0, 0, 0], p = [0, 0, 0];
        for (const node of doc.getRoot().listNodes()) {
          if (!inScene.has(node)) continue;
          const mesh = node.getMesh();
          if (!mesh) continue;
          const m = node.getWorldMatrix();
          for (const prim of mesh.listPrimitives()) {
            const posAcc = prim.getAttribute("POSITION");
            if (!posAcc) continue;
            for (let vi = 0; vi < posAcc.getCount(); vi++) {
              posAcc.getElement(vi, p);
              xf(m, p, out);
              acc.add(out[0], out[1], out[2]);
            }
          }
        }
        const fin = acc.finish(max[1]);
        if (fin.occupied >= SPARSE_MIN_CELLS) {
          // FULL precision: the browser's topLie is unrounded, and the 0.10m
          // gate is strict — a 0.1004 lie rounded to 0.100 flips the verdict
          // headlessly while the browser calls it uneven (#94 review B2).
          lie = fin.lie;

          // ---- per-cell ray certification (#94 review B1) ----------------
          // A body may stand ANYWHERE in a cell, so every offered cell must
          // prove its whole surface, not its tallest vertex: CERT_SUBSAMPLE²
          // (4×4) rays per occupied cell, with rough cells re-proving
          // themselves on an 8×8 lattice below; any miss (air in the cell)
          // or a spread beyond CERT_SPREAD serves as null. The offered value
          // folds in the cell's vertex max — a certified upper bound within
          // the declared spread.
          const bvhMod = tris <= SAMPLE_ABOVE_TRIS ? await getBVH() : null;   // a sampled-scale mesh gets no certification, hence no grid
          if (bvhMod) {
            const soup: number[] = [];
            const pv = [0, 0, 0], pw = [0, 0, 0];
            for (const node of doc.getRoot().listNodes()) {
              if (!inScene.has(node)) continue;
              const mesh = node.getMesh();
              if (!mesh) continue;
              const m = node.getWorldMatrix();
              for (const prim of mesh.listPrimitives()) {
                const posAcc = prim.getAttribute("POSITION");
                if (!posAcc) continue;
                const idxAcc = prim.getIndices();
                const count = idxAcc ? idxAcc.getCount() : posAcc.getCount();
                for (let t = 0; t < count; t++) {
                  posAcc.getElement(idxAcc ? idxAcc.getScalar(t) : t, pv);
                  xf(m, pv, pw);
                  soup.push(pw[0], pw[1], pw[2]);
                }
              }
            }
            const { THREE, MeshBVH } = bvhMod;
            const geo = new THREE.BufferGeometry();
            geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(soup), 3));
            const bvh = new MeshBVH(geo);
            const ray = new THREE.Ray();
            ray.direction.set(0, -1, 0);
            const rayY = max[1] + Math.max(0.1, h * 0.05);
            const cells: (number | null)[] = [];
            let offered = 0;
            for (let iz = 0; iz < LIE_GRID; iz++) {
              for (let ix = 0; ix < LIE_GRID; ix++) {
                const vertMax = fin.cells[iz * LIE_GRID + ix];
                if (vertMax === -Infinity) { cells.push(null); continue; }
                let lo = Infinity, hi = -Infinity, misses = 0;
                for (let sz = 0; sz < CERT_SUBSAMPLE && !misses; sz++) {
                  for (let sx = 0; sx < CERT_SUBSAMPLE; sx++) {
                    ray.origin.set(
                      min[0] + (w * (ix + (sx + 0.5) / CERT_SUBSAMPLE)) / LIE_GRID,
                      rayY,
                      min[2] + (d * (iz + (sz + 0.5) / CERT_SUBSAMPLE)) / LIE_GRID,
                    );
                    const hit = bvh.raycastFirst(ray, THREE.DoubleSide);
                    if (!hit) { misses++; break; }
                    if (hit.point.y < lo) lo = hit.point.y;
                    if (hit.point.y > hi) hi = hit.point.y;
                  }
                }
                // The OFFERED top is max(ray max, this cell's vertex max): a
                // piecewise-linear surface cannot exceed its vertices inside
                // the cell, so folding vertMax in covers peaks the ray lattice
                // slips between. The spread check then runs against the
                // OFFERED value: a cell whose deepest sampled point sits more
                // than CERT_SPREAD under what we would offer is not flat
                // enough to certify — null, air, abstention.
                let top = Math.max(hi, vertMax);
                if (misses || top - lo > CERT_SPREAD) { cells.push(null); continue; }
                // Adaptive re-certification (#94 B1, "adaptive subdivision is
                // fine"): a ROUGH cell — spread in the upper half of the
                // certifiable band — must re-prove itself on an 8×8 lattice.
                // Smooth cloth skips this; rubble crevices that hid between
                // the 4×4 rays are found here and refused.
                if (top - lo > CERT_SPREAD * 0.5) {
                  const RE = 8;
                  for (let sz = 0; sz < RE && !misses; sz++) {
                    for (let sx = 0; sx < RE; sx++) {
                      ray.origin.set(
                        min[0] + (w * (ix + (sx + 0.5) / RE)) / LIE_GRID,
                        rayY,
                        min[2] + (d * (iz + (sz + 0.5) / RE)) / LIE_GRID,
                      );
                      const hit = bvh.raycastFirst(ray, THREE.DoubleSide);
                      if (!hit) { misses++; break; }
                      if (hit.point.y < lo) lo = hit.point.y;
                      if (hit.point.y > hi) hi = hit.point.y;
                    }
                  }
                  top = Math.max(hi, vertMax);
                  if (misses || top - lo > CERT_SPREAD) { cells.push(null); continue; }
                }
                cells.push(+top.toFixed(3));
                offered++;
              }
            }
            if (offered >= SPARSE_MIN_CELLS) {
              const g = { version: TOPGRID_VERSION, n: LIE_GRID,
                minXZ: [+min[0].toFixed(3), +min[2].toFixed(3)] as [number, number],
                sizeXZ: [+w.toFixed(3), +d.toFixed(3)] as [number, number],
                lie, certSpread: CERT_SPREAD, cells };
              // the hard payload cap is part of the contract — an oversized
              // grid is dropped here and the consumer abstains, never box-tops
              if (JSON.stringify(g).length <= TOPGRID_MAX_JSON) topGrid = g;
            }
          }
        }
      }
    }
  }

  const sum: GeomSummary = {
    tris,
    bbox: ok ? {
      min: min.map((v) => +v.toFixed(3)), max: max.map((v) => +v.toFixed(3)),
      size: min.map((v, i) => +(max[i] - v).toFixed(3)),
      center: min.map((v, i) => +((v + max[i]) / 2).toFixed(3)),
    } : { min: [0, 0, 0], max: [0, 0, 0], size: [0, 0, 0], center: [0, 0, 0] },
    topSurfaces,
    nodes,
    sampled: stride > 1,
    ...(lie !== undefined ? { lie } : {}),
    ...(topGrid ? { topGrid } : {}),
    ...(orphans.length ? { orphans } : {}),
  };
  cache.set(absPath, { mtime, sum });
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value!);
  return sum;
}
