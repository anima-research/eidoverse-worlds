// shape-import-test — the shape audit's rules live in the v1 importer, their one real user (tools/protocol/import-v1/shapes.js):
// a v1 world comes out in today's spelling and with its socket maps lifted, and a world founded today needs nothing, so no
// marker, maintenance command, write gate or rollback exists. (shape-repair-test's rows that pinned the rules are here,
// pointed at the importer; the ones that pinned the command went with it.)
//   usage: BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun tools/shape-import-test.ts
// @ts-nocheck
import "./protocol/fixture-ids.ts";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { scratchWorld } from "./protocol/scratchworld.ts";
import { isComponent } from "../shared/protocol/fold.js";
import { partSlot } from "../shared/protocol/names.js";
import { repairComps, repairWorld, repairMotion } from "./protocol/import-v1/shapes.js";
import { translate } from "./protocol/import-v1/translate-v1.js";
import * as A from "../shared/protocol/authority.js";
import { REFUSAL_CODES } from "../shared/protocol/refusalcodes.js";

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail: any = "") => { if (ok) pass++; else fail++; console.log(`${ok ? "✓" : "✗"} ${name}${!ok && detail !== "" ? `  — ${JSON.stringify(detail).slice(0, 400)}` : ""}`); };
const ENGINE = fileURLToPath(new URL("..", import.meta.url));
const TF = { pos: [0, 0, 0], q: [0, 0, 0, 1], scale: [1, 1, 1] };
const genesis = { seq: 0, ts: 1, actor: "world", verb: "genesis", args: { v: 2, dialect: "eidoverse-log", roles: { ann: { role: "owner" } } } };

// ---- the rules, pure (RP1, RP19's reading, RP6's sky)
{ const r = repairComps({ motion: { type: "spin", part: "tripo_part_3", degPerSec: 10 } });
  const keys = Object.keys(r.c).filter((k) => k.startsWith("motion:"));
  check("SI1 a bare motion naming tripo_part_3 becomes motion:<slot> {node: \"tripo_part_3\"}, its key in the §2.3 grammar; a second run finds nothing",
    keys.length === 1 && isComponent(keys[0]) && r.c[keys[0]].node === "tripo_part_3" && !r.c.motion && repairComps(r.c).set.length === 0, r.c);
  const k3 = repairComps({ motion: { type: "spin", part: "Seat Plank" }, "motion:p0": { type: "oscillate", node: "Seat Plank" } }).c;
  check("SI1 …a motion already on that node wins (the bare one is dropped)", !k3.motion && k3["motion:p0"].type === "oscillate", k3);
  const m = repairMotion({ amplitude: "0.4", axis: "-y", type: "pendulum" });
  check("SI2 amplitude → amp (a numeric string read as its number), a letter axis → its vector, a pendulum's unwritten readings written", m.amp === 0.4 && JSON.stringify(m.axis) === "[0,-1,0]" && m.period === 3.5 && m.damp === 0 && m.maxAmp === 1.1, m);
  const w = repairWorld({ sky: { hours: 10, azimuth: 400, weatherSeconds: 0 } }).c.sky;
  check("SI3 a v1 sky's azimuth in degrees becomes radians (400° wraps to 40°); weatherSeconds 0 is dropped", Math.abs(w.azimuth - 40 * Math.PI / 180) < 1e-12 && !("weatherSeconds" in w) && !("transition" in w), w); }

// ---- the translator writes today's spelling (RP8, RP19) and lifts its socket maps (RP16)
{ const old = [genesis,
    { seq: 1, ts: 2, actor: "ann", verb: "spawn", args: { id: "swing", lib: "crate", pos: [0, 0, 0] } },
    { seq: 2, ts: 3, actor: "ann", verb: "comp", args: { id: "swing", type: "motion", data: { type: "pendulum", part: "tripo_part_3", amp: 0.2, period: 2, damp: 0 } } },
    { seq: 3, ts: 4, actor: "ann", verb: "spawn", args: { id: "bench", lib: "crate", pos: [3, 0, 0] } },
    { seq: 4, ts: 5, actor: "ann", verb: "comp", args: { id: "bench", type: "sockets", data: { seat: { pos: [0, 0.5, 0], body: { action: "sit" } } } } },
    { seq: 5, ts: 6, actor: "ann", verb: "spawn", args: { id: "cup", lib: "crate", pos: [1, 0, 0] } },
    { seq: 6, ts: 7, actor: "ann", verb: "motion", args: { id: "cup", type: "pendulum", axis: [1, 0, 0], amp: 0.3 } }];
  const t = translate(old); const ks = `motion:${partSlot("tripo_part_3")}`;
  const f = t.final.translated;
  check("SI4 the translation writes motion:<slot> {node} for a bare part, and the old swing readings (3.5 s, 0, 1.1)",
    f.swing?.[ks]?.node === "tripo_part_3" && !f.swing?.motion && f.cup?.motion?.period === 3.5 && f.cup?.motion?.damp === 0 && f.cup?.motion?.maxAmp === 1.1, [f.swing, f.cup]);
  check("SI5 …and writes no repair-shapes marker (a translated world is in today's spelling; nothing reads a marker)", !t.out.some((e) => e?.verb === "repair-shapes"), t.out.slice(0, 3).map((e) => e.verb ?? e.kind));
  const lift = t.out.findIndex((e) => e?.verb === "lift-sockets"); const { fold } = await import("../shared/protocol/fold.js");
  const g = Object.fromEntries(Object.entries(fold(t.out).entities).map(([id, e]) => [id, e.c])); const kids = Object.entries(g).filter(([, c]) => c?.parent?.to === "bench" && c?.socket?.name === "seat");
  check("SI6 a v1 sockets map is lifted by the translation itself: one lift-sockets act and its change at the tail, the seat a socket child with a station, the map gone",
    lift > 0 && t.out[lift + 1]?.kind === "change" && t.out[lift + 1].cause === lift && kids.length === 1 && kids[0][1].station?.action === "sit" && g.bench?.sockets === undefined && !!f.bench?.sockets && t.stats.lifted === 1, [lift, kids, g.bench]); }

{ const bad = [genesis, { seq: 1, ts: 2, actor: "ann", verb: "spawn", args: { id: "a-cart", lib: "crate", pos: [0, 0, 0] } },
    { seq: 2, ts: 3, actor: "ann", verb: "comp", args: { id: "a-cart", type: "sockets", data: { "front seat": { pos: [0, 0.5, 0], body: { action: "sit" } } } } }];
  let threw = ""; try { translate(bad); } catch (e) { threw = String(e?.message ?? e); }
  check("SI11 a v1 seat today's door refuses (a name that isn't one word) refuses the translation, naming the host: never a socket child the door wouldn't write", /a-cart's v1 seat can't be a socket child/.test(threw), threw); }

// ---- a world founded today needs nothing: no marker, no command, no gate, no refusal code
{ const W = scratchWorld("shape-import");
  check("SI7 a founding writes no repair-shapes act and no `shapes` in its create-world body", !W.entries().some((e) => e?.verb === "repair-shapes") && W.entries().every((e) => e?.verb !== "create-world" || !("shapes" in (e.body ?? {}))), W.entries().map((e) => e?.verb ?? e?.kind));
  const r = W.call("create", { id: "seat", model: "crate", components: { transform: TF } });
  check("SI8 …and takes writes from its first (no repair-needed gate)", r.ok, r.refused);
  check("SI9 the maintenance machinery is gone: no maintain, repairShapes, liftWorld or maintenanceNeeds export; operator repair has no repair verb; no repair-needed code",
    !("maintain" in A) && !("repairShapes" in A) && !("liftWorld" in A) && !("maintenanceNeeds" in A) && !Object.hasOwn(REFUSAL_CODES, "repair-needed")
    && A.operatorRepair(W.world(), "olive", "repair", {})?.refused?.code === "rights", Object.keys(A).filter((k) => /repair|maintain|lift/i.test(k)));
  check("SI10 no runtime file names the shape repair (shaperepair.js is gone; the world CLI has no repair command)", !fs.existsSync(path.join(ENGINE, "shared/protocol/shaperepair.js")) && !/cmd === "repair"/.test(fs.readFileSync(path.join(ENGINE, "tools/protocol/world.ts"), "utf8")), ""); }

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
