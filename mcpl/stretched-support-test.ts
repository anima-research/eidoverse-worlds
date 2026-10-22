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
 * (a negative scale) is read as its size, as componentspec says physics does.
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
  await registerSupport(HOLDER, "w/tall", [-1, 0, -1], [1, 1, 1], { ...at, scale: 1, scale3: [1, 2, 1] });
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
  await registerSupport(HOLDER, "w/mirror", [-1, 0, -1], [1, 1, 1], { ...at, scale: 1, scale3: [-1, 2, 1] });
  const g = groundAt(0, 2.05, 0);
  check("a mirrored, stretched box still holds a body, at its drawn top", near(g, 2), String(g));
  await removeSupport(HOLDER, "w/mirror");
}

console.log("heightfield");
{
  // a 2 × 2 m grid, every cell's top at 0.5, stretched ×2 in height
  const grid = {
    version: TOPGRID_VERSION, n: LIE_GRID, minXZ: [-1, -1], sizeXZ: [2, 2], lie: 0.2, certSpread: 0.01,
    cells: Array.from({ length: LIE_GRID * LIE_GRID }, () => 0.5),
  };
  const ok = await registerSupportGrid(HOLDER, "w/grid", grid, { ...at, scale: 1, scale3: [1, 2, 1] });
  const g = groundAt(0, 1.05, 0);
  check("a stretched heightfield is fitted", ok === true);
  check("...and holds a body at its drawn cell tops", near(g, 1), String(g));
  await removeSupport(HOLDER, "w/grid");
}

console.log("triangles");
{
  const { pos, idx } = boxMesh([[-1, 0, -1, 1, 1, 1]]);
  const mesh = { positions: new Float32Array(pos), indices: new Uint32Array(idx) };
  const ok = await registerMeshSupport(HOLDER, "w/mesh", mesh, { ...at, scale: 1, scale3: [1, 2, 1], collide: "exact", model: "zz/box.glb" });
  const g = groundAt(0, 2.05, 0);
  check("a stretched mesh is fitted", ok === true);
  check("...and holds a body at its drawn top", near(g, 2), String(g));
  // the same model unstretched, beside it, still stands at its own height: the stretch stayed in its copy
  const ok2 = await registerMeshSupport(HOLDER, "w/mesh-plain", mesh, { position: [5, 0, 0], yaw: 0, scale: 1, collide: "exact", model: "zz/box.glb" });
  const g2 = groundAt(5, 1.05, 0);
  check("...and the same model unstretched stands at its own height", ok2 === true && near(g2, 1), String(g2));
  await removeSupport(HOLDER, "w/mesh");
  await removeSupport(HOLDER, "w/mesh-plain");
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
}

console.log(failures ? `\x1b[31m${failures} failed\x1b[0m` : "\x1b[32mall checks passed\x1b[0m");
process.exit(failures ? 1 : 0);
