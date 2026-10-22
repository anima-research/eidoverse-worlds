// syncSupport's model re-check (#260 house I81): an id whose model changes while its geometry is in flight registers
// nothing from the old fetch. No server: the agent's geometry and mesh fetches are stubbed and held open.
//
//   BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun tools/support-swap-test.ts
import { WorldAgent } from "../mcpl/agent.ts";
import { supportHolders } from "../mcpl/physics.ts";

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  else { fail++; console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? ` — ${detail}` : ""}`); }
};
const registered = async (bid: string) => { for (let i = 0; i < 300 && !supportHolders()[bid]; i++) await new Promise((r) => setTimeout(r, 50)); return !!supportHolders()[bid]; };
const deck = { bbox: { min: [-1, 0, -1], max: [1, 1, 1], size: [2, 1, 2] }, topSurfaces: [] };

const ag: any = new WorldAgent({ name: "swap-bot", world: "swap" });
const held: Record<string, (g: any) => void> = {};
ag.geomFor = (model: string) => new Promise((r) => { held[model] = r; });
ag.meshFor = async () => null;

console.log("a model swapped while its geometry is in flight:");
ag.entities.set("t", { id: "t", model: "crate.glb", pos: [10, 0, 0], yaw: 0, actor: "x" });
const first = ag.syncSupport("t");
await new Promise((r) => setTimeout(r, 0));
check("setup: the crate's fetch is in flight", typeof held["crate.glb"] === "function", JSON.stringify(Object.keys(held)));
ag.entities.set("t", { id: "t", model: "lamp.glb", pos: [10, 0, 0], yaw: 0, actor: "x" });   // same id, another thing
held["crate.glb"]?.(deck);
await first;
await new Promise((r) => setTimeout(r, 300));
check("the old fetch registers no support for the id", !ag.supportIds.has("t") && !supportHolders()["swap/t"], JSON.stringify([...ag.supportIds.keys()]));

// the positive control: the same fetch, unswapped, does register (so the check above can fail)
ag.entities.set("u", { id: "u", model: "crate.glb", pos: [30, 0, 0], yaw: 0, actor: "x" });
const second = ag.syncSupport("u");
await new Promise((r) => setTimeout(r, 0));
held["crate.glb"]?.(deck);
await second;
check("unswapped, the same fetch registers the crate's support", ag.supportIds.has("u") && (await registered((ag.supportIds.get("u") ?? [])[0] ?? "swap/u")), JSON.stringify([...ag.supportIds.entries()]));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
