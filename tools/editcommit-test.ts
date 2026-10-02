// editcommit — inspect.js commitEdit / inverseOf, headless.
//
//   bun tools/editcommit-test.ts
//
// The client's half of the shared schema: a live call previews through the
// group's handler and never sends; the final call sends the fewest verbs and
// pushes an inverse computed from the record AS IT STOOD WHEN THE GESTURE
// BEGAN — which is exactly the "a scrub's before leaked into the next
// selection" bug the first review round found. Stubs stand in for the world
// (a Map), the fold (state.st), the wire (a call log) and the DOM factory —
// the shared schema is the real one.

import { plugin } from "bun";
const here = (f: string) => new URL(f, import.meta.url).pathname;
const sent: any[] = [];
const undos: any[] = [];
const world = { entities: new Map<string, any>() };
const fold: any = { st: { entities: {} } };
plugin({
  name: "editcommit-stubs",
  setup(b) {
    b.onResolve({ filter: /^\.\/(world|state|net|panels)\.js$/ }, (a) => ({ path: a.path, namespace: "editcommit-stubs" }));
    b.onLoad({ filter: /.*/, namespace: "editcommit-stubs" }, (a) => {
      const m = a.path.match(/(world|state|net|panels)/)![1];
      // world/net carry what placer.js reads too (inspect.js asks it who may author a guarded thing)
      const src = { world: "export const entities = globalThis.__w.entities; export const entityMeta = new Map(); export const comps = new Map();", state: "export const state = globalThis.__f;",
        net: "export const sendVerb = (v, a) => globalThis.__sent.push({ verb: v, args: a }); export const net = { myId: 'tester', myRights: { role: 'builder' } };", panels: "export const renderDOM = () => {};" }[m];
      return { contents: src!, loader: "js" };
    });
  },
});
(globalThis as any).__w = world; (globalThis as any).__f = fold; (globalThis as any).__sent = sent;

const { commitEdit, registerHandler, setEditHooks, endGesture, schemaFor } = await import("../client/lib/inspect.js");

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  else { fail++; console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? ` — ${detail}` : ""}`); }
};
const lightCommits: any[] = [];
setEditHooks({ undo: (inv: any, what: string) => undos.push({ inv, what }), commitLight: (id: string, patch: any) => lightCommits.push({ id, patch }) });
const previews: any[] = [];
registerHandler("light", (id: string, _obj: any, k: string, v: any, opts: any) => { if (!opts?.live) return false; previews.push({ id, k, v }); return true; });
registerHandler("sockets", (_id: string, _obj: any, k: string) => k === "add");   // a viewport gesture: handled, never sent

fold.st.entities.L = { kind: "light", pos: [0, 2, 0], color: 0xff8800, intensity: 16, range: 6, actor: "r", ts: 1 };
fold.st.entities.c1 = { lib: "chair.glb", pos: [1, 0, 2], yaw: 0, actor: "r", ts: 1, comp: { sockets: { seat: { pos: [0, 0.5, 0], yaw: 0 } } } };
world.entities.set("L", { userData: { isLight: true } }); world.entities.set("c1", {});

console.log("\nlive → preview only; final → verbs + an inverse from the gesture's start:");
{
  commitEdit("L", "light.intensity", 20, { live: true });
  commitEdit("L", "light.intensity", 24, { live: true });
  check("two live calls previewed and sent nothing", previews.length === 2 && sent.length === 0 && lightCommits.length === 0 && undos.length === 0);
  fold.st.entities.L.intensity = 22;   // a coalesced live commit echoed mid-drag: the fold moved under the gesture
  const r = commitEdit("L", "light.intensity", 24);
  check("the final goes through the light coalescer, not the raw wire", r.ok && lightCommits.length === 1 && lightCommits[0].patch.intensity === 24 && sent.length === 0, JSON.stringify({ r, lightCommits, sent }));
  check("the undo inverse is the PRE-DRAG value (16), not the mid-drag fold (22)", undos.length === 1 && undos[0].inv.verb === "light" && undos[0].inv.args.intensity === 16, JSON.stringify(undos));
}

console.log("\na gesture belongs to one id:");
{
  fold.st.entities.L.intensity = 24;
  commitEdit("L", "light.range", 9, { live: true });      // a drag begins on L
  commitEdit("c1", "sockets.seat|yaw", 1);                 // …and c1 is edited before it ends
  const inv = undos[undos.length - 1].inv;
  check("c1's inverse is computed from c1's own record", inv.verb === "comp" && inv.args.type === "sockets" && inv.args.data.seat.yaw === 0, JSON.stringify(inv));
  check("…and the sent comp merged from the fold (yaw 1, pos kept)", sent[sent.length - 1].args.data.seat.yaw === 1 && sent[sent.length - 1].args.data.seat.pos[1] === 0.5);
  endGesture();
  fold.st.entities.L.range = 7;
  commitEdit("L", "light.range", 9);
  check("after endGesture (a selection change) the inverse reads the CURRENT record (7)", undos[undos.length - 1].inv.args.range === 7, JSON.stringify(undos[undos.length - 1]));
}

console.log("\nrefusals, gestures and inverses of the other verbs:");
{
  const n0 = sent.length;
  const r = commitEdit("c1", "sockets.add", 1);
  check("a viewport gesture is handled by the module and never sent", r.handled === true && sent.length === n0);
  fold.st.entities.c1.comp.lock = true;
  const rl = commitEdit("c1", "pos.x", 3);
  check("a locked pose refuses with the reason and sends nothing", !rl.ok && /locked/.test(rl.errors[0]) && sent.length === n0);
  delete fold.st.entities.c1.comp.lock;
  const rz = commitEdit("zz", "pos.x", 1);
  check("an id not in the fold refuses", !rz.ok && /not in the fold/.test(rz.errors[0]));
  commitEdit("c1", "comp.recipe", '{"wood":2}');
  check("a new comp's inverse is data:null (it was absent)", undos[undos.length - 1].inv.args.type === "recipe" && undos[undos.length - 1].inv.args.data === null);
  fold.st.entities.c1.comp.recipe = { wood: 2 };
  commitEdit("c1", "comp.recipe", null);   // what the 'remove recipe' button sends
  check("removing it: the inverse restores {wood:2}", undos[undos.length - 1].inv.args.data.wood === 2 && sent[sent.length - 1].args.data === null);
  fold.st.entities.c1.comp.motion = { type: "spin", degPerSec: 30, t0: 5 };
  commitEdit("c1", "motion.rest", 1);
  check("resting a motion: the inverse re-issues the whole motion with its t0", undos[undos.length - 1].inv.verb === "motion" && undos[undos.length - 1].inv.args.t0 === 5 && sent[sent.length - 1].args.type === null);
  fold.st.entities.c1.comp.sockets.seat.yaw = 0;
  commitEdit("c1", "sockets.seat|yaw", Math.PI / 2);   // the panel commits RADIANS
  check("a numeric deg value from the panel is radians: π/2 lands as π/2, not π/2/57", Math.abs(sent[sent.length - 1].args.data.seat.yaw - Math.PI / 2) < 1e-3, String(sent[sent.length - 1].args.data.seat.yaw));
  const rc = commitEdit("c1", "comp.recipe", "");
  check("a cleared JSON box refuses instead of removing (the button is the deliberate act)", !rc.ok && /remove recipe/.test(rc.errors[0]));
  check("schemaFor reads the fold record", schemaFor("L").groups.some((g: any) => g.group === "light") && schemaFor("nope").groups.length === 0);
}

console.log("\nthe channel box (step 3): rotations undo by q, and the editor reads back what it typed:");
{
  const { emptyState, foldEntry } = await import("../shared/fold.js");
  const { qFromEuler, sameRotation } = await import("../shared/euler.js");
  const echo = (id: string, v: any) => { const st: any = emptyState(); st.entities[id] = fold.st.entities[id]; foldEntry(st, { seq: 9, ts: 9, actor: "o", verb: v.verb, args: v.args }); fold.st.entities[id] = st.entities[id]; };
  fold.st.entities.t1 = { lib: "crate.glb", pos: [0, 0, 0], yaw: 0.5, actor: "r", ts: 1 };
  world.entities.set("t1", {});
  const n0 = undos.length;
  const r = commitEdit("t1", "rot.x", 30 * Math.PI / 180);   // the panel speaks radians for a deg field
  const sentPlace = sent[sent.length - 1];
  check("tilting a yaw-only thing sends ONE place with q", r.ok && sentPlace.verb === "place" && Array.isArray(sentPlace.args.q), JSON.stringify(sentPlace));
  check("…and its undo carries the q of its old yaw (a bare yaw would keep the tilt)", undos.length === n0 + 1 && Array.isArray(undos[undos.length - 1].inv.args.q) && sameRotation(undos[undos.length - 1].inv.args.q, [0, Math.sin(0.25), 0, Math.cos(0.25)], 1e-12), JSON.stringify(undos[undos.length - 1]));
  echo("t1", sentPlace);
  // drive it into gimbal lock through the panel: Y to 90°
  const r2 = commitEdit("t1", "rot.y", Math.PI / 2);
  echo("t1", sent[sent.length - 1]);
  const val = (k: string) => schemaFor("t1").groups.find((g: any) => g.group === "rot").fields.find((f: any) => f.k === k).value;
  check("at gimbal lock the editor reads back exactly what it typed (30°, 90°, 0) — its hint", Math.abs(val("x") - 30 * Math.PI / 180) < 1e-9 && Math.abs(val("y") - Math.PI / 2) < 1e-9 && Math.abs(val("z")) < 1e-9, `${val("x")} ${val("y")} ${val("z")}`);
  check("…the hint is the triple that was composed, and its q is what was sent", !!r2.euler && [30 * Math.PI / 180, Math.PI / 2, 0].every((v, i) => Math.abs(r2.euler.e[i] - v) < 1e-12)
    && sameRotation(r2.euler.q, qFromEuler([30 * Math.PI / 180, Math.PI / 2, 0], "XYZ"), 1e-12) && sameRotation(r2.euler.q, fold.st.entities.t1.q, 1e-12), JSON.stringify(r2.euler));
  // someone else turns it: the hint is void, the fresh (canonical) reading returns
  fold.st.entities.t1 = { ...fold.st.entities.t1, q: qFromEuler([0, Math.PI / 2, 0.7], "XYZ") };
  check("…and is void once someone else's turn lands (inner channel back to 0)", val("x") === 0);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
