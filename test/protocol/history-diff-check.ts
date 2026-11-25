// @ts-nocheck
// history {id}: each entry says WHAT changed (R 10-10 23:55: "does the World log actually not know what I set?").
//   BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun test/protocol/history-diff-check.ts
import "../harness/fixture-ids.ts";   // fixtures seed the ids they read (R 10-17: writers never choose ids)
import { openWorld } from "../harness/filehost.ts";
import { labWorld } from "../harness/labworld.ts";
import { suite } from "../gate/suite.ts";
const { ok, done } = suite("history-diff-check", { quiet: true, cap: Infinity });
const W = "h", L = labWorld("histdiff"), { root } = L;
const call = (a, v, args = {}) => L.call(W, a, v, args);
call("rowan", "create-world", { title: W });
call("rowan", "create", { id: "sign", components: { label: "Sign", transform: { pos: [0, 1, 0] }, text: { text: "hi", size: 0.2, width: 5.076 } } });
call("rowan", "set", { id: "sign", component: "text", value: { text: "hi", size: 0.2, width: 3.912 } });
call("rowan", "set", { id: "sign", component: "hidden", value: true });
call("rowan", "delete", { id: "sign", component: "hidden" });
const h = call("rowan", "history", { id: "sign", limit: 10 });
const by = (comp) => h.entries.map((e) => e.diff?.[comp]).filter(Boolean);
ok(h.ok && by("text").includes("width 5.076 → 3.912"), "HD1 a text edit says which field changed, from what to what", h.entries.map((e) => e.diff));
ok(by("hidden").includes("set on") && by("hidden").some((d) => /removed/.test(d)), "HD2 hidden: 'set on', then 'removed (was on)'", by("hidden"));
done();
