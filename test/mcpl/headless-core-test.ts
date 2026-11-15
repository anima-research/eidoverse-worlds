// bun test/mcpl/headless-core-test.ts — headless-core.mjs stands in for client/lib/core.js: every name both export is a
// function in one exactly when it is in the other (a caller written against core.js calls it the same way here);
// only declared exports are compared: names in an `export { … }` list (THREE, TSL) aren't scanned
import { readFileSync } from "node:fs";
import * as headless from "../../mcpl/headless-core.mjs";
let fails = 0;
const ok = (c: boolean, what: string, got?: unknown) => { if (!c) { fails++; console.log(`  FAIL ${what}`, got ?? ""); } else console.log(`  ok   ${what}`); };

// core.js touches the DOM at import, so its export kinds are read from its source
const core = readFileSync(new URL("../../client/lib/core.js", import.meta.url), "utf8");
const fnName = /^export (?:async )?function (\w+)|^export const (\w+) = (?:async )?(?:\([^)]*\)|\w+) =>/gm;
const coreFns = new Set([...core.matchAll(fnName)].map((m) => m[1] ?? m[2]));
const coreNames = new Set([...core.matchAll(/^export (?:const|let|function|async function) (\w+)/gm)].map((m) => m[1]));
ok(coreFns.has("backendName") && coreFns.has("installRenderListTolerance") && !coreFns.has("scene") && coreNames.has("scene"),
  "setup: the source scan reads core.js's functions and its values apart", [...coreFns].slice(0, 6));
const shared = Object.keys(headless).filter((k) => coreNames.has(k));
ok(shared.length >= 8, "setup: the two share their names", shared);
for (const k of shared) ok((typeof (headless as any)[k] === "function") === coreFns.has(k),
  `${k}: ${coreFns.has(k) ? "a function" : "a value"} in both`, typeof (headless as any)[k]);

console.log(fails ? `\n${fails} failed` : "\nall passed");
process.exit(fails ? 1 : 0);
