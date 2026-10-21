// tools/role-grammar-test.ts — one rank ladder and one role-id grammar, both in shared/protocol/roles.js (refactor plan 2, D7).
//
//   BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun tools/role-grammar-test.ts
//
// Binds: no module outside roles.js writes a rank ladder ({visitor: 0, builder: …}) or restates the role-id grammar (the
// id regex, the reserved words); the three readers of a `who` (a grabbable's, a seat's, roles.js) take the same ids.
// The v1 importer's ladder (tools/protocol/import-v1) is the old protocol's own and is not scanned.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import * as R from "../shared/protocol/roles.js";
import { checkGrabbable } from "../shared/grab.js";
import { checkSockets } from "../shared/sockbody.js";

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  else { fail++; console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? ` — ${detail}` : ""}`); }
};

const ROOT = join(import.meta.dir, "..");
const files: string[] = [];
const walk = (d: string) => { for (const n of readdirSync(d)) { if (n === "node_modules" || n.startsWith(".")) continue; const p = join(d, n); const st = statSync(p);
  if (st.isDirectory()) walk(p); else if (/\.(js|mjs|ts)$/.test(n) && !/\.min\./.test(n)) files.push(p); } };
for (const d of ["shared", "server", "client/lib", "mcpl"]) walk(join(ROOT, d));
const ROLES = join(ROOT, "shared/protocol/roles.js");
const RUNG = /\b(none|visitor|builder|moderator|owner)\s*:\s*-?\d+\b/g;
const ladders: string[] = [], idRegex: string[] = [], reserved: string[] = [];
for (const p of files) {
  if (p === ROLES) continue;
  const lines = readFileSync(p, "utf8").split("\n");
  lines.forEach((line, i) => {
    const at = `${relative(ROOT, p)}:${i + 1}`;
    if (new Set([...line.matchAll(RUNG)].map((m) => m[1])).size >= 2) ladders.push(at);
    if (line.includes("[a-z][a-z0-9-]{0,23}")) idRegex.push(at);
    if (/['"]guest['"]\s*,\s*['"]everyone['"]\s*,\s*['"]ghost['"]/.test(line)) reserved.push(at);
  });
}
check("no rank ladder outside roles.js (RANK is the one)", !ladders.length, ladders.join(", "));
check("no role-id regex outside roles.js", !idRegex.length, idRegex.join(", "));
check("no reserved-word list outside roles.js", !reserved.length, reserved.join(", "));

check("roles.js exports isRoleId", typeof (R as any).isRoleId === "function");
const isRoleId = (R as any).isRoleId ?? (() => null);
const grabTakes = (who: any) => checkGrabbable({ who }) === null;
const seatTakes = (who: any) => checkSockets({ seat: { pos: [0, 0.5, 0], body: { who } } }) === null;
const CORPUS = ["player", "builder", "moderator", "owner", "dj", "stage-crew", "a", "a".repeat(24), "a".repeat(25), "none", "guest", "everyone", "ghost", "banned",
  "Builder", "9lives", "-x", "", "with space", 3, null];
for (const id of CORPUS) {
  const want = isRoleId(id);
  check(`${JSON.stringify(id)}: isRoleId ${want} = a grabbable's who ${grabTakes(id)} = a seat's who ${seatTakes(id)}`, typeof want === "boolean" && grabTakes(id) === want && seatTakes(id) === want);
}
check("the built-in ids are roles; a custom role's id is roles.js's grammar", R.BUILTIN_IDS.every((x: string) => isRoleId(x)) && isRoleId("dj") && isRoleId("none") /* released R 10-21 */ && !isRoleId("banned") /* reserved */);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
