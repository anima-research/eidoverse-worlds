/**
 * Support heightfield probe — #84's matched browser/headless receipt.
 *
 * For each asset: the SERVED summary (server/geometry.ts summarizeGlb,
 * imported directly — no network) against a BVH raycast ground truth (the
 * survey's honest metric, tools/collider-survey.ts machinery). Asserts, for
 * every asset the shared classifier calls floor-shaped + uneven:
 *
 *   - the summary carries a validTopGrid-accepted grid;
 *   - per occupied cell (where a ray hits), the grid top is an UPPER bound
 *     on the ray top and tracks it (median ≤ 5cm, worst reported);
 *   - the OLD box top's error at the same columns — the float a body
 *     suffered before this fix — is recorded as the receipt.
 *
 * Assets that are NOT in the class (both rubble piles at scale 1 — the
 * height gate excludes them, in the browser and here alike) are reported
 * with the scale at which they WOULD enter it, for the agent-level test.
 *
 * Run:
 *   BLANKET_GLB=/path/to/blanket-9a9d0239.glb EIDOVERSE_DIR=/path/to/eidoverse-video \
 *     bun run tools/support-heightfield-probe.ts [extra.glb ...]
 */

import { join } from "node:path";
import { summarizeGlb } from "../server/geometry.ts";
import { decideSupportClass, validTopGrid, LIE_GRID, UNEVEN_MIN_LIE, FLOOR_MAX_H, FLOOR_MIN_AREA }
  from "../client/lib/supportclass.js";

const { THREE }: any = await import("./core-stub.mjs");
const { MeshBVH }: any = await import("../client/node_modules/three-mesh-bvh/src/index.js");

let failures = 0;
const check = (label: string, ok: boolean, detail?: string) => {
  console.log(ok ? `  \x1b[32m✓\x1b[0m ${label}` : `  \x1b[31m✗ ${label}${detail ? ` — ${detail}` : ""}\x1b[0m`);
  if (!ok) failures++;
};
const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const h = s.length >> 1;
  return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2;
};

// ---- world-space triangle soup (collider-survey's loader, verbatim slice) --
let ioP: Promise<any> | null = null;
async function getIO() {
  ioP ??= (async () => {
    const { NodeIO } = await import("@gltf-transform/core");
    const { ALL_EXTENSIONS } = await import("@gltf-transform/extensions");
    const draco3d = (await import("draco3dgltf")).default;
    return new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
      "draco3d.decoder": await draco3d.createDecoderModule(),
      "draco3d.encoder": await draco3d.createEncoderModule(),
    });
  })();
  return ioP;
}
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
      const pos = prim.getAttribute("POSITION");
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

async function probe(label: string, path: string, scale = 1) {
  console.log(`\n━━ ${label}${scale !== 1 ? ` @ ×${scale}` : ""} ━━`);
  const sum = await summarizeGlb(path);
  if (!sum) { check(`${label}: summary`, false, "summarizeGlb returned null"); return; }
  const v = await loadTris(path);
  if (!v) { check(`${label}: triangles`, false, "loadTris returned null"); return; }
  const [w, h, d] = sum.bbox.size;
  const cls = decideSupportClass({ w: w * scale, d: d * scale, h: h * scale, lie: (sum.lie ?? 0) * scale });
  console.log(`  shape ${w.toFixed(2)}×${d.toFixed(2)}×${h.toFixed(2)}m, lie ${sum.lie?.toFixed(4) ?? "—"}, class at ×${scale}: ` +
    (cls.uneven ? "floor-shaped + UNEVEN" : cls.floorShaped ? "floor-shaped (honest top)" : cls.roomScale ? "room-scale" : "small solid"));

  if (!cls.uneven) {
    // outside the class at s=1: report the scale that would admit it (the
    // agent-level test spawns at such a scale), and if a grid is served for
    // that scaled use, verify it against raycast all the same
    const sH = FLOOR_MAX_H / h, area = w * d;
    const sMin = Math.sqrt(FLOOR_MIN_AREA / area);
    const lieOk = (sum.lie ?? 0) * sH > UNEVEN_MIN_LIE;
    console.log(`  (enters the class at scale ≤ ${sH.toFixed(2)}${sMin > sH ? " — never (footprint too small first)" : lieOk ? `, lie ${(sum.lie! * sH).toFixed(2)}m at that scale` : ", but its lie goes honest first"})`);
    if (!sum.topGrid) return;
    console.log(`  (grid served for scaled use — verifying it anyway)`);
  }

  check(`${label}: served grid passes validTopGrid`, validTopGrid(sum.topGrid), JSON.stringify(sum.topGrid)?.slice(0, 120));
  if (!validTopGrid(sum.topGrid)) return;
  const g = sum.topGrid!;

  // raycast truth per OFFERED cell, 4×4 within-cell subsample — a body may
  // stand anywhere in a cell, so the bound is per SUBPOINT, in WORLD metres
  // at the tested scale, not a median over cell centres (#94 review B1).
  // The 4×4 pattern deliberately differs from certification's 3×3: the
  // probe must not sample the exact points generation certified.
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(v, 3));
  const bvh = new MeshBVH(geo);
  const ray = new THREE.Ray();
  ray.direction.set(0, -1, 0);
  const SUB = 5;   // denser than certification's 4×4, on a different lattice — the probe must not resample certification's own points
  const diffs: number[] = [];
  const boxErr: number[] = [];
  let notUpper = 0, overBound = 0, compared = 0, worstOver = 0;
  for (let iz = 0; iz < g.n; iz++) {
    for (let ix = 0; ix < g.n; ix++) {
      const top = g.cells[iz * g.n + ix];
      if (top === null) continue;
      compared++;
      for (let sz = 0; sz < SUB; sz++) {
        for (let sx = 0; sx < SUB; sx++) {
          ray.origin.set(
            g.minXZ[0] + (g.sizeXZ[0] * (ix + (sx + 0.5) / SUB)) / g.n,
            sum.bbox.max[1] + Math.max(0.1, h * 0.05),
            g.minXZ[1] + (g.sizeXZ[1] * (iz + (sz + 0.5) / SUB)) / g.n,
          );
          const hit = bvh.raycastFirst(ray, THREE.DoubleSide);
          if (!hit) continue;   // an offered cell may graze the hem; certification bounded what it DID hit
          const err = (top - hit.point.y) * scale;         // world metres at the tested scale
          diffs.push(Math.abs(err));
          if (err < -0.021 * scale - 0.002) notUpper++;    // below the surface: not an upper bound
          if (err > 0.05 + 0.002) { overBound++; worstOver = Math.max(worstOver, err); }
          boxErr.push((sum.bbox.max[1] - hit.point.y) * scale);
        }
      }
    }
  }
  check(`${label}: enough offered cells to probe`, compared >= 24, String(compared));
  check(`${label}: the grid is an upper bound on the surface`, notUpper === 0, `${notUpper} subpoints above the grid`);
  check(`${label}: EVERY offered cell within the 5cm world bound, at every subpoint`, overBound === 0,
    `${overBound}/${diffs.length} subpoints over (worst ${worstOver.toFixed(3)}m)`);
  const med = median(diffs), worst = Math.max(...diffs);
  console.log(`  grid vs raycast (world m at ×${scale}): median ${med.toFixed(3)}, worst ${worst.toFixed(3)} over ${diffs.length} subpoints in ${compared} offered cells`);
  const boxMed = median(boxErr);
  console.log(`  the OLD box top's error at the same columns: median ${boxMed.toFixed(3)}m — the float a body suffered pre-#84`);
  if ((sum.lie ?? 0) * scale > UNEVEN_MIN_LIE) {
    check(`${label}: the box top was indeed the lie (> gate)`, boxMed > UNEVEN_MIN_LIE, `${boxMed.toFixed(3)}m`);
  }
}

const lib = process.env.EIDOVERSE_DIR;
const targets: Array<[string, string, number?]> = [];
if (process.env.BLANKET_GLB) {
  targets.push(["blanket (store/9a9d0239eca609b3)", process.env.BLANKET_GLB]);
  targets.push(["blanket (store/9a9d0239eca609b3)", process.env.BLANKET_GLB, 1.25]);   // the agent test's spawn scale
}
if (lib) {
  // the scifi debris pile is the rubble asset the scale gate actually admits
  // (h 1.12m → in the class at ≤ 0.90) — probed AT the agent test's scale
  targets.push(["scifi rubble pile", join(lib, "eidoverse/assets/models/apocalyptic_scifi_cyberpunk_destroyed_rubble_debris_pile.glb"), 0.88]);
  targets.push(["rubble pile (building collapse)", join(lib, "eidoverse/assets/models/apocalyptic_destroyed_rubble_debris_pile_building_collapse.glb")]);
  targets.push(["rubble pile (ruins)", join(lib, "eidoverse/assets/models/apocalyptic_destroyed_rubble_debris_pile_ruins.glb")]);
}
for (const extra of process.argv.slice(2)) targets.push([extra.split(/[\\/]/).pop()!, extra]);
if (!targets.length) { console.error("nothing to probe — set BLANKET_GLB and/or EIDOVERSE_DIR"); process.exit(1); }

for (const [label, path, scale] of targets) await probe(label, path, scale ?? 1);

console.log("");
process.exit(failures ? 1 : 0);
