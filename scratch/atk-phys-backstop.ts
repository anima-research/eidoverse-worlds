// scratch/atk-phys-backstop.ts — a thing thrown out of the world never rests: does the 20000-tick backstop rest it, and does return-lost fire? usage: bun scratch/atk-phys-backstop.ts <worldDir>
// @ts-nocheck
import { openLive } from "../server/livehost.ts"; import { settle } from "../shared/protocol/authority.js"; import { restsOf, digestOf, livePoses } from "../shared/protocol/simlayer.js";
const dir = process.argv[2]; let T = Date.now(); const w = openLive(dir, "gym", { now: () => T });
const last = w.entries.at(-1).ts; console.log("entries", w.entries.length, "last ts", last, "now-last s", ((T - last) / 1000).toFixed(0));
const fly = () => Object.entries(w.sim().sim.bodies).filter(([, b]) => !b.resting).map(([k, b]) => [k, b.p.map((n) => +n.toFixed(1)), +Math.hypot(...b.v).toFixed(2)]);
console.log("flying now:", JSON.stringify(fly()), "tick", w.sim().sim.tick);
for (const step of [60, 120, 240, 300, 300, 300]) { T += step * 1000; const a = performance.now(); const wrote = settle(w, {}); console.log(`+${step}s wrote ${wrote} (${(performance.now() - a).toFixed(0)} ms) flying`, JSON.stringify(fly()), "tick", w.sim().sim.tick, "lost acts", w.entries.filter((e) => e.kind === "act" && e.verb === "return-lost" && e.ts > last).length, "unsettled", JSON.stringify(w.unsettled ?? [])); }
