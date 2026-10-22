// grant-until-test — a timed grant's `until` is a whole number of milliseconds (house review I124, #260).
//
//   BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun tools/grant-until-test.ts
//
// The authority refuses roles:<id>.until unless Number.isSafeInteger (shared/protocol/authority/checks.js), and the
// client's clock estimate (client/lib/serverclock.js serverNow) is fractional: performance.now() plus a measured offset.
// So every client writer of `until` goes through serverUntil(ms), which rounds.
//   1. the door, on a scratch world: until with a fraction is refused, the same time rounded is accepted
//   2. serverUntil returns a safe integer while performance.now() is fractional
//   3. no client file writes `until: serverNow() + …` (the timed /grant and the Roles panel's end picker did)
// @ts-nocheck
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";

process.env.WORLDS_DIR = join(mkdtempSync(join(tmpdir(), "ew-grant-until-")), "worlds");
let passed = 0, failed = 0;
const check = (name, ok, detail = "") => {
  if (ok) { passed++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  else { failed++; console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? `\n      ${detail}` : ""}`); }
};

// 1. the door
const { scratchWorld } = await import("./protocol/scratchworld.ts");
const W = scratchWorld("grant-until");
const now = Number(process.env.PROTOCOL_NOW);
const frac = W.call("set", { id: "@world", component: "roles:u-pip", value: { role: "builder", until: now + 7_200_000.37 } });
check("the authority refuses an until with a fraction of a millisecond", !frac.ok, JSON.stringify(frac.refused ?? frac));
const now2 = Number(process.env.PROTOCOL_NOW);
const whole = W.call("set", { id: "@world", component: "roles:u-pip", value: { role: "builder", until: Math.round(now2 + 7_200_000.37) + 1000 } });
check("…and accepts the same time rounded", whole.ok, JSON.stringify(whole.refused ?? whole));

// 2. serverUntil
const realNow = performance.now.bind(performance);
performance.now = () => realNow() + 0.123;
const clock = await import("../client/lib/serverclock.js");
check("serverNow is fractional here (the premise)", !Number.isInteger(clock.serverNow()), String(clock.serverNow()));
const u = typeof clock.serverUntil === "function" ? clock.serverUntil(7_200_000) : undefined;
check("serverUntil(ms) is a safe integer", Number.isSafeInteger(u), String(u));
check("…about ms from now", Number.isSafeInteger(u) && Math.abs(u - (clock.serverNow() + 7_200_000)) < 50, String(u));
performance.now = realNow;

// 3. no client writer computes until from the raw clock
const files = [];
const walk = (d) => { for (const f of readdirSync(d)) { const p = join(d, f); if (statSync(p).isDirectory()) walk(p); else if (p.endsWith(".js")) files.push(p); } };
walk(new URL("../client/lib", import.meta.url).pathname);
const hits = files.filter((f) => /until:\s*serverNow\(\)\s*\+/.test(readFileSync(f, "utf8")));
check("no client file writes until: serverNow() + …", hits.length === 0, hits.join(", "));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
