// Writes the physics conformance scenarios (spec/conformance/physics/<name>.jsonl): each is a world's log up to and
// including its throw, before any rest is written, so it holds the engine's INPUTS only. engine-check.ts replays each
// through every engine version this server carries and holds the result to that version's digests: what "carries"
// means (house, #260 10-21). Run once to (re)write the inputs; the digests are written by engine-check --write.
import "./fixture-ids.ts";
import fs from "node:fs";
import { request } from "../../shared/protocol/authority.js";
import { openWorld } from "../../server/filehost.ts";
import { scratch } from "./common.ts";
import { fileURLToPath } from "node:url";
import { labClock } from "./clock.ts";

const root = scratch("engine-scen"), OUT = fileURLToPath(new URL("../../spec/conformance/physics/", import.meta.url));
const clock = labClock();
const call = (world: string, actor: string, verb: string, args = {}) => { clock.advance(100); const r = request(openWorld(root, world), actor, verb, args); if (!r.ok) throw new Error(`${world}: ${verb} refused: ${JSON.stringify(r).slice(0, 300)}`); return r; };
function world(name: string) {
  for (const f of [`${name}.jsonl`, `${name}.presence.json`]) fs.rmSync(`${root}worlds/${f}`, { force: true });
  const { start, box } = AT[name]; clock.t = start - 100;
  call(name, "rowan", "create-world", { title: name });
  // the scenario's build box, set (at start + 50, before the physics epoch) only where founding wrote another
  if (JSON.stringify(openWorld(root, name).state().entities["@world"].c.bounds ?? null) !== JSON.stringify(box)) {
    clock.t = start - 50; call(name, "rowan", "set", { id: "@world", component: "bounds", value: box }); clock.t = start; }
  call(name, "rowan", "set", { id: "@world", component: "physics-engine", value: { engine: "eidosim@1.0.0" } });
  call(name, "rowan", "create", { id: "table-1", model: "table", place: { at: [0, 4] } });
  call(name, "rowan", "create", { id: "ball", model: "ball", components: { physics: { kind: "dynamic" } }, place: { at: [0, 0] } });
  call(name, "rowan", "create", { id: "crate-1", model: "crate", components: { physics: { kind: "dynamic" } }, place: { at: [2, 0] } });
  call(name, "rowan", "move", { to: [0, 0, -0.5] });
  return name;
}
// each scenario's start ts and build box are part of its identity (fixture-repins.json): a later default never rewrites them
const BOX0 = { min: [-20, 0, -20], max: [20, 12, 20] }, BOX50 = { min: [-20, -50, -20], max: [20, 12, 20] };
const AT: Record<string, { start: number; box: typeof BOX0 }> = {
  "arc-onto-table": { start: 1800000000100, box: BOX0 }, "straight-up": { start: 1800000000900, box: BOX0 },
  "crate-tumble": { start: 1800000001700, box: BOX0 }, "knock-a-sleeper": { start: 1800000002600, box: BOX0 },
  "knock-a-sleeper-2": { start: 1800000003400, box: BOX50 }, "onto-hills": { start: 1800000003400, box: BOX0 },
  "crate-slide": { start: 1800000004300, box: BOX0 } };
const SCEN: Record<string, (w: string) => void> = {
  "arc-onto-table": (w) => { call(w, "rowan", "grab", { id: "ball" }); call(w, "rowan", "throw", { id: "ball", v: [0, 2, 3] }); },
  "straight-up": (w) => { call(w, "rowan", "grab", { id: "ball" }); call(w, "rowan", "throw", { id: "ball", v: [0, 6, 0] }); },
  "crate-tumble": (w) => { call(w, "rowan", "move", { to: [2, 0, -0.5] }); call(w, "rowan", "grab", { id: "crate-1" }); call(w, "rowan", "throw", { id: "crate-1", v: [0, 5, 0], w: [0, 0, 6] }); },
  // knock-a-sleeper's ball passes 0.09 m wide of crate-1 (it never wakes); its digest is pinned, so it stays as a plain throw.
  // knock-a-sleeper-2 is the knock: rowan steps into the crate's line first (engine-check EN6)
  "knock-a-sleeper": (w) => { call(w, "rowan", "grab", { id: "ball" }); call(w, "rowan", "throw", { id: "ball", v: [4, 1.5, 0] }); },
  "knock-a-sleeper-2": (w) => { call(w, "rowan", "move", { to: [0, 0, -0.2] }); call(w, "rowan", "grab", { id: "ball" }); call(w, "rowan", "throw", { id: "ball", v: [4, 1.5, 0] }); },
  // the ground law (terrainmath.js) is part of the engine's result: a throw onto hilly ground holds it to its version too
  "onto-hills": (w) => { call(w, "rowan", "set", { id: "@world", component: "terrain", value: { amplitude: 3, seed: 7 } }); call(w, "rowan", "grab", { id: "ball" }); call(w, "rowan", "throw", { id: "ball", v: [3, 3, 3] }); },
  "crate-slide": (w) => { call(w, "rowan", "move", { to: [2, 0, -0.5] }); call(w, "rowan", "grab", { id: "crate-1" }); call(w, "rowan", "throw", { id: "crate-1", v: [4, 0.5, 0] }); },
};
fs.mkdirSync(OUT, { recursive: true });
for (const [name, act] of Object.entries(SCEN)) {
  const w = world(name); act(w);
  const L = openWorld(root, w).entries;
  fs.writeFileSync(`${OUT}${name}.jsonl`, L.map((e: unknown) => JSON.stringify(e)).join("\n") + "\n");
  console.log(`${name}: ${L.length} entries`);
}
