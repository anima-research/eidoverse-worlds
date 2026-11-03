// bun tools/config-env-test.ts — env numbers are validated (config.ts envNumber): a nonsense or negative
// OPT_MEM_BUDGET_MB falls back to the default with a warning; 0 stays 0 (no cap); a cost factor must be > 0;
// SNAP_TIMEOUT_SEC is taken up to its cap of 225, and above it falls back to 12 with a warning; the snapshot sweep's
// start grace (SNAP_SWEEP_GRACE_SEC, 0..600, default 30) and timer (SNAP_SWEEP_EVERY_SEC, 1..3600, default 15: never 0,
// which would busy-loop the timer) fall back the same way.
import { spawnSync } from "node:child_process";
const ok = (v: unknown, why: string) => { if (!v) { console.error("FAIL", why); process.exit(1); } };
const read = (env: Record<string, string>) => {
  const r = spawnSync(process.execPath, ["-e", 'import { OPT_MEM_BUDGET_MB, OPT_COST_FACTOR, SNAP_TIMEOUT_MS, SNAP_SWEEP_GRACE_MS, SNAP_SWEEP_EVERY_MS } from "./server/config.ts"; console.log(JSON.stringify({ b: OPT_MEM_BUDGET_MB, f: OPT_COST_FACTOR, s: SNAP_TIMEOUT_MS, g: SNAP_SWEEP_GRACE_MS, e: SNAP_SWEEP_EVERY_MS }))'],
    { env: { ...process.env, WORLDS_DIR: process.env.WORLDS_DIR ?? "/tmp/config-env-test-worlds", ...env }, encoding: "utf8", cwd: import.meta.dir + "/.." });
  const line = r.stdout.trim().split("\n").pop() ?? "";
  return { v: JSON.parse(line), warn: r.stderr + r.stdout };
};
const base = read({});
ok(Number.isFinite(base.v.b) && base.v.b >= 0 && base.v.f === 48, "defaults: finite budget, factor 48");
const banana = read({ OPT_MEM_BUDGET_MB: "banana" });
ok(banana.v.b === base.v.b && /not valid/.test(banana.warn), "'banana' → default, with a warning");
const neg = read({ OPT_MEM_BUDGET_MB: "-1" });
ok(neg.v.b === base.v.b && /not valid/.test(neg.warn), "-1 → default, with a warning");
ok(read({ OPT_MEM_BUDGET_MB: "0" }).v.b === 0, "0 → 0 (no cap, documented)");
ok(read({ OPT_MEM_BUDGET_MB: "512" }).v.b === 512, "512 → 512");
ok(read({ OPT_COST_FACTOR: "0" }).v.f === 48 && read({ OPT_COST_FACTOR: "abc" }).v.f === 48, "cost factor 0 / 'abc' → 48");
ok(read({ OPT_COST_FACTOR: "12" }).v.f === 12, "cost factor 12 → 12");
ok(read({ SNAP_TIMEOUT_SEC: "" }).v.s === 12_000, "SNAP_TIMEOUT_SEC unset → a 12 s window");
const cap = read({ SNAP_TIMEOUT_SEC: "225" });
ok(cap.v.s === 225_000 && !/SNAP_TIMEOUT_SEC/.test(cap.warn), "SNAP_TIMEOUT_SEC 225 (the cap) → 225 s, no warning");
const past = read({ SNAP_TIMEOUT_SEC: "226" });
ok(past.v.s === 12_000 && /SNAP_TIMEOUT_SEC="226" is not valid/.test(past.warn), "SNAP_TIMEOUT_SEC 226 → 12 s, with a warning");
ok(base.v.g === 30_000 && base.v.e === 15_000, "the sweep's defaults: a 30 s grace after a start, every 15 s");
ok(read({ SNAP_SWEEP_GRACE_SEC: "0" }).v.g === 0, "SNAP_SWEEP_GRACE_SEC 0 → no grace (tests)");
const longGrace = read({ SNAP_SWEEP_GRACE_SEC: "601" });
ok(longGrace.v.g === 30_000 && /SNAP_SWEEP_GRACE_SEC="601" is not valid/.test(longGrace.warn), "SNAP_SWEEP_GRACE_SEC 601 → 30 s, with a warning");
const busyLoop = read({ SNAP_SWEEP_EVERY_SEC: "0" });
ok(busyLoop.v.e === 15_000 && /SNAP_SWEEP_EVERY_SEC="0" is not valid/.test(busyLoop.warn), "SNAP_SWEEP_EVERY_SEC 0 → 15 s, with a warning (never a busy-looping timer)");
ok(read({ SNAP_SWEEP_EVERY_SEC: "3600" }).v.e === 3_600_000 && read({ SNAP_SWEEP_EVERY_SEC: "abc" }).v.e === 15_000, "SNAP_SWEEP_EVERY_SEC 3600 → an hour; 'abc' → 15 s");
console.log("config-env: 15 ok");
