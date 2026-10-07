// hierarchy-commit — a drag in the Hierarchy is ONE undo step (design §5),
// through the client's real commit path (client/lib/inspect.js commitEdit →
// client/lib/editwrites.js sendOps → the door), headless. The Hierarchy's drop and
// the inspector's Parent field both call commitEdit(id, 'parent.to', onto);
// this checks what that sends, what the door makes of it, and that the
// client's own Ctrl+Z (editwrites.undo: the door's undo of my last act) takes it back.
//
//   BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun tools/hierarchy-commit-test.ts
//
// v4 port (2026-10-06): the wire is the real authority on a scratch world (tools/protocol/inspectharness.ts stubs the page
// around inspect.js/editwrites.js). One drag = one request (a batch: set parent + the LOCAL transform, scale included), so
// "a mount and a scale place" and the client-side inverse list are gone: undo is the door's, by act. A lock is the
// door's to refuse, and the client asks "Move anyway?" (v4 §5).
import { inspectHarness } from "./protocol/inspectharness.ts";
import { worldPose } from "../shared/hierarchy.js";
import { qNorm, qFromYaw } from "../shared/rot.js";
const H = inspectHarness("hiercommit");
const { commitEdit } = await import("../client/lib/inspect.js");
const Edits = await import("../client/lib/editwrites.js");

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  else { fail++; console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? ` — ${detail}` : ""}`); }
};
const near = (a: number[], b: number[], e: number) => a.every((v, i) => Math.abs(v - b[i]) <= e);
const LIB = "eidoverse/assets/models/crate.glb";
const W = () => H.state.st.entities;
const comps = (id: string) => JSON.stringify(H.W.state().entities[id].c);

H.W.seed({
  shelf: { lib: LIB, pos: [4, 1, -2], q: qNorm([0.1, 0.4, 0, 0.91]), scale: 2 },
  book: { lib: LIB, pos: [1, 1.5, 1], yaw: 0.5, scale: 0.8 },
  lamp: { lib: LIB, pos: [0, 0, 3], yaw: 0, parent: { to: "book", offset: [0, 0.3, 0], yaw: 0 } },
});
H.sync();
// the realized objects: what revertPose reads when a refused or cancelled gesture puts a thing back
for (const id of ["shelf", "book", "lamp"]) H.entities.set(id, { position: { x: 0, y: 0, z: 0 }, quaternion: { x: 0, y: 0, z: 0, w: 1 } });

console.log("\none drag = one request = one undo step:");
{
  const W0 = worldPose(W(), "book")!;
  const before = comps("book");
  const r = commitEdit("book", "parent.to", "shelf");
  await H.flush();
  const req = H.sent.at(-1);
  check("the drop sent ONE request: a batch of set parent {to: shelf} and the local transform", r.ok && H.sent.length === 1 && req.verb === "batch"
    && req.args.ops.map((o: any) => `${o.verb} ${o.args.component}`).join() === "set parent,set transform" && req.args.ops[0].args.value.to === "shelf", JSON.stringify(H.sent));
  check("…its expect pins what it sets as the drag began (parent absent, the old transform)", Array.isArray(req.args.expect) && req.args.expect.some((x: any) => x.component === "parent" && !("value" in x)) && req.args.expect.some((x: any) => x.component === "transform" && JSON.stringify(x.value) === JSON.stringify(JSON.parse(before).transform)), JSON.stringify(req.args.expect));
  check("the door has it under the shelf, where it stood (and its world size: 0.8 under a ×2 shelf is a local 0.4)", W().book.parent?.to === "shelf" && near(worldPose(W(), "book")!.pos, W0.pos, 2e-3) && Math.abs(worldPose(W(), "book")!.scale - 0.8) < 1e-6 && Math.abs(W().book.scale - 0.4) < 1e-6, JSON.stringify(W().book));
  check("ONE act on my undo stack", Edits.stacks().undo.length === 1, JSON.stringify(Edits.stacks()));
  // Ctrl+Z: the client's undo (the door's undo of my last act)
  const u = await Edits.undo();
  check("undo: a root again, its old transform exactly (pos, q, scale), and the lamp still rides it", u.ok && !W().book.parent && comps("book") === before && W().lamp.parent?.to === "book", JSON.stringify([u.refused, H.W.state().entities.book.c]));
}
console.log("\nrefusals send nothing; a lock is the door's question:");
{
  H.sent.length = 0;
  const r = commitEdit("book", "parent.to", "lamp");   // lamp rides book
  check("onto its own child: refused with the reason, nothing sent", !r.ok && /lamp is inside book/.test(r.errors.join()) && H.sent.length === 0, JSON.stringify(r));
  H.W.call("set", { id: "book", component: "lock", value: true }); H.sync();
  const before = comps("book"); const stack = Edits.stacks().undo.length;
  H.choose = "cancel";
  const l = commitEdit("book", "parent.to", "shelf");
  await H.flush();
  check("a locked thing: the door refuses `locked`, I'm asked \"Move anyway?\", cancel writes nothing and pushes no undo",
    l.ok && H.sent.length === 1 && H.asked.length === 1 && /locked/i.test(JSON.stringify(H.asked[0])) && comps("book") === before && Edits.stacks().undo.length === stack && H.hints.some((t: string) => /cancelled/.test(t)), JSON.stringify({ l, sent: H.sent, asked: H.asked }));
  H.choose = "through";
  commitEdit("book", "parent.to", "shelf");
  await H.flush();
  check("…answering \"move anyway\" re-sends the same request throughLock: parented, lock kept, one act", W().book.parent?.to === "shelf" && W().book.comp?.lock === true && H.sent.at(-1).args.throughLock === true && Edits.stacks().undo.length === stack + 1, JSON.stringify(H.sent.at(-1)));
  const asked = H.asked.length;
  await Edits.undo();   // the lock binds the undo too: I'm asked again, and "move anyway" (still H.choose) takes it back
  H.W.call("delete", { id: "book", component: "lock" }); H.sync();
  check("(and Ctrl+Z takes that back, asked again through the lock: the door's undo of my own act)", !W().book.parent && H.asked.length === asked + 1, JSON.stringify(W().book));
}
console.log("\nunparent (drag to the root zone, the ✕ on Parent, or `unparent`):");
{
  H.sent.length = 0;
  const W0 = worldPose(W(), "lamp")!;
  const was = comps("lamp");
  const r = commitEdit("lamp", "parent.to", null);
  await H.flush();
  const req = H.sent.at(-1);
  // the book is scaled 0.8, so the lamp's world size is 0.8 of its own: the world transform carries it
  check("ONE request: delete parent, then its WORLD transform (scale 0.8 kept), one act", r.ok && H.sent.length === 1 && req.verb === "batch" && req.args.ops[0].tool === "delete" && req.args.ops[0].args.component === "parent"
    && near(req.args.ops[1].args.value.pos, W0.pos, 2e-3) && near(req.args.ops[1].args.value.scale, [0.8, 0.8, 0.8], 1e-9), JSON.stringify(H.sent));
  check("the door: a root, same world pose and size", !W().lamp.parent && near(worldPose(W(), "lamp")!.pos, W0.pos, 2e-3) && Math.abs(worldPose(W(), "lamp")!.scale - W0.scale) < 1e-9, JSON.stringify(W().lamp));
  const u = await Edits.undo();
  const c = H.W.state().entities.lamp.c, w0 = JSON.parse(was);
  check("undo puts it back on the book with its old local transform exactly (pos, q, scale 1)", u.ok && c.parent?.to === "book" && JSON.stringify(c.transform) === JSON.stringify(w0.transform) && near(W().lamp.pos, [0, 0.3, 0], 0) && W().lamp.scale === 1, JSON.stringify([u.refused, c]));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
