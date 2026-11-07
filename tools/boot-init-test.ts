// boot-init-test — every `export function init*` under client/lib is called from somewhere in the client other than its own
// definition. initOccupants lost its only call in the merge resolution of cdc539db (PR #109, 2026-08-12) and nothing noticed:
// an init with no caller is a module that silently never starts.
//
//   BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun tools/boot-init-test.ts
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Glob } from "bun";
import { mkCheck } from "./harness.ts";
const { check, tally } = mkCheck();

// a commented-out call is no call (a `//` after a quote or colon is a URL, kept)
const uncomment = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[\s;{}()])\/\/.*$/gm, "$1");
const CLIENT = resolve(import.meta.dir, "../client");
const files = [...new Glob("**/*.{js,mjs,ts}").scanSync(CLIENT)].map((f) => f.split("\\").join("/")).filter((f) => !f.includes("node_modules")).map((f) => ({ f, src: uncomment(readFileSync(join(CLIENT, f), "utf8")) }));   // "/" on every OS (Windows globs with "\\", CI 10-21)
const DEF = /export\s+(?:async\s+)?function\s+(init[A-Z]\w*)\s*\(|export\s+const\s+(init[A-Z]\w*)\s*=/g;
const inits = files.filter(({ f }) => f.startsWith("lib/")).flatMap(({ f, src }) => [...src.matchAll(DEF)].map((m) => ({ name: m[1] ?? m[2], f })));
check(`found the client's init* exports (${inits.length})`, inits.length > 20);

const esc = (s: string) => s.replace(/[$]/g, "\\$&");
const uncalled: string[] = [];
for (const { name, f } of inits) {
  const names = new Set([name]);
  for (const { src } of files) for (const m of src.matchAll(new RegExp(`\\b${esc(name)}\\s+as\\s+(\\w+)`, "g"))) names.add(m[1]);
  const isDef = (src: string, at: number) => /(?:function|const)\s+$/.test(src.slice(Math.max(0, at - 40), at));
  const called = files.some(({ src }) => [...names].some((n) => [...src.matchAll(new RegExp(`(?<![\\w$])${esc(n)}\\s*\\(`, "g"))].some((m) => !isDef(src, m.index!))));
  if (!called) uncalled.push(`${name} (${f})`);
}
check("every init* export has a caller", uncalled.length === 0, uncalled.join(", "));

console.log(`\n${tally.passed} passed, ${tally.failed} failed`);
process.exit(tally.failed ? 1 : 0);
