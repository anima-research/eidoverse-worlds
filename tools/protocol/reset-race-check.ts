// tools/protocol/reset-race-check.ts — a request that was awaiting warm() when the world was reset must refuse, not
// append the old world's line into the new world's file (review 10-14 C1). The slow warm is simulated: the request's
// await is held by a gate; everything after it (the retired log, the real resetWorld, the real file) is production code.
// Also: a reset that fails at its last step leaves the world live (PR), what a reset keeps and who founds it (RS), durable poses (DW).
// usage: BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun tools/protocol/reset-race-check.ts
// @ts-nocheck
import fs from "node:fs";
import path from "node:path";
import { scratch } from "./common.ts";
import { tryUntil } from "./wait.ts";
const root = scratch("resetrace");
process.env.WORLDS_DIR = path.join(root, "w"); process.env.OPT_DIR = path.join(root, "opt"); process.env.SKIP_OPT_SWEEP = "1";
fs.mkdirSync(process.env.WORLDS_DIR, { recursive: true });
const { foundWorld, WorldLog } = await import("../../server/worldlog.ts");
const { World } = await import("../../server/world.ts");
let pass = 0, fail = 0;
const ok = (c, what, d?) => { if (c) pass++; else { fail++; console.log(`  FAIL ${what}${d !== undefined ? " — " + JSON.stringify(d).slice(0, 300) : ""}`); } };
const lines = (name) => fs.readFileSync(path.join(process.env.WORLDS_DIR, name, "world.jsonl"), "utf8").split("\n").filter(Boolean);

foundWorld(path.join(process.env.WORLDS_DIR, "race"), "race", "olive");
const w = new World("race");
const old = w.log;
let release; const gate = new Promise((r) => { release = r; });
// the held warm: request() awaits it exactly where it awaits warm(modelsIn(args)) — then runs the real requestSync
const held = (async () => { await gate; return old.requestSync("olive", "create", { id: "straggler", model: "crate", place: { at: [1, 1] } }); })();
const arch = w.resetWorld();
const fresh = w.log;
ok(fresh !== old && fs.existsSync(path.join(arch, "world.jsonl")), "RR1 reset swapped the log and archived the old file", { arch });
const before = lines("race").length;
release(); const r = await held;
ok(r?.ok === false && r?.refused?.code === "reset", "RR2 the straggler is refused with code reset", r);
ok(lines("race").length === before, "RR3 the new world's file gained no line from the old log", { before, after: lines("race").length });
ok(!fresh.live.state().entities.straggler && fresh.live.entries.length === before, "RR4 the fresh log never saw it", { head: fresh.live.entries.length });
ok(old.requestSync("olive", "say", { text: "late" })?.refused?.code === "reset", "RR5 the old log stays retired for every later request");
// RR7: the world directory's sync failing AFTER the fresh log is renamed into place is said, not a failed reset: the fresh log is
// there, the world stays live and is not retired (a retirement told the owner to put the old log back, for nothing)
if (process.platform !== "win32") { foundWorld(path.join(process.env.WORLDS_DIR, "synced"), "synced", "olive");
  const sw = new World("synced"); const wdir = path.resolve(process.env.WORLDS_DIR, "synced"); const o = fs.openSync; let threw = 0;
  const oldIno = fs.statSync(path.join(wdir, "world.jsonl")).ino;   // the dir's open after the fresh log replaced the old one is the one that fails
  fs.openSync = function (p, ...a) { if (path.resolve(String(p)) === wdir && fs.statSync(path.join(wdir, "world.jsonl")).ino !== oldIno) { threw++; throw new Error("injected: fsync of the world dir"); } return o.call(fs, p, ...a); };
  let arch7 = null, err7 = null; try { arch7 = sw.resetWorld(); } catch (e) { err7 = e; } finally { fs.openSync = o; }
  const entries = fs.readdirSync(wdir);
  ok(threw > 0 && arch7 && !err7 && !sw.log.retired && entries.includes("world.jsonl") && sw.log.requestSync("olive", "say", { text: "after" })?.ok === true,
    "RR7 a sync that fails after the swap: the reset stands (its archive returned), the world takes writes, nothing is retired", { threw, err: String(err7?.message ?? err7), entries }); }
// RR6: a failure after the fresh log is in place has erased the world; the owner is told it was, not that nothing changed
{ const { REQUEST_MESSAGES } = await import("../../server/requestwire.ts");
  const { owner } = foundWorld(path.join(process.env.WORLDS_DIR, "reopen"), "reopen", "olive");
  const rw = new World("reopen"); rw.openLog = () => { throw new Error("injected: the fresh log won't open"); };
  (await import("../../server/world.ts")).worlds.set("reopen", rw);   // registered, as getWorld leaves a loaded world
  const erasedId = rw.log.live.worldId;
  const casts = []; rw.broadcast = (m) => casts.push(m);   // what everyone present is sent
  const sent = []; const c = { id: "olive", world: rw, actorId: owner, spectator: false, ws: { send: (d) => sent.push(JSON.parse(d)) } };
  REQUEST_MESSAGES["world-reset"]({ c, ws: c.ws }, { name: "reopen" });
  const e = sent.find((m) => m.type === "error")?.error ?? "";
  const archived = fs.readdirSync(path.join(process.env.WORLDS_DIR, "reopen")).some((n) => n.startsWith("reset-"));
  // (review of the house's PR #9: "stays closed" wasn't true: the World stayed registered and a reload was served the erased
  // world's state from memory) it leaves the registry, everyone present reloads, and the next join opens the fresh world from disk
  const { worlds, getWorld } = await import("../../server/world.ts");
  const gone = !worlds.has("reopen"); const next = gone ? getWorld("reopen") : null;
  const fresh = !!next && next !== rw && !next.log.retired && !!next.log.live.worldId && next.log.live.worldId !== erasedId;   // the fresh world, not the erased one
  ok(/was erased/.test(e) && /next join/.test(e) && /whoever runs this server/.test(e) && /There is nothing more to erase right now/.test(e) && !/Resetting again/.test(e) && !/nothing changed/.test(e) && !/stays closed/.test(e)
    && archived && casts.some((m) => m.type === "world-reset") && gone && fresh,
    "RR6 the fresh log doesn't open after the reset swapped it: the owner is told the world was erased and opens at the next join (who to ask if not), and that there is nothing more to erase right now; everyone present reloads, and the next join opens the fresh world from disk, never the erased one from memory", { e, archived, gone, fresh, casts: casts.map((m) => m.type) }); }
// RR6b: once the fresh log is open the reset stands: a failure starting the fresh world's scripts (it has none) is the
// server log's, and everyone present is told of the reset as usual
{ const { REQUEST_MESSAGES } = await import("../../server/requestwire.ts"); const { WorldScripts } = await import("../../server/scripts.ts");
  const { owner } = foundWorld(path.join(process.env.WORLDS_DIR, "scripted"), "scripted", "olive");
  const sw = new World("scripted"); const sync = WorldScripts.prototype.sync;
  const sent = []; const c = { id: "olive", world: sw, actorId: owner, spectator: false, ws: { send: (d) => sent.push(JSON.parse(d)) } }; sw.clients.add(c);
  let threw = 0; WorldScripts.prototype.sync = () => { threw++; throw new Error("injected: the scripts won't start"); };   // counted: a stub never reached proves nothing
  try { REQUEST_MESSAGES["world-reset"]({ c, ws: c.ws }, { name: "scripted" }); } finally { WorldScripts.prototype.sync = sync; }
  const fresh = sw.log.live.entries.length, err = sent.find((m) => m.type === "error")?.error;
  ok(threw === 1 && !err && sent.some((m) => m.type === "world-reset") && sw.log.requestSync(owner, "create", { components: { description: "after" } })?.ok === true,
    "RR6b the fresh log opened but the scripts didn't start (the injected failure ran once): the reset stands, everyone present is told, and the fresh world takes requests", { threw, err, sent: sent.map((m) => m.type), fresh }); }

// ---- SR: a connection superseded (or closed) while its request awaits never writes (review of PR #260, requestwire.ts:135;
// Antra's repro: the old tab's request still committed, wrote:true, ok reply). The await is held by a gate in front of the
// real WorldLog.request (warm, the recheck, requestSync); the wire handler is the real REQUEST_MESSAGES.request.
{ const { REQUEST_MESSAGES } = await import("../../server/requestwire.ts");
  const { owner } = foundWorld(path.join(process.env.WORLDS_DIR, "tabs"), "tabs", "olive");
  const tw = new World("tabs");
  const real = WorldLog.prototype.request;
  let release = () => {}; let gate = Promise.resolve();
  let entered = 0;
  tw.log.request = function (...a) { entered++; return gate.then(() => real.apply(this, a)); };
  const tab = (gen) => { const replies = []; const c = { id: "olive", world: tw, actorId: owner, gen, legGen: 0, ws: { send: (d) => { const m = JSON.parse(d); if (m.type === "reply") replies.push(m); } } };
    tw.clients.add(c); return { c, replies }; };
  const send = (t, rid, label) => REQUEST_MESSAGES.request({ c: t.c, ws: t.c.ws, now: Date.now(), expel: () => {} }, { id: rid, verb: "create", args: { components: { description: label } } });
  const described = (label) => Object.values(tw.log.live.state().entities).some((e) => e.c?.description === label);
  const hold = () => { gate = new Promise((r) => { release = r; }); };
  // superseded: the old tab's request is waiting when the same account's new tab takes over
  hold(); const oldTab = tab(1); const n0 = tw.log.live.entries.length;
  // the setup is asserted: a wait that expires (tryUntil → undefined) must not read as "the request was inside"
  let e0 = entered; send(oldTab, "a1", "from-the-old-tab"); const in1 = await tryUntil("the old tab's request is inside the await", () => entered > e0, { ms: 2000, step: 10 });   // it is inside the await now
  oldTab.c.superseded = true; tw.clients.delete(oldTab.c); tab(2);   // the takeover path (server.ts admitJoin)
  release(); await tryUntil("the old tab's request is answered", () => oldTab.replies.length, { ms: 2000, step: 10 });
  const r1 = oldTab.replies[0];
  ok(in1 === true && r1?.ok === false && r1?.reply?.refused?.code === "superseded" && !described("from-the-old-tab") && tw.log.live.entries.length === n0,
    "SR1 a request waiting (inside the await) when its connection is superseded is refused (superseded) and writes nothing", { inside: in1, reply: r1, wrote: described("from-the-old-tab"), entries: [n0, tw.log.live.entries.length] });
  // closed: close takes the connection out of the world's clients but leaves c.world set
  hold(); const closing = tab(3); const n1 = tw.log.live.entries.length;
  e0 = entered; send(closing, "b1", "from-a-closed-tab"); const in2 = await tryUntil("the closed tab's request is inside the await", () => entered > e0, { ms: 2000, step: 10 }); tw.clients.delete(closing.c);
  release(); await tryUntil("the closed tab's request is answered", () => closing.replies.length, { ms: 2000, step: 10 });
  ok(in2 === true && closing.replies[0]?.reply?.refused?.code === "superseded" && !described("from-a-closed-tab") && tw.log.live.entries.length === n1,
    "SR2 a request waiting when its connection closes writes nothing", { reply: closing.replies[0], wrote: described("from-a-closed-tab") });
  // the control: a connection that stays writes
  hold(); const stays = tab(4); send(stays, "c1", "from-a-live-tab"); release(); await tryUntil("the live tab's request is answered", () => stays.replies.length, { ms: 2000, step: 10 });
  ok(stays.replies[0]?.ok === true && described("from-a-live-tab"), "SR3 (control) a connection that is still in the world writes", stays.replies[0]);
  // SR4: whois waits its turn too: asked while the same connection's role grant awaits, it answers after it
  hold(); const asker = tab(5); const bob = (await import("../../server/directory.ts")).directoryFor(process.env.WORLDS_DIR).resolve({ sub: "local:bob", name: "bob" }); const order = []; const sendRaw = asker.c.ws.send;
  asker.c.ws.send = (d) => { const m = JSON.parse(d); if (m.type === "reply") order.push(`${m.verb}:${m.verb === "whois" ? m.reply?.people?.[0]?.role : m.ok}${m.ok ? "" : ":" + JSON.stringify(m.reply?.refused).slice(0, 200)}`); return sendRaw(d); };
  e0 = entered; REQUEST_MESSAGES.request({ c: asker.c, ws: asker.c.ws, now: Date.now(), expel: () => {} }, { id: "d1", verb: "set", args: { id: "@world", component: `roles:${bob}`, value: { role: "builder" } } });
  await tryUntil("the grant is inside the await", () => entered > e0, { ms: 2000, step: 10 });
  REQUEST_MESSAGES.request({ c: asker.c, ws: asker.c.ws, now: Date.now(), expel: () => {} }, { id: "d2", verb: "whois", args: { id: bob } });
  const early = [...order];
  release(); await tryUntil("both are answered", () => order.length >= 2, { ms: 2000, step: 10 });
  ok(early.length === 0 && order[0] === "set:true" && order[1] === "whois:builder", "SR4 whois runs in the connection's queue: asked while its own role grant awaits, it answers after it, with the new role", { early, order }); }
// ---- PR (house 6340433633; bot review of #260, #10): a reset that fails at the last step. The old log is linked into the archive and
// the fresh one renamed OVER it, so a failure (or a crash) there leaves the old world in place and live. A world whose log an older
// server's failed reset already moved aside (no world.jsonl) takes no writes, and resetting again finishes the erase.
{ const { REQUEST_MESSAGES } = await import("../../server/requestwire.ts");
  const dir = path.join(process.env.WORLDS_DIR, "half"); const { owner } = foundWorld(dir, "half", "olive");
  fs.writeFileSync(path.join(dir, "poses.json"), "{}");
  const hw = new World("half"); const before = fs.readFileSync(path.join(dir, "world.jsonl"), "utf8");
  const errs = []; const c = { id: "olive", world: hw, actorId: owner, gen: 0, legGen: 0, ws: { send: (d) => { const m = JSON.parse(d); if (m.type === "error") errs.push(m.error); } } };
  const reset = () => REQUEST_MESSAGES["world-reset"]({ c, ws: c.ws, now: Date.now(), expel: () => {} }, { name: "half" });
  const rename = fs.renameSync; let injected = 0;
  const logged = [], cerr = console.error; console.error = (...a) => { logged.push(String(a[0])); };   // the operator's line (PR0b)
  fs.renameSync = function (a, b) { if (String(a).includes(".refound-")) { injected++; throw new Error("EIO: injected (the fresh log into place)"); } return rename.call(fs, a, b); };
  try { reset(); } finally { fs.renameSync = rename; console.error = cerr; }
  const still = fs.existsSync(path.join(dir, "world.jsonl")) && fs.readFileSync(path.join(dir, "world.jsonl"), "utf8") === before;
  const archived = fs.readdirSync(dir).filter((f) => f.startsWith("reset-") && fs.existsSync(path.join(dir, f, "world.jsonl")));
  const w0 = hw.log.requestSync(owner, "say", { text: "the reset failed; the world goes on" });
  ok(injected === 1 && still && fs.existsSync(path.join(dir, "poses.json")) && w0?.ok === true && /goes on as before/.test(errs[0] ?? "") && archived.length === 0,
    "PR0 a reset that fails at the last rename leaves the old log (and poses) in place and live, says so, and no archive holds a copy", { injected, still, w0: w0?.ok ?? w0?.refused, errs, archived });
  // the log already gone from its place (what an older server's failed reset left): the same failure retires the world
  if (fs.existsSync(path.join(dir, "world.jsonl"))) fs.renameSync(path.join(dir, "world.jsonl"), path.join(dir, "aside.jsonl")); const n0 = hw.log.live.entries.length;
  console.error = (...a) => { logged.push(String(a[0])); };
  fs.renameSync = function (a, b) { if (String(a).includes(".refound-")) throw new Error("EIO: injected (the fresh log into place)"); return rename.call(fs, a, b); };
  try { reset(); } finally { fs.renameSync = rename; console.error = cerr; }
  ok(logged.length === 2 && /nothing moved: the old log is where it was/.test(logged[0]) && !/old log in|archived in/.test(logged[0]) && /no world\.jsonl here/.test(logged[1]) && /\.refound-/.test(logged[1]),
    "PR0b the server's log line says where the logs are: nothing moved when the swap failed; no world.jsonl (the fresh one in scratch) when it was already gone", logged);
  const said = errs[1] ?? "";
  const w1 = hw.log.requestSync(owner, "say", { text: "after the failed reset" });
  const file = fs.existsSync(path.join(dir, "world.jsonl"));
  ok(!w1?.ok && !file, "PR1 with the log already moved aside, after a reset that failed a write is refused and no world.jsonl appears", { w1: w1?.ok ?? w1?.refused, file, lines: file ? lines("half").length : 0, n0 });
  ok(/takes no writes until the server's operator puts it back/.test(said) && /resetting again is safe/i.test(said) && /takes no writes/.test(w1?.refused?.reason ?? ""),
    "PR2 the answer and the refusal say the world takes no writes until the operator puts its log back, and whether resetting again is safe", { said, refused: w1?.refused });
  // resetting again finishes the erase
  reset();
  const w2 = hw.log.requestSync(owner, "say", { text: "in the fresh world" });
  ok(errs.length === 2 && fs.existsSync(path.join(dir, "world.jsonl")) && w2?.ok === true,
    "PR3 resetting again finishes the erase (a fresh world that takes writes)", { errs, w2: w2?.ok ?? w2?.refused }); }
// PR4: a reset that succeeds archives the old log and poses (the fresh world has none)
{ const dir = path.join(process.env.WORLDS_DIR, "whole"); const { owner } = foundWorld(dir, "whole", "olive");
  fs.writeFileSync(path.join(dir, "poses.json"), '{"x":1}'); const hw = new World("whole"); hw.log.requestSync(owner, "say", { text: "old" });
  const before = fs.readFileSync(path.join(dir, "world.jsonl"), "utf8");
  const arch = hw.resetWorld(); const fresh = fs.readFileSync(path.join(dir, "world.jsonl"), "utf8");
  ok(fs.readFileSync(path.join(arch, "world.jsonl"), "utf8") === before && fs.readFileSync(path.join(arch, "poses.json"), "utf8") === '{"x":1}' && !fs.existsSync(path.join(dir, "poses.json")) && fresh !== before && !fs.readdirSync(process.env.WORLDS_DIR).some((f) => f.startsWith(".refound-whole-")),
    "PR4 a reset archives the old log and poses whole, and the fresh log takes world.jsonl's place", { arch: fs.readdirSync(arch), dir: fs.readdirSync(dir) }); }
// ---- RS (bot review of #260, #9 and #13): what a reset keeps, and who founds it again ----
const { directoryFor } = await import("../../server/directory.ts");
const idOf = (n) => directoryFor(process.env.WORLDS_DIR).resolve({ sub: `local:${n}`, name: n });
const comps = (hw) => hw.log.live.state().entities["@world"]?.c ?? {};
// RS9: a world at the default door (no access component) keeps its grants, custom roles and default-role
{ const { owner } = foundWorld(path.join(process.env.WORLDS_DIR, "nodoor"), "nodoor", "olive"); const hw = new World("nodoor"); const bob = idOf("bob");
  const a = hw.log.requestSync(owner, "set", { id: "@world", component: `roles:${bob}`, value: { role: "builder" } });
  const b = hw.log.requestSync(owner, "set", { id: "@world", component: "default-role", value: { role: "member" } });
  const had = comps(hw).access; hw.resetWorld(); const c = comps(hw);
  ok(a?.ok && b?.ok && had == null && c[`roles:${bob}`]?.role === "builder" && c["default-role"]?.role === "member",
    "RS9 a reset of a world with no access component keeps its grants and default-role", { a: a?.ok ?? a?.refused, b: b?.ok ?? b?.refused, had, kept: Object.keys(c) }); }
// RS13: the senior owner founds the fresh world: B (senior once A stepped down and B made A owner again) stays senior after the reset
{ const { owner: A } = foundWorld(path.join(process.env.WORLDS_DIR, "senior"), "senior", "olive"); const hw = new World("senior"); const B = idOf("bea");
  const r1 = hw.log.requestSync(A, "set", { id: "@world", component: `roles:${B}`, value: { role: "owner" } });
  const r2 = hw.log.requestSync(A, "set", { id: "@world", component: `roles:${A}`, value: { role: "member" } });
  const r3 = hw.log.requestSync(B, "set", { id: "@world", component: `roles:${A}`, value: { role: "owner" } });
  const was = hw.log.seniorOwner(); hw.resetWorld();
  const now = hw.log.seniorOwner(), demote = hw.log.requestSync(A, "set", { id: "@world", component: `roles:${B}`, value: { role: "member" } });
  ok(r1?.ok && r2?.ok && r3?.ok && was === B && now === B && !demote?.ok,
    "RS13 the senior owner stays senior through a reset (the junior can't demote them after)", { r: [r1?.ok, r2?.ok, r3?.ok], was, now, B, demote: demote?.ok ?? demote?.refused?.code }); }
// DW1 (bot review of #260, #2): remembered poses are replaced durably (the file synced before its rename)
{ foundWorld(path.join(process.env.WORLDS_DIR, "poses"), "poses", "olive"); const hw = new World("poses"); const pp = path.join(process.env.WORLDS_DIR, "poses", "poses.json");
  const o = { open: fs.openSync, sync: fs.fsyncSync }; const fds = new Map(); let synced = 0;
  fs.openSync = function (p, ...a) { const fd = o.open.call(fs, p, ...a); fds.set(fd, String(p)); return fd; };
  fs.fsyncSync = function (fd) { if ((fds.get(fd) ?? "").startsWith(pp)) synced++; return o.sync.call(fs, fd); };
  try { hw.log.rememberPose("u-p", { at: [1, 2, 3] }, (p) => p); } finally { Object.assign(fs, { openSync: o.open, fsyncSync: o.sync }); }
  ok(synced >= 1 && JSON.parse(fs.readFileSync(pp, "utf8"))["u-p"]?.at?.[2] === 3, "DW1 remembered poses: the new file is synced before it replaces the old", { synced }); }
fs.rmSync(root, { recursive: true, force: true });
console.log(`[reset-race-check] ${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
