// hierarchy-commit — a drag in the Hierarchy is ONE undo step (design §5),
// through the client's real commit path (client/lib/inspect.js commitEdit),
// headless. The Hierarchy's drop and the inspector's Parent field both call
// commitEdit(id, 'parent.to', onto); this checks what that pushes and sends.
//
//   BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun tools/hierarchy-commit-test.ts
//
// Stubs as in tools/editcommit-test.ts: the realized world (a Map), the fold
// (state.st, folded for real by shared/fold.js), the wire (a call log).

import { plugin } from "bun";
import { emptyState, foldEntry } from "../shared/fold.js";
import { worldPose } from "../shared/hierarchy.js";
const sent: any[] = [];
const undos: any[] = [];
const world = { entities: new Map<string, any>() };
const fold: any = { st: emptyState() };
plugin({
  name: "hiercommit-stubs",
  setup(b) {
    b.onResolve({ filter: /^\.\/(world|state|net|panels)\.js$/ }, (a) => ({ path: a.path, namespace: "hiercommit-stubs" }));
    b.onLoad({ filter: /.*/, namespace: "hiercommit-stubs" }, (a) => {
      const m = a.path.match(/(world|state|net|panels)/)![1];
      const src = { world: "export const entities = globalThis.__w.entities; export const entityMeta = new Map(); export const comps = new Map();", state: "export const state = globalThis.__f;",
        net: "export const sendVerb = (v, a) => globalThis.__sent.push({ verb: v, args: a }); export const net = { myId: 'tester', myRights: { role: 'builder' } };", panels: "export const renderDOM = () => {};" }[m];
      return { contents: src!, loader: "js" };
    });
  },
});
(globalThis as any).__w = world; (globalThis as any).__f = fold; (globalThis as any).__sent = sent;
const { commitEdit, setEditHooks } = await import("../client/lib/inspect.js");

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  else { fail++; console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? ` — ${detail}` : ""}`); }
};
setEditHooks({ undo: (inv: any, what: string) => undos.push({ inv, what }) });
let seq = 0;
const F = (verb: string, args: any) => foldEntry(fold.st, { seq: ++seq, ts: seq, actor: "tester", verb, args });
const near = (a: number[], b: number[], e: number) => a.every((v, i) => Math.abs(v - b[i]) <= e);
const LIB = "eidoverse/assets/models/crate.glb";

F("spawn", { id: "shelf", lib: LIB, pos: [4, 1, -2], q: [0.1, 0.4, 0, 0.91], scale: 2 });
F("spawn", { id: "book", lib: LIB, pos: [1, 1.5, 1], yaw: 0.5, scale: 0.8 });
F("spawn", { id: "lamp", lib: LIB, pos: [0, 0, 3], yaw: 0 });
F("mount", { id: "lamp", to: "book", offset: [0, 0.3, 0], yaw: 0 });
for (const id of ["shelf", "book", "lamp"]) world.entities.set(id, {});

console.log("\none drag = one undo step:");
{
  const W0 = worldPose(fold.st.entities, "book")!;
  const before = JSON.stringify(fold.st.entities.book);
  const r = commitEdit("book", "parent.to", "shelf");
  check("the drop sent a mount and a scale place (the shelf is scaled)", r.ok && sent.map((v) => v.verb).join() === "mount,place", JSON.stringify(sent));
  check("ONE undo entry, compound", undos.length === 1 && undos[0].inv.verbs?.length === 2, JSON.stringify(undos));
  for (const v of sent) F(v.verb, v.args);
  check("the fold has it under the shelf, where it stood", fold.st.entities.book.parent?.to === "shelf" && near(worldPose(fold.st.entities, "book")!.pos, W0.pos, 2e-3));
  // Ctrl+Z: build.js undo() sends step.inverse.verbs in order
  for (const v of undos[0].inv.verbs) F(v.verb, v.args);
  const back = fold.st.entities.book;
  const was = JSON.parse(before);
  check("undo: a root again, at its old pos, yaw and scale", !back.parent && near(back.pos, was.pos, 1e-9) && back.yaw === was.yaw && back.scale === was.scale, JSON.stringify({ back, was }));
}
console.log("\nrefusals send nothing and push no undo:");
{
  sent.length = 0; undos.length = 0;
  const r = commitEdit("book", "parent.to", "lamp");   // lamp rides book
  check("onto its own child: refused with the reason, nothing sent", !r.ok && /lamp is inside book/.test(r.errors.join()) && sent.length === 0 && undos.length === 0, JSON.stringify(r));
  fold.st.entities.book.comp = { lock: true };
  const l = commitEdit("book", "parent.to", "shelf");
  check("a locked thing: refused, nothing sent", !l.ok && /locked/.test(l.errors.join()) && sent.length === 0 && undos.length === 0, JSON.stringify(l));
  delete fold.st.entities.book.comp;
}
console.log("\nunparent (drag to the root zone, the ✕ on Parent, or `unparent`):");
{
  sent.length = 0; undos.length = 0;
  const W0 = worldPose(fold.st.entities, "lamp")!;
  const r = commitEdit("lamp", "parent.to", null);
  // the book is scaled 0.8, so the lamp's world size is 0.8 of its own: a place rides along to keep it
  check("a dismount stamped at its world pose (+ its world scale), one undo", r.ok && sent.map((v) => v.verb).join() === "dismount,place" && near(sent[0].args.pos, W0.pos, 2e-3) && sent[1].args.scale === 0.8 && undos.length === 1, JSON.stringify({ sent, undos }));
  for (const v of sent) F(v.verb, v.args);
  check("the fold: a root, same world pose", !fold.st.entities.lamp.parent && near(worldPose(fold.st.entities, "lamp")!.pos, W0.pos, 2e-3) && Math.abs(worldPose(fold.st.entities, "lamp")!.scale - W0.scale) < 1e-9);
  check("undo puts it back on the book with its old relation and scale", (() => { for (const v of undos[0].inv.verbs) F(v.verb, v.args); const l = fold.st.entities.lamp; return l.parent?.to === "book" && near(l.parent.offset, [0, 0.3, 0], 0) && (l.scale ?? 1) === 1; })());
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
