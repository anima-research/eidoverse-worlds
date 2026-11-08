// compose-test — one thing carrying several components (Mica 11-04: "component bags should compose"): model + mesh + light
// + socket on one entity, each realized on its own, none deciding the others away; the gate takes it, capacity counts it
// once (and as a socket), delete takes all of it, a late join folds and realizes the same; labels read the components.
//
//   BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun tools/compose-test.ts
//
// The realizer is the real client/lib/realize/models.js over tools/lod-client-stub.mjs (as components-wire-test runs it).
import "./protocol/fixture-ids.ts";
import { plugin } from "bun";
import { fileURLToPath } from "node:url";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const STUB = fileURLToPath(new URL("./unknown-comp-stub.mjs", import.meta.url));
const SPY = fileURLToPath(new URL("./unknown-comp-report-spy.mjs", import.meta.url));
plugin({
  name: "compose-stub",
  setup(b) {
    for (const f of ["^\\.\\./(core|assets|colliders|lightrig|lights|world|materials)\\.js$", "^\\./(core|world|colliders|remotes)\\.js$"]) b.onResolve({ filter: new RegExp(f) }, () => ({ path: STUB }));
    b.onResolve({ filter: /^\.\.\/base\.js$/ }, (args) => (args.importer.replace(/\\/g, "/").endsWith("realize/models.js") ? { path: SPY } : undefined));
  },
});
process.env.WORLDS_DIR = join(mkdtempSync(join(tmpdir(), "ew-compose-")), "worlds");

let passed = 0, failed = 0;
const check = (name: string, ok: boolean, detail: unknown = "") => {
  if (ok) { passed++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  else { failed++; console.log(`  \x1b[31m✗\x1b[0m ${name}\n      ${typeof detail === "string" ? detail : JSON.stringify(detail)}`); }
};
const LAMP = "eidoverse/assets/models/lamp.glb";
const stub: any = await import("./unknown-comp-stub.mjs");
const M: any = await import("../client/lib/realize/models.js");
const S: any = await import("../client/lib/state.js");
const spy: any = await import("./unknown-comp-report-spy.mjs");
const { kindHint } = await import("../shared/hierarchy.js");
const { tryUntil } = await import("./protocol/wait.ts");
// every load landed and every promote tail drained
const settle = () => tryUntil("the realizer settles", () => { M.residencySweep(); M.drainPromoteTail(); return M.residencyDebug().loading === 0 && M.promoteTailPending() === 0; }, { ms: 5000, step: 15 });
const part = (o: any) => o?.children?.find((c: any) => c.userData?.meshPart);
const rq = (id: string) => stub.lightRequests.get(`complight:${id}`);
const gizmo = (o: any) => !!o?.children?.some((c: any) => c.userData?.gizmo);

console.log("\nthe renderer (client/lib/realize/models.js)");
const MIXED = { model: LAMP, pos: [0, 0, 0], parent: { to: "host", offset: [0, 1, 0] }, mesh: { shape: "box", size: [0.5, 0.5, 0.5] }, light: { intensity: 4 }, socket: { name: "perch" } };
const view0: any = { entities: {
  host: { model: "eidoverse/assets/models/crate.glb", pos: [0, 0, 0] },
  mixed: MIXED,
  meshbulb: { pos: [12, 0, 0], mesh: { shape: "sphere", size: [1, 1, 1] }, light: { intensity: 3 } },
} };
M.initModelsRealizer();
S.hydrate(structuredClone(view0));
await settle();
const mixed = stub.entities.get("mixed"), mb = stub.entities.get("meshbulb");
check("model + mesh + light + socket on one thing: the model loads, the mesh is drawn on it, it is a socket, and the light rides it",
  !!mixed?.userData?.lib && part(mixed)?.userData.meshShape === "box" && mixed.userData.socket === true && rq("mixed")?.obj === mixed && rq("mixed").intensity === 4 && mixed.userData.empty === false,
  { lib: mixed?.userData?.lib, part: part(mixed)?.userData, socket: mixed?.userData?.socket, light: !!rq("mixed") });
check("…it draws, so it wears no light gizmo and holds a caster slot (riding its host, it collides as the host)", !gizmo(mixed) && stub.casters.has("mixed") && !stub.colliders.has("mixed"),
  stub.colliderLog.filter((e: any) => e[1] === "mixed"));
check("a mesh beside a light (no model): a frame drawing its mesh, lit, with a collider and no gizmo",
  !!mb && mb.isGroup && part(mb)?.userData.meshShape === "sphere" && mb.userData.empty === false && rq("meshbulb")?.obj === mb && stub.colliders.has("meshbulb") && !gizmo(mb),
  { part: part(mb)?.userData, empty: mb?.userData?.empty, collider: stub.colliders.has("meshbulb") });
{ const v = structuredClone(view0); v.entities.meshbulb.mesh = { shape: "box", size: [2, 1, 2] }; S.applyView(v); }
check("…a reshaped mesh is reshaped in place (the same frame and the same part)", stub.entities.get("meshbulb") === mb && part(mb)?.userData.meshShape === "box" && part(mb)?.userData.meshSize?.[0] === 2, part(mb)?.userData);
{ const v = structuredClone(view0); delete v.entities.meshbulb.mesh; S.applyView(v); }
check("…its mesh leaving makes it a bulb in place: the same frame, an Empty, its gizmo on, its collider gone, its light kept",
  stub.entities.get("meshbulb") === mb && !part(mb) && mb.userData.empty === true && gizmo(mb) && !stub.colliders.has("meshbulb") && rq("meshbulb")?.obj === mb,
  { same: stub.entities.get("meshbulb") === mb, empty: mb?.userData?.empty, collider: stub.colliders.has("meshbulb") });
{ const v = structuredClone(view0); delete v.entities.meshbulb.mesh; delete v.entities.mixed.socket; S.applyView(v); }
check("a socket leaving is the socket flag off on the same object; the model, the mesh and the light stay", stub.entities.get("mixed") === mixed && !mixed.userData.socket && !!part(mixed) && rq("mixed")?.obj === mixed);
check("the realizer reported nothing", spy.reports.length === 0, spy.reports);

console.log("\nthe door, capacity, delete and a late join agree (a scratch world behind the real authority)");
{
  const { scratchWorld } = await import("./protocol/scratchworld.ts");
  const { openWorld } = await import("../server/filehost.ts");
  const { viewState } = await import("../shared/protocol/view.js");
  const { SOCKETS_PER_HOST } = await import("../shared/protocol/authority/sockets.js");
  S.reset();
  const W: any = scratchWorld("compose");
  W.seed({ host: { model: "eidoverse/assets/models/crate.glb", pos: [0, 0, 0] } });
  const comps = { transform: { pos: [0, 1, 0] }, parent: { to: "host" }, mesh: { shape: "box", size: [0.5, 0.5, 0.5] }, light: { intensity: 4 }, socket: { name: "perch" } };
  const made = W.call("create", { id: "mixed", model: LAMP, components: comps });
  const c = W.state().entities.mixed?.c;
  check("the gate takes model + mesh + light + socket on one thing (no one-place refusal)", made.ok && c?.model === LAMP && !!c?.mesh && !!c?.light && c?.socket?.name === "perch", made.refused ?? c);
  S.hydrate(structuredClone(W.view())); await settle();
  const live = stub.entities.get("mixed");
  check("…and the renderer draws all of it", !!live?.userData?.lib && !!part(live) && live.userData.socket === true && rq("mixed")?.obj === live);
  // capacity: one entity, and one of its host's sockets (capacity.js counts by component presence: isSocketC)
  const n = Object.keys(W.state().entities).length - 1;
  W.call("set", { id: "@world", component: "capacity", value: { entities: n } });
  const full = W.call("create", { components: { transform: { pos: [5, 0, 5] } } });
  check("capacity counts the composed thing as one entity", !full.ok && full.refused?.code === "full" && full.refused?.entities === n, full.refused);
  W.call("set", { id: "@world", component: "capacity", value: { entities: 500 } });
  const socks = Array.from({ length: SOCKETS_PER_HOST - 1 }, (_, i) => ({ verb: "create", args: { components: { transform: { pos: [0, 0.5, 0] }, parent: { to: "host" }, socket: { name: `s${i}` } } } }));
  const fill = W.call("batch", { requests: socks });
  const over = W.call("create", { components: { transform: { pos: [0, 0.5, 0] }, parent: { to: "host" }, socket: { name: "one-more" } } });
  check(`…and as one of its host's sockets: ${SOCKETS_PER_HOST - 1} more fill the host, the next is refused`, fill.ok && !over.ok && over.refused?.code === "full" && over.refused?.sockets === SOCKETS_PER_HOST, [fill.refused ?? "ok", over.refused]);
  // a late join: the log folded again from disk is the same thing, realized the same way
  const reread = openWorld(W.root, W.name).state().entities.mixed?.c;
  S.applyView(structuredClone(W.view())); await settle();
  const before = { lib: live.userData.lib, part: part(live)?.userData.key, socket: live.userData.socket, light: rq("mixed")?.intensity };
  S.reset(); S.hydrate(viewState(openWorld(W.root, W.name).state())); await settle();
  const late = stub.entities.get("mixed");
  const after = { lib: late?.userData?.lib, part: part(late)?.userData.key, socket: late?.userData?.socket, light: rq("mixed")?.intensity };
  check("a late join folds the same record and realizes it the same way", JSON.stringify(reread) === JSON.stringify(W.state().entities.mixed?.c) && late !== live && JSON.stringify(after) === JSON.stringify(before), { before, after });
  // delete: the thing and every component go, at the door and on screen
  const del = W.call("delete", { id: "mixed" }); S.applyView(structuredClone(W.view())); await settle();
  check("delete takes the whole thing: gone from the fold, no object, no light, no caster, no mesh left in the scene",
    del.ok && !W.state().entities.mixed && !stub.entities.has("mixed") && !rq("mixed") && !stub.casters.has("mixed") && !part(late?.parent ? late : null) && !late?.parent,
    { ok: del.ok, refused: del.refused, has: stub.entities.has("mixed"), light: !!rq("mixed") });
}

console.log("\nlabels read the components (shared/hierarchy.js kindHint)");
check("kindHint names every component it carries", kindHint(MIXED) === "lamp + box + light + attach", kindHint(MIXED));
check("…a bulb, a bare thing, a socket", kindHint({ light: {} }) === "light" && kindHint({ pos: [0, 0, 0] }) === "empty" && kindHint({ socket: { name: "s" }, station: { action: "sit" } }) === "station",
  [kindHint({ light: {} }), kindHint({ pos: [0, 0, 0] }), kindHint({ socket: { name: "s" }, station: { action: "sit" } })]);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
