// tools/protocol/catalogue-check.ts — a world knows only the models of the catalogue it is handed; there is no silent lab
// default (the lab table is a suite fixture: tools/protocol/labmodels.js). Mica 11-04: explicit-catalogue acceptance, a
// negative control that an uncatalogued model refuses truthfully, and no silent loss of previously valid authored state.
//   BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun tools/protocol/catalogue-check.ts
// @ts-nocheck
import "./fixture-ids.ts";
import fs from "node:fs";
import path from "node:path";
import { scratch, ENGINE } from "./common.ts";
import { request, worldOf, NO_CATALOGUE } from "../../shared/protocol/authority.js";
import { openLive } from "../../server/livehost.ts";
import { digest } from "../../shared/protocol/fold.js";
import { LAB_CATALOGUE } from "./labmodels.js";

let pass = 0, fail = 0;
const ok = (name, c, info) => { if (c) { pass++; console.log(`ok   ${name}`); } else { fail++; console.log(`FAIL ${name}${info === undefined ? "" : " — " + JSON.stringify(info).slice(0, 300)}`); } };
const root = scratch("catalogue"); let T = 1800000000000; const now = () => (T += 1000);
const TF = { transform: { pos: [0, 0, 0] } };
const ONE = Object.freeze({ get: (n) => (n === "crate" ? { label: "a crate", size: [0.6, 0.6, 0.6], surfaces: [{ y: 0.6 }] } : undefined), list: () => [] });

// C1: a world handed a catalogue takes its models, measured (a size: it can be stacked on)
{ const dir = path.join(root, "one"); fs.mkdirSync(dir, { recursive: true }); const w = openLive(dir, "one", { now, catalogue: ONE });
  request(w, "olive", "create-world", { title: "one" });
  const a = request(w, "olive", "create", { id: "c", model: "crate", components: TF }), b = request(w, "olive", "create", { id: "cup", model: "crate", place: { on: "c" } });
  ok("C1 a world handed a catalogue takes its models and measures them (placed on top of one: y 0.6)", a.ok && b.ok && Math.abs(w.state().entities.cup.c.transform.pos[1] - 0.6) < 1e-6, [a.refused, b.refused, w.state().entities.cup?.c.transform]);

  // C2: a model its catalogue doesn't name is refused, truthfully: "no model called …", and how to find one; nothing changes
  const n0 = w.entries.length, r = request(w, "olive", "create", { id: "t", model: "table", components: TF });
  ok("C2 a model the catalogue doesn't name is refused in plain words (no model called 'table'; find lists models): nothing changes (only the refusal is logged)",
    !r.ok && r.refused.code === "shape" && /no model called 'table'/.test(r.refused.reason) && /find/.test(r.refused.fix) && !w.state().entities.t && !w.entries.slice(n0).some((e) => e.kind === "change"), r.refused);

  // C3: previously valid authored state survives a host whose catalogue no longer names it: it folds and reads as written
  const d0 = digest(w.state()); const w2 = openLive(dir, "one", { now, catalogue: NO_CATALOGUE });
  ok("C3 reopened with a catalogue that names nothing, the stored crates fold to the same digest and read as written (no silent loss)", digest(w2.state()) === d0 && w2.state().entities.c?.c.model === "crate" && w2.state().entities.cup?.c.model === "crate", { d0, d1: digest(w2.state()) });
  const ed = request(w2, "olive", "set", { id: "c", component: "label", value: "the crate" });
  ok("C3 …and an edit of such a thing that doesn't name the model is still taken", ed.ok && w2.state().entities.c.c.label === "the crate", ed.refused); }

// C4: no catalogue at all: the runtime host knows no model (the lab table is never a silent default)
{ const dir = path.join(root, "none"); fs.mkdirSync(dir, { recursive: true }); const w = openLive(dir, "none", { now });
  request(w, "olive", "create-world", { title: "none" });
  const r = request(w, "olive", "create", { id: "c", model: "crate", components: TF });
  ok("C4 a host opened with no catalogue knows no model: the lab's crate is refused, no model called 'crate'", !r.ok && /no model called 'crate'/.test(r.refused?.reason ?? ""), r.refused);
  const bare = worldOf({ name: "bare", entries: [], getBlob: () => null, putBlob: () => "", now, writeLine: () => {} });
  ok("C4 …and the bare authority (worldOf with no catalogue) holds none: it falls back to NO_CATALOGUE, which names nothing", bare.catalogue === null && NO_CATALOGUE.get("crate") === undefined && NO_CATALOGUE.list("").length === 0, bare.catalogue); }

// C5: the suites' lab table is a fixture: it lives in tools/, and no runtime file imports it
{ const g = Bun.spawnSync(["git", "-C", ENGINE, "grep", "-l", "labmodels", "--", "shared", "server", "mcpl", "client/lib"]);
  const users = String(g.stdout).split("\n").filter((f) => f && f !== "server/filehost.ts");
  ok("C5 the lab table is tools/protocol/labmodels.js and no runtime file imports it (server/filehost.ts is the suites' host)", !fs.existsSync(path.join(ENGINE, "shared/protocol/labmodels.js")) && !users.length && !!LAB_CATALOGUE.get("crate"), users); }

console.log(`[catalogue-check] ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
