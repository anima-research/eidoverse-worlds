// editcommit — inspect.js commitEdit, headless, against the real v4 door.
//
//   BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun tools/editcommit-test.ts
//
// The client's half of the shared schema: a live call previews through the
// group's handler and never sends; the final call sends ONE door request whose
// `expect` names what it changes AS IT STOOD WHEN THE GESTURE BEGAN — the v4
// form of the "a scrub's before leaked into the next selection" bug the first
// review round found (v1 computed an undo inverse from it; v4 sends it as
// expect, and the door refuses `changed` if someone wrote it since).
// tools/v4/inspectharness.ts stubs the page (the realized world, the wire to the
// scratch door, the dialogs); inspect.js, v4edit.js, the schema and the door are real.
//
// v4 port (2026-10-06): the client-side undo stack of inverses and the light coalescer are gone (undo is the door's,
// by act; a lamp is a light COMPONENT edited with set). Each old inverse check became either the expect the request
// carries (what it started from) or the door's undo of the act, read back.
import { inspectHarness } from "./v4/inspectharness.ts";
import { qFromEuler, sameRotation } from "../shared/euler.js";
import { qFromYaw } from "../shared/rot.js";
const H = inspectHarness("editcommit");
const { commitEdit, registerHandler, endGesture, schemaFor } = await import("../client/lib/inspect.js");
const V4 = await import("../client/lib/v4edit.js");

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  else { fail++; console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? ` — ${detail}` : ""}`); }
};
const previews: any[] = [];
registerHandler("light", (id: string, _obj: any, k: string, v: any, opts: any) => { if (!opts?.live) return false; previews.push({ id, k, v }); return true; });
registerHandler("sockets", (_id: string, _obj: any, k: string) => k === "add");   // a viewport gesture: handled, never sent
const realized = () => ({ position: { x: 0, y: 0, z: 0 }, quaternion: { x: 0, y: 0, z: 0, w: 1 } });
const c = (id: string) => H.W.state().entities[id]?.c;
const last = () => H.sent.at(-1);
const expectOf = (req: any, comp: string) => req?.args?.expect?.find((x: any) => x.component === comp);

H.W.seed({
  lamp: { pos: [0, 2, 0], comp: { light: { color: 0xff8800, intensity: 16, range: 6 } } },
  c1: { lib: "chair.glb", pos: [1, 0, 2], yaw: 0, comp: { sockets: { seat: { pos: [0, 0.5, 0], yaw: 0 } } } },
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
  check("the final is ONE set light (intensity 24)", r.ok && H.sent.length === 1 && req.tool === "set" && req.args.component === "light" && req.args.value.intensity === 24, JSON.stringify(H.sent));
  check("its expect is the PRE-DRAG light (16), not the mid-drag one (22)", expectOf(req, "light")?.value?.intensity === 16, JSON.stringify(req.args.expect));
  check("…so the door refuses it `changed`, naming who wrote it, and nothing is written", c("lamp").light.intensity === 22 && H.toasts.some((t: string) => /changed/.test(t) && /bob/.test(t)), JSON.stringify(H.toasts));
}

console.log("\na gesture belongs to one id:");
{
  H.sent.length = 0;
  commitEdit("lamp", "light.range", 9, { live: true });       // a drag begins on the lamp
  commitEdit("c1", "sockets.seat|yaw", 1);                     // …and c1 is edited before it ends
  await H.flush();
  const req = last();
  check("c1's expect is computed from c1's own record (its sockets as they were)", req?.args.id === "c1" && expectOf(req, "sockets")?.value?.seat?.yaw === 0 && req.args.expect.every((x: any) => x.id === "c1"), JSON.stringify(req));
  check("…and the sent sockets merged from the record (yaw 1, pos kept), accepted", req.args.value.seat.yaw === 1 && req.args.value.seat.pos[1] === 0.5 && c("c1").sockets.seat.yaw === 1, JSON.stringify(c("c1")));
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
  commitEdit("c1", "comp.recipe", '{"wood":2}');
  await H.flush();
  check("a new comp: one set recipe whose expect says it was ABSENT (no value)", last().args.component === "recipe" && expectOf(last(), "recipe") && !("value" in expectOf(last(), "recipe")) && c("c1").recipe?.wood === 2, JSON.stringify(last()));
  commitEdit("c1", "comp.recipe", null);   // what the 'remove recipe' button sends
  await H.flush();
  check("removing it: delete recipe", last().tool === "delete" && last().args.component === "recipe" && c("c1").recipe === undefined, JSON.stringify(last()));
  const u = await V4.undo();
  check("…and Ctrl+Z (the door's undo of that act) restores {wood: 2}", u.ok && c("c1").recipe?.wood === 2, JSON.stringify([u.refused, c("c1")]));
  H.W.call("set", { id: "c1", component: "motion", value: { type: "spin", degPerSec: 30, t0: 5 } }); H.sync();
  commitEdit("c1", "motion.rest", 1);
  await H.flush();
  const u2 = await V4.undo();
  check("resting a motion is delete motion; its undo re-issues the whole motion with its t0", H.sent.some((x: any) => x.tool === "delete" && x.args.component === "motion") && u2.ok && c("c1").motion?.t0 === 5 && c("c1").motion.degPerSec === 30, JSON.stringify([u2.refused, c("c1").motion]));
  H.W.call("set", { id: "c1", component: "sockets", value: { seat: { pos: [0, 0.5, 0], yaw: 0 } } }); H.sync();
  commitEdit("c1", "sockets.seat|yaw", Math.PI / 2);   // the panel commits RADIANS
  await H.flush();
  check("a numeric deg value from the panel is radians: π/2 lands as π/2, not π/2/57", Math.abs(c("c1").sockets.seat.yaw - Math.PI / 2) < 1e-3, String(c("c1").sockets.seat.yaw));
  const rc = commitEdit("c1", "comp.recipe", "");
  check("a cleared JSON box refuses instead of removing (the button is the deliberate act)", !rc.ok && /remove recipe/.test(rc.errors[0]));
  check("schemaFor reads the fold record", schemaFor("lamp").groups.some((g: any) => g.group === "light") && schemaFor("nope").groups.length === 0);
}

console.log("\nthe channel box (step 3): rotations undo by q, and the editor reads back what it typed:");
{
  H.W.seed({ t1: { lib: "crate.glb", pos: [0, 0, 0], yaw: 0.5 } }); H.sync();
  H.entities.set("t1", realized());
  const was = JSON.stringify(c("t1").transform);
  const r = commitEdit("t1", "rot.x", 30 * Math.PI / 180);   // the panel speaks radians for a deg field
  await H.flush();
  check("tilting a yaw-only thing sends ONE set transform with a tilted q", r.ok && last().tool === "set" && last().args.component === "transform" && Math.abs(last().args.value.q[0]) > 1e-3, JSON.stringify(last()));
  check("…its expect is the old transform (the q of its old yaw), and the door took it", JSON.stringify(expectOf(last(), "transform")?.value) === was && sameRotation(c("t1").transform.q, qFromEuler([30 * Math.PI / 180, 0.5, 0], "XYZ"), 1e-9), JSON.stringify([last().args.expect, c("t1").transform]));
  const u = await V4.undo();
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
  // a compound edit (remove-both: two ops) is ONE request, so ONE act and one Ctrl+Z
  H.W.seed({ r1: { lib: "swing.glb", pos: [0, 0, 0], yaw: 0, comp: { motion: { type: "pendulum", amp: 0, period: 3.5 }, reactions: { push: { kind: "pendulum-push", gain: 0.25 } } } } }); H.sync();
  H.entities.set("r1", realized());
  const before = V4.stacks().undo.length;
  const rr = commitEdit("r1", "remove.motion", "both");
  await H.flush();
  check("a held compound edit is ONE request, one act on my undo stack", rr.ops.length === 2 && last().tool === "batch" && last().args.ops.length === 2 && V4.stacks().undo.length === before + 1 && !c("r1").motion && !c("r1").reactions, JSON.stringify([rr, last()]));
  const ub = await V4.undo();
  check("…and one Ctrl+Z brings both back", ub.ok && c("r1").motion?.type === "pendulum" && c("r1").reactions?.push?.kind === "pendulum-push", JSON.stringify([ub.refused, c("r1")]));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
