// server-clock-readers-test: a server stamp (a sky's ts, a role's until) is read on the authority's clock
// (client/lib/serverclock.js serverNow), never this machine's wall clock, so a skewed client sees everyone's sun and expiry.
//   BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun test/client/server-clock-readers-test.ts
// inspect.js runs in the inspect harness (test/harness/inspectharness.ts); the other readers are held by one-binding-test's
// "a server stamp is read on serverNow" row.
// @ts-nocheck
import { inspectHarness } from "../harness/inspectharness.ts";
inspectHarness("server-clock-readers");
const { worldLive } = await import("../../client/lib/edit/inspect.js");
const { serverNow, noteRoundTrip, localNow } = await import("../../client/lib/serverclock.js");

let failures = 0;
const check = (label: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m"} ${label}${!ok && detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};
// the authority's clock is this machine's (one round trip, offset 0); then the wall clock is skewed two hours ahead
const t = localNow(); noteRoundTrip(t, t + 5, t + 10);
const realNow = Date.now, SKEW = 2 * 3600e3;
Date.now = () => realNow() + SKEW;
check("the setup: the wall clock reads two hours off the authority's", Math.abs(Date.now() - serverNow() - SKEW) < 1000, `${Date.now() - serverNow()}`);
const now = worldLive().now;
check("the world panel's now (sky preset, forecast cursor) is the authority's", Math.abs(now - serverNow()) < 1000, `off by ${Math.round((now - serverNow()) / 1000)} s`);
Date.now = realNow;

console.log(failures ? `\n${failures} failed` : "\nall passed");
process.exit(failures ? 1 : 0);
