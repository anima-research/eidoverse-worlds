// tools/protocol/owners-check.ts — a translated world's owners are bound to the accounts main recorded for them (R 10-28:
// "MAKE SURE all current server operators are in fact the owners of their own worlds"). Synthetic fixtures only.
//   MK1  main's .principals.json: one account under a name (any case) is what main knew for it
//   MK2  two accounts under one name (principals and another world's log) are both returned: ambiguous
//   MK3  another world's grant / genesis / placer pairs count (log.jsonl, or log.original.jsonl once translated); the world itself doesn't
//   MK4  .bans.json and .sessions.json are not read
// usage: BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun tools/protocol/owners-check.ts
// @ts-nocheck
import fs from "node:fs";
import path from "node:path";
import { scratch } from "./common.ts";
import { mainKnowledge } from "./import-v1/mainknew.ts";

let pass = 0, fail = 0;
const ok = (cond: any, what: string, detail?: any) => { if (cond) { pass++; console.log(`  ok  ${what}`); } else { fail++; console.log(`  FAIL ${what}${detail !== undefined ? ` — ${JSON.stringify(detail)?.slice(0, 700)}` : ""}`); } };
const row = (what: string, fn: () => any) => { try { return fn(); } catch (e) { ok(false, what, `threw: ${e?.stack ?? e}`); } };
const T0 = 1790000000000;
const same = (a: any, b: any) => JSON.stringify(a) === JSON.stringify(b);
/** a main-era world: its log.jsonl from [actor, verb, args] triples */
function v1(W: string, name: string, L: [string, string, any][], file = "log.jsonl") {
  const d = path.join(W, name); fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, file), L.map(([actor, verb, args], k) => JSON.stringify({ seq: k, ts: T0 + k * 1000, actor, verb, args })).join("\n") + "\n");
  return d;
}
const principals = (W: string, p: Record<string, [string, string]>) => fs.writeFileSync(path.join(W, ".principals.json"),
  JSON.stringify(Object.fromEntries(Object.entries(p).map(([sub, [name, kind]]) => [sub, { name, kind, first: T0, last: T0 }]))), { mode: 0o600 });

// ================= MK: what main recorded for a name, outside the world's own log =================
{ const root = scratch("owners-mk"), W = path.join(root, "worlds");
  principals(W, { "human:test:antra": ["Antra", "human"], "human:test:mica1": ["mica", "human"], "service:x": ["svc", "human"] });
  v1(W, "garden", [["world", "grant", { id: "Mica", role: "owner", sub: "human:test:mica2" }], ["Mica", "spawn", { id: "c", lib: "x.glb", placer: { id: "Pip", sub: "human:test:pip" } }]]);
  v1(W, "water", [["world", "genesis", { roles: { Rue: { role: "owner", sub: "human:test:rue" } } }]], "log.original.jsonl");
  fs.writeFileSync(path.join(W, "water", "world.jsonl"), "{}\n");
  v1(W, "commons", [["world", "grant", { id: "Self", role: "owner", sub: "human:test:self" }]]);
  fs.writeFileSync(path.join(W, ".bans.json"), JSON.stringify({ zed: { by: "Antra", ts: T0, sub: "human:test:zed" } }));
  fs.writeFileSync(path.join(root, ".sessions.json"), JSON.stringify({ ["a".repeat(64)]: { sub: "human:test:sess", name: "Sess", exp: T0 * 2 } }));
  const k = mainKnowledge(W, { self: "commons" });
  row("MK1", () => ok(same(k("antra"), { subs: ["human:test:antra"], from: [".principals.json"] }) && same(k("ANTRA"), k("antra")),
    "MK1 main's .principals.json: one account under a name, in any case, is what main knew for it", k("antra")));
  row("MK2", () => ok(same(k("mica")?.subs, ["human:test:mica1", "human:test:mica2"]) && same(k("mica")?.from, [".principals.json", "garden's log"]),
    "MK2 two accounts under one name (principals and another world's grant) are both returned: ambiguous", k("mica")));
  row("MK3", () => ok(same(k("pip")?.subs, ["human:test:pip"]) && same(k("rue")?.from, ["water's log"]) && k("self") === null,
    "MK3 another world's placer and genesis pairs count (log.jsonl, or log.original.jsonl once that world was translated); the world being translated is skipped", { pip: k("pip"), rue: k("rue"), self: k("self") }));
  row("MK4", () => ok(k("zed") === null && k("sess") === null, "MK4 .bans.json (a name the banner typed) and .sessions.json (bearer secrets) are not read", { zed: k("zed"), sess: k("sess") }));
}

console.log(`[owners-check] ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
