// test/protocol/txn-check.ts: the transaction service and the request capability (docs/decisions/TXN-CAPABILITY.md).
// Real World, WorldLog, authority, files and REQUEST_MESSAGES; storage faults are injected at node:fs (the calls
// server/durable.ts makes), and a slow warm() is a gate held in front of the real WorldLog.request.
//   T1  a durable write throws on the 2nd line of a commit → ambiguous, `from` = that line; the 1st line is published
//   T2  fsync throws after the bytes were written → ambiguous, wedged, no ok to anyone; reopen finds the line; later writes rolled back
//   T3  a refusal is rolled back and publishes nothing; every published line was on disk when it was published
//   T4–T6, SR, RR2  one table (WAITED): banned, re-roled, the door closed, someone else, a re-join in flight,
//       superseded, closed, reset while the request waited → refused with its code and the request's id, nothing written;
//       RR1/RR3/RR5 the reset's files; SR3 the control writes
//   T7  static: no await in the authority; none between worldlog's recheck and the synchronous commit
//   T8  a short write is looped to the end, and a write that takes nothing throws
//   T8c a log's or blob's first write into directories just made: each new directory's name is synced in its parent too,
//       a founded world's own directory included (and nothing is synced on win32, where the server can't sync a directory)
//   T8d the keys file a mint writes is synced before it's renamed into place
//   T8f a person's founding, a fork (its copied blobs too) and a reset sync each directory a new name lands in (house 6344940039)
//   T8e …and the directory that holds its name is synced after, as are directories made for it (none on win32, where the
//       server can't sync a directory)
//   T8g founding writes the ledger row before the world lands
//   T8h an unreadable founders ledger refuses the founding and is left as it was
//   T8i a fork counts the roles it copied that imported identities hold
//   T9  operator-repair: operator status revoked while queued → refused
//   T9f operator-repair from an account that isn't an operator: refused, pointed to whoever runs the server, not the world's owners
//   T10 no false refusals: 100 serial requests from an unchanged guest connection all committed
//   T11 (r14 M1) server.ts writes only through requestwire (voice-moderate via requestAs); no direct w.log.request caller
//   T12 a connection's queue behind a stalled request holds 256; the rest are refused busy at once, and it drains after
// usage: BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun test/protocol/txn-check.ts
//        … --mutants   each row's mutation, applied to a scratch copy of the tree: every one must turn its rows red
// @ts-nocheck
import fs from "node:fs";
import path from "node:path";
import { scratch, copyTree, readLF, linkInto } from "../gate/common.ts";
import { tryUntil } from "../gate/wait.ts";
import { suite } from "../gate/suite.ts";
// [name, file, find, replace, rows it must turn red]: the mutation each row exists to catch
const MUTANTS: [string, string, string, string, string[]][] = [
  ["unpublished lines: publish only when the authority returned (no finally)", "server/worldlog.ts", "    finally { this.publish(from, held); }\n    const o = txnOutcome(live, from, { threw: threw !== null, error: threw, refused: !!r && typeof r === \"object\" && r.ok === false, wedgedBefore });\n    if (threw !== null) {\n      console.error(", "    if (threw === null) this.publish(from, held);\n    const o = txnOutcome(live, from, { threw: threw !== null, error: threw, refused: !!r && typeof r === \"object\" && r.ok === false, wedgedBefore });\n    if (threw !== null) {\n      console.error(", ["T1"]],
  ["unknown called failure: a throw from a durable write reported rolled-back", "shared/protocol/authority/storage.js", "  if (newLog || newMod) return { outcome: \"ambiguous\"", "  if (false) return { outcome: \"ambiguous\"", ["T2"]],
  ["persist before publish: entries before the disk", "shared/protocol/authority/storage.js", "durably(\"log\", () => io.writeLine(line));", "entries.push(posAt(parsed, seq)); durably(\"log\", () => io.writeLine(line)); entries.pop();", ["T3c", "T3d"]],
  ["the door decided at join only: recheck without it", "server/request-capability.ts", "  if (door) return", "  if (false) return", ["T4", "T5"]],
  ["recheck without the role", "server/request-capability.ts", "  if (role && w.log.roleOf(cap.actorId) !== cap.role) return", "  if (false) return", ["T4b"]],
  ["identity read after the await: recheck without it", "server/request-capability.ts", "  if (c.actorId !== cap.actorId ||", "  if (false &&", ["T6", "T6b"]],
  ["an await in the authority's commit", "shared/protocol/authority/writes.js", "function commit(w, actor, verb, args, build) {", "async function __m() { await 0; }\nfunction commit(w, actor, verb, args, build) {", ["T7"]],
  ["new directories' names not synced: mkdir alone", "server/durable.ts", "  if (first === undefined) return;", "  return;", ["T8c"]],
  ["a founded world's directory made by plain mkdir", "server/worldlog.ts", "  mkdirDurable(dir);", "  fs.mkdirSync(dir, { recursive: true });", ["T8c"]],
  ["a replaced file renamed in unsynced", "server/durable.ts", "writeAll(fd, typeof data === \"string\" ? Buffer.from(data, \"utf8\") : data); fs.fsyncSync(fd); }", "writeAll(fd, typeof data === \"string\" ? Buffer.from(data, \"utf8\") : data); }", ["T8d"]],
  ["the keys file's directory made by plain mkdir", "server/custody.ts", "    mkdirDurable(path.dirname(file));", "    fs.mkdirSync(path.dirname(file), { recursive: true });", ["T8e"]],
  ["a replaced file's new name left unsynced", "server/durable.ts", "  fs.renameSync(tmp, file);\n  syncDir(path.dirname(file));   //", "  fs.renameSync(tmp, file);\n  path.dirname(file);   //", ["T8e"]],
  ["short writes: writeSync's count ignored", "server/durable.ts", "    const n = fs.writeSync(fd, buf, off, buf.length - off);", "    fs.writeSync(fd, buf, off, buf.length - off); const n = buf.length - off;", ["T8", "T8b"]],
  ["operator status checked before the queue only: operator-repair rechecks liveness only", "server/requestwire.ts", "      const gone = recheck(cap, Date.now(), { role: false });", "      const gone = c.world === w && !c.superseded && w.clients.has(c) ? null : \"gone\";", ["T9"]],
  ["a non-operator sent to the world's owners", "server/requestwire.ts", 'reason: "operator-repair needs a server operator\'s account (SERVER_OPERATORS)", fix: "ask whoever runs this server" } }); return; }', 'reason: "operator-repair needs a server operator\'s account (SERVER_OPERATORS)", fix: "repair through the world\'s own roles: ask an owner" } }); return; }', ["T9f"]],
  ["a false refusal: operator-repair compares the world role", "server/requestwire.ts", "recheck(cap, Date.now(), { role: false })", "recheck(cap, Date.now())", ["T9c"]],
  ["a false refusal: the account compared un-normalised (undefined vs null)", "server/request-capability.ts", "(c.account ?? null) !== cap.account", "c.account !== cap.account", ["T10"]],
  ["a person's founding as it was: no sync after the rename, the ledger written unsynced", "server/worldlog.ts", "    replaceDurable(foundersPath(), JSON.stringify({ ...L, [name]: { account, actor, ts: now } }, null, 1)); rowWritten = true;\n    fs.renameSync(tmp, dest); renamed = true;\n    // the world is there; its name not yet synced is said, not a failed founding\n    try { syncDir(WORLDS_DIR); }", "    fs.writeFileSync(foundersPath(), JSON.stringify({ ...L, [name]: { account, actor, ts: now } }, null, 1)); rowWritten = true;\n    fs.renameSync(tmp, dest); renamed = true;\n    // the world is there; its name not yet synced is said, not a failed founding\n    try { }", ["T8f"]],
  ["founding renames the world in before its ledger row (bot #31)", "server/worldlog.ts", "    replaceDurable(foundersPath(), JSON.stringify({ ...L, [name]: { account, actor, ts: now } }, null, 1)); rowWritten = true;\n    fs.renameSync(tmp, dest); renamed = true;", "    fs.renameSync(tmp, dest); renamed = true;\n    replaceDurable(foundersPath(), JSON.stringify({ ...L, [name]: { account, actor, ts: now } }, null, 1)); rowWritten = true;", ["T8g"]],
  ["an unreadable ledger reads as empty (bot #31)", "server/worldlog.ts", "const v = JSON.parse(text); if (!v", "let v = {}; try { v = JSON.parse(text); } catch {} if (!v", ["T8h"]],
  ["a fork's copied blobs left unsynced", "server/worldlog.ts", " syncTree(path.join(tmp, \"blobs\")); }", " }", ["T8f"]],
  ["a reset's fresh log renamed in unsynced", "server/worldlog.ts", "  try { syncDir(dir); } catch (e) { console.warn(`[world] reset:", "  try { } catch (e) { console.warn(`[world] reset:", ["T8f"]],
  ["CONTROL (no-op: must stay green)", "server/request-capability.ts", "// the door: the same decision", "// the door:  the same decision", []],
];
// T8c, T8e and T8f check directory syncs, which the server doesn't make on win32 (durable.ts syncDir): there the rows that only
// they would turn red have nothing to catch, so their mutants are skipped
const DIR_SYNC_ROWS = new Set(["T8c", "T8e", "T8f"]);
if (process.argv.includes("--mutants")) {
  const ENGINE = path.resolve(import.meta.dir, "../.."); let bad = 0, ran = 0;
  for (const [name, file, find, repl, rows] of MUTANTS) {
    if (process.platform === "win32" && rows.length && rows.every((x) => DIR_SYNC_ROWS.has(x))) { console.log(`skip mutant '${name}': the server syncs no directory on win32`); continue; }
    ran++;
    const d = scratch("txnmut");
    for (const dir of ["server", "shared", "client", "mcpl"]) copyTree(path.join(ENGINE, dir), path.join(d, dir));
    for (const f of ["test/gate/common.ts", "test/gate/suite.ts", "test/gate/wait.ts", "test/protocol/txn-check.ts", "test/harness/labhost.ts", "test/harness/labmodels.js"]) { fs.mkdirSync(path.dirname(path.join(d, f)), { recursive: true }); fs.copyFileSync(path.join(ENGINE, f), path.join(d, f)); }
    fs.copyFileSync(path.join(ENGINE, "package.json"), path.join(d, "package.json")); linkInto(path.join(ENGINE, "node_modules"), path.join(d, "node_modules"));
    const f = path.join(d, file); const src = readLF(f);
    if (src.split(find).length !== 2) { bad++; console.log(`FAIL mutant '${name}': its text isn't found exactly once in ${file} (the fix moved?)`); continue; }
    fs.writeFileSync(f, src.replace(find, repl));
    const r = Bun.spawnSync(["bun", path.join(d, "test/protocol/txn-check.ts")], { cwd: d, env: { ...process.env, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" }, timeout: 300_000 });
    const out = r.stdout.toString() + r.stderr.toString(); const red = [...out.matchAll(/^\s*FAIL (\S+)/gm)].map((m) => m[1]);
    const good = rows.length ? r.exitCode !== 0 && rows.every((x) => red.includes(x)) : r.exitCode === 0 && !red.length; if (!good) bad++;
    console.log(`${good ? "ok  " : "FAIL"} mutant '${name}' → red: ${red.join(",") || "(none)"} (want ${rows.join(",")})`);
    fs.rmSync(d, { recursive: true, force: true });
  }
  console.log(`[txn-check --mutants] ${ran} mutations run${ran < MUTANTS.length ? ` (${MUTANTS.length - ran} skipped on ${process.platform})` : ""}, ${bad} wrong (each must turn its rows red; the control must stay green)`); process.exit(bad ? 1 : 0);
}
const root = scratch("txn");
process.env.WORLDS_DIR = path.join(root, "w"); process.env.OPT_DIR = path.join(root, "opt"); process.env.SKIP_OPT_SWEEP = "1";
process.env.SERVER_OPERATORS = "local:opie";
fs.mkdirSync(process.env.WORLDS_DIR, { recursive: true });
const ENGINE = path.resolve(import.meta.dir, "../..");
const { foundWorld, WorldLog, wireEntry } = await import("../../server/worldlog.ts");
const { World } = await import("../../server/world.ts");
const { REQUEST_MESSAGES } = await import("../../server/requestwire.ts");
const { directoryFor } = await import("../../server/directory.ts");
const { openLive } = await import("../harness/labhost.ts");
const { appendDurable } = await import("../../server/durable.ts");
const { OPERATORS } = await import("../../server/operators.ts");
const nodefs = (await import("node:fs")).default;
const { ok, done } = suite("txn-check");
const W = process.env.WORLDS_DIR;
const logFile = (name) => path.join(W, name, "world.jsonl");
const lines = (name) => fs.readFileSync(logFile(name), "utf8").split("\n").filter(Boolean);
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
      if (m.type === "log") { logs.push(m); const L = lines(W_.name), n = L.length; if (n < m.from + m.entries.length) publishedNotOnDisk.push({ world: W_.name, from: m.from, n: m.entries.length, onDisk: n });
        else { const differ = m.entries.findIndex((e, i) => JSON.stringify(wireEntry(JSON.parse(L[m.from + i]))) !== JSON.stringify(e));   // the same entries, not just enough lines
          if (differ >= 0) publishedNotOnDisk.push({ world: W_.name, from: m.from, differsAt: m.from + differ, sent: JSON.stringify(m.entries[differ]).slice(0, 200), onDisk: L[m.from + differ].slice(0, 200) }); } } } } };
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
  send(t, "create", { components: { description: "whole" } }); await tryUntil('the reply to "whole"', () => t.replies.length, { ms: 3000, step: 10 });   // a whole act first: undo's target after the reopen
  const n0 = X.w.log.live.entries.length; const logs0 = t.logs.length;
  const restore = fault("t1", 2, "before");
  send(t, "create", { components: { description: "half" } }); await tryUntil('the reply to "half"', () => t.replies.length > 1, { ms: 3000, step: 10 }); restore();
  const r = t.replies[1];
  const actPublished = t.logs.slice(logs0).some((m) => m.from === n0 && m.entries.length === 1 && m.entries[0].kind === "request");
  ok(r?.ok === false && r?.txn === "ambiguous" && r?.reply?.refused?.code === "ambiguous" && r?.reply?.from === n0 + 1 && actPublished
    && lines("t1").length === n0 + 1 && X.w.log.live.entries.length === n0 + 1,
    "T1 the 2nd line's write throws: ambiguous (never ok), from = that line; the act (1st line) is durable and published", { r, logs: t.logs.map((m) => [m.from, m.entries.length]), disk: lines("t1").length, n0 });
  // what stands after a reopen: the act without its change folds (an act carries no ops), and undo finds nothing of it
  const re = openLive(path.join(W, "t1"), "t1-reopened");
  const { request: authorityRequest } = await import("../../shared/protocol/authority.js");
  const whole = (st) => Object.values(st.entities).some((e) => e.c?.description === "whole");
  const stood = whole(re.state()) && re.state().status === "ok" && re.entries.length === n0 + 1 && re.entries[n0].kind === "request" && !Object.values(re.state().entities).some((e) => e.c?.description === "half");
  const undo = authorityRequest(re, X.owner, "undo", {});
  ok(stood && undo?.ok === true && !whole(re.state()),
    "T1b reopened: the orphan act folds, nothing it asked for exists, and undo passes over it to the last act with a result (PROTOCOL §7)", { status: re.state().status, n: re.entries.length, undo }); }

// ---------------- T2 ----------------
{ const X = world("t2"); const t = tab(X, X.owner, { account: "local:olive" }); const other = tab(X, idOf("local:bea", "bea"), { account: "local:bea" }); const n0 = X.w.log.live.entries.length;
  const restore = fault("t2", 1, "after");
  send(t, "say", { text: "maybe" }); await tryUntil('the reply to "maybe"', () => t.replies.length, { ms: 3000, step: 10 }); restore();
  const r = t.replies[0];
  const anyOk = [...t.replies, ...other.replies].some((m) => m.ok === true);
  ok(r?.ok === false && r?.txn === "ambiguous" && r?.reply?.refused?.code === "ambiguous" && r?.reply?.from === n0 && !!X.w.log.live.wedged?.log && !anyOk
    && X.w.log.live.entries.length === n0 && !t.logs.length && !other.logs.length,
    "T2 fsync throws after the bytes were written: ambiguous, wedged, no one told ok, nothing published", { r, wedged: X.w.log.live.wedged, n: X.w.log.live.entries.length });
  const re = openLive(path.join(W, "t2"), "t2-reopened");
  ok(re.entries.length === n0 + 1 && re.entries[n0]?.kind === "say" && re.entries[n0]?.body?.text === "maybe",
    "T2b reopen finds the line the asker was told is unknown (so 'failed' would have been a lie)", { n: re.entries.length });
  send(t, "say", { text: "after" }); await tryUntil('the reply to "after"', () => t.replies.length > 1, { ms: 3000, step: 10 });
  const r2 = t.replies[1];
  ok(r2?.ok === false && r2?.txn === "rolled-back" && r2?.reply?.refused?.code === "server-error" && lines("t2").length === n0 + 1,
    "T2c the wedged log refuses the next write before any byte: rolled back, server-error, the file unchanged", r2);
  // what each reply tells its reader to do: only whoever runs the server can reopen the world, and asking again changes nothing
  // until then; neither points at a log the reader can't open, nor says to send it again
  const fx = (m) => `${m?.reply?.refused?.reason ?? ""} | ${m?.reply?.refused?.fix ?? ""}`;
  ok([r, r2].every((m) => /whoever runs (the|this) server/.test(fx(m)) && /won't change|until (then|it is reopened)/.test(fx(m)) && !/send it again|server's log/.test(fx(m))) && /refuses writes/.test(fx(r2)),
    "T2d the ambiguous reply and the wedged log's next refusal say only whoever runs the server can reopen the world, and asking again changes nothing until then", { r: fx(r), r2: fx(r2) }); }

// ---------------- T3 ----------------
{ const X = world("t3"); const t = tab(X, X.owner, { account: "local:olive" }); const n0 = X.w.log.live.entries.length;
  send(t, "inspect", { id: "nothing-here" }); await tryUntil('the reply to "after"', () => t.replies.length, { ms: 3000, step: 10 });
  const r = t.replies[0];
  ok(r?.ok === false && r?.txn === "rolled-back" && r?.reply?.refused && X.w.log.live.entries.length === n0 && !t.logs.length,
    "T3 a refusal: rolled back, nothing appended, nothing published", r);
  send(t, "say", { text: "ok" }); await tryUntil('the reply to "ok"', () => t.replies.length > 1, { ms: 3000, step: 10 });
  ok(t.replies[1]?.ok === true && t.replies[1]?.txn === "committed" && t.replies[1]?.reply?.txn === "committed" && t.replies[1]?.reply?.seq === n0,
    "T3b a write that lands: committed (envelope and reply), ok", t.replies[1]);
  const n1 = X.w.log.live.entries.length; const restore = fault("t3", 1, "before");
  send(t, "say", { text: "lost" }); await tryUntil('the reply to "lost"', () => t.replies.length > 2, { ms: 3000, step: 10 }); restore();
  ok(t.replies[2]?.txn === "ambiguous" && X.w.log.live.entries.length === n1 && !said(X, "lost") && t.logs.length === 1,
    "T3c a line whose write threw never reaches memory or anyone (persist before publish)", { r: t.replies[2], logs: t.logs.length }); }

// ---------------- T4–T6, SR, RR: what changed while the request waited ----------------
// One held-gate fixture per row: the request is inside the await, `while` changes the world or the connection, the gate
// opens. Each row is refused with its code and words, and nothing is written under any identity; the control writes.
const WAITED = [
  { id: "T4", what: "banned (the door)", code: "superseded", reason: /door/, while: (X, t) => ok(ownerDo(X, "ban", { who: t.c.actorId, reason: "test" })?.ok === true, "(T4 setup) the owner bans the asker while its request waits") },
  { id: "T4b", what: "re-roled (a member made a builder: admitted under the old role, never silently promoted)", asker: "bea", verb: "create", code: "superseded", reason: /role/,
    setup: (X, who) => ok(ownerDo(X, "set", { id: "@world", component: `roles:${who}`, value: { role: "member" } })?.ok === true, "(T4b setup) the asker starts a member"),
    while: (X, t) => ok(ownerDo(X, "set", { id: "@world", component: `roles:${t.c.actorId}`, value: { role: "builder" } })?.ok === true, "(T4b setup) the owner makes the asker a builder while its request waits") },
  { id: "T5", what: "the door closed (invite-only, the asker unlisted: the same decision as join)", code: "superseded", reason: /no-access/,
    while: (X) => ok(ownerDo(X, "set", { id: "@world", component: "access", value: { join: "listed" } })?.ok === true, "(T5 setup) the door becomes invite-only while the request waits") },
  { id: "T6", what: "the connection became someone else (a re-join resolved another identity)", code: "superseded", reason: /someone else/, while: (X, t) => { t.c.actorId = idOf("local:bea", "bea"); } },
  { id: "T6b", what: "a re-join in flight (actorId reset before the new one resolves): refused with the request's id, not an id-less server error", code: "superseded", reason: /./, while: (X, t) => { t.c.actorId = undefined; } },
  { id: "SR1", what: "superseded by the same account's new tab", code: "superseded", reason: /taken over/, while: (X, t) => { t.c.superseded = true; X.w.clients.delete(t.c); tab(X, t.c.actorId, { account: t.c.account }); } },
  { id: "SR2", what: "closed (out of the world's clients, c.world still set)", code: "superseded", reason: /closed/, while: (X, t) => { X.w.clients.delete(t.c); } },
  { id: "RR2", what: "the world was reset (the old log retired, a fresh one founded)", code: "reset", reason: /reset/, while: (X) => { X.old = X.w.log; X.n0 = X.w.log.live.entries.length; X.arch = X.w.resetWorld(); X.before = lines(X.name).length; } },
];
for (const row of WAITED) {
  const X = world(`w-${row.id.toLowerCase()}`); const who = idOf(`local:${row.asker ?? "vic"}`, row.asker ?? "vic"); row.setup?.(X, who);
  const t = tab(X, who, { account: `local:${row.asker ?? "vic"}` }); const n0 = X.w.log.live.entries.length;
  const label = `while-${row.id}`, rid = `q-${row.id}`, args = row.verb === "create" ? { components: { description: label } } : { text: label };
  X.g.hold(); const e0 = X.g.entered;
  REQUEST_MESSAGES.request({ c: t.c, ws: t.c.ws, now: Date.now(), expel: () => {}, sweep: () => {} }, { id: rid, verb: row.verb ?? "say", args });
  ok(!!await tryUntil(`${row.id}'s request is held at the await`, () => X.g.entered > e0, { ms: 3000, step: 10 }), `(${row.id} setup) the request reached the await within 3 s`);
  row.while(X, t);
  X.g.release(); await tryUntil(`the reply to ${row.id}'s request`, () => t.replies.length, { ms: 3000, step: 10 });
  const r = t.replies[0], log = X.w.log.live, wrote = said(X, label) || described(X, label) || (X.old && (X.old.live.entries.some((e) => e?.body?.text === label)));
  const by = log.entries.slice(row.id === "RR2" ? 0 : n0).map((e) => e.actor);
  ok(r?.id === rid && r?.ok === false && r?.txn === "rolled-back" && r?.reply?.refused?.code === row.code && row.reason.test(r?.reply?.refused?.reason ?? "") && !wrote
    && (row.id === "RR2" || (!by.includes(who) && !by.includes(idOf("local:bea", "bea")))),
    `${row.id} ${row.what} while the request waited: refused (${row.code}), with the request's id, nothing written under any identity`, { r, wrote, by });
  if (row.id === "RR2") {   // the reset's own files: the old log archived, the fresh one untouched by the straggler, the old one retired for good
    ok(log !== X.old.live && fs.existsSync(path.join(X.arch, "world.jsonl")), "RR1 reset swapped the log and archived the old file", { arch: X.arch });
    ok(lines(X.name).length === X.before && !log.state().entities[label] && log.entries.length === X.before, "RR3 the new world's file (and its fresh log) gained no line from the old one", { before: X.before, after: lines(X.name).length });
    ok(X.old.requestSync(X.owner, "say", { text: "late" })?.refused?.code === "reset", "RR5 the old log stays retired for every later request"); }
}
{ const X = world("w-control"); const t = tab(X, X.owner, { account: "local:olive" });
  X.g.hold(); send(t, "create", { components: { description: "from-a-live-tab" } }); X.g.release();
  await tryUntil("the live tab's request is answered", () => t.replies.length, { ms: 3000, step: 10 });
  ok(t.replies[0]?.ok === true && described(X, "from-a-live-tab"), "SR3 (control) a connection that is still in the world writes", t.replies[0]); }

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
  const base = path.join(root, "t8c"); fs.mkdirSync(base, { recursive: true });
  // a world founded in a worlds directory that already exists: its own directory is the only new name, in that directory.
  // The directory's keys exist already, as for any founding after its first, so the first founding is made before the
  // syncs are watched: it mints the keys, and saving the keys file syncs this directory too, which would hide whether
  // founding synced the world's own name
  const worlds = path.join(base, "worlds"); fs.mkdirSync(worlds); foundWorld(path.join(worlds, "t8c-first"), "t8c-first", "olive");
  const o = { openSync: nodefs.openSync, fsyncSync: nodefs.fsyncSync }; const dirFds = new Map(); const synced = [];
  nodefs.openSync = function (p, flags, ...r) { const fd = o.openSync.call(nodefs, p, flags, ...r); if (flags === "r") dirFds.set(fd, path.resolve(String(p))); return fd; };
  nodefs.fsyncSync = function (fd) { if (dirFds.has(fd)) synced.push(dirFds.get(fd)); return o.fsyncSync.call(nodefs, fd); };
  try { appendDurable(path.join(base, "a", "b", "c", "world.jsonl"), '{"n":1}'); putBlobFile(path.join(base, "x", "blobs", "h.txt"), "blob", "sha256:unused");
    foundWorld(path.join(worlds, "t8c"), "t8c", "olive"); }
  finally { nodefs.openSync = o.openSync; nodefs.fsyncSync = o.fsyncSync; }
  const want = process.platform === "win32" ? [] : [base, "a", "a/b", "a/b/c", "x", "x/blobs", "worlds"].map((d) => d === base ? base : path.join(base, d));
  const missing = want.filter((d) => !synced.includes(d));
  ok(!missing.length && (process.platform !== "win32" || !synced.length) && fs.readFileSync(path.join(base, "a", "b", "c", "world.jsonl"), "utf8") === '{"n":1}\n',
    "T8c a first write into directories just made syncs each new directory's name in its parent, up to the parent of the first one made, a founded world's directory too (none on win32)", { missing: missing.map((d) => path.relative(root, d)), synced: synced.map((d) => path.relative(root, d)) }); }

// ---------------- T8f (house 6344940039) ----------------
// a person's founding, a fork and a reset each move new names into place: each syncs them before it answers
// (the directory they land in synced AFTER the rename, a sync that throws logged, not refused; a fork's copied blobs synced
// before its directory moves). None on
// win32, where the server can't sync a directory
{ const WL = await import("../../server/worldlog.ts"); const { putBlobFile } = await import("../../server/durable.ts");
  const o = { openSync: nodefs.openSync, fsyncSync: nodefs.fsyncSync, renameSync: nodefs.renameSync, linkSync: nodefs.linkSync }; let fdPath = new Map(), ev = [];
  const watch = () => { fdPath = new Map(); ev = [];
    nodefs.openSync = function (p, ...r) { const fd = o.openSync.call(nodefs, p, ...r); fdPath.set(fd, path.resolve(String(p))); return fd; };
    nodefs.fsyncSync = function (fd) { ev.push(["fsync", fdPath.get(fd)]); return o.fsyncSync.call(nodefs, fd); };
    nodefs.renameSync = function (a, b) { ev.push(["rename", path.resolve(String(a)), path.resolve(String(b))]); return o.renameSync.call(nodefs, a, b); };
    nodefs.linkSync = function (a, b) { ev.push(["rename", path.resolve(String(a)), path.resolve(String(b))]); return o.linkSync.call(nodefs, a, b); }; };   // a reset links the old log into its archive (bot #10)
  const unwatch = () => Object.assign(nodefs, o);
  const syncedAfter = (to, dir) => { const i = ev.findIndex((e) => e[0] === "rename" && e[2] === path.resolve(to)); return i >= 0 && ev.slice(i + 1).some((e) => e[0] === "fsync" && e[1] === path.resolve(dir)); };
  const none = process.platform === "win32";
  // founding
  watch(); let f; try { f = WL.foundOwnedWorld("t8f-found", idOf("local:fay", "fay"), "local:fay"); } finally { unwatch(); }
  const foundOk = f?.ok && (none || (syncedAfter(path.join(W, "t8f-found"), W) && syncedAfter(path.join(W, ".founders.json"), W)));
  // fork, from a world holding a blob
  const src = world("t8f-src"); putBlobFile(path.join(W, "t8f-src", "blobs", "ab", "cafe.txt"), "a blob", "sha256:unused");
  watch(); let k; try { k = WL.forkWorld(src.w.log, "t8f-fork", src.owner); } finally { unwatch(); }
  const into = ev.find((e) => e[0] === "rename" && e[2] === path.join(W, "t8f-fork")); const tmp = into?.[1] ?? "";
  const before = into ? ev.slice(0, ev.indexOf(into)) : [];
  const blobSynced = before.some((e) => e[0] === "fsync" && e[1] === path.join(tmp, "blobs", "ab", "cafe.txt")) && before.some((e) => e[0] === "fsync" && e[1] === path.join(tmp, "blobs"));
  const forkOk = k?.ok && (none || (syncedAfter(path.join(W, "t8f-fork"), W) && blobSynced));
  // a fork says how many roles it copied that imported identities (names with no account yet) hold: a later bind reaches the copy too (bot #369)
  const src2 = world("t8f-src2"), ghost = directoryFor(W).imported("Ghost");
  ownerDo(src2, "set", { id: "@world", component: `roles:${ghost}`, value: { role: "builder" } });
  const k2 = WL.forkWorld(src2.w.log, "t8f-fork2", src2.owner);
  ok(k?.ok && k.importedRoles === 0 && k2?.ok && k2.importedRoles === 1, "T8i a fork counts the roles it copied that imported identities hold (0 for a world of accounts, 1 with Ghost's)", { k, k2 });
  // reset
  const rs = world("t8f-reset"); watch(); let arch = null; try { arch = WL.resetWorld(rs.w.log); } finally { unwatch(); }
  const dir = path.join(W, "t8f-reset");
  const resetOk = !!arch && (none || (syncedAfter(path.join(arch, "world.jsonl"), arch) && syncedAfter(path.join(dir, "world.jsonl"), dir)));
  ok(foundOk && forkOk && resetOk, "T8f a person's founding, a fork (its copied blobs too) and a reset each sync the directory a new name lands in, after the rename (none on win32)",
    { foundOk, forkOk, blobSynced, resetOk, tmp }); }
// ---------------- T8g ----------------
// founding writes the ledger row before the world lands: a failed ledger write leaves no world (a retry founds it); an
// unreadable ledger refuses the founding and is left as it was (it used to be replaced by a one-row ledger)
{ const WL = await import("../../server/worldlog.ts"); const lp = path.join(W, ".founders.json"); const fay = idOf("local:fay", "fay");
  const before = nodefs.existsSync(lp) ? nodefs.readFileSync(lp, "utf8") : null;
  const jam = `${lp}.${process.pid}.tmp`; nodefs.mkdirSync(jam);   // replaceDurable's temp name, taken by a directory: its write fails
  let f1; try { f1 = WL.foundOwnedWorld("t8g-crash", fay, "local:fay"); } finally { nodefs.rmdirSync(jam); }
  const crash = { ok: f1?.ok, world: nodefs.existsSync(path.join(W, "t8g-crash")), row: !!WL.foundersLedger()["t8g-crash"] };
  const f2 = WL.foundOwnedWorld("t8g-crash", fay, "local:fay");
  const retry = { ok: f2?.ok, world: nodefs.existsSync(path.join(W, "t8g-crash")), row: !!WL.foundersLedger()["t8g-crash"] };
  ok(crash.ok === false && !crash.world && !crash.row && retry.ok === true && retry.world && retry.row && before !== null,
    "T8g founding: the ledger row is written before the world is renamed into place, so a failed ledger write leaves no world and a retry founds it", { crash, retry, hadLedger: before !== null });
  const garbage = '{"keep-a": {"account": "local:a"}, "keep-b": {"account": "lo';
  nodefs.writeFileSync(lp, garbage);
  const f3 = WL.foundOwnedWorld("t8g-garbled", fay, "local:fay");
  const garbled = { ok: f3?.ok, err: (f3 as any)?.err, world: nodefs.existsSync(path.join(W, "t8g-garbled")), same: nodefs.readFileSync(lp, "utf8") === garbage };
  nodefs.writeFileSync(lp, before ?? "{}");
  ok(garbled.ok === false && /can't be read/.test(garbled.err ?? "") && !garbled.world && garbled.same,
    "T8h an unreadable founders ledger refuses the founding and is left byte-for-byte (never replaced by a one-row ledger)", garbled); }

// ---------------- T8d, T8e ----------------
// a key a mint hands out must survive a crash, or the genesis it signed (synced) names a key no one holds: the keys file is
// written to a temp file and synced, renamed into place, and the directory holding its name synced after the rename
{ const { custodyAt } = await import("../../server/custody.ts");
  const file = path.join(root, "t8d", "keys", "custody.json"), dir = path.dirname(file);
  const o = { openSync: nodefs.openSync, fsyncSync: nodefs.fsyncSync, renameSync: nodefs.renameSync }; const fdPath = new Map(), events = [];
  nodefs.openSync = function (p, ...r) { const fd = o.openSync.call(nodefs, p, ...r); fdPath.set(fd, path.resolve(String(p))); return fd; };
  nodefs.fsyncSync = function (fd) { events.push(["fsync", fdPath.get(fd)]); return o.fsyncSync.call(nodefs, fd); };
  nodefs.renameSync = function (a, b) { events.push(["rename", path.resolve(String(a)), path.resolve(String(b))]); return o.renameSync.call(nodefs, a, b); };
  let key; try { key = custodyAt(file).sequencer(); } finally { nodefs.openSync = o.openSync; nodefs.fsyncSync = o.fsyncSync; nodefs.renameSync = o.renameSync; }
  const into = events.findIndex((e) => e[0] === "rename" && e[2] === file), tmp = into >= 0 ? events[into][1] : null;
  const synced = tmp !== null && events.slice(0, into).some((e) => e[0] === "fsync" && e[1] === tmp);
  const dirSynced = into >= 0 && events.slice(into + 1).some((e) => e[0] === "fsync" && e[1] === dir)
    // the keys directory and its parent were made for this file: each is named in the directory above it
    && [path.dirname(dir), path.dirname(path.dirname(dir))].every((d) => events.some((e) => e[0] === "fsync" && e[1] === d));
  const onDisk = JSON.parse(fs.readFileSync(file, "utf8")).sequencer?.pub === key;
  ok(onDisk && synced, "T8d the keys file a mint writes is synced before it's renamed into place", { key, into, tmp, events: events.map((e) => e.map((x) => typeof x === "string" ? path.relative(root, x) : x)) });
  ok(onDisk && (process.platform === "win32" ? !dirSynced : dirSynced), "T8e …and the directory holding its name is synced after the rename, as are the directories made for it (none on win32)", { dirSynced, events: events.map((e) => e.map((x) => typeof x === "string" ? path.relative(root, x) : x)) }); }

// ---------------- T9 ----------------
{ const X = world("t9"); const opie = idOf("local:opie", "opie"); const t = tab(X, opie, { account: "local:opie" }); const bea = idOf("local:bea", "bea");
  X.g.hold(); const e0 = X.g.entered; send(t, "say", { text: "ahead-in-the-queue" }); ok(!!await tryUntil('"ahead-in-the-queue" is held at the await', () => X.g.entered > e0, { ms: 3000, step: 10 }), '(setup) ahead-in-the-queue reached the await within 3 s');
  send(t, "set", { id: "@world", component: `roles:${bea}`, value: { role: "owner" } }, "operator-repair");   // queued behind the held request
  OPERATORS.delete("local:opie");   // the account stops being an operator while the repair waits
  X.g.release(); await tryUntil('the reply to "operator-repair owner"', () => t.replies.length > 1, { ms: 3000, step: 10 }); OPERATORS.add("local:opie");
  const rep = t.replies.find((m) => m.operator);
  ok(rep?.ok === false && rep?.reply?.refused?.code === "superseded" && !X.w.log.live.state().entities["@world"]?.c?.[`roles:${bea}`],
    "T9 operator status revoked while the repair waited: refused, nothing written", rep);
  send(t, "set", { id: "@world", component: `roles:${bea}`, value: { role: "owner" } }, "operator-repair"); await tryUntil('the operator-repair reply (operator-repair owner)', () => t.replies.filter((m) => m.operator).length > 1, { ms: 3000, step: 10 });
  ok(t.replies.filter((m) => m.operator)[1]?.ok === true && t.replies.filter((m) => m.operator)[1]?.txn === "committed", "T9b (control) an operator's repair commits", t.replies.filter((m) => m.operator)[1]);
  // an operator's right is the account's, never the world's role: a second repair queued behind one that changed the
  // operator's own role is not refused for it
  const k0 = t.replies.filter((m) => m.operator).length; const fen = idOf("local:fen", "fen");
  X.g.hold(); const e1 = X.g.entered; send(t, "say", { text: "ahead-again" }); ok(!!await tryUntil('"ahead-again" is held at the await', () => X.g.entered > e1, { ms: 3000, step: 10 }), '(setup) ahead-again reached the await within 3 s');
  send(t, "set", { id: "@world", component: `roles:${opie}`, value: { role: "moderator" } }, "operator-repair");
  send(t, "set", { id: "@world", component: `roles:${fen}`, value: { role: "builder" } }, "operator-repair");
  X.g.release(); await tryUntil('the operator-repair reply (operator-repair builder)', () => t.replies.filter((m) => m.operator).length >= k0 + 2, { ms: 3000, step: 10 });
  const two = t.replies.filter((m) => m.operator).slice(k0);
  ok(two.length === 2 && two.every((m) => m.ok === true && m.txn === "committed"), "T9c an operator's repairs queued behind one that changed their own role both commit (no role compare for repairs)", two);
  // house 6340433633: the refusal says which way the status went, and its fix follows: revoked, sending again won't
  // change it; granted (an ordinary request queued while the account became an operator), sending again is decided anew
  ok(/stopped being a server operator/.test(rep?.reply?.refused?.reason ?? "") && /won't change this/.test(rep?.reply?.refused?.fix ?? ""), "T9d revoked: said so, and that sending it again won't change it", rep?.reply?.refused);
  const gus = idOf("local:gus", "gus"); const tg = tab(X, gus, { account: "local:gus" });
  X.g.hold(); const e2 = X.g.entered; send(t, "say", { text: "ahead-a-third-time" }); ok(!!await tryUntil('"ahead-a-third-time" is held at the await', () => X.g.entered > e2, { ms: 3000, step: 10 }), '(setup) ahead-a-third-time reached the await within 3 s');
  const n0 = tg.replies.length; send(tg, "say", { text: "queued" }); OPERATORS.add("local:gus");
  X.g.release(); await tryUntil('the reply to "queued"', () => tg.replies.length > n0, { ms: 3000, step: 10 }); OPERATORS.delete("local:gus");
  const gr = tg.replies[n0];
  ok(gr?.ok === false && /became a server operator/.test(gr?.reply?.refused?.reason ?? gr?.refused?.reason ?? "") && !/won't change/.test(gr?.reply?.refused?.fix ?? gr?.refused?.fix ?? "") && /send it again/.test(gr?.reply?.refused?.fix ?? gr?.refused?.fix ?? ""),
    "T9e granted while a request waited: said so, and sending it again is the way (not 'won't change this')", gr);
  // T9f: an account that isn't an operator is refused at once, and told who can repair, which is never a world's owner
  const nob = idOf("local:nob", "nob"); const tn = tab(X, nob, { account: "local:nob" });
  send(tn, "set", { id: "@world", component: `roles:${bea}`, value: { role: "visitor" } }, "operator-repair"); await tryUntil('the operator-repair reply (operator-repair visitor)', () => tn.replies.some((m) => m.operator), { ms: 3000, step: 10 });
  const nr = tn.replies.find((m) => m.operator)?.reply;
  ok(nr?.ok === false && nr?.refused?.code === "rights" && /whoever runs this server/.test(nr?.refused?.fix ?? "") && !/owner/.test(nr?.refused?.fix ?? ""),
    "T9f operator-repair from an account that isn't an operator: refused, and pointed to whoever runs this server, not to an owner", nr); }

// ---------------- T10 ----------------
{ const X = world("t10"); const guest = directoryFor(W).resolve({ sub: null, name: "guest" }); const t = tab(X, guest, { account: undefined }); t.c.anonymous = true;
  // reads and writes alike (a guest may say 20 in 10 s: 14 says, 86 reads), each through both recheck seams
  for (let i = 0; i < 100; i++) if (i % 7 === 6 && i < 105) send(t, "say", { text: `n${i}` }); else send(t, "inspect", { id: "@world" });
  await tryUntil('the reply to "operator-repair visitor"', () => t.replies.length === 100, { ms: 3000, step: 10 });
  const bad = t.replies.filter((m) => !(m.ok === true && m.txn === "committed"));
  ok(t.replies.length === 100 && !bad.length && said(X, "n97") && t.replies.filter((m) => m.verb === "say").length === 14, "T10 100 serial requests from an unchanged guest connection: all committed, no false refusal", { n: t.replies.length, bad: bad.slice(0, 2) }); }

// ---------------- T12 ----------------
// a connection's queue behind a stalled warm is bounded: past 256 waiting, a request is refused at arrival (busy), and once the
// stall ends every queued one is answered and the queue is empty again
{ const X = world("t12"); const guest = directoryFor(W).resolve({ sub: null, name: "guest12" }); const t = tab(X, guest, { account: undefined }); t.c.anonymous = true;
  X.g.hold(); send(t, "say", { text: "stalled" }); ok(!!await tryUntil('"stalled" is held at the await', () => X.g.entered > 0, { ms: 3000, step: 10 }), '(setup) stalled reached the await within 3 s');
  for (let i = 0; i < 300; i++) send(t, "say", { text: `q${i}` });   // writes: no arrival meter, so each one meets the queue
  const early = t.replies.filter((m) => m.reply?.refused?.code === "busy").length;   // a refusal at arrival is sent before send() returns
  X.g.release(); await tryUntil("every request is answered", () => t.replies.length === 301, { ms: 5000, step: 10 });
  ok(early === 300 - 255 && t.replies.length === 301 && t.c.verbQueue === undefined,
    "T12 behind a stalled request, a connection's queue holds 256: the rest are refused busy at once, and after the stall all are answered and the queue drains", { early, n: t.replies.length, queue: !!t.c.verbQueue }); }

ok(!publishedNotOnDisk.length, "T3d every line any client was sent was on disk when it was sent, as the bytes sent (the wire's view of the line on disk)", publishedNotOnDisk);
// ---------------- T11 (review r14 M1, 10-18) ----------------
// every request a socket sends goes through requestwire (one capability, the queue, the meters, both recheck seams; a drive frame's periodic lease commit is the exception, messages.ts requestSync): server.ts
// itself calls w.log.request nowhere; voice-moderate goes through requestAs. A static row: the wire has no other door to a write.
{ const srv = fs.readFileSync(path.join(ENGINE, "server/server.ts"), "utf8"); const rw = fs.readFileSync(path.join(ENGINE, "server/requestwire.ts"), "utf8");
  const direct = srv.split("\n").map((l, i) => [i + 1, l] as const).filter(([, l]) => /\.log\.request\(/.test(l) && !/^\s*\/\//.test(l)).map(([n, l]) => `${n}: ${l.trim().slice(0, 100)}`);
  ok(!direct.length && /requestAs\(c, ws, w,/.test(srv) && /export function requestAs\(/.test(rw) && /recheck\(cap\)/.test(rw.slice(rw.indexOf("export function requestAs"))),
    "T11 server.ts has no direct w.log.request caller (voice-moderate goes through requestwire.requestAs: capture, the connection's queue, the busy meter, recheck at both seams)", direct); }
done();
