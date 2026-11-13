// replica-hierarchy-test — the client's fold carries its own parent/child index (C12b, survey #11): childrenOf /
// parentOf / ancestors answered from an index the replica maintains at adopt and at every ingest, never from a scan
// of the records and never from a map a realizer keeps by hand beside the fold.
//
//   BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun tools/replica-hierarchy-test.ts
//
// After every write — a create under a carrier, a move to another carrier, an unparent, a delete that takes the
// children, a create+parent in one batch — the index answers exactly what a fresh scan of the records answers, for
// every id present (and for a carrier that is gone while something still names it: the scan's answer, the dangling
// edge). Mutation: skip the index update on the ingest path and the first move goes red.
import "./protocol/fixture-ids.ts";   // fixtures seed the ids they read (R 10-17: writers never choose ids)
import { scratchWorld, socketChild } from "./protocol/scratchworld.ts";
import { makeReplica, wireState } from "../shared/protocol/replica.js";

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  else { fail++; console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? ` — ${detail}` : ""}`); }
};

const W = scratchWorld("hier").seed({
  truck: { model: "truck.glb", pos: [0, 0, 0], yaw: 0 },
  "truck-bed": { parent: { to: "truck", offset: [0, 1, 0] }, socket: { name: "bed" } },
  crate: { model: "crate.glb", pos: [0, 0, 0], yaw: 0, parent: { to: "truck", socket: "bed" } },
  lantern: { model: "lantern.glb", pos: [0, 0, 0], yaw: 0, parent: { to: "crate" } },
  rock: { model: "rock.glb", pos: [5, 0, 5], yaw: 0 },
});
// the truck's bed is a socket child (PLAN-sockets-entities), so the crate rides it: truck › bed › crate › lantern
const bed = socketChild(W.state(), "truck", "bed");
const cutAt = () => JSON.parse(JSON.stringify({ dialect: "eidoverse-log", v: 4, state: wireState(W.state()), seq: W.entries().length - 1 }));
const r = makeReplica(); r.adopt(cutAt());
let head = W.entries().length;
const write = (tool: string, args: any) => {
  const res = W.call(tool, args); if (!res.ok) throw new Error(`${tool} ${JSON.stringify(args)} refused: ${JSON.stringify(res.refused)}`);
  const n = W.entries().length; const ing = r.ingest(W.entries().slice(head), head); head = n;
  if (ing.resync) throw new Error(`resync: ${ing.why}`);
};

/** The scan the index replaces: the records' own parent fields, read fresh. */
const scanKids = (id: string) => Object.keys(r.st.entities).filter((k) => r.st.entities[k].c?.parent?.to === id).sort();
const scanParent = (id: string) => { const p = r.st.entities[id]?.c?.parent?.to; return typeof p === "string" ? p : null; };
const scanAnc = (id: string) => { const out: string[] = []; const seen = new Set([id]); for (let p = scanParent(id); p && r.st.entities[p] && !seen.has(p); p = scanParent(p)) { out.push(p); seen.add(p); } return out; };
/** Every id the records hold, plus every id a parent field names (a dangling carrier answers like the scan). */
const idsToAsk = () => { const s = new Set(Object.keys(r.st.entities)); for (const k of Object.keys(r.st.entities)) { const p = r.st.entities[k].c?.parent?.to; if (typeof p === "string") s.add(p); } s.delete("@world"); return [...s]; };
const agree = (label: string) => {
  const diffs: string[] = [];
  for (const id of idsToAsk()) {
    const k = r.childrenOf(id), sk = scanKids(id); if (JSON.stringify(k) !== JSON.stringify(sk)) diffs.push(`childrenOf(${id}) ${JSON.stringify(k)} ≠ ${JSON.stringify(sk)}`);
    const p = r.parentOf(id), sp = scanParent(id); if (p !== sp) diffs.push(`parentOf(${id}) ${p} ≠ ${sp}`);
    const a = r.ancestors(id), sa = scanAnc(id); if (JSON.stringify(a) !== JSON.stringify(sa)) diffs.push(`ancestors(${id}) ${JSON.stringify(a)} ≠ ${JSON.stringify(sa)}`);
  }
  check(label, diffs.length === 0, diffs.join("; "));
};

console.log("\nthe index agrees with a fresh scan after every write:");
agree("adopt: the cut's folded parents are indexed");
check("the seed's tree reads as seeded", r.childrenOf("truck").join() === bed && r.childrenOf(bed).join() === "crate" && r.childrenOf("crate").join() === "lantern" && r.ancestors("lantern").join() === `crate,${bed},truck` && r.parentOf("rock") === null && r.childrenOf("rock").length === 0);
write("set", { id: "rock", component: "parent", value: { to: "truck" } });
agree("a root moves under a carrier");
check("…and the carrier lists it, in id order", r.childrenOf("truck").join() === [bed, "rock"].sort().join());
write("set", { id: "rock", component: "parent", value: { to: "crate" } });
agree("a child moves to another carrier");
check("…the old carrier forgets it, the new one lists it, its ancestors grow", r.childrenOf("truck").join() === bed && r.childrenOf("crate").join() === "lantern,rock" && r.ancestors("rock").join() === `crate,${bed},truck`);
write("delete", { id: "rock", component: "parent" });
agree("an unparent");
check("…it is a root again", r.parentOf("rock") === null && r.childrenOf("crate").join() === "lantern");
write("create", { id: "cup", model: "cup.glb", components: { transform: { pos: [0, 0, 0] }, parent: { to: "lantern" } } });
agree("a create born under a carrier (one entry)");
check("…five deep", r.ancestors("cup").join() === `lantern,crate,${bed},truck`);
write("delete", { id: "crate" });
agree("a delete that takes the children with it");
check("…nothing names the gone carrier; truck keeps only its socket; what was under it is gone too", r.childrenOf("crate").length === 0 && r.childrenOf(bed).length === 0 && r.childrenOf("truck").join() === bed && !r.st.entities.lantern && !r.st.entities.cup && r.parentOf("lantern") === null);
write("create", { id: "box", model: "box.glb", components: { transform: { pos: [1, 0, 1] } } });
write("set", { id: "box", component: "parent", value: { to: "truck" } });
write("set", { id: "rock", component: "parent", value: { to: "box" } });
agree("a fresh chain built in three entries");
check("…reads whole", r.ancestors("rock").join() === "box,truck" && r.childrenOf("truck").join() === [bed, "box"].sort().join());
check("an id the world never had answers empty", r.childrenOf("nothing").length === 0 && r.parentOf("nothing") === null && r.ancestors("nothing").length === 0);

console.log("\nthe index is the fold's, not a view's:");
{
  const r2 = makeReplica(); r2.adopt(cutAt());
  check("a second replica adopting the same cut indexes the same tree", JSON.stringify([r2.childrenOf("truck"), r2.ancestors("rock")]) === JSON.stringify([r.childrenOf("truck"), r.ancestors("rock")]));
  r2.reset();
  check("reset empties it", r2.childrenOf("truck").length === 0 && r2.parentOf("rock") === null);
}

console.log("\na carrier that is gone while something still names it:");
// the authority cascades a delete (the log never holds a bare one), so the entry is fed to the replica by hand
{ const ing = r.ingest([{ kind: "change", op: "delete", body: { id: "truck" }, ts: 0, actor: "u-hier" }], head); head++;
  if (ing.resync) throw new Error(`resync: ${ing.why}`); }
agree("the index answers the dangling edge exactly as the scan does");
check("…the gone carrier still lists its child, the child still names it, and the grandchild's ancestors stop at the gap",
  !r.st.entities.truck && r.childrenOf("truck").includes("box") && r.parentOf("box") === "truck" && r.ancestors("rock").join() === "box",
  JSON.stringify([r.childrenOf("truck"), r.parentOf("box"), r.ancestors("rock")]));

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
