// test/shared/role-grammar-test.ts — one rank ladder and one role-id grammar, both in shared/protocol/roles.js (refactor plan 2, D7).
//
//   BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun test/shared/role-grammar-test.ts
//
// Binds: the three readers of a `who` (a grabbable's, a seat's, roles.js) take the same ids. That no module outside roles.js
// writes a rank ladder or restates the role-id grammar is test/client/one-binding-test.ts's scan.

import * as R from "../../shared/protocol/roles.js";
import { checkGrabbable } from "../../shared/grab.js";
import { checkStation } from "../../shared/sockbody.js";

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  else { fail++; console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? ` — ${detail}` : ""}`); }
};

check("roles.js exports isRoleId", typeof (R as any).isRoleId === "function");
const isRoleId = (R as any).isRoleId ?? (() => null);
const grabTakes = (who: any) => checkGrabbable({ who }) === null;
const seatTakes = (who: any) => checkStation({ who }) === null;
const CORPUS = ["member", "builder", "moderator", "owner", "dj", "stage-crew", "a", "a".repeat(24), "a".repeat(25), "none", "guest", "everyone", "ghost", "banned",
  "Builder", "9lives", "-x", "", "with space", 3, null];
for (const id of CORPUS) {
  const want = isRoleId(id);
  check(`${JSON.stringify(id)}: isRoleId ${want} = a grabbable's who ${grabTakes(id)} = a seat's who ${seatTakes(id)}`, typeof want === "boolean" && grabTakes(id) === want && seatTakes(id) === want);
}
check("the built-in ids are roles; a custom role's id is roles.js's grammar", R.BUILTIN_IDS.every((x: string) => isRoleId(x)) && isRoleId("dj") && isRoleId("none") /* released R 10-21 */ && !isRoleId("banned") /* reserved */);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
