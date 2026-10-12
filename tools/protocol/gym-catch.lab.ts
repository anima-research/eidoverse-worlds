// @ts-nocheck
// LAB: R 10-11 14:24, "Couldn't punt: Rab is holding 'tower crate 2'… but I'm not holding anything". Her log: she caught
// tower-1 mid-air at 21:23:27.861 (`sim catch`), and at 31.849 a REST was logged for it — while it was in her hand. The sim
// layer re-placed it as a child of tower-2 when tower-2's rest moved tower-2 (28.714): a body again, under the crate it had
// rested on, woken, fallen, rested. Traced through simFolder on her own log: after the catch, tower-1 must stay out.
//   bun tools/protocol/gym-catch.lab.ts
import fs from "node:fs"; import { simFolder } from "../../shared/protocol/simlayer.js"; import { readLog } from "../../shared/protocol/fold.js";
const SRC = process.env.WORLDS_SRC; if (!SRC) throw new Error("WORLDS_SRC=<the scratch worlds dir holding gym/> is required");
const E = readLog(fs.readFileSync(`${SRC}/gym/world.jsonl`));
const f = simFolder(E, { models: {} }); const A = Date.parse("2026-10-11T21:23:27.861Z"), B = Date.parse("2026-10-11T21:23:31.84Z");
let back = null, caught = false;
for (let i = 0; i < E.length; i++) { f.feed(i); const e = E[i]; if (e.ts > B) break;
  if (e.ts >= A && e.kind === "sim" && e.verb === "catch" && e.body?.id === "tower-1") { caught = true; continue; }
  if (caught) { const o = f.view(); if (!back && (o.sim?.bodies?.["tower-1"] || o.launched["tower-1"])) back = { at: new Date(e.ts).toISOString().slice(17, 23), after: `${e.kind} ${e.verb}` }; } }
console.log(back ? `✗ CA1 the caught crate went back into the engine at ${back.at} (${back.after})` : "✓ CA1 the caught crate stays out of the engine while it's in her hand");
process.exit(back ? 1 : 0);
