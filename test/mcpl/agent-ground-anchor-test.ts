// A structure's anchor model is not support for an agent's body — tested headless.
//
//   BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun test/mcpl/agent-ground-anchor-test.ts
//
// A `structure` entity's model is only its anchor: the browser fits it no collider (client/lib/realize/models_field.js
// collisionOwnedElsewhere; test/client/models-field-test.ts §8), and the agent's syncSupport (mcpl/agent-ground.ts) must
// register no support for it either. Drives the agent's own syncSupport and comp event, geometry stubbed.

import { noWorldUrl } from "../harness/no-world.ts";
import { WorldAgent } from "../../mcpl/agent.ts";
import { supportHolders, supportShape } from "../../mcpl/physics.ts";
import { tryUntil } from "../gate/wait.ts";
import { suite } from "../gate/suite.ts";
// registration is detached and waits for the sim to load (seconds, the first time): wait for the box itself
const registered = async (bid: string) => !!(await tryUntil(`support ${bid}`, () => supportHolders()[bid], { ms: 15000 }));
// a refusal or a drop has nothing to wait for: a plain crate synced after it takes the same detached path (one
// `await loadSim()`, resumed in call order), so once its box lands any registration or removal issued before it has
// landed too (false if it never does: the row goes red, not vacuously green)
let sentinels = 0;
const settled = async () => {
  const id = `sentinel${++sentinels}`;
  ag.entities.set(id, { id, model: "crate.glb", pos: [100 + 10 * sentinels, 0, 0], yaw: 0, actor: "x" });
  await ag.ground.syncSupport(id);
  return registered(`anchor/${id}`);
};

const { check, done } = suite("agent-ground-anchor");

const ag: any = new WorldAgent({ url: noWorldUrl(), name: "anchor-bot", world: "anchor" });
const crateGeom = { bbox: { min: [-1.25, 0, -0.75], max: [1.25, 2, 0.75], size: [2.5, 2, 1.5] }, topSurfaces: [] };
// rug.glb: floor-shaped with a lying box top, so it takes the grid path; `onFit` runs when the fit reads the grid (in flight)
let onFit: (() => void) | null = null;
const rugTop = new Proxy({ version: 1, n: 24, minXZ: [-1.25, -0.75], sizeXZ: [2.5, 1.5], lie: 0.2, certSpread: 0.02, cells: Array(24 * 24).fill(0.3) },
  { get(t: any, k) { if (k === "version" && onFit) { const f = onFit; onFit = null; f(); } return t[k]; } });
const rugGeom = { bbox: { min: [-1.25, 0, -0.75], max: [1.25, 0.3, 0.75], size: [2.5, 0.3, 1.5] }, topSurfaces: [], lie: 0.2, topGrid: rugTop };
// held.glb: its geometry answers only when the row releases it
let release = null as (() => void) | null;
ag.ground.geomFor = async (lib: string) => lib === "rug.glb" ? rugGeom : lib === "held.glb" ? new Promise((r) => { release = () => r(crateGeom); }) : crateGeom;
const becomeAnchor = (id: string) => {
  ag.entities.get(id).structure = { levels: [{ y: 0, tiles: [[0, 0]] }] };
  ag.onThingChange({ id, what: "comp", comp: "structure" }, null, true, "x", Date.now());
};
console.log("an agent's support for a structure's anchor:");

// a plain crate is a 2 m deck (the control: the stub and the registry work)
ag.entities.set("crate", { id: "crate", model: "crate.glb", pos: [10, 0, 0], yaw: 0, actor: "x" });
await ag.ground.syncSupport("crate");
const C: any = await import("../../client/lib/colliders.js");   // after the agent has loaded physics (its core shim)
check("(control) a plain crate registers support", await registered("anchor/crate"), JSON.stringify(Object.keys(supportHolders())));

// the same model carrying a structure is only an anchor
ag.entities.set("cabin", { id: "cabin", model: "crate.glb", pos: [30, 0, 0], yaw: 0, actor: "x", structure: { levels: [{ y: 0, tiles: [[0, 0]] }] } });
await ag.ground.syncSupport("cabin");
check("a structure's anchor registers none", await settled() && !supportHolders()["anchor/cabin"], JSON.stringify(Object.keys(supportHolders())));
const on = C.surfaceUnder(30, 0, () => 0);
check("…so nothing stands 2 m up at the building's origin", on.onto === null && on.y === 0, JSON.stringify(on));

// a crate that gains a structure after it landed drops the support it had
ag.entities.set("late", { id: "late", model: "crate.glb", pos: [50, 0, 0], yaw: 0, actor: "x" });
await ag.ground.syncSupport("late"); const lateHad = await registered("anchor/late");
ag.entities.get("late").structure = { levels: [{ y: 0, tiles: [[0, 0]] }] };
await ag.ground.syncSupport("late");
check("a crate that becomes a structure's anchor drops its support", lateHad && await settled() && !supportHolders()["anchor/late"], JSON.stringify(Object.keys(supportHolders())));

// the same, through the comp event the agent folds (not a direct syncSupport): a structure set, then removed
ag.entities.set("evt", { id: "evt", model: "crate.glb", pos: [70, 0, 0], yaw: 0, actor: "x" });
await ag.ground.syncSupport("evt"); const evtHad = await registered("anchor/evt");
ag.entities.get("evt").structure = { levels: [{ y: 0, tiles: [[0, 0]] }] };
ag.onThingChange({ id: "evt", what: "comp", comp: "structure" }, null, true, "x", Date.now());
await ag.ground.supportReady();   // the comp event's syncSupport is tracked: wait for it, then settled() for its drop
check("a structure comp event drops the anchor's support", evtHad && await settled() && !supportHolders()["anchor/evt"], JSON.stringify(Object.keys(supportHolders())));
delete ag.entities.get("evt").structure;
ag.onThingChange({ id: "evt", what: "comp", comp: "structure" }, null, true, "x", Date.now());
check("...and removing the structure makes it an ordinary crate again", await registered("anchor/evt"), JSON.stringify(Object.keys(supportHolders())));

// becoming an anchor while its geometry is in flight: the re-check after the fetch refuses it
ag.entities.set("pend", { id: "pend", model: "held.glb", pos: [130, 0, 0], yaw: 0, actor: "x" });
const pending = ag.ground.syncSupport("pend");
const held = !!release; becomeAnchor("pend"); release?.(); await pending;
check("a thing that becomes an anchor while its geometry is in flight registers none", held && await settled() && !supportHolders()["anchor/pend"], JSON.stringify(Object.keys(supportHolders())));

// ...and while its grid fit is in flight: the fit that lands is taken back out
ag.entities.set("rug", { id: "rug", model: "rug.glb", pos: [150, 0, 0], yaw: 0, actor: "x" });
await ag.ground.syncSupport("rug");
check("(control) a rug with a lying top registers grid support", await registered("anchor/rug") && supportShape("anchor/rug") === "grid", JSON.stringify(Object.keys(supportHolders())));
ag.entities.set("rug2", { id: "rug2", model: "rug.glb", pos: [170, 0, 0], yaw: 0, actor: "x" });
let fired = false; onFit = () => { fired = true; becomeAnchor("rug2"); };
await ag.ground.syncSupport("rug2");
check("a rug that becomes an anchor while its grid fit is in flight keeps none", fired && await settled() && !supportHolders()["anchor/rug2"] && !ag.ground.supportIds.has("rug2"), JSON.stringify(Object.keys(supportHolders())));

done();
