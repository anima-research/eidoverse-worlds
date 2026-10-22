// tools/protocol/reset-race-check.ts — a request that was awaiting warm() when the world was reset must refuse, not
// append the old world's line into the new world's file (review 10-14 C1). The slow warm is simulated: the request's
// await is held by a gate; everything after it (the retired log, the real resetWorld, the real file) is production code.
// usage: BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun tools/protocol/reset-race-check.ts
// @ts-nocheck
import fs from "node:fs";
import path from "node:path";
import { scratch } from "./common.ts";
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
// RR6: a failure after the fresh log is in place has erased the world; the owner is told it was, not that nothing changed
{ const { REQUEST_MESSAGES } = await import("../../server/requestwire.ts");
  const { owner } = foundWorld(path.join(process.env.WORLDS_DIR, "reopen"), "reopen", "olive");
  const rw = new World("reopen"); rw.openLog = () => { throw new Error("injected: the fresh log won't open"); };
  const sent = []; const c = { id: "olive", world: rw, actorId: owner, spectator: false, ws: { send: (d) => sent.push(JSON.parse(d)) } };
  REQUEST_MESSAGES["world-reset"]({ c, ws: c.ws }, { name: "reopen" });
  const e = sent.find((m) => m.type === "error")?.error ?? "";
  const archived = fs.readdirSync(path.join(process.env.WORLDS_DIR, "reopen")).some((n) => n.startsWith("reset-"));
  ok(/was erased/.test(e) && /stays closed/.test(e) && /whoever runs this server/.test(e) && /Resetting again erases nothing more/.test(e) && !/nothing changed/.test(e)
    && archived && !sent.some((m) => m.type === "world-reset"),
    "RR6 the fresh log doesn't open after the reset swapped it: the owner is told the world was erased and stays closed, who can open it, and that resetting again erases nothing more; never that nothing changed", { e, archived }); }
// RR6b: once the fresh log is open the reset stands: a failure starting the fresh world's scripts (it has none) is the
// server log's, and everyone present is told of the reset as usual
{ const { REQUEST_MESSAGES } = await import("../../server/requestwire.ts"); const { WorldScripts } = await import("../../server/scripts.ts");
  const { owner } = foundWorld(path.join(process.env.WORLDS_DIR, "scripted"), "scripted", "olive");
  const sw = new World("scripted"); const sync = WorldScripts.prototype.sync;
  const sent = []; const c = { id: "olive", world: sw, actorId: owner, spectator: false, ws: { send: (d) => sent.push(JSON.parse(d)) } }; sw.clients.add(c);
  WorldScripts.prototype.sync = () => { throw new Error("injected: the scripts won't start"); };
  try { REQUEST_MESSAGES["world-reset"]({ c, ws: c.ws }, { name: "scripted" }); } finally { WorldScripts.prototype.sync = sync; }
  const fresh = sw.log.live.entries.length, err = sent.find((m) => m.type === "error")?.error;
  ok(!err && sent.some((m) => m.type === "world-reset") && sw.log.requestSync(owner, "create", { components: { description: "after" } })?.ok === true,
    "RR6b the fresh log opened but the scripts didn't start: the reset stands, everyone present is told, and the fresh world takes requests", { err, sent: sent.map((m) => m.type), fresh }); }

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
  const until = async (f) => { for (let i = 0; i < 200 && !f(); i++) await new Promise((r) => setTimeout(r, 10)); return f(); };
  const described = (label) => Object.values(tw.log.live.state().entities).some((e) => e.c?.description === label);
  const hold = () => { gate = new Promise((r) => { release = r; }); };
  // superseded: the old tab's request is waiting when the same account's new tab takes over
  hold(); const oldTab = tab(1); const n0 = tw.log.live.entries.length;
  let e0 = entered; send(oldTab, "a1", "from-the-old-tab"); await until(() => entered > e0);   // it is inside the await now
  oldTab.c.superseded = true; tw.clients.delete(oldTab.c); tab(2);   // the takeover path (server.ts admitJoin)
  release(); await until(() => oldTab.replies.length);
  const r1 = oldTab.replies[0];
  ok(r1?.ok === false && r1?.reply?.refused?.code === "superseded" && !described("from-the-old-tab") && tw.log.live.entries.length === n0,
    "SR1 a request waiting when its connection is superseded is refused (superseded) and writes nothing", { reply: r1, wrote: described("from-the-old-tab"), entries: [n0, tw.log.live.entries.length] });
  // closed: close takes the connection out of the world's clients but leaves c.world set
  hold(); const closing = tab(3); const n1 = tw.log.live.entries.length;
  e0 = entered; send(closing, "b1", "from-a-closed-tab"); await until(() => entered > e0); tw.clients.delete(closing.c);
  release(); await until(() => closing.replies.length);
  ok(closing.replies[0]?.reply?.refused?.code === "superseded" && !described("from-a-closed-tab") && tw.log.live.entries.length === n1,
    "SR2 a request waiting when its connection closes writes nothing", { reply: closing.replies[0], wrote: described("from-a-closed-tab") });
  // the control: a connection that stays writes
  hold(); const stays = tab(4); send(stays, "c1", "from-a-live-tab"); release(); await until(() => stays.replies.length);
  ok(stays.replies[0]?.ok === true && described("from-a-live-tab"), "SR3 (control) a connection that is still in the world writes", stays.replies[0]); }
// ---- PR (house 6340433633): a reset that fails after the old log was moved aside. The old log stayed live in memory and kept
// taking writes, which appendDurable (it opens by path) put in a NEW world.jsonl holding only the tail: a broken chain on disk.
// The failure is injected at the last rename (the fresh world's log into place); the rest is the real wire handler and reset.
{ const { REQUEST_MESSAGES } = await import("../../server/requestwire.ts");
  const dir = path.join(process.env.WORLDS_DIR, "half"); const { owner } = foundWorld(dir, "half", "olive");
  const hw = new World("half"); const n0 = hw.log.live.entries.length;
  const errs = []; const c = { id: "olive", world: hw, actorId: owner, gen: 0, legGen: 0, ws: { send: (d) => { const m = JSON.parse(d); if (m.type === "error") errs.push(m.error); } } };
  const rename = fs.renameSync;
  fs.renameSync = function (a, b) { if (String(a).includes(".refound-")) throw new Error("EIO: injected (the fresh log into place)"); return rename.call(fs, a, b); };
  try { REQUEST_MESSAGES["world-reset"]({ c, ws: c.ws, now: Date.now(), expel: () => {} }, { name: "half" }); } finally { fs.renameSync = rename; }
  const said = errs[0] ?? "";
  const w1 = hw.log.requestSync(owner, "say", { text: "after the failed reset" });
  const file = fs.existsSync(path.join(dir, "world.jsonl"));
  ok(!w1?.ok && !file, "PR1 after a reset that failed partway a write is refused and no world.jsonl appears", { w1: w1?.ok ?? w1?.refused, file, lines: file ? lines("half").length : 0, n0 });
  ok(/takes no writes until the server's operator puts it back/.test(said) && /resetting again is safe/i.test(said) && /takes no writes/.test(w1?.refused?.reason ?? ""),
    "PR2 the answer and the refusal say the world takes no writes until the operator puts its log back, and whether resetting again is safe", { said, refused: w1?.refused });
  // resetting again finishes the erase; the old log stays in the first attempt's archive
  REQUEST_MESSAGES["world-reset"]({ c, ws: c.ws, now: Date.now(), expel: () => {} }, { name: "half" });
  const archives = fs.readdirSync(dir).filter((f) => f.startsWith("reset-")); const kept = archives.filter((a) => fs.existsSync(path.join(dir, a, "world.jsonl")));
  const w2 = hw.log.requestSync(owner, "say", { text: "in the fresh world" });
  ok(errs.length === 1 && fs.existsSync(path.join(dir, "world.jsonl")) && kept.length === 1 && w2?.ok === true,
    "PR3 resetting again finishes the erase (a fresh world that takes writes); the old log stays in the first archive", { errs, archives, kept, w2: w2?.ok ?? w2?.refused }); }
// PR4 (review of the house fixes): a failure at the SECOND rename (poses.json), twice. The second attempt finds no world.jsonl to
// move, so "did this attempt move the log" is no; the world is still retired, and the answer must say so, not "goes on as before"
{ const { REQUEST_MESSAGES } = await import("../../server/requestwire.ts");
  const dir = path.join(process.env.WORLDS_DIR, "half2"); const { owner } = foundWorld(dir, "half2", "olive");
  fs.writeFileSync(path.join(dir, "poses.json"), "{}");
  const hw = new World("half2");
  const errs = []; const c = { id: "olive", world: hw, actorId: owner, gen: 0, legGen: 0, ws: { send: (d) => { const m = JSON.parse(d); if (m.type === "error") errs.push(m.error); } } };
  const rename = fs.renameSync; const reset = () => REQUEST_MESSAGES["world-reset"]({ c, ws: c.ws, now: Date.now(), expel: () => {} }, { name: "half2" });
  fs.renameSync = function (a, b) { if (String(a).endsWith("poses.json")) throw new Error("EIO: injected (poses.json)"); return rename.call(fs, a, b); };
  try { reset(); reset(); } finally { fs.renameSync = rename; }
  const w1 = hw.log.requestSync(owner, "say", { text: "after two failed resets" });
  ok(errs.length === 2 && errs.every((e) => /takes no writes/.test(e)) && !/goes on as before/.test(errs[1]) && !w1?.ok,
    "PR4 a second failed attempt, with the log already moved by the first, still says the world takes no writes (and it doesn't)", { errs, w1: w1?.ok ?? w1?.refused });
  reset(); const w2 = hw.log.requestSync(owner, "say", { text: "fresh" });
  ok(errs.length === 2 && w2?.ok === true, "PR4 …and a third attempt that succeeds leaves a fresh world that takes writes", { errs, w2: w2?.ok ?? w2?.refused }); }
fs.rmSync(root, { recursive: true, force: true });
console.log(`[reset-race-check] ${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
