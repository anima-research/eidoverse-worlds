// @ts-nocheck
// history {id}: each entry says WHAT changed (R 10-10 23:55: "does the World log actually not know what I set?").
//   BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun tools/protocol/history-diff-check.ts
import "./fixture-ids.ts";   // fixtures seed the ids they read (R 10-17: writers never choose ids)
import { request } from "../../shared/protocol/authority.js";
import { openWorld } from "../../server/filehost.ts";
import { scratch } from "./common.ts";
import { labClock } from "./clock.ts";
let pass = 0, fail = 0; const ok = (c, n, d) => { if (c) pass++; else { fail++; console.log("FAIL", n, JSON.stringify(d)); } };
const root = scratch("histdiff"); const clock = labClock(); const W = "h";
const call = (a, v, args = {}) => { clock.advance(1500); return request(openWorld(root, W), a, v, args); };
call("rowan", "create-world", { title: W });
call("rowan", "create", { id: "sign", components: { label: "Sign", transform: { pos: [0, 1, 0] }, text: { text: "hi", size: 0.2, width: 5.076 } } });
call("rowan", "set", { id: "sign", component: "text", value: { text: "hi", size: 0.2, width: 3.912 } });
call("rowan", "set", { id: "sign", component: "hidden", value: true });
call("rowan", "delete", { id: "sign", component: "hidden" });
const h = call("rowan", "history", { id: "sign", limit: 10 });
const by = (comp) => h.entries.map((e) => e.diff?.[comp]).filter(Boolean);
ok(h.ok && by("text").includes("width 5.076 → 3.912"), "HD1 a text edit says which field changed, from what to what", h.entries.map((e) => e.diff));
ok(by("hidden").includes("set on") && by("hidden").some((d) => /removed/.test(d)), "HD2 hidden: 'set on', then 'removed (was on)'", by("hidden"));
console.log(`[history-diff-check] ${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
