// bun test/server/config-env-test.ts — env numbers are validated (server/limits.ts envNumber, config.ts and limits.ts read it): unset → the fallback, silently;
// not a number or outside the variable's range → the fallback with a `NAME="v" is not valid` warning; in range → taken.
// One generated table: each variable × [unset, "abc", "-1", its floor (and just under it), its cap and cap+1, a middle].
import { spawnSync } from "node:child_process";

// [name, key, fallback (null: machine-derived), scale, floor, floor taken?, cap?, middle]; the _SEC vars are ×1000
const VARS: [string, string, number | null, number, number, boolean, number | undefined, number][] = [
  ["OPT_MEM_BUDGET_MB", "b", null, 1, 0, true, undefined, 512],          // 0 = no cap, documented
  ["OPT_COST_FACTOR", "f", 48, 1, 0, false, undefined, 12],
  ["SNAP_TIMEOUT_SEC", "s", 12, 1000, 0, false, 225, 60],
  ["SNAP_SWEEP_GRACE_SEC", "g", 30, 1000, 0, true, 600, 120],
  ["SNAP_SWEEP_EVERY_SEC", "e", 15, 1000, 1, true, 3600, 30],            // never 0: a busy-looping timer
  ["PORT", "p", 8940, 1, 0, true, 65535, 8950],                       // 0 = an ephemeral port, as main read it
  ["UPLOAD_CAP_MB", "u", 20, 1_000_000, 0, true, undefined, 50],      // 0 taken, as main took it
  ["IMAGE_CAP_MB", "i", 8, 1_000_000, 0, true, undefined, 4],
  ["MSG_RATE", "m", 60, 1, 1, true, undefined, 120],                    // NaN or 0 refused every message (main took both): the floor is 1 a second
  ["EW_ID_LEN", "l", 64, 1, 0, true, undefined, 32],                     // limits.ts's table: "" read as 0
  ["CLIENTLOG_IP_PER_10MIN", "c", 30, 1, 0, true, undefined, 60],         // 0 = no rail; "" read as 0 turned it off
  ["OPT_CHILD_TIMEOUT_MS", "t", 1_800_000, 1, 0, true, undefined, 1500], // 0 = never kill; NaN never armed the killer
  ["EIDO_METER_SCALE", "r", 1, 1, 1, true, undefined, 2],                // Infinity never refused a read (#391)
];
// [raw, taken?] per variable; "" is unset
const cases = VARS.map(([, , , , min, minOk, max, mid]): [string, boolean][] => [["", false], ["abc", false], ["-1", false], ["Infinity", false], [String(min), minOk],
  ...(minOk && min > 0 ? [[String(min - 1), false]] : []), ...(max !== undefined ? [[String(max), true], [String(max + 1), false]] : []), [String(mid), true]] as [string, boolean][]);
const read = (env: Record<string, string>) => {
  const r = spawnSync(process.execPath, ["-e", 'import { OPT_MEM_BUDGET_MB, OPT_COST_FACTOR, SNAP_TIMEOUT_MS, SNAP_SWEEP_GRACE_MS, SNAP_SWEEP_EVERY_MS, PORT, UPLOAD_CAP, IMAGE_CAP, MSG_RATE, optChildTimeoutMs } from "./server/config.ts"; import { LIMITS } from "./server/limits.ts"; import { LIMITS as CL } from "./server/clientlog.ts"; import { READ } from "./server/readmeter.ts"; console.log(JSON.stringify({ r: READ.ms / 1500, b: OPT_MEM_BUDGET_MB, f: OPT_COST_FACTOR, s: SNAP_TIMEOUT_MS, g: SNAP_SWEEP_GRACE_MS, e: SNAP_SWEEP_EVERY_MS, p: PORT, u: UPLOAD_CAP, i: IMAGE_CAP, m: MSG_RATE, l: LIMITS.ID_LEN, t: optChildTimeoutMs(), c: CL.ipPer10Min }))'],
    { env: { ...process.env, WORLDS_DIR: process.env.WORLDS_DIR ?? "/tmp/config-env-test-worlds", ...env }, encoding: "utf8", cwd: import.meta.dir + "/../.." });
  return { v: JSON.parse(r.stdout.trim().split("\n").pop() ?? "") as Record<string, number>, warn: r.stderr + r.stdout };
};
let fail = 0, rows = 0, budgetDefault = NaN;
// one child per scenario sets every variable at once: the i-th case of each (a variable with fewer cases is unset)
for (let i = 0; i < Math.max(...cases.map((c) => c.length)); i++) {
  const got = read(Object.fromEntries(VARS.map(([name], j) => [name, cases[j][i]?.[0] ?? ""])));
  if (i === 0) budgetDefault = got.v.b;
  VARS.forEach(([name, key, fallback, scale], j) => {
    const [raw, taken] = cases[j][i] ?? ["", false]; rows++;
    const want = taken ? Number(raw) * scale : (fallback ?? budgetDefault) * scale, wantWarn = raw !== "" && !taken;
    const warned = got.warn.includes(`${name}=${JSON.stringify(raw)} is not valid`), named = got.warn.includes(`${name}=`);
    if (got.v[key] !== want || (wantWarn ? !warned : named)) { fail++; console.error(`FAIL ${name}=${JSON.stringify(raw)}: got ${got.v[key]}, want ${want}; warning ${named ? "given" : "none"}, want ${wantWarn ? "one" : "none"}`); }
  });
}
// a count (limits.ts LIMITS, clientlog.ts) is a whole number: a fraction falls back with the warning (EW_PAGE_MAX=1.5 left every page unbounded)
{ const got = read({ EW_ID_LEN: "1.5", CLIENTLOG_IP_PER_10MIN: "0.5" }); rows++;
  if (got.v.l !== 64 || got.v.c !== 30 || !got.warn.includes('EW_ID_LEN="1.5" is not valid') || !got.warn.includes('CLIENTLOG_IP_PER_10MIN="0.5" is not valid')) { fail++; console.error(`FAIL a fractional count: got l=${got.v.l} c=${got.v.c}, want 64 and 30 with warnings`); } }
// the budget's own default is machine-derived (half the usable memory): finite, never negative
if (!(Number.isFinite(budgetDefault) && budgetDefault >= 0)) { fail++; console.error(`FAIL OPT_MEM_BUDGET_MB default ${budgetDefault}`); }
if (fail) process.exit(1);
console.log(`config-env: ${rows} rows ok`);
