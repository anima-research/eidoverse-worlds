// bun tools/config-env-test.ts — env numbers are validated (config.ts envNumber): a nonsense or negative
// OPT_MEM_BUDGET_MB falls back to the default with a warning; 0 stays 0 (no cap); a cost factor must be > 0.
import { spawnSync } from "node:child_process";
const ok = (v: unknown, why: string) => { if (!v) { console.error("FAIL", why); process.exit(1); } };
const read = (env: Record<string, string>) => {
  const r = spawnSync(process.execPath, ["-e", 'import { OPT_MEM_BUDGET_MB, OPT_COST_FACTOR } from "./server/config.ts"; console.log(JSON.stringify({ b: OPT_MEM_BUDGET_MB, f: OPT_COST_FACTOR }))'],
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
console.log("config-env: 7 ok");
