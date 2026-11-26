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
// badrug.glb: the same rug, its grid one the fitter refuses (a version it doesn't read)
const badRugGeom = { ...rugGeom, topGrid: { version: 2, n: 24, minXZ: [-1.25, -0.75], sizeXZ: [2.5, 1.5], lie: 0.2, certSpread: 0.02, cells: Array(24 * 24).fill(0.3) } };
// held.glb: its geometry answers only when the row releases it; flaky.glb: answers until `flaky` is set, then fails
// every held read is kept and released together: a second read of held.glb must not strand the first
const held: (() => void)[] = []; let flaky = false;
ag.ground.geomFor = async (lib: string) => lib === "rug.glb" ? rugGeom : lib === "badrug.glb" ? badRugGeom
  : lib === "held.glb" ? new Promise((r) => { held.push(() => r(crateGeom)); }) : lib === "flaky.glb" ? (flaky ? null : crateGeom)
  : lib === "nogeom.glb" ? null : crateGeom;
// no model's bytes are served here (noWorldUrl answers 404): the summary path, at once rather than after a round trip
ag.ground.meshFor = async () => null;
const becomeAnchor = (id: string) => {
  ag.entities.get(id).structure = { levels: [{ y: 0, tiles: [[0, 0]] }] };
  ag.onThingChange({ id, what: "comp", comp: "structure" }, null, true, "x", Date.now());
};
console.log("an agent's support for a structure's anchor:");

// #347 bot 2 (first, while the sim is still loading, so each grid fit waits there: `overlapped` checks it did): a later sync of the same thing
// reuses its bid, so a reservation is told apart by more than the bid. Each rug is resized (scale3, its lie under the
// uneven line) once its grid fit is waiting, and the second sync registers a plain box under the same bid.
const resizedWhileFitting = async (id: string, model: string, x: number) => {
  ag.entities.set(id, { id, model, pos: [x, 0, 0], yaw: 0, actor: "x" });
  let oldDone = false;
  const old = ag.ground.syncSupport(id).then(() => { oldDone = true; });
  // microtasks only, from here to the second sync's end: the sim's load (file reads) can't land in between
  for (let n = 0; n < 1000 && !ag.ground.supportIds.has(id); n++) await null;
  const reserved = ag.ground.supportIds.has(id);
  ag.entities.get(id).scale3 = [1, 0.4, 1];
  await ag.ground.syncSupport(id);
  const overlapped = reserved && !oldDone;   // the later sync finished while the old fit still waited
  await old;
  return overlapped;
};
const [badOverlap, goodOverlap] = await Promise.all([resizedWhileFitting("bad", "badrug.glb", 190), resizedWhileFitting("good", "rug.glb", 210)]);
const ids = () => JSON.stringify({ holders: Object.keys(supportHolders()), supportIds: [...ag.ground.supportIds] });
check("a refused grid fit overtaken by a resize leaves the newer box registered and tracked (no ghost)",
  badOverlap && await settled() && !!supportHolders()["anchor/bad"] && !!ag.ground.supportIds.get("bad")?.includes("anchor/bad"), ids());
check("a grid fit that landed, overtaken by a resize, doesn't take out the newer box under its bid",
  goodOverlap && await settled() && !!supportHolders()["anchor/good"] && supportShape("anchor/good") !== "grid" && !!ag.ground.supportIds.get("good")?.includes("anchor/good"), ids());

// a plain crate is a 2 m deck (the control: the stub and the registry work, and the box is a real one to stand on)
ag.entities.set("crate", { id: "crate", model: "crate.glb", pos: [10, 0, 0], yaw: 0, actor: "x" });
await ag.ground.syncSupport("crate");
const C: any = await import("../../client/lib/colliders.js");   // after the agent has loaded physics (its core shim)
const deck = (x: number) => C.surfaceUnder(x, 0, () => 0);
check("(control) a plain crate registers support: a box whose top stands 2 m up", await registered("anchor/crate") && deck(10).onto != null && Math.abs(deck(10).y - 2) < 1e-6,
  JSON.stringify({ holders: Object.keys(supportHolders()), on: deck(10) }));

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
check("...and removing the structure makes it an ordinary crate again, 2 m up", await registered("anchor/evt") && Math.abs(deck(70).y - 2) < 1e-6, JSON.stringify({ holders: Object.keys(supportHolders()), on: deck(70) }));

// #347 bot 9: the drop before the fetch. With no geometry to be had the sync returns before its re-check, so the
// structure event's only drop is the one issued before it asks
ag.entities.set("nullg", { id: "nullg", model: "flaky.glb", pos: [230, 0, 0], yaw: 0, actor: "x" });
await ag.ground.syncSupport("nullg"); const nullHad = await registered("anchor/nullg");
flaky = true; becomeAnchor("nullg");
await ag.ground.supportReady();
check("a thing that becomes an anchor while its geometry can't be read still drops its support", nullHad && await settled() && !supportHolders()["anchor/nullg"], JSON.stringify(Object.keys(supportHolders())));

// becoming an anchor while its geometry is in flight: the re-check after the fetch refuses it
ag.entities.set("pend", { id: "pend", model: "held.glb", pos: [130, 0, 0], yaw: 0, actor: "x" });
const pending = ag.ground.syncSupport("pend");
const wasHeld = held.length === 1; becomeAnchor("pend"); const reads = held.length; held.splice(0).forEach((r) => r()); await pending;
check("a thing that becomes an anchor while its geometry is in flight registers none, and its event asks no second time", wasHeld && reads === 1 && await settled() && !supportHolders()["anchor/pend"], JSON.stringify(Object.keys(supportHolders())));

// ...and while its grid fit is in flight: the fit that lands is taken back out
ag.entities.set("rug", { id: "rug", model: "rug.glb", pos: [150, 0, 0], yaw: 0, actor: "x" });
await ag.ground.syncSupport("rug");
check("(control) a rug with a lying top registers grid support", await registered("anchor/rug") && supportShape("anchor/rug") === "grid", JSON.stringify(Object.keys(supportHolders())));
ag.entities.set("rug2", { id: "rug2", model: "rug.glb", pos: [170, 0, 0], yaw: 0, actor: "x" });
// (#347 bot 6) the event comes once the fit has landed, its holder added, before the sync resumes from its await
let landedFirst = false; onFit = () => queueMicrotask(() => { landedFirst = !!supportHolders()["anchor/rug2"]; becomeAnchor("rug2"); });
await ag.ground.syncSupport("rug2");
check("a rug that becomes an anchor while its grid fit is in flight keeps none", landedFirst && await settled() && !supportHolders()["anchor/rug2"] && !ag.ground.supportIds.has("rug2"), JSON.stringify(Object.keys(supportHolders())));

// (#347 cold read) a fit in flight overtaken with no drop of its own: the thing vanishes with no "gone" (a rejoin's
// snapshot clears the entities and folds the new cut from an empty view, agent.ts), or it is respawned as a model whose
// geometry can't be read (a new record, as the fold writes one; that sync returns before dropping). Only overtaken's
// own drop takes the landed fit back out.
for (const [what, id, x, overtake] of [
  ["vanishes without a gone event", "rug3", 250, (id: string) => ag.entities.delete(id)],
  ["is respawned as a model whose geometry can't be read", "rug4", 270, (id: string) => {
    ag.entities.set(id, { ...ag.entities.get(id), model: "nogeom.glb" }); ag.onThingChange({ id, what: "born" }, null, false, "x", Date.now()); }],
] as const) {
  ag.entities.set(id, { id, model: "rug.glb", pos: [x, 0, 0], yaw: 0, actor: "x" });
  let landed = false; onFit = () => queueMicrotask(() => { landed = !!supportHolders()[`anchor/${id}`]; overtake(id); });
  await ag.ground.syncSupport(id); await ag.ground.supportReady();
  check(`a rug whose grid fit is in flight when it ${what} keeps none`, landed && await settled() && !supportHolders()[`anchor/${id}`] && !ag.ground.supportIds.has(id),
    JSON.stringify(Object.keys(supportHolders())));
}

// (#347 reader) an anchor still reads its model's own description: its places (the model's `building` extras, read
// with its bytes by meshFor, the only reader), though it stands on nothing. The two-storey fixture declares an arrival
// `outside`, listed as the place `entrance`; no other thing here has loaded the model first.
{
  const { buildGlb, boxes, building } = await import("../fixtures/two-storey-fixture.ts");
  const glb = await buildGlb(boxes, { building });
  const lib = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (r) => /^\/library\/fixtures\/tower[0-9]*\.glb$/.test(new URL(r.url).pathname) ? new Response(glb) : new Response("", { status: 404 }) });
  const towerAg: any = new WorldAgent({ url: `ws://127.0.0.1:${lib.port}/ws`, name: "places-bot", world: "anchor" });
  towerAg.entities.set("hut", { id: "hut", model: "fixtures/tower.glb", pos: [300, 0, 0], yaw: 0, actor: "x",
    structure: { levels: [{ y: 0, tiles: [[0, 0]] }] }, places: { yard: { at: [0, 0, 8] } } });
  await towerAg.ground.syncSupport("hut"); await towerAg.ground.modelRead("fixtures/tower.glb");   // read beside the sync, not in it
  const names = towerAg.placesOn(towerAg.entities.get("hut")).map((p: any) => p.name).sort();
  check("an anchor whose model nobody loaded first lists the model's places (entrance) beside its own (yard), and has no support",
    names.includes("entrance") && names.includes("yard") && !towerAg.ground.supportIds.has("hut") && !supportHolders()["anchor/hut"], JSON.stringify({ names, holders: Object.keys(supportHolders()) }));
  // the same for a thing with its collision off (it read no bytes on main either): a model of its own, also loaded first here
  towerAg.entities.set("shed", { id: "shed", model: "fixtures/tower2.glb", pos: [320, 0, 0], yaw: 0, actor: "x", collider: { enabled: false } });
  await towerAg.ground.syncSupport("shed"); await towerAg.ground.modelRead("fixtures/tower2.glb");
  const shed = towerAg.placesOn(towerAg.entities.get("shed")).map((p: any) => p.name);
  check("...and so does a thing with its collision off", shed.includes("entrance") && !towerAg.ground.supportIds.has("shed"), JSON.stringify(shed));
  lib.stop(true);
}

// (#347 round 5) a thing nobody stands on has its model read for its places in a lane that real fits pass, never
// awaited by the sync or supportReady. Three collision-off things whose models are held at the server, synced ahead
// of a plain floor: the floor's model is read and supportReady answers while all three are still held.
{
  const { buildGlb } = await import("../fixtures/two-storey-fixture.ts");
  const glb = await buildGlb([[-2, 0, -2, 2, 0.2, 2]]);
  const heldDeco: (() => void)[] = [], fetched: Record<string, number> = {}; let letGo = false;
  const srv = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(r) {
    const p = new URL(r.url).pathname; fetched[p] = (fetched[p] ?? 0) + 1;
    if (p.startsWith("/library/lane/deco")) { if (!letGo) await new Promise<void>((go) => heldDeco.push(go)); return new Response(glb); }
    if (p === "/library/lane/floor.glb" || p === "/library/lane/shared.glb") return new Response(glb);
    return new Response("", { status: 404 });
  } });
  const q: any = new WorldAgent({ url: `ws://127.0.0.1:${srv.port}/ws`, name: "lane-bot", world: "lane" });
  q.ground.geomFor = async () => null;   // the mesh alone: what's measured is the queue
  for (let i = 1; i <= 3; i++) q.entities.set(`d${i}`, { id: `d${i}`, model: `lane/deco${i}.glb`, pos: [400 + i * 10, 0, 0], yaw: 0, actor: "x", collider: { enabled: false } });
  q.entities.set("floor", { id: "floor", model: "lane/floor.glb", pos: [400, 0, 0], yaw: 0, actor: "x" });
  // and a model first asked for in the lane (by a collision-off thing, queued behind the held ones), then by a fit
  q.entities.set("d4", { id: "d4", model: "lane/shared.glb", pos: [450, 0, 0], yaw: 0, actor: "x", collider: { enabled: false } });
  q.entities.set("plain", { id: "plain", model: "lane/shared.glb", pos: [460, 0, 0], yaw: 0, actor: "x" });
  for (const id of ["d1", "d2", "d3", "d4", "floor", "plain"]) q.ground.trackSupport(q.ground.syncSupport(id));
  // supportReady's own bound (3 s) is the deadline: a floor queued behind the held reads leaves its sync pending
  await q.ground.supportReady(3000);
  const held = heldDeco.length;
  check("a floor synced behind three collision-off things whose models are held is fitted, and supportReady answers, while they still wait",
    q.ground.supportPending.size === 0 && held > 0 && !!supportHolders()["lane/floor"], JSON.stringify({ pending: q.ground.supportPending.size, held, fetched, floor: !!supportHolders()["lane/floor"] }));
  check("...and a fit of a model whose read was waiting in the lane takes it out of the lane (fitted while the held ones wait)",
    held > 0 && !!supportHolders()["lane/plain"], JSON.stringify({ held, fetched, plain: !!supportHolders()["lane/plain"] }));
  // let go: the held ones answer, and any asked for from here answers at once
  letGo = true; heldDeco.splice(0).forEach((go) => go());
  for (let i = 1; i <= 3; i++) await q.ground.modelRead(`lane/deco${i}.glb`);
  const { meshGovernor } = await import("../../mcpl/agent-ground.ts");
  check("...and once let go, every read lands and nothing is left in either lane", meshGovernor.active === 0 && meshGovernor.queued === 0 && meshGovernor.metaActive === 0,
    JSON.stringify({ active: meshGovernor.active, queued: meshGovernor.queued, meta: meshGovernor.metaActive }));
  // a model that can't be read is asked for once in a while, not once per sync: twenty collision-off things share one
  for (let i = 1; i <= 20; i++) { q.entities.set(`b${i}`, { id: `b${i}`, model: "lane/bad.glb", pos: [400, 0, 50 + i], yaw: 0, actor: "x", collider: { enabled: false } });
    await q.ground.syncSupport(`b${i}`); await q.ground.modelRead("lane/bad.glb"); }
  check("twenty things sharing a model that can't be read (404) fetch it once", fetched["/library/lane/bad.glb"] === 1, JSON.stringify(fetched));
  q.close(); srv.stop(true);
}

done();
