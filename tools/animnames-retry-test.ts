// animnames-retry-test — one failed /defs fetch doesn't leave the action bar empty (house config I18, #260).
//
//   BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun tools/animnames-retry-test.ts
//
// animnames.js hydrates the bar's gestures from /defs at load and, before, again only on a hot-reload push: one failed
// fetch left no gestures for the session. It tries again, backing off from 2 s. Here the first fetch fails and the
// second answers; within the first back-off the bar is filled.
import { mock } from "bun:test";
let calls = 0;
mock.module(`${import.meta.dir}/../client/lib/defs.js`, () => ({
  defsRegistry: () => (++calls === 1 ? Promise.reject(new Error("GET /defs -> 503")) : Promise.resolve({ actionbar: { wave: { clip: "wave", icon: "hand" } } })),
}));
const origWarn = console.warn; console.warn = () => {};
const A = await import("../client/lib/animnames.js");
await new Promise((r) => setTimeout(r, 2300));
console.warn = origWarn;
const ok = calls >= 2 && A.ANIM_ORDER.includes("wave");
console.log(`  ${ok ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m"} a failed first fetch is retried and the bar fills (${calls} fetches, order ${JSON.stringify(A.ANIM_ORDER)})`);
console.log(`\n${ok ? 1 : 0} passed, ${ok ? 0 : 1} failed`);
process.exit(ok ? 0 : 1);
