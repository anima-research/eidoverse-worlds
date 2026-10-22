// editcommit — inspect.js commitEdit, headless, against the real authority.
//
//   BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun tools/editcommit-test.ts
//
// The client's half of the shared schema: a live call previews through the
// group's handler and never sends; the final call sends ONE door request whose
// `expect` names what it changes AS IT STOOD WHEN THE GESTURE BEGAN — the
// form of the "a scrub's before leaked into the next selection" bug the first
// review round found (v1 computed an undo inverse from it; now it is sent as
// expect, and the door refuses `changed` if someone wrote it since).
// tools/protocol/inspectharness.ts stubs the page (the realized world, the wire to the
// scratch door, the dialogs); inspect.js, editwrites.js, the schema and the door are real.
//
// the protocol port (2026-10-06): the client-side undo stack of inverses and the light coalescer are gone (undo is the door's,
// by act; a lamp is a light COMPONENT edited with set). Each old inverse check became either the expect the request
// carries (what it started from) or the door's undo of the act, read back.
import { inspectHarness } from "./protocol/inspectharness.ts";
import { qFromEuler, sameRotation } from "../shared/euler.js";
import { qFromYaw } from "../shared/rot.js";
import { socketMapIn } from "../shared/sockbody.js";
const H = inspectHarness("editcommit");
const { commitEdit, registerHandler, endGesture, schemaFor } = await import("../client/lib/inspect.js");
const Edits = await import("../client/lib/editwrites.js");

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  else { fail++; console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? ` — ${detail}` : ""}`); }
};
const previews: any[] = [];
registerHandler("light", (id: string, _obj: any, k: string, v: any, opts: any) => { if (!opts?.live) return false; previews.push({ id, k, v }); return true; });
registerHandler("sockets", (_id: string, _obj: any, k: string) => k === "add");   // a viewport gesture: handled, never sent
const { Object3D } = await import("../client/node_modules/three/build/three.module.js");
const realized = () => new Object3D();   // a pos edit is a live drag for everyone else: inspect.js reads the object's world pose
const c = (id: string) => H.W.state().entities[id]?.c;
// a thing's sockets are its socket children (PLAN-sockets-entities), read as the card's map
const socks = (id: string) => socketMapIn(H.W.state().entities, id) ?? {};
const last = () => H.sent.at(-1);
const expectOf = (req: any, comp: string) => req?.args?.expect?.find((x: any) => x.component === comp);

H.W.seed({
  lamp: { pos: [0, 2, 0], light: { color: 0xff8800, intensity: 16, range: 6 } },
  c1: { model: "chair.glb", pos: [1, 0, 2], yaw: 0, sockets: { seat: { pos: [0, 0.5, 0], body: {} } } },
});
H.sync();
H.entities.set("lamp", realized()); H.entities.set("c1", realized());

console.log("\nlive → preview only; final → one request whose expect is the gesture's start:");
{
  commitEdit("lamp", "light.intensity", 20, { live: true });
  commitEdit("lamp", "light.intensity", 24, { live: true });
  await H.flush();
  check("two live calls previewed and sent nothing", previews.length === 2 && H.sent.length === 0);
  H.other("set", { id: "lamp", component: "light", value: { ...c("lamp").light, intensity: 22 } });   // someone else writes mid-drag
  const r = commitEdit("lamp", "light.intensity", 24);
  await H.flush();
  const req = last();
  check("the final is ONE set light (intensity 24)", r.ok && H.sent.length === 1 && req.verb === "set" && req.args.component === "light" && req.args.value.intensity === 24, JSON.stringify(H.sent));
  check("its expect is the PRE-DRAG light (16), not the mid-drag one (22)", expectOf(req, "light")?.value?.intensity === 16, JSON.stringify(req.args.expect));
  check("…so the door refuses it `changed`, naming who wrote it, and nothing is written", c("lamp").light.intensity === 22 && H.toasts.some((t: string) => /changed/.test(t) && /bob/.test(t)), JSON.stringify(H.toasts));
}

console.log("\na gesture belongs to one id:");
{
  H.sent.length = 0;
  commitEdit("lamp", "light.range", 9, { live: true });       // a drag begins on the lamp
  commitEdit("c1", "sockets.seat|rot|1", 1);                   // …and c1 is edited before it ends (heading 1 rad)
  await H.flush();
  const req = last();
  check("c1's expect is computed from c1's own record (it stores no sockets map: its seats are children)", req?.args.id === "c1" && !!expectOf(req, "sockets") && !("value" in expectOf(req, "sockets")) && req.args.expect.every((x: any) => x.id === "c1"), JSON.stringify(req));
  check("…and the sent sockets merged from the record (yaw 1, pos kept), accepted", Math.abs(req.args.value.seat.q?.[1] - Math.sin(0.5)) < 1e-6 && req.args.value.seat.pos[1] === 0.5 && Math.abs(socks("c1").seat?.q?.[1] - Math.sin(0.5)) < 1e-6, JSON.stringify(socks("c1")));
  endGesture();
  H.other("set", { id: "lamp", component: "light", value: { ...c("lamp").light, range: 7 } });
  commitEdit("lamp", "light.range", 9);
  await H.flush();
  check("after endGesture (a selection change) the expect reads the CURRENT record (range 7), and the door takes it", expectOf(last(), "light")?.value?.range === 7 && c("lamp").light.range === 9, JSON.stringify([last(), c("lamp")]));
}

console.log("\nrefusals, gestures, and the door's undo of the other edits:");
{
  const n0 = H.sent.length;
  const r = commitEdit("c1", "sockets.add", 1);
  check("a viewport gesture is handled by the module and never sent", r.handled === true && H.sent.length === n0);
  H.W.call("set", { id: "c1", component: "lock", value: true }); H.sync();
  const asked = H.asked.length; H.choose = "cancel";
  const rl = commitEdit("c1", "pos.x", 3);
  await H.flush();
  check("a locked pose: the door refuses `locked`, I'm asked first, and cancel writes nothing", rl.ok && H.asked.length === asked + 1 && c("c1").transform.pos[0] === 1 && H.hints.some((t: string) => /cancelled/.test(t)), JSON.stringify({ rl, asked: H.asked.length, pos: c("c1").transform.pos }));
  H.W.call("delete", { id: "c1", component: "lock" }); H.sync();
  const rz = commitEdit("zz", "pos.x", 1);
  check("an id not in the fold refuses", !rz.ok && /not in the fold/.test(rz.errors[0]));
  // a component of my own carries a namespace (PROTOCOL §4): a bare name is refused at the door
  commitEdit("c1", "comp.example.org/recipe", '{"wood":2}');
  await H.flush();
  check("a new comp: one set recipe whose expect says it was ABSENT (no value)", last().args.component === "example.org/recipe" && expectOf(last(), "example.org/recipe") && !("value" in expectOf(last(), "example.org/recipe")) && c("c1")["example.org/recipe"]?.wood === 2, JSON.stringify(last()));
  commitEdit("c1", "comp.example.org/recipe", null);   // what the 'remove recipe' button sends
  await H.flush();
  check("removing it: delete recipe", last().verb === "delete" && last().args.component === "example.org/recipe" && c("c1")["example.org/recipe"] === undefined, JSON.stringify(last()));
  const u = await Edits.undo();
  check("…and Ctrl+Z (the door's undo of that act) restores {wood: 2}", u.ok && c("c1")["example.org/recipe"]?.wood === 2, JSON.stringify([u.refused, c("c1")]));
  H.W.call("set", { id: "c1", component: "motion", value: { type: "spin", degPerSec: 30, t0: 5 } }); H.sync();
  commitEdit("c1", "motion.rest", 1);
  await H.flush();
  const u2 = await Edits.undo();
  check("resting a motion is delete motion; its undo re-issues the whole motion with its t0", H.sent.some((x: any) => x.verb === "delete" && x.args.component === "motion") && u2.ok && c("c1").motion?.t0 === 5 && c("c1").motion.degPerSec === 30, JSON.stringify([u2.refused, c("c1").motion]));
  H.W.call("set", { id: "c1", component: "sockets", value: { seat: { pos: [0, 0.5, 0], body: {} } } }); H.sync();
  commitEdit("c1", "sockets.seat|rot|1", Math.PI / 2);   // the panel commits RADIANS (heading)
  await H.flush();
  check("a numeric deg value from the panel is radians: π/2 lands as π/2, not π/2/57", Math.abs(socks("c1").seat?.q?.[1] - Math.SQRT1_2) < 1e-3, JSON.stringify(socks("c1").seat));
  const rc = commitEdit("c1", "comp.example.org/recipe", "");
  check("a cleared JSON box refuses instead of removing (the button is the deliberate act)", !rc.ok && /remove example.org\/recipe/.test(rc.errors[0]));
  check("schemaFor reads the fold record", schemaFor("lamp").groups.some((g: any) => g.group === "light") && schemaFor("nope").groups.length === 0);
}

console.log("\nthe channel box (step 3): rotations undo by q, and the editor reads back what it typed:");
{
  H.W.seed({ t1: { model: "crate.glb", pos: [0, 0, 0], yaw: 0.5 } }); H.sync();
  H.entities.set("t1", realized());
  const was = JSON.stringify(c("t1").transform);
  const r = commitEdit("t1", "rot.x", 30 * Math.PI / 180);   // the panel speaks radians for a deg field
  await H.flush();
  check("tilting a yaw-only thing sends ONE set transform with a tilted q", r.ok && last().verb === "set" && last().args.component === "transform" && Math.abs(last().args.value.q[0]) > 1e-3, JSON.stringify(last()));
  check("…its expect is the old transform (the q of its old yaw), and the door took it", JSON.stringify(expectOf(last(), "transform")?.value) === was && sameRotation(c("t1").transform.q, qFromEuler([30 * Math.PI / 180, 0.5, 0], "XYZ"), 1e-9), JSON.stringify([last().args.expect, c("t1").transform]));
  const u = await Edits.undo();
  check("…and its undo restores exactly the old q of its yaw (a bare yaw would keep the tilt)", u.ok && JSON.stringify(c("t1").transform) === was && sameRotation(c("t1").transform.q, qFromYaw(0.5), 1e-9), JSON.stringify([u.refused, c("t1").transform]));
  commitEdit("t1", "rot.x", 30 * Math.PI / 180); await H.flush();
  // drive it into gimbal lock through the panel: Y to 90°
  const r2 = commitEdit("t1", "rot.y", Math.PI / 2);
  await H.flush();
  const val = (k: string) => schemaFor("t1").groups.find((g: any) => g.group === "rot").fields.find((f: any) => f.k === k).value;
  check("at gimbal lock the editor reads back exactly what it typed (30°, 90°, 0) — its hint", Math.abs(val("x") - 30 * Math.PI / 180) < 1e-9 && Math.abs(val("y") - Math.PI / 2) < 1e-9 && Math.abs(val("z")) < 1e-9, `${val("x")} ${val("y")} ${val("z")}`);
  check("…the hint is the triple that was composed, and its q is what the door holds", !!r2.euler && [30 * Math.PI / 180, Math.PI / 2, 0].every((v, i) => Math.abs(r2.euler.e[i] - v) < 1e-12)
    && sameRotation(r2.euler.q, qFromEuler([30 * Math.PI / 180, Math.PI / 2, 0], "XYZ"), 1e-12) && sameRotation(r2.euler.q, H.state.st.entities.t1.q, 1e-9), JSON.stringify(r2.euler));
  // someone else turns it: the hint is void, the fresh (canonical) reading returns
  H.other("set", { id: "t1", component: "transform", value: { ...c("t1").transform, q: qFromEuler([0, Math.PI / 2, 0.7], "XYZ") } });
  check("…and is void once someone else's turn lands (inner channel back to 0)", val("x") === 0, String(val("x")));
  // a compound edit (remove-both: two ops) is ONE request, so ONE act and one Ctrl+Z. (Was a pendulum under its push
  // reaction; the push was the impulse handler, reserved since the shape audit 10-16: a collider under its model now.)
  H.W.seed({ r1: { model: "swing.glb", pos: [0, 0, 0], yaw: 0, collider: { shape: "box" } } }); H.sync();
  H.entities.set("r1", realized());
  const before = Edits.stacks().undo.length;
  const rr = commitEdit("r1", "remove.model", "both");
  await H.flush();
  check("a held compound edit is ONE request, one act on my undo stack", rr.ops.length === 2 && last().verb === "batch" && last().args.ops.length === 2 && Edits.stacks().undo.length === before + 1 && !c("r1").model && !c("r1").collider, JSON.stringify([rr, last()]));
  const ub = await Edits.undo();
  check("…and one Ctrl+Z brings both back", ub.ok && c("r1").model === "swing.glb" && c("r1").collider?.shape === "box", JSON.stringify([ub.refused, c("r1")]));
}

console.log("\nan edit landing while an undo is in flight (house I162, #260):");
{
  H.W.seed({ u1: { model: "chair.glb", pos: [0, 0, 5], yaw: 0 } }); H.sync();
  await Edits.send({ verb: "set", args: { id: "u1", component: "example.org/note", value: { n: 1 } } }, { what: "note 1" });
  const target = Edits.stacks().undo.at(-1);
  // the edit goes out after the undo is sent and before its reply: its act lands on the stack above the one being undone
  const call = H.W.call; let racer: any = null;
  H.W.call = (verb: string, args: any, actor: string) => { if (verb === "undo" && !racer) racer = Edits.send({ verb: "set", args: { id: "u1", component: "example.org/note", value: { n: 2 } } }, { what: "note 2" }); return call(verb, args, actor); };
  const u = await Edits.undo(); await racer; H.W.call = call;
  const st = Edits.stacks().undo;
  check("the undo took its own act off the stack", u.ok && !st.includes(target), JSON.stringify({ target, st }));
  check("…and the racing edit's act is still there to undo", st.length > 0 && st.at(-1) !== target && st.at(-1) > target, JSON.stringify({ target, st }));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
