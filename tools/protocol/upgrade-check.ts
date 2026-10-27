// tools/protocol/upgrade-check.ts — opening an old-format world: the verified backup, the structured refusal, the operator's upgrade.
// Design: docs/TRANSLATING-OLD-WORLDS.md ("Upgrading from the browser", "Backups").
//   UB1  an in-place `translate` first copies the whole old world dir to BACKUPS_DIR/<world>-<UTC stamp>/ with SHA256SUMS, every hash verified; the output names it
//   UB2  a backup copy that doesn't verify (injected: WORLD_TS_CORRUPT_BACKUP) refuses the translation: nothing moved
//   UB3  translation.json names the backup's path
//   UB4  rollback leaves the backup exactly as it was
//   UB5  a BACKUPS_DIR inside WORLDS_DIR is refused (the server lists every directory there as a world)
//   US1  an old-format world's join is refused (close 4005 kept) with refused {code: "old-format", doc, upgrade: "operator", operator}: false for a visitor, true for an operator's session
//   US2  world-upgrade-review / world-upgrade from someone who isn't an operator: refused, "ask the server's operator", nothing written
//   US3  world-upgrade-review → the dry-run report and its hash (the CLI's), nothing written
//   US4  world-upgrade with a stale hash is refused (both hashes), nothing written
//   US5  world-upgrade with the reviewed hash: a verified backup, the CLI's translation bound to it, the world joinable at once; the result names the backup and the hash
//   US6  operator requests are rate-limited (a fresh account: RATE_N taken, the next refused)
//   US7  an agent (mcpl/agent.ts) refused at an old-format world says, in words, who can upgrade it and where the doc is
//   UB6  a world name starting with "-" is refused by the CLI; UB7 a WORLDS_DIR/<name> that is a symlink is refused; UB8 after `--` nothing is a flag
//   US8  the server refuses a "-x" world and a symlinked one (not-old), nothing written
// usage: BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun tools/protocol/upgrade-check.ts
// @ts-nocheck
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { ENGINE, scratch } from "./common.ts";
import { tryUntil } from "./wait.ts";
import { isWorldDir } from "../../server/livehost.ts";

const root = scratch("upgrade");
let pass = 0, fail = 0;
const ok = (cond: any, what: string, detail?: any) => { if (cond) { pass++; console.log(`  ok  ${what}`); } else { fail++; console.log(`  FAIL ${what}${detail !== undefined ? ` — ${JSON.stringify(detail).slice(0, 700)}` : ""}`); } };
const W = path.join(root, "worlds"), B = path.join(root, "backups"), OPT = path.join(root, "opt"); fs.mkdirSync(OPT, { recursive: true });
const tool = (args: string[], env: Record<string, string> = {}) => { const r = Bun.spawnSync(["bun", "tools/protocol/world.ts", ...args], { cwd: ENGINE,
  env: { ...process.env, WORLDS_DIR: W, OPT_DIR: OPT, BACKUPS_DIR: "", PROTOCOL_SCRATCH: root, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0", ...env }, timeout: 45_000 });
  return { code: r.exitCode, out: r.stdout.toString() + r.stderr.toString() }; };
const dryHash = (name: string, env: Record<string, string> = {}) => /^report-hash ([0-9a-f]{64})$/m.exec(tool(["translate", name, "--dry-run", "--no-founder-key"], env).out)?.[1] ?? "no-hash";
const xlate = (name: string, env: Record<string, string> = {}) => tool(["translate", name, "--no-founder-key", "--operator-only-no-owner", "--approved", dryHash(name, env)], env);
const sha = (b: Buffer) => crypto.createHash("sha256").update(b).digest("hex");
/** every file under d, recursively: relative path → sha256 */
const tree = (d: string, at = ""): Record<string, string> => { const out: Record<string, string> = {}; if (!fs.existsSync(d)) return out;
  for (const f of fs.readdirSync(path.join(d, at)).sort()) { const rel = at ? `${at}/${f}` : f; const p = path.join(d, rel);
    if (fs.statSync(p).isDirectory()) Object.assign(out, tree(d, rel)); else out[rel] = sha(fs.readFileSync(p)); } return out; };
const same = (a: any, b: any) => JSON.stringify(a) === JSON.stringify(b);
const temps = () => fs.readdirSync(W).filter((f) => f.startsWith(".translating-"));

// a tiny synthetic old world: a log.jsonl of the first protocol's verbs, a poses.json and a nested file
const T0 = 1790000000000;
function oldWorld(name: string) {
  const d = path.join(W, name); fs.mkdirSync(path.join(d, "extra"), { recursive: true });
  const L = [{ actor: "world", verb: "grant", args: { id: "Ann", role: "owner" } }, { actor: "Ann", verb: "spawn", args: { id: "cup_1", lib: "test/cup.glb", pos: [1, 0, 1] } },
    { actor: "Ann", verb: "say", args: { text: "an old hello" } }];
  fs.writeFileSync(path.join(d, "log.jsonl"), L.map((e, k) => JSON.stringify({ seq: k, ts: T0 + k * 1000, ...e })).join("\n") + "\n");
  fs.writeFileSync(path.join(d, "poses.json"), JSON.stringify({ Ann: { p: [1, 0, 2], yaw: 0 } }));
  fs.writeFileSync(path.join(d, "extra", "note.txt"), "kept by the old server\n");
  return d;
}
const backupsOf = (name: string) => (fs.existsSync(B) ? fs.readdirSync(B).filter((f) => f.startsWith(`${name}-`)).map((f) => path.join(B, f)) : []);

// ================= UB: the verified backup (one path for the CLI and the server) =================
{ const d = oldWorld("porch"); const before = tree(d);
  const r = xlate("porch");
  const bs = backupsOf("porch"), b = bs[0];
  const sums = b && fs.existsSync(path.join(b, "SHA256SUMS")) ? fs.readFileSync(path.join(b, "SHA256SUMS"), "utf8") : "";
  const listed = Object.fromEntries(sums.split("\n").filter(Boolean).map((l) => { const m = /^([0-9a-f]{64}) {2}(.+)$/.exec(l); return m ? [m[2], m[1]] : ["?", l]; }));
  const copied = b ? tree(b) : {}; delete copied.SHA256SUMS;
  ok(r.code === 0 && bs.length === 1 && /^porch-\d{8}T\d{6}Z$/.test(path.basename(b)) && same(copied, before) && same(listed, before) && !b.startsWith(W + path.sep) && r.out.includes(`backup: ${b}`),
    "UB1 an in-place translate first copies the whole old world dir (nested files too) to BACKUPS_DIR/<world>-<UTC yyyymmddThhmmssZ>/ beside the worlds dir, with SHA256SUMS; every byte equal; the output names it", { code: r.code, bs, copied, before, listed, out: r.out.slice(-500) });
  const m = JSON.parse(fs.existsSync(path.join(d, "translation.json")) ? fs.readFileSync(path.join(d, "translation.json"), "utf8") : "{}");
  ok(!!b && m.backup === b, "UB3 translation.json names the backup's path", { backup: m.backup, b });
  const bt = b ? tree(b) : {};
  const rb = tool(["rollback", "porch"]);
  ok(rb.code === 0 && same(tree(d), before) && same(b ? tree(b) : null, bt) && backupsOf("porch").length === 1, "UB4 rollback puts the world back and leaves the backup exactly as it was", { code: rb.code, out: rb.out.slice(-300) });
}
{ const d = oldWorld("cracked"); const before = tree(d);
  const r = xlate("cracked", { WORLD_TS_CORRUPT_BACKUP: "1" });
  ok(r.code !== 0 && /backup/i.test(r.out) && /verif|SHA256SUMS|doesn't match/i.test(r.out) && /Nothing was (moved|changed)/.test(r.out) && same(tree(d), before) && !isWorldDir(d) && !temps().length,
    "UB2 a backup whose copy doesn't verify refuses the translation: nothing moved, the world as it was", { code: r.code, out: r.out.slice(-600) });
}
{ const d = oldWorld("inside"); const before = tree(d);
  const r = xlate("inside", { BACKUPS_DIR: path.join(W, "backups") });
  ok(r.code !== 0 && /BACKUPS_DIR/.test(r.out) && /inside|within/.test(r.out) && same(tree(d), before) && !fs.existsSync(path.join(W, "backups")),
    "UB5 a BACKUPS_DIR inside WORLDS_DIR is refused (every directory there is served as a world), nothing written", { code: r.code, out: r.out.slice(-400) });
}

// ================= UB6-8: names and paths the CLI must not take (review finding 4) =================
const elsewhere = path.join(root, "elsewhere"); fs.mkdirSync(elsewhere, { recursive: true });
function linkedWorld(name: string) { const real = oldWorld(name); const to = path.join(elsewhere, name); fs.renameSync(real, to); fs.symlinkSync(to, real); return to; }
{ const d = oldWorld("-x"), before = tree(d); const r = tool(["translate", "-x", "--dry-run", "--no-founder-key"]);
  ok(r.code !== 0 && !/report-hash/.test(r.out) && same(tree(d), before), "UB6 a world named \"-x\" (it would read as a flag) is refused by the CLI, nothing written", { code: r.code, out: r.out.slice(-300) }); }
{ const to = linkedWorld("linked"), before = tree(to); const r = tool(["translate", "linked", "--dry-run", "--no-founder-key"]);
  ok(r.code !== 0 && /symlink/.test(r.out) && same(tree(to), before), "UB7 a WORLDS_DIR/<name> that is a symlink is refused (backup and translate never follow it), nothing written", { code: r.code, out: r.out.slice(-300) }); }
{ oldWorld("porch3"); const r = tool(["translate", "porch3", "--no-founder-key", "--", "--dry-run"]), d = tool(["translate", "--dry-run", "--no-founder-key", "--", "porch3"]);
  ok(r.code !== 0 && !/report-hash/.test(r.out) && d.code === 0 && /report-hash/.test(d.out), "UB8 after `--` nothing is a flag: `-- --dry-run` is a (refused) name, not a dry run; `-- porch3` is the world", { r: r.out.slice(-200), d: d.code }); }

// ================= US: the join refusal and the operator's upgrade, on a real server =================
async function freePort(from: number) { for (let p = from; p < from + 200; p++) { if (p === 8968 || p === 8970) continue;
  const free = await new Promise((res) => { try { const s = Bun.listen({ hostname: "0.0.0.0", port: p, socket: { data() {} } }); s.stop(true); res(true); } catch { res(false); } }); if (free) return p; } throw new Error("no free port"); }
const OP = "a".repeat(64), VIS = "b".repeat(64), OP2 = "c".repeat(64), OP3 = "d".repeat(64);
const sf = path.join(root, "sessions.json");
fs.writeFileSync(sf, JSON.stringify({ [OP]: { sub: "human:test:op", name: "Opal", scopes: ["worlds:join"], exp: Date.now() + 3600_000 },
  [VIS]: { sub: "human:test:vis", name: "Vee", scopes: ["worlds:join"], exp: Date.now() + 3600_000 },
  [OP2]: { sub: "human:test:op2", name: "Otto", scopes: ["worlds:join"], exp: Date.now() + 3600_000 },
  [OP3]: { sub: "human:test:op3", name: "Ona", scopes: ["worlds:join"], exp: Date.now() + 3600_000 } }), { mode: 0o600 });
const port = await freePort(9440); const slog = path.join(root, "server.log");
const proc = Bun.spawn(["bun", "server/server.ts"], { cwd: ENGINE, env: { ...process.env, PORT: String(port), WORLDS_DIR: W, OPT_DIR: OPT, BACKUPS_DIR: "", SKIP_OPT_SWEEP: "1", TRUST_NAMES: "1",
  BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0", JOIN_TOKEN: "", WORLD_ADMIN: "human:test:op,human:test:op2,human:test:op3", SESSIONS_PATH: sf, EIDO_FLIGHT_REHEARSAL: "" }, stdout: Bun.file(slog), stderr: Bun.file(slog + ".err") });
process.on("exit", () => { try { proc.kill(); } catch {} });
if (!(await tryUntil("the server answers /worlds", async () => (await fetch(`http://127.0.0.1:${port}/worlds`, { signal: AbortSignal.timeout(1000) })).ok, { ms: 115_000, step: 150 })))
  { console.log(`  FAIL the server didn't come up: ${fs.existsSync(slog + ".err") ? fs.readFileSync(slog + ".err", "utf8").slice(-500) : ""}`); process.exit(1); }
/** a socket (with a session cookie or none): its messages, a send, and the close */
async function sock(sid: string | null) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, sid ? { headers: { cookie: `ew_sess=${sid}` } } as any : undefined); const msgs: any[] = []; let closed: any = null;
  ws.onmessage = (ev) => msgs.push(JSON.parse(String(ev.data))); ws.onclose = (ev) => { closed = { code: ev.code, reason: ev.reason }; };
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  return { ws, msgs, closed: () => closed, send: (m: any) => ws.send(JSON.stringify(m)) };
}
async function joinOld(sid: string | null, world: string) {
  const s = await sock(sid); s.send({ type: "join", world, id: "Pat", avatar: "", replica: true });
  await tryUntil(`the join to ${world} is closed`, () => !!s.closed(), { ms: 5000, step: 50 });
  return { err: s.msgs.find((m) => m.type === "error"), closed: s.closed() };
}
let rid = 0;
async function ask(sid: string | null, type: string, body: any, ms = 60_000) {
  const s = await sock(sid); const id = ++rid; s.send({ type, id, ...body });
  await tryUntil(`${type} is answered`, () => s.msgs.some((m) => m.type === type && m.id === id), { ms, step: 100 });
  s.ws.close(); return s.msgs.find((m) => m.type === type && m.id === id) ?? { none: s.msgs.map((m) => m.type) };
}
const attic = oldWorld("attic"); const atticBefore = tree(attic);
{ const v = await joinOld(VIS, "attic"), a = await joinOld(null, "attic"), o = await joinOld(OP, "attic");
  const want = (r: any, op: boolean) => r.closed?.code === 4005 && r.err?.refused?.code === "old-format" && r.err.refused.doc === "docs/TRANSLATING-OLD-WORLDS.md" && r.err.refused.upgrade === "operator" && r.err.refused.operator === op && typeof r.err.error === "string" && r.err.error.length > 10;
  ok(want(v, false) && want(a, false) && want(o, true), "US1 an old-format world's join: close 4005 as before, and the error carries refused {code: 'old-format', doc, upgrade: 'operator', operator} — false for a signed-in visitor and a guest, true for the operator's session", { v, a, o });
}
{ const r1 = await ask(VIS, "world-upgrade-review", { world: "attic" }), r2 = await ask(null, "world-upgrade", { world: "attic", approved: "0".repeat(64) });
  ok(r1.ok === false && r1.refused?.code === "rights" && /ask the server's operator/.test(r1.refused.reason + " " + (r1.refused.fix ?? "")) && !r1.report && r2.ok === false && r2.refused?.code === "rights"
    && same(tree(attic), atticBefore) && backupsOf("attic").length === 0,
    "US2 world-upgrade-review / world-upgrade from someone who isn't the operator (a signed-in visitor, a guest): refused, 'ask the server's operator', no report, nothing written", { r1, r2 });
}
let reviewed = "";
{ const r = await ask(OP, "world-upgrade-review", { world: "attic" }); reviewed = r.hash ?? "";
  ok(r.ok === true && /^[0-9a-f]{64}$/.test(r.hash ?? "") && r.hash === dryHash("attic") && r.report?.world === "attic" && r.report?.entries?.old === 3 && r.report.refused === null && same(tree(attic), atticBefore) && backupsOf("attic").length === 0,
    "US3 world-upgrade-review (the operator): the CLI's dry-run report and its hash (the same hash the CLI prints), nothing written", { ok: r.ok, hash: r.hash, refused: r.refused, keys: Object.keys(r.report ?? {}) });
}
{ const stale = await ask(OP, "world-upgrade", { world: "attic", approved: "1".repeat(64) });
  ok(stale.ok === false && stale.refused?.code === "stale" && stale.refused.reason.includes("1".repeat(64)) && stale.refused.reason.includes(reviewed) && same(tree(attic), atticBefore) && backupsOf("attic").length === 0 && !isWorldDir(attic),
    "US4 world-upgrade with a hash that isn't the report's: refused as stale, both hashes named, nothing written", stale);
}
{ const r = await ask(OP, "world-upgrade", { world: "attic", approved: reviewed }, 120_000);
  const b = backupsOf("attic")[0]; const m = JSON.parse(fs.existsSync(path.join(attic, "translation.json")) ? fs.readFileSync(path.join(attic, "translation.json"), "utf8") : "{}");
  const copied = b ? tree(b) : {}; delete copied.SHA256SUMS;
  const s = await sock(VIS); s.send({ type: "join", world: "attic", id: "Vee", avatar: "", replica: true });
  await tryUntil("the join to the upgraded attic is answered", () => s.msgs.some((x) => x.type === "snapshot" || x.type === "error"), { ms: 8000, step: 50 }); s.ws.close();
  ok(r.ok === true && r.backup === b && r.report === reviewed && /rollback attic/.test(r.rollback ?? "") && isWorldDir(attic) && m.report === reviewed && m.backup === b && m.approval?.owner === null && same(copied, atticBefore)
    && s.msgs.some((x) => x.type === "snapshot"),
    "US5 world-upgrade with the reviewed hash: the verified backup first, the CLI's translation bound to that hash (operator only, no owner), the world joinable at once; the result names the backup, the hash and the rollback command", { r, b, joined: s.msgs.map((x) => x.type).slice(0, 4) });
}
{ const x = path.join(W, "-x"), xb = tree(x), to = path.join(elsewhere, "linked"), lb = tree(to);
  const a = await ask(OP2, "world-upgrade-review", { world: "-x" }), b = await ask(OP2, "world-upgrade-review", { world: "linked" });
  ok(a.refused?.code === "not-old" && b.refused?.code === "not-old" && same(tree(x), xb) && same(tree(to), lb) && backupsOf("linked").length === 0 && backupsOf("-x").length === 0,
    "US8 the server refuses a world named \"-x\" and a symlinked world dir (not-old), nothing written", { a: a.refused ?? a.ok, b: b.refused ?? b.ok }); }
{ oldWorld("cellar"); const RATE_N = 6, seen: any[] = [];   // server/upgrade.ts RATE_N; a fresh account, so no other row spent its slots
  let last: any = null; for (let k = 0; k <= RATE_N; k++) { last = await ask(OP3, "world-upgrade-review", { world: "cellar" }); seen.push(last.ok ? "ok" : last.refused?.code); }
  ok(seen.slice(0, RATE_N).every((x) => x === "ok") && seen[RATE_N] === "rate" && new RegExp(`at most ${RATE_N} `).test(last.refused?.reason ?? ""),
    "US6 the operator's upgrade requests are rate-limited: from a fresh account, RATE_N taken and the next refused 'rate'", seen);
}
{ oldWorld("loft");
  const { WorldAgent } = await import("../../mcpl/agent.ts");
  const ag: any = new WorldAgent({ name: "Ag", world: "loft", url: `ws://127.0.0.1:${port}/ws` });
  let said = ""; try { await ag.connect(); } catch (x) { said = String(x?.message ?? x); } try { ag.close(); } catch {}
  ok(/operator/.test(said) && /TRANSLATING-OLD-WORLDS\.md/.test(said) && /upgrade/.test(said) && /older/.test(said), "US7 an agent refused at an old-format world is told in words: saved by an older Eidoverse, a one-time upgrade only the server's operator can run, and where the doc is", said);
}
try { proc.kill(); } catch {}

console.log(`[upgrade-check] ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
