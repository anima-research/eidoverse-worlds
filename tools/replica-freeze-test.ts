// replica-freeze-test — the client's fold is frozen in dev (C7a): a reader that writes into a record throws where it
// stands, and the fold still applies every later entry (a set replaces the value; the bag is thawed for the write).
//
//   BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun tools/replica-freeze-test.ts
//
// Why: the realizer's `comps` clone (models.js syncComps, gone in C7c) was the only thing between an evaluator's stray
// `bag.x = …` and this client's fold. With every reader on replica.st, the guard has to be the record itself.
import "./protocol/fixture-ids.ts";   // fixtures seed the ids they read (R 10-17: writers never choose ids)
import { scratchWorld } from "./protocol/scratchworld.ts";
import { makeReplica, wireState } from "../shared/protocol/replica.js";
import { digest } from "../shared/protocol/fold.js";

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  else { fail++; console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? ` — ${detail}` : ""}`); }
};
const throws = (f: () => void) => { try { f(); return false; } catch { return true; } };

const W = scratchWorld("freeze").seed({ crate: { lib: "crate.glb", pos: [1, 0, 2], yaw: 0, comp: { label: "crate", "example.org/rack": { top: { pos: [0, 1, 0] } } } } });
const cutAt = () => JSON.parse(JSON.stringify({ state: wireState(W.state()), head: W.entries().length - 1 }));

console.log("\nfrozen by default (every suite runs with the guard):");
{
  const r = makeReplica(); r.adopt(cutAt());
  const c = r.st.entities.crate.c;
  check("the bag is frozen", Object.isFrozen(c));
  check("…and so is every value under it", Object.isFrozen(c["example.org/rack"]) && Object.isFrozen(c["example.org/rack"].top) && Object.isFrozen(c["example.org/rack"].top.pos) && Object.isFrozen(c.transform.pos));
  check("a reader that writes a value throws (rack.top.pos[0] = 9)", throws(() => { c["example.org/rack"].top.pos[0] = 9; }));
  check("a reader that adds a key throws (c.stray = 1)", throws(() => { (c as any).stray = 1; }));
  check("a reader that deletes a key throws", throws(() => { delete (c as any).label; }));
  check("the fold is untouched", c["example.org/rack"].top.pos[0] === 0 && c.label === "crate" && !("stray" in c));

  const before = W.entries().length, worldBag = r.st.entities["@world"].c;
  const res = W.call("set", { id: "crate", component: "label", value: "tall crate" });
  check("the authority writes a label", res.ok === true, JSON.stringify(res.refused));
  const fresh = W.entries().slice(before);
  const ing = r.ingest(fresh, before);
  check("…the frozen replica folds it (the bag is thawed for the write, never mutated)", ing.changed === true && !ing.resync && r.st.entities.crate.c.label === "tall crate", JSON.stringify(ing));
  check("…and the record is frozen again, the digest the authority's", Object.isFrozen(r.st.entities.crate.c) && digest(r.st) === digest(W.state()));
  check("the other record stayed the same object (only the written entity's bag was copied)", r.st.entities["@world"].c === worldBag && r.st.entities.crate.c !== c);
  const r2 = makeReplica(); r2.adopt(cutAt());
  check("a create folds into a frozen state and the new record is frozen too", (() => { const n = W.entries().length; W.call("create", { id: "lamp", components: { transform: { pos: [0, 2, 0], q: [0, 0, 0, 1], scale: [1, 1, 1] }, light: { intensity: 4 } } }); r2.ingest(W.entries().slice(n), n); return Object.isFrozen(r2.st.entities.lamp?.c) && Object.isFrozen(r2.st.entities.lamp.c.light) && digest(r2.st) === digest(W.state()); })());
}

console.log("\noff by choice (a visitor's browser):");
{
  const r = makeReplica({ freeze: false }); r.adopt(cutAt());
  check("nothing is frozen", !Object.isFrozen(r.st.entities.crate.c) && !Object.isFrozen(r.st.entities.crate.c["example.org/rack"]));
  check("the replica says which it is", r.frozen === false && makeReplica().frozen === true);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
