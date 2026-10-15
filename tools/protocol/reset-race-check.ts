// tools/protocol/reset-race-check.ts — a request that was awaiting warm() when the world was reset must refuse, not
// append the old world's line into the new world's file (review 10-14 C1). The slow warm is simulated: the request's
// await is held by a gate; everything after it (the retired log, the real resetWorld, the real file) is production code.
// usage: BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun tools/protocol/reset-race-check.ts
// @ts-nocheck
import fs from "node:fs";
import path from "node:path";
import { scratch } from "./common.ts";
const root = scratch("resetrace");
process.env.WORLDS_DIR = path.join(root, "w"); process.env.OPT_DIR = path.join(root, "opt"); process.env.SKIP_OPT_SWEEP = "1";
fs.mkdirSync(process.env.WORLDS_DIR, { recursive: true });
const { foundWorld, WorldLog } = await import("../../server/worldlog.ts");
const { World } = await import("../../server/world.ts");
let pass = 0, fail = 0;
const ok = (c, what, d?) => { if (c) pass++; else { fail++; console.log(`  FAIL ${what}${d !== undefined ? " — " + JSON.stringify(d).slice(0, 300) : ""}`); } };
const lines = (name) => fs.readFileSync(path.join(process.env.WORLDS_DIR, name, "world.jsonl"), "utf8").split("\n").filter(Boolean);

foundWorld(path.join(process.env.WORLDS_DIR, "race"), "race", "olive");
const w = new World("race");
const old = w.log;
let release; const gate = new Promise((r) => { release = r; });
// the held warm: request() awaits it exactly where it awaits warm(modelsIn(args)) — then runs the real requestSync
const held = (async () => { await gate; return old.requestSync("olive", "create", { id: "straggler", model: "crate", place: { at: [1, 1] } }); })();
const arch = w.resetWorld();
const fresh = w.log;
ok(fresh !== old && fs.existsSync(path.join(arch, "world.jsonl")), "RR1 reset swapped the log and archived the old file", { arch });
const before = lines("race").length;
release(); const r = await held;
ok(r?.ok === false && r?.refused?.code === "reset", "RR2 the straggler is refused with code reset", r);
ok(lines("race").length === before, "RR3 the new world's file gained no line from the old log", { before, after: lines("race").length });
ok(!fresh.live.state().entities.straggler && fresh.live.entries.length === before, "RR4 the fresh log never saw it", { head: fresh.live.entries.length });
ok(old.requestSync("olive", "say", { text: "late" })?.refused?.code === "reset", "RR5 the old log stays retired for every later request");
fs.rmSync(root, { recursive: true, force: true });
console.log(`[reset-race-check] ${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
