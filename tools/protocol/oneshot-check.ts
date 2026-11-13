// tools/protocol/oneshot-check.ts — the framed one-shot contract (server/oneshot.ts) on its product paths: the server's
// owner lookup (server/worldindex.ts ownersOf, through lookup()) and the operator's upgrade (server/upgrade.ts, through its
// two messages), each child misbehaving as tools/protocol/oneshot-sim.ts (a preload) says (Mica 11-05).
//   OS1 ownersOf: a post-frame hang (Bun 1.3.14 on Windows, simulated) → the owners read, bounded (≪ its 120 s guard), and the
//       forced-cleanup receipt logged; its group gone
//   OS2 upgrade: the same hang on the review, on the apply, and on an apply the CLI refuses (stale hash) → each answered, bounded
//       (≪ CLI_MS), the world translated by the apply; the refusal is "stale", never "interrupted"; each with its receipt
//   OS3 a timer or a listening socket of its own open at exit → refused, never forgiven: ownersOf reads no owners; the review
//       fails; the apply is "interrupted" (its outcome isn't trusted)
//   OS4 a partial frame (stdout's missing), a frame with another nonce, a frame whose exit isn't its exit, no frame → refused
//       (ownersOf and the upgrade); OS4h a partial frame and then alive: never accepted at the grace, only refused at its guard
//   OS5 a descendant still running at its end → refused (ownersOf and the review), and killed; OS5h at a forced cleanup → refused
//   OS6 a clean exit → accepted with no forced-cleanup label (no receipt, nothing logged by oneshot)
// usage: BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun tools/protocol/oneshot-check.ts
// @ts-nocheck
import fs from "node:fs";
import path from "node:path";
import { ENGINE, scratch } from "./common.ts";
import { tryUntil } from "./wait.ts";

const root = scratch("oneshot");
let pass = 0, fail = 0;
const ok = (cond: any, what: string, detail?: any) => { if (cond) { pass++; console.log(`  ok  ${what}`); } else { fail++; console.log(`  FAIL ${what}${detail !== undefined ? ` — ${JSON.stringify(detail)?.slice(0, 900)}` : ""}`); } };
const W = path.join(root, "worlds"), B = path.join(root, "backups"), OPT = path.join(root, "opt"), PIDS = path.join(root, "pids");
for (const d of [W, B, OPT, PIDS]) fs.mkdirSync(d, { recursive: true });
const OPS = Array.from({ length: 16 }, (_, i) => `human:test:op${i}`);
Object.assign(process.env, { WORLDS_DIR: W, BACKUPS_DIR: B, OPT_DIR: OPT, SERVER_OPERATORS: OPS.join(","), TRUST_NAMES: "1",
  BUN_OPTIONS: `--preload ${path.join(ENGINE, "tools", "protocol", "oneshot-sim.ts").replaceAll("\\", "/")}` });   // the children's, never this process's (a backslash there is an escape)
const { lookup } = await import("../../server/worldindex.ts");
const { UPGRADE_MESSAGES } = await import("../../server/upgrade.ts");
const { runOneShot, FORCED } = await import("../../server/oneshot.ts");

/** a main-era world with an owner */
const T0 = 1790000000000;
function v1(name: string) {
  const d = path.join(W, name); fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, "log.jsonl"), [["world", "grant", { id: "Ann", role: "owner", sub: "human:test:ann" }], ["Ann", "say", { text: "hi" }]]
    .map(([actor, verb, args], k) => JSON.stringify({ seq: k, ts: T0 + k * 1000, actor, verb, args })).join("\n") + "\n");
}
// what oneshot logs, per call
const logged: string[] = []; const log0 = console.log;
console.log = (...a: any[]) => { const l = a.map(String).join(" "); if (l.startsWith("[oneshot]") || l.startsWith("[upgrade]")) logged.push(l); log0(...a); };
const since = (n: number) => logged.slice(n);
// a killed process is gone once it's dead or a zombie init hasn't reaped yet (kill(pid, 0) still answers for a zombie)
const running = (pid: number) => { try { process.kill(pid, 0); } catch { return false; }
  try { const st = fs.readFileSync(`/proc/${pid}/stat`, "utf8"); return st.slice(st.lastIndexOf(")") + 2, st.lastIndexOf(")") + 3) !== "Z"; } catch { return process.platform !== "linux"; } };
const gone = async (pid: number) => !!(await tryUntil(`process ${pid} gone`, () => !running(pid), { ms: 5_000 }));
const grandchild = (tag: string) => { try { return Number(fs.readFileSync(path.join(PIDS, tag), "utf8")); } catch { return 0; } };
const sim = (mode: string, tag = mode) => { if (mode) process.env.ONESHOT_SIM = mode; else delete process.env.ONESHOT_SIM; process.env.ONESHOT_SIM_PIDFILE = path.join(PIDS, tag); };

// ================= ownersOf (server/worldindex.ts), through lookup() =================
const owners = async (name: string, mode: string) => {
  v1(name); sim(mode, name); const n = logged.length, t0 = performance.now();
  const e = lookup(name); await e.ready; sim("");
  return { owners: e.owners, ms: Math.round(performance.now() - t0), log: since(n), kid: grandchild(name) };
};
const fine = (o: any) => Array.isArray(o.owners) && o.owners.length === 1 && o.owners[0].name === "Ann";
const receiptIn = (log: string[]) => log.filter((l) => l.includes(FORCED) && l.startsWith("[oneshot]"));
{ const o = await owners("ow-hang", "hang");
  ok(fine(o) && o.ms < 30_000 && receiptIn(o.log).length === 1 && /"left":0/.test(receiptIn(o.log)[0]),
    "OS1 ownersOf: a post-frame hang → its owners read, bounded (≪ 120 s), with the forced-cleanup receipt", o); }
for (const m of ["timer", "listener"]) { const o = await owners(`ow-${m}`, m);
  ok(o.owners === null && o.log.some((l) => /not accepted .*a handle of its own open: (Timeout|Listener)/.test(l)) && !receiptIn(o.log).length,
    `OS3 ownersOf: a ${m} of its own open at exit → refused (no owners read), not forgiven`, o); }
for (const m of ["partial", "nonce", "exitlie", "noframe"]) { const o = await owners(`ow-${m}`, m);
  ok(o.owners === null && o.log.some((l) => /not accepted/.test(l)) && !receiptIn(o.log).length, `OS4 ownersOf: ${m} frame → refused (no owners read)`, o); }
{ const o = await owners("ow-descendant", "descendant");
  ok(o.owners === null && o.log.some((l) => /not accepted .*still running at its end/.test(l)) && o.kid > 0 && await gone(o.kid),
    "OS5 ownersOf: a descendant left running at its end → refused (no owners read), and it was killed", o); }
{ const o = await owners("ow-clean", "");
  ok(fine(o) && o.log.length === 0, "OS6 ownersOf: a clean exit → its owners, no forced-cleanup label (oneshot logged nothing)", o); }

// ================= the upgrade (server/upgrade.ts), through its messages =================
let opN = 0;
const ask = async (type: string, msg: any, mode: string, tag: string) => {
  const replies: any[] = [], account = OPS[opN++];
  const ctx = { c: { auth: { sub: account, exp: Date.now() + 3600_000, name: `Op${opN}` } }, ws: { send: (d: string) => replies.push(JSON.parse(d)) } };
  sim(mode, tag); const n = logged.length, t0 = performance.now();
  UPGRADE_MESSAGES[type](ctx as any, { id: 1, ...msg });
  await tryUntil(`a ${type} reply`, () => replies.length, { ms: 60_000 });   // a row's own bound: CLI_MS is 10 min
  sim("");
  return { r: replies[0] ?? null, ms: Math.round(performance.now() - t0), log: since(n), kid: grandchild(tag) };
};
const ready = async (name: string) => { v1(name); const e = lookup(name); await e.ready; };   // its owners read cleanly first (the index, as at boot)
const translated = (name: string) => fs.existsSync(path.join(W, name, "world.jsonl"));
{ await ready("up-hang");
  const rv = await ask("world-upgrade-review", { world: "up-hang" }, "hang", "up-hang-rv");
  const st = await ask("world-upgrade", { world: "up-hang", approved: "0".repeat(64) }, "hang", "up-hang-st");
  const ap = await ask("world-upgrade", { world: "up-hang", approved: rv.r?.hash }, "hang", "up-hang-ap");
  ok(rv.r?.ok === true && /^[0-9a-f]{64}$/.test(rv.r.hash) && rv.ms < 30_000 && receiptIn(rv.log).length === 1 && rv.log.some((l) => /reviewed by .*forced process cleanup/.test(l)),
    "OS2 upgrade review: a post-frame hang → the report answered, bounded (≪ CLI_MS), with the forced-cleanup receipt", rv);
  ok(st.r?.ok === false && st.r.refused?.code === "stale" && st.ms < 30_000 && receiptIn(st.log).length === 1,
    "OS2 upgrade apply refused by the CLI (stale hash), then the hang → \"stale\" (never \"interrupted\"), bounded, with the receipt", st);
  ok(ap.r?.ok === true && translated("up-hang") && ap.ms < 60_000 && receiptIn(ap.log).length === 1 && ap.log.some((l) => /upgraded by .*forced process cleanup/.test(l)),
    "OS2 upgrade apply: a post-frame hang → the world translated and answered ok, bounded, with the receipt", { ...ap, translated: translated("up-hang") }); }
{ await ready("up-timer"); await ready("up-listener");
  const rv = await ask("world-upgrade-review", { world: "up-timer" }, "timer", "up-timer-rv");
  const good = await ask("world-upgrade-review", { world: "up-listener" }, "", "up-listener-rv");
  const ap = await ask("world-upgrade", { world: "up-listener", approved: good.r?.hash }, "listener", "up-listener-ap");
  ok(rv.r?.ok === false && rv.r.refused?.code === "failed" && /Timeout/.test(rv.r.refused.reason) && !receiptIn(rv.log).length,
    "OS3 upgrade review: a timer of its own open at exit → refused (failed, naming it)", rv);
  ok(good.r?.ok === true && ap.r?.ok === false && ap.r.refused?.code === "interrupted" && /Listener/.test(ap.r.refused.reason),
    "OS3 upgrade apply: a listening socket of its own open at exit → \"interrupted\" (its outcome not trusted), never ok", ap); }
for (const m of ["partial", "nonce"]) { await ready(`up-${m}`);
  const rv = await ask("world-upgrade-review", { world: `up-${m}` }, m, `up-${m}-rv`);
  const good = await ask("world-upgrade-review", { world: `up-${m}` }, "", `up-${m}-rv2`);
  const ap = await ask("world-upgrade", { world: `up-${m}`, approved: good.r?.hash }, m, `up-${m}-ap`);
  ok(rv.r?.ok === false && rv.r.refused?.code === "failed" && ap.r?.ok === false && ap.r.refused?.code === "interrupted",
    `OS4 upgrade: ${m} frame → the review fails and the apply is "interrupted", neither ok`, { rv: rv.r, ap: ap.r }); }
{ await ready("up-descendant");
  const rv = await ask("world-upgrade-review", { world: "up-descendant" }, "descendant", "up-descendant-rv");
  ok(rv.r?.ok === false && rv.r.refused?.code === "failed" && /still running at its end/.test(rv.r.refused.reason) && rv.kid > 0 && await gone(rv.kid),
    "OS5 upgrade review: a descendant left running at its end → refused, and it was killed", rv); }
{ await ready("up-clean");
  const rv = await ask("world-upgrade-review", { world: "up-clean" }, "", "up-clean-rv");
  const ap = await ask("world-upgrade", { world: "up-clean", approved: rv.r?.hash }, "", "up-clean-ap");
  ok(rv.r?.ok === true && ap.r?.ok === true && translated("up-clean") && ![...rv.log, ...ap.log].some((l) => l.startsWith("[oneshot]") || l.includes(FORCED)),
    "OS6 upgrade review and apply: clean exits → ok, translated, no forced-cleanup label", { rv: rv.log, ap: ap.log }); }

// ================= the helper itself, where a product guard would make the row minutes long =================
const direct = async (mode: string, guardMs: number) => {
  v1(`h-${mode}`); sim(mode, `h-${mode}`);
  const r = await runOneShot([process.execPath, path.join(ENGINE, "tools", "protocol", "world.ts"), "owners-of", "--", `h-${mode}`], { cwd: ENGINE, env: { ...process.env }, guardMs, label: `oneshot-check ${mode}` });
  sim(""); return { ...r, out: r.out.slice(-200), kid: grandchild(`h-${mode}`) };
};
{ const r = await direct("partial-hang", 9_000);
  ok(!r.accepted && r.end === "timed out" && r.ms >= 9_000 && !r.receipt && r.gone, "OS4h a partial frame and then alive: not accepted at the 5 s grace; refused at its guard (9 s here), its group killed", r); }
{ const r = await direct("descendant-hang", 30_000);
  ok(!r.accepted && r.end === "forced process cleanup" && /still running when it was killed/.test(r.why ?? "") && !r.receipt && r.gone && r.kid > 0 && await gone(r.kid),
    "OS5h a descendant running when a framed, hung child is killed → refused (no receipt), the descendant killed with its group", r); }

console.log(`oneshot: ${pass} passed, ${fail} failed (bun ${Bun.version}, ${process.platform})`);
process.exit(fail ? 1 : 0);
