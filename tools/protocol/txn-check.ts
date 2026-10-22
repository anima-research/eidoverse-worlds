// tools/protocol/txn-check.ts — the transaction service and the request capability (reviewer items 1 and 2, 10-18;
// docs/DESIGN-txn-capability.md). Real World, real WorldLog, real authority, real files; the wire handler is the
// real REQUEST_MESSAGES. Storage faults are injected at node:fs (the calls server/durable.ts makes), and a slow warm() is a
// gate held in front of the real WorldLog.request (the same stub reset-race-check uses).
//   T1  a durable write throws on the 2nd line of a commit → ambiguous, `from` = that line; the 1st line is published
//   T2  fsync throws after the bytes were written → ambiguous, wedged, no ok to anyone; reopen finds the line; later writes rolled back
//   T3  a refusal is rolled back and publishes nothing; every published line was on disk when it was published
//   T4  banned (the door) or re-roled while the request waited → refused, nothing written by the asker
//   T5  the door closes (members only) while the request waits, the asker unlisted → refused
//   T6  the connection becomes someone else while the request waits → refused; nothing under either identity
//   T7  static: no await in the authority; none between worldlog's recheck and the synchronous commit
//   T8  a short write is looped to the end, and a write that takes nothing throws
//   T8c a log's or blob's first write into directories just made: each new directory's name is synced in its parent too
//   T9  operator-repair: operator status revoked while queued → refused
//   T9d operator-repair from an account that isn't an operator: refused, pointed to whoever runs the server, not the world's owners
//   T10 no false refusals: 100 serial requests from an unchanged guest connection all committed
//   T11 (r14 M1) server.ts writes only through requestwire (voice-moderate via requestAs); no direct w.log.request caller
// usage: BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun tools/protocol/txn-check.ts
//        … --mutants   each row's mutation, applied to a scratch copy of the tree: every one must turn its rows red
// @ts-nocheck
import fs from "node:fs";
import path from "node:path";
import { scratch, copyTree } from "./common.ts";
// [name, file, find, replace, rows it must turn red]: the mutation each row exists to catch
const MUTANTS: [string, string, string, string, string[]][] = [
  ["unpublished lines: publish only when the authority returned (no finally)", "server/worldlog.ts", "    finally { this.publish(from, held); }\n    const o = txnOutcome(live, from, { threw: threw !== null, refused: !!r && typeof r === \"object\" && r.ok === false, wedgedBefore });\n    if (threw !== null) {\n      console.error(", "    if (threw === null) this.publish(from, held);\n    const o = txnOutcome(live, from, { threw: threw !== null, refused: !!r && typeof r === \"object\" && r.ok === false, wedgedBefore });\n    if (threw !== null) {\n      console.error(", ["T1"]],
  ["unknown called failure: a throw from a durable write reported rolled-back", "shared/protocol/authority/storage.js", "  if (newLog || newMod) return { outcome: \"ambiguous\"", "  if (false) return { outcome: \"ambiguous\"", ["T2"]],
  ["persist before publish: entries before the disk", "shared/protocol/authority/storage.js", "    durably(\"log\", () => io.writeLine(line));   // on disk first; only then the live chain and fold see it\n    entries.push(posAt(parsed, seq));", "    entries.push(posAt(parsed, seq)); durably(\"log\", () => io.writeLine(line));", ["T3c", "T3d"]],
  ["the door decided at join only: recheck without it", "server/reqcap.ts", "  if (door) return", "  if (false) return", ["T4", "T5"]],
  ["recheck without the role", "server/reqcap.ts", "  if (role && w.log.roleOf(cap.actorId) !== cap.role) return", "  if (false) return", ["T4b"]],
  ["identity read after the await: recheck without it", "server/reqcap.ts", "  if (c.actorId !== cap.actorId ||", "  if (false &&", ["T6", "T6b"]],
  ["an await in the authority's commit", "shared/protocol/authority/writes.js", "// A write: build ops against the folded state", "async function __m() { await 0; }\n// A write: build ops against the folded state", ["T7"]],
  ["new directories' names not synced: mkdir alone", "server/durable.ts", "  if (first === undefined) return;", "  return;", ["T8c"]],
  ["short writes: writeSync's count ignored", "server/durable.ts", "    const n = fs.writeSync(fd, buf, off, buf.length - off);", "    fs.writeSync(fd, buf, off, buf.length - off); const n = buf.length - off;", ["T8", "T8b"]],
  ["operator status checked before the queue only: operator-repair rechecks liveness only", "server/requestwire.ts", "      const gone = recheck(cap, Date.now(), { role: false });", "      const gone = c.world === w && !c.superseded && w.clients.has(c) ? null : \"gone\";", ["T9"]],
  ["a non-operator sent to the world's owners", "server/requestwire.ts", 'fix: "ask whoever runs this server" } }); return; }   // an owner', 'fix: "repair through the world\'s own roles: ask an owner" } }); return; }   // an owner', ["T9d"]],
  ["a false refusal: operator-repair compares the world role", "server/requestwire.ts", "recheck(cap, Date.now(), { role: false })", "recheck(cap, Date.now())", ["T9c"]],
  ["a false refusal: the account compared un-normalised (undefined vs null)", "server/reqcap.ts", "(c.account ?? null) !== cap.account", "c.account !== cap.account", ["T10"]],
  ["CONTROL (no-op: must stay green)", "server/reqcap.ts", "// the door: the same decision", "// the door:  the same decision", []],
];
if (process.argv.includes("--mutants")) {
  const ENGINE = path.resolve(import.meta.dir, "../.."); let bad = 0;
  for (const [name, file, find, repl, rows] of MUTANTS) {
    const d = scratch("txnmut");
    for (const dir of ["server", "shared", "client", "mcpl"]) copyTree(path.join(ENGINE, dir), path.join(d, dir));
    fs.mkdirSync(path.join(d, "tools/protocol"), { recursive: true });
    for (const f of ["common.ts", "txn-check.ts"]) fs.copyFileSync(path.join(ENGINE, "tools/protocol", f), path.join(d, "tools/protocol", f));
    fs.copyFileSync(path.join(ENGINE, "package.json"), path.join(d, "package.json")); fs.symlinkSync(path.join(ENGINE, "node_modules"), path.join(d, "node_modules"), "junction");
    const f = path.join(d, file); const src = fs.readFileSync(f, "utf8");
    if (src.split(find).length !== 2) { bad++; console.log(`FAIL mutant '${name}': its text isn't found exactly once in ${file} (the fix moved?)`); continue; }
    fs.writeFileSync(f, src.replace(find, repl));
    const r = Bun.spawnSync(["bun", path.join(d, "tools/protocol/txn-check.ts")], { cwd: d, env: { ...process.env, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" }, timeout: 300_000 });
    const out = r.stdout.toString() + r.stderr.toString(); const red = [...out.matchAll(/^\s*FAIL (\S+)/gm)].map((m) => m[1]);
    const good = rows.length ? r.exitCode !== 0 && rows.every((x) => red.includes(x)) : r.exitCode === 0 && !red.length; if (!good) bad++;
    console.log(`${good ? "ok  " : "FAIL"} mutant '${name}' → red: ${red.join(",") || "(none)"} (want ${rows.join(",")})`);
    fs.rmSync(d, { recursive: true, force: true });
  }
  console.log(`[txn-check --mutants] ${MUTANTS.length} mutations run, ${bad} wrong (each must turn its rows red; the control must stay green)`); process.exit(bad ? 1 : 0);
}
const root = scratch("txn");
process.env.WORLDS_DIR = path.join(root, "w"); process.env.OPT_DIR = path.join(root, "opt"); process.env.SKIP_OPT_SWEEP = "1";
process.env.WORLD_ADMIN = "local:opie";
fs.mkdirSync(process.env.WORLDS_DIR, { recursive: true });
const ENGINE = path.resolve(import.meta.dir, "../..");
const { foundWorld, WorldLog } = await import("../../server/worldlog.ts");
const { World } = await import("../../server/world.ts");
const { REQUEST_MESSAGES } = await import("../../server/requestwire.ts");
const { directoryFor } = await import("../../server/directory.ts");
const { openLive } = await import("../../server/livehost.ts");
const { appendDurable } = await import("../../server/durable.ts");
const { OPERATORS } = await import("../../server/operators.ts");
const nodefs = (await import("node:fs")).default;
let pass = 0, fail = 0;
const ok = (c, what, d?) => { if (c) { pass++; console.log(`  ok   ${what}`); } else { fail++; console.log(`  FAIL ${what}${d !== undefined ? " — " + JSON.stringify(d).slice(0, 400) : ""}`); } };
const W = process.env.WORLDS_DIR;
const logFile = (name) => path.join(W, name, "world.jsonl");
const lines = (name) => fs.readFileSync(logFile(name), "utf8").split("\n").filter(Boolean);
const until = async (f) => { for (let i = 0; i < 300 && !f(); i++) await new Promise((r) => setTimeout(r, 10)); return f(); };
const idOf = (acct, name) => directoryFor(W).resolve({ sub: acct, name });

// every log message any test client is sent: was each line it carries on disk when it was sent? (persist before publish)
let publishedNotOnDisk = [];
function world(name) {
  const { owner } = foundWorld(path.join(W, name), name, "olive");
  const w = new World(name);
  const real = WorldLog.prototype.request;
  const g = { gate: Promise.resolve(), release: () => {}, entered: 0 };
  w.log.request = function (...a) { g.entered++; return g.gate.then(() => real.apply(this, a)); };   // a held warm(): the request's await
  g.hold = () => { g.gate = new Promise((r) => { g.release = r; }); };
  return { w, owner, g, name };
}
let gens = 100;
function tab(W_, actorId, { account = undefined, spectator = false } = {}) {
  const replies = [], logs = [];
  const c = { id: `p${gens}`, world: W_.w, actorId, account, spectator, gen: gens++, legGen: 0,
    ws: { send: (d) => { const m = JSON.parse(d);
      if (m.type === "reply") replies.push(m);
      if (m.type === "log") { logs.push(m); const n = lines(W_.name).length; if (n < m.from + m.entries.length) publishedNotOnDisk.push({ world: W_.name, from: m.from, n: m.entries.length, onDisk: n }); } } } };
  W_.w.clients.add(c); return { c, replies, logs };
}
const send = (t, verb, args, type = "request") => REQUEST_MESSAGES[type]({ c: t.c, ws: t.c.ws, now: Date.now(), expel: () => {}, sweep: () => {} }, { id: `r${Math.random().toString(36).slice(2, 8)}`, verb, args });
const ownerDo = (W_, verb, args) => W_.w.log.requestSync(W_.owner, verb, args);

// storage faults at node:fs, for one world's log file: the n-th write (counted from arming) fails
//   before: writeSync throws, nothing written · after: the bytes are written, fsync throws · zero: writeSync takes nothing
function fault(name, at, mode) {
  const file = logFile(name); const fds = new Set(); let n = 0; let failFsync = new Set();
  const o = { openSync: nodefs.openSync, writeSync: nodefs.writeSync, fsyncSync: nodefs.fsyncSync };
  nodefs.openSync = function (p, ...r) { const fd = o.openSync.call(nodefs, p, ...r); if (path.resolve(String(p)) === file) fds.add(fd); return fd; };
  nodefs.writeSync = function (fd, ...r) { if (fds.has(fd) && ++n === at) { if (mode === "before") throw new Error("EIO: injected (before write)"); if (mode === "zero") return 0;
      const k = o.writeSync.call(nodefs, fd, ...r); failFsync.add(fd); return k; } return o.writeSync.call(nodefs, fd, ...r); };
  nodefs.fsyncSync = function (fd) { if (failFsync.has(fd)) { failFsync.delete(fd); throw new Error("EIO: injected (fsync after write)"); } return o.fsyncSync.call(nodefs, fd); };
  return () => Object.assign(nodefs, o);
}
const said = (W_, text) => W_.w.log.live.entries.some((e) => e?.kind === "say" && e.body?.text === text);
const described = (W_, label) => Object.values(W_.w.log.live.state().entities).some((e) => e.c?.description === label);

// ---------------- T1 ----------------
{ const X = world("t1"); const t = tab(X, X.owner, { account: "local:olive" });
  send(t, "create", { components: { description: "whole" } }); await until(() => t.replies.length);   // a whole act first: undo's target after the reopen
  const n0 = X.w.log.live.entries.length; const logs0 = t.logs.length;
  const restore = fault("t1", 2, "before");
  send(t, "create", { components: { description: "half" } }); await until(() => t.replies.length > 1); restore();
  const r = t.replies[1];
  const actPublished = t.logs.slice(logs0).some((m) => m.from === n0 && m.entries.length === 1 && m.entries[0].kind === "act");
  ok(r?.ok === false && r?.txn === "ambiguous" && r?.reply?.refused?.code === "ambiguous" && r?.reply?.from === n0 + 1 && actPublished
    && lines("t1").length === n0 + 1 && X.w.log.live.entries.length === n0 + 1,
    "T1 the 2nd line's write throws: ambiguous (never ok), from = that line; the act (1st line) is durable and published", { r, logs: t.logs.map((m) => [m.from, m.entries.length]), disk: lines("t1").length, n0 });
  // what stands after a reopen: the act without its change folds (an act carries no ops), and undo finds nothing of it
  const re = openLive(path.join(W, "t1"), "t1-reopened");
  const { request: authorityRequest } = await import("../../shared/protocol/authority.js");
  const whole = (st) => Object.values(st.entities).some((e) => e.c?.description === "whole");
  const stood = whole(re.state()) && re.state().status === "ok" && re.entries.length === n0 + 1 && re.entries[n0].kind === "act" && !Object.values(re.state().entities).some((e) => e.c?.description === "half");
  const undo = authorityRequest(re, X.owner, "undo", {});
  ok(stood && undo?.ok === true && !whole(re.state()),
    "T1b reopened: the orphan act folds, nothing it asked for exists, and undo passes over it to the last act with a result (PROTOCOL §7)", { status: re.state().status, n: re.entries.length, undo }); }

// ---------------- T2 ----------------
{ const X = world("t2"); const t = tab(X, X.owner, { account: "local:olive" }); const other = tab(X, idOf("local:bea", "bea"), { account: "local:bea" }); const n0 = X.w.log.live.entries.length;
  const restore = fault("t2", 1, "after");
  send(t, "say", { text: "maybe" }); await until(() => t.replies.length); restore();
  const r = t.replies[0];
  const anyOk = [...t.replies, ...other.replies].some((m) => m.ok === true);
  ok(r?.ok === false && r?.txn === "ambiguous" && r?.reply?.refused?.code === "ambiguous" && r?.reply?.from === n0 && !!X.w.log.live.wedged?.log && !anyOk
    && X.w.log.live.entries.length === n0 && !t.logs.length && !other.logs.length,
    "T2 fsync throws after the bytes were written: ambiguous, wedged, no one told ok, nothing published", { r, wedged: X.w.log.live.wedged, n: X.w.log.live.entries.length });
  const re = openLive(path.join(W, "t2"), "t2-reopened");
  ok(re.entries.length === n0 + 1 && re.entries[n0]?.kind === "say" && re.entries[n0]?.body?.text === "maybe",
    "T2b reopen finds the line the asker was told is unknown (so 'failed' would have been a lie)", { n: re.entries.length });
  send(t, "say", { text: "after" }); await until(() => t.replies.length > 1);
  const r2 = t.replies[1];
  ok(r2?.ok === false && r2?.txn === "rolled-back" && r2?.reply?.refused?.code === "server-error" && lines("t2").length === n0 + 1,
    "T2c the wedged log refuses the next write before any byte: rolled back, server-error, the file unchanged", r2); }

// ---------------- T3 ----------------
{ const X = world("t3"); const t = tab(X, X.owner, { account: "local:olive" }); const n0 = X.w.log.live.entries.length;
  send(t, "inspect", { id: "nothing-here" }); await until(() => t.replies.length);
  const r = t.replies[0];
  ok(r?.ok === false && r?.txn === "rolled-back" && r?.reply?.refused && X.w.log.live.entries.length === n0 && !t.logs.length,
    "T3 a refusal: rolled back, nothing appended, nothing published", r);
  send(t, "say", { text: "ok" }); await until(() => t.replies.length > 1);
  ok(t.replies[1]?.ok === true && t.replies[1]?.txn === "committed" && t.replies[1]?.reply?.txn === "committed" && t.replies[1]?.reply?.seq === n0,
    "T3b a write that lands: committed (envelope and reply), ok", t.replies[1]);
  const n1 = X.w.log.live.entries.length; const restore = fault("t3", 1, "before");
  send(t, "say", { text: "lost" }); await until(() => t.replies.length > 2); restore();
  ok(t.replies[2]?.txn === "ambiguous" && X.w.log.live.entries.length === n1 && !said(X, "lost") && t.logs.length === 1,
    "T3c a line whose write threw never reaches memory or anyone (persist before publish)", { r: t.replies[2], logs: t.logs.length }); }

// ---------------- T4 ----------------
{ const X = world("t4"); const vic = idOf("local:vic", "vic"); const t = tab(X, vic, { account: "local:vic" }); const n0 = X.w.log.live.entries.length;
  X.g.hold(); let e0 = X.g.entered; send(t, "say", { text: "from-the-banned" }); await until(() => X.g.entered > e0);
  ok(ownerDo(X, "ban", { who: vic, reason: "test" })?.ok === true, "(T4 setup) the owner bans the asker while its request waits");
  X.g.release(); await until(() => t.replies.length);
  const r = t.replies[0];
  ok(r?.reply?.refused?.code === "superseded" && /door/.test(r?.reply?.refused?.reason ?? "") && r?.txn === "rolled-back" && !said(X, "from-the-banned"),
    "T4 banned while the request waited: refused at the seam by the door (superseded), nothing written", r);
  // re-roled while waiting: an inhabitant made a builder mid-request is refused (admitted under the old role), never silently promoted
  const bea = idOf("local:bea", "bea");
  // she starts an inhabitant (a new world's newcomers are builders, R 10-21: promoting a builder to builder changes nothing)
  ok(ownerDo(X, "set", { id: "@world", component: `roles:${bea}`, value: { role: "inhabitant" } })?.ok === true, "(T4b setup) the asker starts an inhabitant");
  const b = tab(X, bea, { account: "local:bea" });
  X.g.hold(); e0 = X.g.entered; send(b, "create", { components: { description: "under-the-old-role" } }); await until(() => X.g.entered > e0);
  ok(ownerDo(X, "set", { id: "@world", component: `roles:${bea}`, value: { role: "builder" } })?.ok === true, "(T4b setup) the owner makes the asker a builder while its request waits");
  X.g.release(); await until(() => b.replies.length);
  ok(b.replies[0]?.reply?.refused?.code === "superseded" && /role/.test(b.replies[0]?.reply?.refused?.reason ?? "") && !described(X, "under-the-old-role"),
    "T4b the role changed while the request waited: refused (superseded), nothing written", b.replies[0]); }

// ---------------- T5 ----------------
{ const X = world("t5"); const vic = idOf("local:vic", "vic"); const t = tab(X, vic, { account: "local:vic" });
  X.g.hold(); const e0 = X.g.entered; send(t, "say", { text: "through-a-closed-door" }); await until(() => X.g.entered > e0);
  ok(ownerDo(X, "set", { id: "@world", component: "access", value: { join: "listed" } })?.ok === true, "(T5 setup) the door becomes members-only while the request waits");
  X.g.release(); await until(() => t.replies.length);
  ok(t.replies[0]?.reply?.refused?.code === "superseded" && /no-access/.test(t.replies[0]?.reply?.refused?.reason ?? "") && !said(X, "through-a-closed-door"),
    "T5 members-only while it waited, the asker unlisted: refused by the door (the same decision as join), nothing written", t.replies[0]); }

// ---------------- T6 ----------------
{ const X = world("t6"); const vic = idOf("local:vic", "vic"), bea = idOf("local:bea", "bea"); const t = tab(X, vic, { account: "local:vic" }); const n0 = X.w.log.live.entries.length;
  X.g.hold(); let e0 = X.g.entered; send(t, "say", { text: "whose-line" }); await until(() => X.g.entered > e0);
  t.c.actorId = bea;   // a re-join over the same socket resolved another identity (server.ts admitJoin), its leg not yet re-issued
  X.g.release(); await until(() => t.replies.length);
  const by = X.w.log.live.entries.slice(n0).map((e) => e.actor);
  ok(t.replies[0]?.reply?.refused?.code === "superseded" && /someone else/.test(t.replies[0]?.reply?.refused?.reason ?? "") && !said(X, "whose-line") && !by.includes(vic) && !by.includes(bea),
    "T6 the connection became someone else while the request waited: refused; nothing under either identity", { r: t.replies[0], by });
  t.c.actorId = vic; X.g.hold(); e0 = X.g.entered; send(t, "say", { text: "mid-rejoin" }); await until(() => X.g.entered > e0);
  t.c.actorId = undefined;   // a re-join in flight (server.ts resets actorId before resolving the new one)
  X.g.release(); await until(() => t.replies.length > 1);
  ok(t.replies[1]?.reply?.refused?.code === "superseded" && !said(X, "mid-rejoin"), "T6b a re-join in flight: refused with the request's id (was an id-less server error)", t.replies[1]); }

// ---------------- T7 ----------------
{ const strip = (s) => s.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
  const files = ["shared/protocol/authority.js", ...fs.readdirSync(path.join(ENGINE, "shared/protocol/authority")).filter((f) => f.endsWith(".js")).map((f) => `shared/protocol/authority/${f}`)];
  const awaits = files.flatMap((f) => [...strip(fs.readFileSync(path.join(ENGINE, f), "utf8")).matchAll(/\b(await|async)\b/g)].map(() => f));
  const wl = fs.readFileSync(path.join(ENGINE, "server/worldlog.ts"), "utf8");
  const body = wl.slice(wl.indexOf("  async request(actor"), wl.indexOf("  requestSync(actor"));
  const seam = body.slice(body.indexOf("gone = still?.()"), body.indexOf("return this.requestSync("));
  ok(files.length > 10 && !awaits.length && body.length > 0 && seam.length > 0 && !/\bawait\b/.test(seam),
    "T7 no await/async in the authority (enter() to w.append is one synchronous call), none between worldlog's recheck and requestSync", { awaits, seam: seam.length }); }

// ---------------- T8 ----------------
{ const f = path.join(root, "short.jsonl"); const o = nodefs.writeSync;
  nodefs.writeSync = function (fd, buf, off = 0, len = buf.length - off) { return o.call(nodefs, fd, buf, off, Math.min(len, 5)); };   // at most 5 bytes a call
  let threw = null; try { appendDurable(f, '{"a":"a whole line"}'); } catch (e) { threw = e; } finally { nodefs.writeSync = o; }
  ok(!threw && fs.readFileSync(f, "utf8") === '{"a":"a whole line"}\n', "T8 a short write is looped until the whole line is on disk", { threw: String(threw), got: fs.readFileSync(f, "utf8") });
  nodefs.writeSync = function () { return 0; };
  let threw2 = null; try { appendDurable(f, '{"b":1}'); } catch (e) { threw2 = e; } finally { nodefs.writeSync = o; }
  ok(/short write/.test(String(threw2?.message)), "T8b a write that takes nothing throws (never a silent torn line)", String(threw2)); }
// ---------------- T8c ----------------
// a directory mkdir makes is named by an entry in its parent: a first write into new directories is durable only once
// every one of those entries is synced, the topmost new directory's parent included
{ const { putBlobFile } = await import("../../server/durable.ts");
  const o = { openSync: nodefs.openSync, fsyncSync: nodefs.fsyncSync }; const dirFds = new Map(); const synced = [];
  nodefs.openSync = function (p, flags, ...r) { const fd = o.openSync.call(nodefs, p, flags, ...r); if (flags === "r") dirFds.set(fd, path.resolve(String(p))); return fd; };
  nodefs.fsyncSync = function (fd) { if (dirFds.has(fd)) synced.push(dirFds.get(fd)); return o.fsyncSync.call(nodefs, fd); };
  const base = path.join(root, "t8c"); fs.mkdirSync(base, { recursive: true });
  try { appendDurable(path.join(base, "a", "b", "c", "world.jsonl"), '{"n":1}'); putBlobFile(path.join(base, "x", "blobs", "h.txt"), "blob", "sha256:unused"); }
  finally { nodefs.openSync = o.openSync; nodefs.fsyncSync = o.fsyncSync; }
  const want = [base, "a", "a/b", "a/b/c", "x", "x/blobs"].map((d) => d === base ? base : path.join(base, d));
  const missing = want.filter((d) => !synced.includes(d));
  ok(!missing.length && fs.readFileSync(path.join(base, "a", "b", "c", "world.jsonl"), "utf8") === '{"n":1}\n',
    "T8c a first write into directories just made syncs each new directory's name in its parent, up to the parent of the first one made", { missing: missing.map((d) => path.relative(root, d)), synced: synced.map((d) => path.relative(root, d)) }); }

// ---------------- T9 ----------------
{ const X = world("t9"); const opie = idOf("local:opie", "opie"); const t = tab(X, opie, { account: "local:opie" }); const bea = idOf("local:bea", "bea");
  X.g.hold(); const e0 = X.g.entered; send(t, "say", { text: "ahead-in-the-queue" }); await until(() => X.g.entered > e0);
  send(t, "set", { id: "@world", component: `roles:${bea}`, value: { role: "owner" } }, "operator-repair");   // queued behind the held request
  OPERATORS.delete("local:opie");   // the account stops being an operator while the repair waits
  X.g.release(); await until(() => t.replies.length > 1); OPERATORS.add("local:opie");
  const rep = t.replies.find((m) => m.operator);
  ok(rep?.ok === false && rep?.reply?.refused?.code === "superseded" && !X.w.log.live.state().entities["@world"]?.c?.[`roles:${bea}`],
    "T9 operator status revoked while the repair waited: refused, nothing written", rep);
  send(t, "set", { id: "@world", component: `roles:${bea}`, value: { role: "owner" } }, "operator-repair"); await until(() => t.replies.filter((m) => m.operator).length > 1);
  ok(t.replies.filter((m) => m.operator)[1]?.ok === true && t.replies.filter((m) => m.operator)[1]?.txn === "committed", "T9b (control) an operator's repair commits", t.replies.filter((m) => m.operator)[1]);
  // an operator's right is the account's, never the world's role: a second repair queued behind one that changed the
  // operator's own role is not refused for it
  const k0 = t.replies.filter((m) => m.operator).length; const fen = idOf("local:fen", "fen");
  X.g.hold(); const e1 = X.g.entered; send(t, "say", { text: "ahead-again" }); await until(() => X.g.entered > e1);
  send(t, "set", { id: "@world", component: `roles:${opie}`, value: { role: "moderator" } }, "operator-repair");
  send(t, "set", { id: "@world", component: `roles:${fen}`, value: { role: "builder" } }, "operator-repair");
  X.g.release(); await until(() => t.replies.filter((m) => m.operator).length >= k0 + 2);
  const two = t.replies.filter((m) => m.operator).slice(k0);
  ok(two.length === 2 && two.every((m) => m.ok === true && m.txn === "committed"), "T9c an operator's repairs queued behind one that changed their own role both commit (no role compare for repairs)", two);
  // T9d: an account that isn't an operator is refused at once, and told who can repair, which is never a world's owner
  const nob = idOf("local:nob", "nob"); const tn = tab(X, nob, { account: "local:nob" });
  send(tn, "set", { id: "@world", component: `roles:${bea}`, value: { role: "visitor" } }, "operator-repair"); await until(() => tn.replies.some((m) => m.operator));
  const nr = tn.replies.find((m) => m.operator)?.reply;
  ok(nr?.ok === false && nr?.refused?.code === "rights" && /whoever runs this server/.test(nr?.refused?.fix ?? "") && !/owner/.test(nr?.refused?.fix ?? ""),
    "T9d operator-repair from an account that isn't an operator: refused, and pointed to whoever runs this server, not to an owner", nr); }

// ---------------- T10 ----------------
{ const X = world("t10"); const guest = directoryFor(W).resolve({ sub: null, name: "guest" }); const t = tab(X, guest, { account: undefined }); t.c.anonymous = true;
  // reads and writes alike (a guest may say 20 in 10 s: 15 says, 85 reads), each through both recheck seams
  for (let i = 0; i < 100; i++) if (i % 7 === 6 && i < 105) send(t, "say", { text: `n${i}` }); else send(t, "inspect", { id: "@world" });
  await until(() => t.replies.length === 100);
  const bad = t.replies.filter((m) => !(m.ok === true && m.txn === "committed"));
  ok(t.replies.length === 100 && !bad.length && said(X, "n97") && t.replies.filter((m) => m.verb === "say").length === 14, "T10 100 serial requests from an unchanged guest connection: all committed, no false refusal", { n: t.replies.length, bad: bad.slice(0, 2) }); }

ok(!publishedNotOnDisk.length, "T3d every line any client was sent was on disk when it was sent", publishedNotOnDisk);
// ---------------- T11 (review r14 M1, 10-18) ----------------
// every write a socket sends goes through requestwire (one capability, the queue, the meters, both recheck seams): server.ts
// itself calls w.log.request nowhere; voice-moderate goes through requestAs. A static row: the wire has no other door to a write.
{ const srv = fs.readFileSync(path.join(ENGINE, "server/server.ts"), "utf8"); const rw = fs.readFileSync(path.join(ENGINE, "server/requestwire.ts"), "utf8");
  const direct = srv.split("\n").map((l, i) => [i + 1, l] as const).filter(([, l]) => /\.log\.request\(/.test(l) && !/^\s*\/\//.test(l)).map(([n, l]) => `${n}: ${l.trim().slice(0, 100)}`);
  ok(!direct.length && /requestAs\(c, ws, w,/.test(srv) && /export function requestAs\(/.test(rw) && /recheck\(cap\)/.test(rw.slice(rw.indexOf("export function requestAs"))),
    "T11 server.ts has no direct w.log.request caller (voice-moderate goes through requestwire.requestAs: capture, the connection's queue, the busy meter, recheck at both seams)", direct); }
console.log(`[txn-check] ${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
