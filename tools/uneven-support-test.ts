/**
 * Uneven-support agent test — #84 end to end, through the REAL spawn path:
 * a scratch sequencer serves /geom (with the new lie/topGrid), a WorldAgent
 * folds the spawns and registers support, and the shared collider state is
 * queried exactly where the physics would ask. Covers, per the review:
 *
 *   - the blanket at NONZERO YAW and NON-UNIT SCALE: ground at an occupied
 *     cell equals the composed cell top (world→model-local round trip);
 *   - stepping from an occupied cell into an adjacent EMPTY one: terrain,
 *     not interpolated air;
 *   - a rubble pile brought INTO the class by an in-world scale;
 *   - a crate keeps its honest box (no regression);
 *   - fail-on-main: on a pre-#84 checkout the blanket registers its box and
 *     the ground floats by the documented lie.
 *
 * The blanket is the commons' actual store/9a9d0239eca609b3.glb, copied to
 * the LOCAL store dir — no production networking (review amendment 4).
 *
 * Run:
 *   BLANKET_GLB=/path/to/blanket-9a9d0239.glb EIDOVERSE_DIR=/path/to/eidoverse-video \
 *     bun run tools/uneven-support-test.ts
 */

import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, copyFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorldAgent } from "../mcpl/agent.ts";
import { supportHolders } from "../mcpl/physics.ts";
import { summarizeGlb } from "../server/geometry.ts";

const PORT = Number(process.env.PORT ?? 9001);
const URL_ = `ws://127.0.0.1:${PORT}/ws`;
const WORLD = "uneventest";
const BLANKET_LIB = "store/9a9d0239eca609b3.glb";
const RUBBLE_LIB = "eidoverse/assets/models/apocalyptic_scifi_cyberpunk_destroyed_rubble_debris_pile.glb";
const CRATE_LIB = "eidoverse/assets/models/crate_large_blue.glb";

let failures = 0;
const check = (label: string, ok: boolean, detail?: string) => {
  console.log(ok ? `  \x1b[32m✓\x1b[0m ${label}` : `  \x1b[31m✗ ${label}${detail ? ` — ${detail}` : ""}\x1b[0m`);
  if (!ok) failures++;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, ms = 8000, step = 100) {
  const t0 = Date.now();
  while (!cond() && Date.now() - t0 < ms) await sleep(step);
  return cond();
}

if (!process.env.EIDOVERSE_DIR || !process.env.BLANKET_GLB) {
  console.error("EIDOVERSE_DIR and BLANKET_GLB are required (local files only — no production networking).");
  process.exit(1);
}

// ---- host the blanket in the LOCAL store, where an upload would land -------
const storeDir = join(import.meta.dir, "..", "assets", "opt", "store");
mkdirSync(storeDir, { recursive: true });
const blanketDst = join(storeDir, "9a9d0239eca609b3.glb");
if (!existsSync(blanketDst)) copyFileSync(process.env.BLANKET_GLB, blanketDst);

// summaries read directly (same code the server serves) — they drive the
// expected values, so expectations come from served data, not from the
// modules under test
const blanketSum = (await summarizeGlb(blanketDst))!;
const rubbleSum = (await summarizeGlb(join(process.env.EIDOVERSE_DIR, RUBBLE_LIB)))!;

// ---- scratch sequencer ------------------------------------------------------
const server = spawn("bun", [join(import.meta.dir, "..", "server", "server.ts")], {
  env: { ...process.env, PORT: String(PORT), WORLDS_DIR: mkdtempSync(join(tmpdir(), "ew-uneven-")), JOIN_TOKEN: "" },
  stdio: "ignore",
});
const stop = () => { try { server.kill(); } catch {} };
process.on("exit", stop);
await sleep(1500);

const warden = new WebSocket(URL_);
const verb = (v: string, args: any) => warden.send(JSON.stringify({ type: "verb", verb: v, args }));
await new Promise<void>((res, rej) => {
  warden.onopen = () => { warden.send(JSON.stringify({ type: "join", world: WORLD, id: "warden", avatar: "eidoverse/assets/vrms/claude.vrm" })); res(); };
  warden.onerror = () => rej(new Error("warden failed to connect"));
});
await sleep(400);

const agent = new WorldAgent({ url: URL_, name: "prober", world: WORLD });
await agent.connect();

// the blanket: nonzero yaw, non-unit scale, and raised so its below-origin
// cloth clears the flat terrain (else terrain-at-0 legitimately covers it)
const B = { pos: [4, 0.5, 4], yaw: 0.9, scale: 1.25 };
verb("spawn", { id: "blank1", lib: BLANKET_LIB, pos: B.pos, yaw: B.yaw, scale: B.scale });
// the rubble pile, scaled INTO the floor-shaped class (h·s ≤ 1.0)
const R = { pos: [20, 0, 20], yaw: 0.7, scale: 0.88 };
verb("spawn", { id: "rubble1", lib: RUBBLE_LIB, pos: R.pos, yaw: R.yaw, scale: R.scale });
// the honest control
verb("spawn", { id: "crate1", lib: CRATE_LIB, pos: [40, 0, 40], yaw: 0, scale: 1 });
await (agent as any).supportReady(8000);
await until(() => Object.keys(supportHolders()).length >= 3, 8000);

check("all three register support", Object.keys(supportHolders()).length >= 3, JSON.stringify(supportHolders()));

// query the SAME collider state the physics reads (module cache = one instance)
const colliders: any = await import("../client/lib/colliders.js");
const { THREE }: any = await import("./core-stub.mjs");   // the stub loadSim's plugin already routed core.js to
const groundAt = (x: number, z: number, y = 10) =>
  colliders.resolveColliders(new THREE.Vector3(x, y, z), () => 0, 0.05, 0.03);

/** world position of a grid cell center under an entity transform */
const cellWorld = (g: any, ix: number, iz: number, T: { pos: number[]; yaw: number; scale: number }) => {
  const lx = g.minXZ[0] + (g.sizeXZ[0] * (ix + 0.5)) / g.n;
  const lz = g.minXZ[1] + (g.sizeXZ[1] * (iz + 0.5)) / g.n;
  const c = Math.cos(T.yaw), s = Math.sin(T.yaw);
  // THREE applyAxisAngle(+Y, yaw): x' = x·cos + z·sin, z' = −x·sin + z·cos
  return { x: T.pos[0] + (lx * c + lz * s) * T.scale, z: T.pos[2] + (-lx * s + lz * c) * T.scale };
};
/** the TALLEST occupied cell — a cushion top, safely above terrain, so the
 *  grid (not the terrain floor) is what answers the query */
const tallestCell = (g: any) => {
  let best: { ix: number; iz: number; top: number } | null = null;
  for (let iz = 0; iz < g.n; iz++) {
    for (let ix = 0; ix < g.n; ix++) {
      const top = g.cells[iz * g.n + ix];
      if (top !== null && (!best || top > best.top)) best = { ix, iz, top };
    }
  }
  return best;
};

console.log("\n━━ blanket: yaw 0.9, scale 1.25 ━━");
{
  const g = blanketSum.topGrid;
  check("a grid is served for the blanket", !!g, "absent — pre-#84 server, box-top era");
  const cell = g ? tallestCell(g) : null;
  if (g && !cell) check("the blanket's grid has occupied cells", false);
  if (g && cell) {
    const p = cellWorld(g, cell.ix, cell.iz, B);
    const expected = B.pos[1] + cell.top * B.scale;
    const ground = groundAt(p.x, p.z);
    check("ground = the composed cell top (yaw+scale round trip)", Math.abs(ground - expected) < 0.02,
      `ground ${ground.toFixed(3)} vs expected ${expected.toFixed(3)}`);
    // the bare cloth: a cell at ~median height, where the box top's lie is
    // the full 0.25m·s — the pre-#84 float this asset was filed over
    const tops = (g.cells.filter((c: number | null) => c !== null) as number[]).sort((a, b) => a - b);
    const medTop = tops[tops.length >> 1];
    let medCell: { ix: number; iz: number; top: number } | null = null;
    for (let iz = 0; iz < g.n && !medCell; iz++) for (let ix = 0; ix < g.n && !medCell; ix++) {
      const t = g.cells[iz * g.n + ix];
      if (t !== null && Math.abs(t - medTop) < 1e-9) medCell = { ix, iz, top: t };
    }
    const boxTop = B.pos[1] + blanketSum.bbox.max[1] * B.scale;
    if (medCell) {
      const mp = cellWorld(g, medCell.ix, medCell.iz, B);
      const mg = groundAt(mp.x, mp.z);
      check("bare cloth rests at cloth height — NOT the box top", Math.abs(mg - (B.pos[1] + medCell.top * B.scale)) < 0.02 && boxTop - mg > 0.1,
        `ground ${mg.toFixed(3)}, box top ${boxTop.toFixed(3)} (lie ${(blanketSum.lie! * B.scale).toFixed(3)}m)`);
    }
    // step OFF the cloth's edge: half a metre past the footprint along the
    // entity's local +x, composed through the same yaw/scale — outside the
    // grid there is no support, and the honest answer is terrain
    const beyond = cellWorld({ ...g, minXZ: [g.minXZ[0] + g.sizeXZ[0] + 0.5 / B.scale, g.minXZ[1]], sizeXZ: [0, g.sizeXZ[1]] } as any, 0, Math.floor(g.n / 2), B);
    const offEdge = groundAt(beyond.x, beyond.z);
    check("one step off the cloth's edge: terrain, not stretched cloth", Math.abs(offEdge - 0) < 1e-6, `ground ${offEdge.toFixed(3)}`);
  }
}

console.log("\n━━ rubble: scaled into the class (yaw 0.7, scale 0.88) ━━");
{
  const g = rubbleSum.topGrid;
  check("a grid is served for the rubble", !!g, "absent — pre-#84 server");
  const cell = g ? tallestCell(g) : null;
  if (g && cell) {
    const p = cellWorld(g, cell.ix, cell.iz, R);
    const expected = R.pos[1] + cell.top * R.scale;
    const ground = groundAt(p.x, p.z);
    check("scaled rubble rests bodies on the rubble, not 0.6m above it", Math.abs(ground - expected) < 0.02,
      `ground ${ground.toFixed(3)} vs expected ${expected.toFixed(3)} (box top ${(rubbleSum.bbox.max[1] * R.scale).toFixed(3)})`);
  }
}

console.log("\n━━ interior hole: an empty cell inside the footprint is AIR ━━");
{
  // Real cloth covers its footprint, so the interior-empty-cell semantics are
  // pinned at the colliders tier with a synthetic grid (the pipeline cases
  // above all ride the real spawn path; this one pins fitSupportGrid's own
  // contract: occupied neighbors must not bleed across a hole).
  const n = 24, cells: (number | null)[] = new Array(n * n).fill(0.4);
  cells[12 * n + 12] = null;                            // one hole, dead centre
  const ok = typeof colliders.fitSupportGrid === "function" && colliders.fitSupportGrid("synthetic-hole", {
    version: 1, n, minXZ: [-1.2, -1.2], sizeXZ: [2.4, 2.4], lie: 0.4, certSpread: 0.03, cells,
  }, { position: [60, 0, 60], yaw: 0, scale: 1 });
  check("synthetic grid registers", ok === true);
  const occupied = groundAt(60 + (11.5 / n) * 2.4 - 1.2, 60 + (12.5 / n) * 2.4 - 1.2);
  const hole = groundAt(60 + (12.5 / n) * 2.4 - 1.2, 60 + (12.5 / n) * 2.4 - 1.2);
  check("occupied neighbor answers 0.4", Math.abs(occupied - 0.4) < 1e-9, String(occupied));
  check("the hole answers terrain — no bleed across air", Math.abs(hole - 0) < 1e-9, String(hole));
  colliders.removeCollider("synthetic-hole");
}

console.log("\n━━ the old worst cell: max-y's 21cm float is behaviorally gone ━━");
{
  // Rebuild what the max-y implementation WOULD have offered (the vertex
  // grid) and ray truth per cell, independently; find the cell where the
  // old float was worst; assert the agent's ground there is truth-or-
  // terrain — never the old vertex top. On the max-y head this fails by
  // ~0.21m (#94 review B1's behavioral requirement).
  const { gridAccumulator } = await import("../client/lib/supportclass.js");
  const { MeshBVH }: any = await import("../client/node_modules/three-mesh-bvh/src/index.js");
  const io = await (async () => {
    const { NodeIO } = await import("@gltf-transform/core");
    const { ALL_EXTENSIONS } = await import("@gltf-transform/extensions");
    const draco3d = (await import("draco3dgltf")).default;
    return new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
      "draco3d.decoder": await draco3d.createDecoderModule(),
      "draco3d.encoder": await draco3d.createEncoderModule(),
    });
  })();
  const doc = await io.read(blanketDst);
  const inScene = new Set<any>();
  for (const s of doc.getRoot().listScenes()) s.traverse((n: any) => inScene.add(n));
  const soup: number[] = [];
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
        soup.push(m[0]*p[0]+m[4]*p[1]+m[8]*p[2]+m[12], m[1]*p[0]+m[5]*p[1]+m[9]*p[2]+m[13], m[2]*p[0]+m[6]*p[1]+m[10]*p[2]+m[14]);
      }
    }
  }
  const bb = blanketSum.bbox;
  const acc = gridAccumulator(bb.min[0], bb.min[2], bb.size[0], bb.size[2])!;
  for (let i = 0; i < soup.length; i += 3) acc.add(soup[i], soup[i + 1], soup[i + 2]);
  const vfin = acc.finish(bb.max[1]);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(soup), 3));
  const bvh = new MeshBVH(geo);
  const ray = new THREE.Ray();
  ray.direction.set(0, -1, 0);
  const n = blanketSum.topGrid!.n;
  let worst: { ix: number; iz: number; float: number; ray: number } | null = null;
  for (let iz = 0; iz < n; iz++) {
    for (let ix = 0; ix < n; ix++) {
      const vm = vfin.cells[iz * n + ix];
      if (vm === -Infinity) continue;
      ray.origin.set(bb.min[0] + (bb.size[0] * (ix + 0.5)) / n, bb.max[1] + 0.2, bb.min[2] + (bb.size[2] * (iz + 0.5)) / n);
      const hit = bvh.raycastFirst(ray, THREE.DoubleSide);
      if (!hit) continue;
      const fl = vm - hit.point.y;
      if (!worst || fl > worst.float) worst = { ix, iz, float: fl, ray: hit.point.y };
    }
  }
  check("the old worst cell is a real float (the 0.21m class)", !!worst && worst.float > 0.1, JSON.stringify(worst));
  if (worst) {
    const p = cellWorld(blanketSum.topGrid!, worst.ix, worst.iz, B);
    const ground = groundAt(p.x, p.z);
    const oldGround = B.pos[1] + worst.float * B.scale + worst.ray * B.scale;  // what max-y offered
    const truthCap = B.pos[1] + (worst.ray + 0.05 / B.scale) * B.scale;       // ray truth + the world bound
    check("agent ground there is truth-or-terrain, never the max-y float",
      ground <= truthCap + 1e-6, `ground ${ground.toFixed(3)}, truth+bound ${truthCap.toFixed(3)}, old max-y would offer ${oldGround.toFixed(3)}`);
  }
}

console.log("\n━━ a scale that stretches certification: declared abstention ━━");
{
  // certSpread 0.03 × scale 2 = 0.06 > the 0.05 world bound — the grid must
  // be refused, the seam declared, and the body finds terrain (no box!)
  verb("spawn", { id: "blank2", lib: BLANKET_LIB, pos: [80, 0.5, 80], yaw: 0, scale: 2 });
  await sleep(1500);
  await (agent as any).supportReady(8000);
  const held = Object.keys(supportHolders()).some((k) => k.endsWith("/blank2"));
  check("over-stretched grid registers NOTHING (no box, no grid)", !held, JSON.stringify(Object.keys(supportHolders())));
  check("and the seam is declared, bounded", agent.supportSeams > 0, `seams=${agent.supportSeams}`);
}

console.log("\n━━ crate: the honest box is untouched ━━");
{
  const crateSum = (await summarizeGlb(join(process.env.EIDOVERSE_DIR!, CRATE_LIB)))!;
  const expected = crateSum.bbox.max[1];   // scale 1, pos.y 0 — the box top IS truthful here
  const ground = groundAt(40, 40);
  check("crate ground = box top exactly (no regression)", Math.abs(ground - expected) < 1e-6,
    `ground ${ground.toFixed(3)} vs box top ${expected.toFixed(3)}`);
}

agent.close();
try { warden.close(); } catch {}
stop();
console.log("");
process.exit(failures ? 1 : 0);
