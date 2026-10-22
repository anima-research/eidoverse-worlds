/**
 * A stretched thing holds a body up where it is drawn.
 *
 * Run: bun mcpl/stretched-support-test.ts
 *
 * A thing's per-axis scale (scale3) stretches it along its own axes, as the
 * browser's applyScale does. The colliders' readers take one scale for all
 * three axes, so the door fits a stretched support at scale 1 with the stretch
 * in its own numbers: its box, its heightfield, its triangles. A thing lying
 * down is stretched along its own axes first and turned after. A mirrored axis
 * (a negative scale) is read as its size, as componentspec says physics does,
 * a mirror the same on every axis included. Each fixture carries the one-number
 * scale a record's transform gives beside its per-axis one (view.js tf: the
 * y axis's, when stretched), as the door receives it.
 *
 * Each case asks standOn for the ground just above where the stretched top is
 * drawn, so it answers that top or, if the stretch was lost, something lower.
 */
import { WorldAgent } from "./agent.ts";
import { registerSupport, registerSupportGrid, registerMeshSupport, removeSupport, standOn, inWorld } from "./physics.ts";
import { boxMesh } from "../tools/two-storey-fixture.ts";
import { LIE_GRID, TOPGRID_VERSION } from "../client/lib/supportclass.js";

let failures = 0;
const check = (label: string, ok: boolean, detail?: string) => {
  console.log(ok ? `  \x1b[32m✓\x1b[0m ${label}` : `  \x1b[31m✗ ${label}${detail ? ` — ${detail}` : ""}\x1b[0m`);
  if (!ok) failures++;
};
const near = (a: number | null, b: number) => a !== null && Math.abs(a - b) < 0.02;
const flat = () => 0;
/** The ground standOn finds at (x, z) for a body whose feet are at y, in world W. */
const groundAt = (x: number, y: number, z: number) => inWorld("w", () => standOn({ x, y, z }, flat));
const HOLDER = "stretched-support-test";
const at = { position: [0, 0, 0], yaw: 0 };

console.log("data boxes");
{
  // a 2 × 1 × 2 box, stretched ×2 in height: drawn 2 m tall
  await registerSupport(HOLDER, "w/tall", [-1, 0, -1], [1, 1, 1], { ...at, scale: 2, scale3: [1, 2, 1] });
  const g = groundAt(0, 2.05, 0);
  check("a box stretched in height holds a body at its drawn top", near(g, 2), String(g));
  await removeSupport(HOLDER, "w/tall");
}
{
  // stretched ×3 in depth: its footprint reaches z = 3
  await registerSupport(HOLDER, "w/deep", [-1, 0, -1], [1, 1, 1], { ...at, scale: 1, scale3: [1, 1, 3] });
  const g = groundAt(0, 1.05, 2.5);
  check("a box stretched in depth holds a body over its drawn footprint", near(g, 1), String(g));
  await removeSupport(HOLDER, "w/deep");
}
{
  // mirrored in x and stretched ×2 in height
  await registerSupport(HOLDER, "w/mirror", [-1, 0, -1], [1, 1, 1], { ...at, scale: 2, scale3: [-1, 2, 1] });
  const g = groundAt(0, 2.05, 0);
  check("a mirrored, stretched box still holds a body, at its drawn top", near(g, 2), String(g));
  await removeSupport(HOLDER, "w/mirror");
}
{
  // mirrored in y alone, the same size on every axis: no stretch, and the one-number scale is −1
  await registerSupport(HOLDER, "w/flip", [-1, 0, -1], [1, 1, 1], { ...at, scale: -1, scale3: [1, -1, 1] });
  const g = groundAt(0, 1.05, 0);
  check("a box mirrored to the same size on every axis holds a body at its top", near(g, 1), String(g));
  await removeSupport(HOLDER, "w/flip");
  await registerSupport(HOLDER, "w/neg", [-1, 0, -1], [1, 1, 1], { ...at, scale: -1 });
  const g2 = groundAt(0, 1.05, 0);
  check("...and so does one whose one-number scale is −1", near(g2, 1), String(g2));
  await removeSupport(HOLDER, "w/neg");
}

console.log("heightfield");
const gridOf = (cell: (gx: number, gz: number) => number | null) => ({
  version: TOPGRID_VERSION, n: LIE_GRID, minXZ: [-1, -1], sizeXZ: [2, 2], lie: 0.2, certSpread: 0.01,
  cells: Array.from({ length: LIE_GRID * LIE_GRID }, (_, k) => cell(k % LIE_GRID, Math.floor(k / LIE_GRID))),
});
{
  // a 2 × 2 m grid whose tops are 0.5 on its −x half and 0.8 on its +x half, with one empty cell; stretched ×3 along x,
  // ×2 in height and ×1.5 along z, it is drawn 6 × 3 m, its tops at 1 and 1.6
  const HOLE = [18, 12];
  const grid = gridOf((gx, gz) => gx === HOLE[0] && gz === HOLE[1] ? null : gx < LIE_GRID / 2 ? 0.5 : 0.8);
  const ok = await registerSupportGrid(HOLDER, "w/grid", grid, { ...at, scale: 2, scale3: [3, 2, 1.5] });
  check("a stretched heightfield is fitted", ok === true);
  const right = groundAt(2.5, 1.65, 0), left = groundAt(-2.5, 1.05, 1.2);
  check("...and holds a body at its drawn cell tops, out along its stretched width", near(right, 1.6), String(right));
  check("...and across its stretched depth", near(left, 1), String(left));
  // the empty cell's middle, where it is drawn: [-3 + 18.5/24 × 6, -1.5 + 12.5/24 × 3]
  const hole = groundAt(-3 + (HOLE[0] + 0.5) / LIE_GRID * 6, 1.65, -1.5 + (HOLE[1] + 0.5) / LIE_GRID * 3);
  check("...and its empty cell holds nothing, where it is drawn", near(hole, 0), String(hole));
  await removeSupport(HOLDER, "w/grid");
}
{
  // every top at 0.5, under a one-number scale of −1: read as its size
  const ok = await registerSupportGrid(HOLDER, "w/grid-neg", gridOf(() => 0.5), { ...at, scale: -1 });
  const g = groundAt(0, 0.55, 0);
  check("a heightfield whose one-number scale is −1 is fitted at its size", ok === true && near(g, 0.5), `${ok} ${g}`);
  await removeSupport(HOLDER, "w/grid-neg");
}

console.log("triangles");
{
  const { pos, idx } = boxMesh([[-1, 0, -1, 1, 1, 1]]);
  const mesh = { positions: new Float32Array(pos), indices: new Uint32Array(idx) };
  // stretched ×3 along x and ×2 in height: drawn 6 m wide and 2 m tall
  const ok = await registerMeshSupport(HOLDER, "w/mesh", mesh, { ...at, scale: 2, scale3: [3, 2, 1], collide: "exact", model: "zz/box.glb" });
  const g = groundAt(2.5, 2.05, 0);
  check("a stretched mesh is fitted", ok === true);
  check("...and holds a body at its drawn top, out along its stretched width", near(g, 2), String(g));
  // the same model unstretched, beside it, still stands at its own height: the stretch stayed in its copy
  const ok2 = await registerMeshSupport(HOLDER, "w/mesh-plain", mesh, { position: [10, 0, 0], yaw: 0, scale: 1, collide: "exact", model: "zz/box.glb" });
  const g2 = groundAt(10, 1.05, 0);
  check("...and the same model unstretched stands at its own height", ok2 === true && near(g2, 1), String(g2));
  await removeSupport(HOLDER, "w/mesh");
  await removeSupport(HOLDER, "w/mesh-plain");
  // a one-number scale of −1: read as its size, not turned inside out below the ground
  const ok3 = await registerMeshSupport(HOLDER, "w/mesh-neg", mesh, { position: [20, 0, 0], yaw: 0, scale: -1, collide: "exact", model: "zz/box.glb" });
  const g3 = groundAt(20, 1.05, 0);
  check("a mesh whose one-number scale is −1 holds a body at its top", ok3 === true && near(g3, 1), `${ok3} ${g3}`);
  await removeSupport(HOLDER, "w/mesh-neg");
}

console.log("lying down");
{
  // A 2 × 0.5 × 1 box, stretched ×4 in depth (4 m along its own z), tipped forward a quarter turn about x: its own z
  // stands up, so it is drawn 4 m tall, from y −2 to 2. Stretched after the turn instead, the ×4 would land on what
  // is now its 0.5 m thickness.
  const ag: any = new WorldAgent({ name: "lier", world: "w" });
  const s = Math.SQRT1_2;
  ag.entities.set("log", { id: "log", model: "zz/log.glb", kind: "thing", pos: [0, 0, 0], yaw: 0, actor: "x", scale: 1, scale3: [1, 1, 4], q: [s, 0, 0, s] });
  ag.geomFor = async () => ({ bbox: { min: [-1, 0, -0.5], max: [1, 0.5, 0.5], size: [2, 0.5, 1] } });
  ag.meshFor = async () => null;
  await ag.syncSupport("log");
  let g: number | null = null;
  for (let i = 0; i < 50 && !near(g, 2); i++) { await new Promise((r) => setTimeout(r, 10)); g = groundAt(0, 2.05, 0.25); }
  check("a stretched thing lying down is stretched along its own axes, then turned", near(g, 2), String(g));
  ag.dropSupport("log");
  // A stump whose box runs from its base (z 0) to 1 m along its own z, stretched ×4 and mirrored along that axis, tipped
  // back a quarter turn so its own z stands up. A mirrored axis is read as its size, as every support reads it, so it
  // stands 4 m tall from the ground; read signed, its 4 m would run below the ground instead.
  ag.geomFor = async (model: string) => model === "zz/stump.glb"
    ? { bbox: { min: [-0.5, -0.5, 0], max: [0.5, 0.5, 1], size: [1, 1, 1] } }
    : { bbox: { min: [-1, 0, -0.5], max: [1, 0.5, 0.5], size: [2, 0.5, 1] } };
  ag.entities.set("stump", { id: "stump", model: "zz/stump.glb", kind: "thing", pos: [6, 0, 0], yaw: 0, actor: "x", scale: 1, scale3: [1, 1, -4], q: [-s, 0, 0, s] });
  await ag.syncSupport("stump");
  let g2: number | null = null;
  for (let i = 0; i < 50 && !near(g2, 4); i++) { await new Promise((r) => setTimeout(r, 10)); g2 = groundAt(6, 4.05, 0); }
  check("...and one mirrored along its length stands at its size, as unmirrored", near(g2, 4), String(g2));
  ag.dropSupport("stump");
}

console.log("a summary's floors");
{
  // A 6 × 3 × 6 m building whose summary has one deck at 1.5 m, mirrored in x. A mirrored axis is its size, so the
  // building is room-scale and its deck holds a body; read signed, it was a 3 m pillar where its floor is.
  const ag: any = new WorldAgent({ name: "visitor", world: "w" });
  ag.entities.set("hall", { id: "hall", model: "zz/hall.glb", kind: "thing", pos: [30, 0, 0], yaw: 0, actor: "x", scale: 1, scale3: [-1, 1, 1] });
  ag.geomFor = async () => ({ bbox: { min: [-3, 0, -3], max: [3, 3, 3], size: [6, 3, 6] }, topSurfaces: [{ x: [-3, 3], z: [-3, 3], y: 1.5, area: 36 }] });
  ag.meshFor = async () => null;
  await ag.syncSupport("hall");
  let g: number | null = null;
  for (let i = 0; i < 50 && !near(g, 1.5); i++) { await new Promise((r) => setTimeout(r, 10)); g = groundAt(32, 1.55, 2); }
  check("a mirrored building's summary deck holds a body on its floor", near(g, 1.5), String(g));
  ag.dropSupport("hall");
  // mirrored in height: its height is its size too, so it is still room-scale, and its deck holds
  ag.entities.set("hall2", { id: "hall2", model: "zz/hall.glb", kind: "thing", pos: [40, 0, 0], yaw: 0, actor: "x", scale: -1, scale3: [1, -1, 1] });
  await ag.syncSupport("hall2");
  let g2: number | null = null;
  for (let i = 0; i < 50 && !near(g2, 1.5); i++) { await new Promise((r) => setTimeout(r, 10)); g2 = groundAt(42, 1.55, 2); }
  check("...and so does one mirrored in height", near(g2, 1.5), String(g2));
  ag.dropSupport("hall2");
}
{
  // A rubble pile (2 × 0.4 × 2 m, its box top 0.4 m above cells at 0.15 m, lie 0.2 m) mirrored in height. Its lie is its
  // size, so it is uneven and gets its heightfield, never its box top, which floats a body over the rubble.
  const ag: any = new WorldAgent({ name: "visitor", world: "w" });
  const pile = (certSpread: number) => ({
    bbox: { min: [-1, 0, -1], max: [1, 0.4, 1], size: [2, 0.4, 2] }, lie: 0.2,
    topGrid: { ...gridOf(() => 0.15), certSpread },
  });
  ag.meshFor = async () => null;
  ag.geomFor = async () => pile(0.01);
  ag.entities.set("rubble", { id: "rubble", model: "zz/rubble.glb", kind: "thing", pos: [50, 0, 0], yaw: 0, actor: "x", scale: -1, scale3: [1, -1, 1] });
  await ag.syncSupport("rubble");
  let g: number | null = null;
  for (let i = 0; i < 50 && !near(g, 0.15); i++) { await new Promise((r) => setTimeout(r, 10)); g = groundAt(50, 0.45, 0); }
  check("rubble mirrored in height stands a body on its cells, not its box top", near(g, 0.15), String(g));
  ag.dropSupport("rubble");
  // stretched ×2 in height and mirrored, a grid certified to 3 cm is 6 cm in the world, past the agreed 5 cm: abstain
  ag.geomFor = async () => pile(0.03);
  ag.entities.set("rubble2", { id: "rubble2", model: "zz/rubble.glb", kind: "thing", pos: [60, 0, 0], yaw: 0, actor: "x", scale: -2, scale3: [1, -2, 1] });
  await ag.syncSupport("rubble2");   // a heightfield is fitted before syncSupport returns, so its absence is final here
  const g2 = groundAt(60, 0.85, 0);
  check("...and one stretched past its certification in height abstains, as unmirrored", near(g2, 0), String(g2));
  ag.dropSupport("rubble2");
}

console.log(failures ? `\x1b[31m${failures} failed\x1b[0m` : "\x1b[32mall checks passed\x1b[0m");
process.exit(failures ? 1 : 0);
