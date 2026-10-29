// tools/protocol/foldparity-check.ts — a boot from a fold cache with views reads only genesis and the tail (server/foldviews.ts,
// server/lazylog.ts; R 10-28: main's seek-past-the-snapshot parity), and every reader answers as a boot that read the whole log.
// usage: BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun tools/protocol/foldparity-check.ts   (FP_ENTRIES=200000 for the full bench;
//        FP_FROM=<world dir> also runs FP2 on a copy of that world's log, re-signed here)
//   FP1 a boot from a cache with views leaves the covered prefix on disk (genesis and the tail read), and folds what the log folds
//   FP2 equivalence: for synthetic worlds (chat, undo, roles, deletes; a physics one with checkpoints) and the repo's conformance
//       logs, two copies booted with and without the cache answer every reader alike (state, chain heads, every view, the act
//       index, creators, history and modlog pages, chat pages, client cuts, sanctions, maintenance, the sim), then take the same
//       writes (a set, a create, an undo of an old act, a say) to the same bytes, and answer alike again
//   FP3 the next write's head comes from the seeded chain: no prefix line read, the head a full chain gives
//   FP4 the byte offsets are checked: a prefix that grew a byte, or a cache whose offset is off by one, boots the whole log (the
//       state cache still used), equal to the fold
//   FP5 a stale view (a say dropped from the cache's list) that passes the boot is found by the re-derive: BUG said, the cache
//       discarded, the views rebuilt from genesis, and the readers agree with the whole-log boot again; a WorldLog resyncs its clients
//   FP6 views are carried only for a log with no purge: a purge after a tail boot reads the prefix in, and the boot after it reads
//       the whole log, equal to the fold; a stale-guests seed is dropped with it
//   FP7 a torn last line after a tail boot's covered line is cut, as readLogBytes cuts it
//   FP8 a log replaced under a live world: a prefix read throws, never reads the other file
//   FP9 boot time, RSS and the first write on a generated large log, with and without the cache (printed; the tail boot must be faster);
//       a reader walking the prefix loads the rest at once (lazylog BULK)
//   FP10 the readers rewritten not to scan (creatorOf, modlog, chat pages, client cuts) answer as their whole-log formulas
//   FP11 the boot sweep's script peek (durable.ts fileIncludes) reads in chunks and finds a needle across a chunk's edge
// @ts-nocheck
import "./fixture-ids.ts";   // fixtures seed the ids they read (R 10-17: writers never choose ids)
import fs from "node:fs";
import path from "node:path";
import { scratch, ENGINE } from "./common.ts";
import { pause } from "./wait.ts";

const root = scratch("foldparity");
const W = path.join(root, "worlds");
Object.assign(process.env, { WORLDS_DIR: W, BACKUPS_DIR: path.join(root, "backups"), OPT_DIR: path.join(root, "opt"), SKIP_OPT_SWEEP: "1", STATE_CACHE_EVERY: "1000", SIM_CHECKPOINT_EVERY: "1000" });
const A = await import("../../shared/protocol/authority.js"); const { request, settle, checkpointNow, creatorOf, lastSetterOf, sanctionsNow, seniorOwnerOf, maintenanceNeeds } = A;
const { readLog, fold, jcs, worldIdOf } = await import("../../shared/protocol/fold.js");
const { seal } = await import("../../shared/protocol/authority/storage.js");
const { actIndexOf, entityBefore } = await import("../../shared/protocol/authority/undo.js");
const { digestOf } = await import("../../shared/protocol/simlayer.js");
const { openLive } = await import("../../server/livehost.ts");
const { custodyAt } = await import("../../server/custody.ts");
const SC = await import("../../server/statecache.ts");
const FV = await import("../../server/foldviews.ts").catch(() => null);   // absent before 10-28: its rows go red, the rest still run
const { WorldLog } = await import("../../server/worldlog.ts");

let pass = 0, fail = 0;
const ok = (cond, what, detail?) => { if (cond) pass++; else { fail++; console.log(`  FAIL ${what}${detail !== undefined ? ` — ${JSON.stringify(detail).slice(0, 600)}` : ""}`); } };
const canon = (st) => jcs(SC.encodeState(st));
const logP = (dir) => path.join(dir, "world.jsonl");
const truth = (dir) => canon(fold(readLog(fs.readFileSync(logP(dir)))));
const cacheP = (dir) => path.join(dir, SC.CACHE_FILE);
const cacheOf = (dir) => JSON.parse(fs.readFileSync(cacheP(dir), "utf8"));
let T = 1800000000000;
const CUSTODY = path.join(W, ".custody.json");
const opts = (every = 1000, extra = {}) => ({ now: () => T, custodyFile: CUSTODY, nameOf: () => null, kindOf: () => "human", scripts: null,
  ...(every ? { stateCache: { every } } : {}), simCheckpoint: { every: 200 }, ...extra });
/** open a world; copies of one world (-with, -without, -ref) open under its own name, so what names it reads alike */
const nameOf = (dir) => path.basename(dir).replace(/-(with|without|ref|wl-with|wl-without)$/, "");
const open = (dir, every = 1000, extra = {}) => { const w = openLive(dir, nameOf(dir), opts(every, extra)); let k = 0; w.random = (n) => Uint8Array.from({ length: n }, () => (k = (k * 1103515245 + 12345) >>> 0) & 255); return w; };
async function said(f) { const lines = [], ow = console.warn, oe = console.error; console.warn = console.error = (...a) => lines.push(a.join(" "));
  try { return { r: await f(), lines }; } finally { console.warn = ow; console.error = oe; } }
const onDisk = (w) => w.prefixOnDisk?.() ?? 0;   // absent before 10-28: every prefix read whole
const copyDir = (from, to) => { fs.rmSync(to, { recursive: true, force: true }); fs.cpSync(from, to, { recursive: true }); return to; };
const J = (v) => JSON.stringify(v, (k, x) => (x instanceof Map ? [...x] : x instanceof Set ? [...x] : x === -Infinity ? "-inf" : x));
const first = (a, b) => { const x = J(a), y = J(b); if (x === y) return null; let i = 0; while (x[i] === y[i]) i++; return { at: i, with: x.slice(Math.max(0, i - 80), i + 120), without: y.slice(Math.max(0, i - 80), i + 120) }; };

/** Every reader's answer (a live world's): what a boot must not change. */
function readers(w) {
  const n = w.entries.length, st = w.state(), ids = Object.keys(st.entities ?? {}).sort();
  const X = actIndexOf(w); const actors = [...new Set([...X.actsOf.keys()])].sort();
  const page = (verb, args, key) => { const out = []; let a = { ...args }; for (let k = 0; k < 400; k++) { const r = request(w, "rowan", verb, a); out.push(r); const c = r?.[key]; if (!r?.ok || c == null || !r.more && !r.hasMore && key !== "next") break; if (key === "next" && r.next === undefined) break; a = { ...args, before: key === "next" ? r.next : c }; if (!(r.entries?.length || r.records?.length)) break; } return out; };
  const sf = w.simPeek();
  return {
    state: canon(st), n, heads: [1, Math.floor(n / 3), Math.floor(n / 2), n - 2, n - 1].map((s) => w.headAt(s)), nextTs: w.nextTs(),
    ever: [...w.everIds()].sort(), touching: ids.map((id) => [id, w.touching(id)]),
    act: { actsOf: [...X.actsOf], resultOf: [...X.resultOf], undone: [...X.undone].sort((a, b) => a - b), changes: X.changes, touch: [...X.touch], rests: X.rests, restAfter: [...X.restAfter], lastAct: X.lastAct, purged: [...X.purged], purgedOps: [...X.purgedOps] },
    views: J(w.viewsNow?.() ?? null),
    creators: ids.map((id) => [id, creatorOf(w, id), Object.keys(st.entities[id].c).sort().map((c) => [c, creatorOf(w, id, c), lastSetterOf(w, id, c)])]),
    before: ids.slice(0, 12).map((id) => [id, entityBefore(w, id, Math.floor(n / 2))]),
    history: page("history", { limit: 9 }, "next"), modlog: page("modlog", { limit: 5 }, "next"),
    sanctions: sanctionsNow(w), senior: seniorOwnerOf(w), maint: maintenanceNeeds(w), actors,
    sim: { clock: sf.clock, spec: sf.spec, foreign: sf.foreign, digest: sf.sim ? digestOf(sf.sim) : null, launched: sf.launched, lifted: [...(sf.lifted ?? [])], rev: sf.rev, checks: sf.checks, st: sf.st ? jcs(SC.encodeState({ ...sf.st, diagnostics: sf.st.diagnostics ?? [] })) : null, unknownEpoch: !!sf.unknownEpoch, unknownHold: !!sf.unknownHold },
  };
}
/** The WorldLog's own readers (chat window, history pages, cuts, the directory-scoped sets). */
function logReaders(L) {
  const pages = []; let before = Infinity; for (let k = 0; k < 200; k++) { const r = L.readHistory({ before, limit: 13, floor: null }); pages.push(r); if (!r.hasMore) break; before = r.oldestSeq; }
  const actors = [...L.knownIds()].sort();
  return { chat: L.state.recentChat, chatTotal: L.state.chatTotal, pages, known: actors, cuts: ["rowan", "ash", ...actors].map((a) => [a, L.clientCut(a).mine]), senior: L.seniorOwner(), sanctions: L.sanctions(), head: L.head, roles: ["rowan", "ash"].map((a) => L.roleOf(a)) };
}

/** A world with history: things made, labelled, parented, deleted; chat; a role granted and changed; undos. */
function grow(w, k, tag = "g") {
  const call = (actor, verb, args) => { T += 700; return request(w, actor, verb, args); };
  if (!w.entries.length) { call("rowan", "create-world", { title: tag }); call("rowan", "set", { id: "@world", component: "roles:ash", value: { role: "builder" } }); }
  for (let i = 0; i < k; i++) { const id = `${tag}-${i % 23}`, who = i % 5 === 0 ? "ash" : "rowan";
    const have = !!w.state().entities[id];
    if (!have) call(who, "create", { id, components: { label: `${tag} ${i}` } });
    else if (i % 17 === 0) call(who, "delete", { id });
    else if (i % 7 === 0) call(who, "say", { text: `${tag} says ${i}` });
    else if (i % 11 === 0) call(who, "undo", {});
    else if (i % 13 === 0 && w.state().entities[`${tag}-0`] && id !== `${tag}-0`) call(who, "set", { id, component: "parent", value: { to: `${tag}-0` } });
    else call(who, "set", { id, component: "label", value: `${tag} ${i}` });
    if (i % 97 === 0) call("rowan", "set", { id: "@world", component: "roles:ash", value: { role: i % 2 ? "builder" : "member" } }); }
}
/** Re-sign a log under this run's custody key (a fixture's key isn't ours): its genesis names our sequencer. */
function resealed(E) {
  const cu = custodyAt(CUSTODY); E = E.map((e) => JSON.parse(JSON.stringify(e))); E[0].body.sequencer = cu.sequencer(); const wid = worldIdOf(E[0]);
  for (let i = 1; i < E.length; i++) { E[i].world = wid; delete E[i].head; delete E[i].sig; }
  return seal(E, { sign: (m) => cu.sign(m) }).map((e) => JSON.stringify(e)).join("\n") + "\n";
}

/** FP2's core: copies with and without the cache, booted, compared; the same writes on both, compared again. */
async function equivalent(label, dir, { writes = true, wantTail = true, mustWrite = true } = {}) {
  const a = copyDir(dir, path.join(W, `${path.basename(dir)}-with`)), b = copyDir(dir, path.join(W, `${path.basename(dir)}-without`)); SC.dropCache(b);
  const { r: [wa, wb] } = await said(() => [open(a), open(b)]);
  if (wantTail) ok(onDisk(wa) > 0 && wa.bootedFromCache != null, `FP2 ${label}: (setup) the cached copy booted from its tail`, { onDisk: onDisk(wa), from: wa.bootedFromCache });
  else ok(onDisk(wa) === 0, `FP2 ${label}: a log whose views aren't carried boots whole`, { onDisk: onDisk(wa) });
  const d = first(readers(wa), readers(wb)); ok(!d, `FP2 ${label}: every reader answers as the whole-log boot`, d);
  if (writes && wa.state().status === "ok") {
    const old = actIndexOf(wb).actsOf.get("rowan")?.find((q) => wb.entries[q].verb === "set" && actIndexOf(wb).resultOf.has(q) && !actIndexOf(wb).undone.has(q));
    const id = Object.keys(wb.state().entities).find((k) => k !== "@world");
    const steps = [["set", { id, component: "label", value: "after the boot" }], ["create", { id: "fp-new", components: { label: "new" } }], ...(old !== undefined ? [["undo", { act: old }]] : []), ["say", { text: "after the boot" }]];
    const replies = steps.map(([v, x]) => { T += 900; return [request(wa, "rowan", v, x), request(wb, "rowan", v, x)]; });
    const dr = replies.map(([x, y], i) => [steps[i][0], first(x, y)]).filter(([, e]) => e);
    ok(!dr.length && (!mustWrite || replies.some(([x]) => x.ok)), `FP2 ${label}: the same writes (set, create, undo of an old act ${old}, say) reply alike`, dr);
    ok(fs.readFileSync(logP(a)).equals(fs.readFileSync(logP(b))), `FP2 ${label}: …to the same bytes`);
    const d2 = first(readers(wa), readers(wb)); ok(!d2, `FP2 ${label}: …and every reader answers alike after them`, d2); }
  // the server's own readers (WorldLog: chat, pages, cuts), on two more copies
  const la = copyDir(dir, path.join(W, `${path.basename(dir)}-wl-with`)), lb = copyDir(dir, path.join(W, `${path.basename(dir)}-wl-without`)); SC.dropCache(lb);
  const { r: [La, Lb] } = await said(() => [new WorldLog(path.basename(la)), new WorldLog(path.basename(lb))]);
  const d3 = first(logReaders(La), logReaders(Lb)); ok(!d3, `FP2 ${label}: the WorldLog's readers (chat window, history pages, client cuts, known ids) answer alike`, d3);
  // FP10: a reader rewritten not to scan answers as its whole-log formula (the two copies share the rewrite, so equivalence alone can't see it)
  { const ids = Object.keys(wa.state().entities ?? {}); const bare = { entries: wa.entries, touching: wa.touching };   // no state: creatorOf walks
    const cr = ids.filter((id) => J(creatorOf(wa, id)) !== J(creatorOf(bare, id)));
    const whole = Object.create(wa); whole.touching = undefined;   // modlog's loop over every entry
    const ml = J(request(wa, "rowan", "modlog", { limit: 200 })) === J(request(whole, "rowan", "modlog", { limit: 200 }));
    const E = La.live.entries, X = actIndexOf(La.live), hist = [];
    for (let i = E.length - 1; i >= 0; i--) { const e = E[i]; if (!e || e.kind !== "say" || e.body?.commit !== undefined) continue; hist.push(e.seq * 1000); }
    const paged = logReaders(La).pages.flatMap((p) => p.entries.map((x) => x.seq)).sort((a, b) => b - a);
    const cuts = ["rowan", "ash"].filter((a) => J(La.clientCut(a).mine) !== J((X.actsOf.get(a) ?? []).filter((q) => !["undo", "create-world", "throw", "drop", "leave", "move", "grab"].includes(E[q].verb) && !X.undone.has(q) && X.resultOf.has(q)).slice(-40)));
    ok(!cr.length && ml && J(paged) === J(hist) && !cuts.length, `FP10 ${label}: creatorOf (born line), modlog (@world's index), chat pages (say index) and client cuts (newest 40) answer as their whole-log formulas`, { cr, ml, pages: paged.length, says: hist.length, cuts }); }
  ok(await wa.cacheChecked !== false, `FP2 ${label}: the re-derive agrees with the cache`);
  return { wa, wb, a, b };
}

// ---- FP1 / FP3 ----
{ const dir = path.join(W, "fp1"); fs.mkdirSync(dir, { recursive: true });
  const w = open(dir); grow(w, 600, "fp1"); w.saveCache(); const c = cacheOf(dir);
  ok(c.views && c.at && c.coversIndex === w.entries.length - 1, "FP1 (setup) the cache carries views and the covered line's offsets", { keys: Object.keys(c), at: c.at });
  grow(w, 40, "fp1");
  const b = open(dir);
  ok(b.bootedFromCache === c.coversIndex && onDisk(b) === c.coversIndex - 1 && canon(b.state()) === truth(dir), "FP1 a boot from it reads genesis and the tail only, and folds what the log folds", { onDisk: onDisk(b), at: c.coversIndex });
  const off = open(dir, 0); ok(onDisk(off) === 0 && off.bootedFromCache == null, "FP1 control: no stateCache option, the whole log read");
  const ref = copyDir(dir, path.join(W, "fp1-ref")); SC.dropCache(ref); const r = open(ref);
  const n0 = onDisk(b); T += 900; const x = request(b, "rowan", "say", { text: "the next write" }), y = request(r, "rowan", "say", { text: "the next write" });
  const hb = b.headAt(b.entries.length - 1), hr = r.headAt(r.entries.length - 1);
  ok(x.ok && y.ok && hb && hb === hr && fs.readFileSync(logP(dir)).equals(fs.readFileSync(logP(ref)).subarray(0, fs.statSync(logP(dir)).size)) && fs.statSync(logP(dir)).size === fs.statSync(logP(ref)).size, "FP3 the next write's head is the one a chain from genesis gives (the same line, byte for byte)", { hb, hr });
  ok(onDisk(b) === n0, "FP3 …and chaining it read no prefix line (the chain is seeded at the covered line)", { before: n0, after: onDisk(b) });
  ok(b.headAt(5) === r.headAt(5) && b.headAt(c.coversIndex - 1) === r.headAt(c.coversIndex - 1), "FP3 an old seq's head is chained from genesis on demand, and agrees");
  ok(await b.cacheChecked === true, "FP1 the background re-derive agrees with the state, the chain and the views"); }

// ---- FP2 ----
{ const dir = path.join(W, "chat"); fs.mkdirSync(dir, { recursive: true }); const w = open(dir); grow(w, 900, "chat"); w.saveCache(); T += 700; request(w, "ash", "say", { text: "the first line after the cache" }); grow(w, 30, "chat");
  await equivalent("a built world (things, chat, roles, undos)", dir); }
{ const dir = path.join(W, "phys"); fs.mkdirSync(dir, { recursive: true }); const w = open(dir);
  const call = (verb, args = {}) => { T += 100; return request(w, "rowan", verb, args); };
  call("create-world", { title: "phys" }); call("set", { id: "@world", component: "physics-engine", value: { engine: "eidosim@1.0.0", tickMs: 33 } });
  for (let i = 0; i < 6; i++) call("create", { id: `cr-${i}`, model: "crate", components: { physics: { kind: "dynamic", who: "member" } }, place: { at: [i * 2, 3] } });
  for (let k = 0; k < 400; k++) { T += 33; settle(w); }
  for (let i = 0; i < 500; i++) { call("set", { id: `cr-${i % 6}`, component: "label", value: `l ${i}` }); if (i % 3 === 0) { const p = w.state().entities[`cr-${i % 6}`].c.transform.pos; call("set", { id: `cr-${i % 6}`, component: "transform", value: { pos: [p[0] + 0.01, p[1], p[2]], q: [0, 0, 0, 1], scale: 1 } }); } T += 33; settle(w); }
  T += 100; checkpointNow(w); w.saveCache(); for (let i = 0; i < 9; i++) { call("set", { id: "cr-1", component: "label", value: `tail ${i}` }); T += 33; settle(w); }
  const { wa } = await equivalent("a physics world with checkpoints", dir, { writes: false });
  ok(wa.bootedFrom != null, "FP2 a physics world: (setup) the engine started from a checkpoint", wa.bootedFrom); }
{ const fx = path.join(ENGINE, "spec/conformance"); let n = 0, seen = 0;
  const files = [...fs.readdirSync(fx).filter((f) => f.endsWith(".jsonl")).map((f) => path.join(fx, f)), ...fs.readdirSync(path.join(fx, "logs")).filter((f) => f.endsWith(".jsonl")).map((f) => path.join(fx, "logs", f))];
  for (const f of files) { let E; try { E = readLog(fs.readFileSync(f)); } catch { continue; }
    if (!E.length || E.some((e) => !e || e.constructor?.name === "Malformed") || fold(E).status !== "ok" || E.some((e) => e.kind === "sequencer")) continue;
    seen++; const name = `fx-${path.basename(f, ".jsonl").replace(/[^a-z0-9-]/gi, "-").toLowerCase()}`, dir = path.join(W, name); fs.mkdirSync(dir, { recursive: true });
    try { fs.writeFileSync(logP(dir), resealed(E)); } catch { continue; }
    const { r: w } = await said(() => open(dir)); if (w.state().status !== "ok") continue;
    grow(w, 60, "fx"); w.saveCache(); grow(w, 5, "fx");
    const carried = fs.existsSync(cacheP(dir)) && !!cacheOf(dir).views; await equivalent(`fixture ${path.basename(f)}`, dir, { wantTail: carried, mustWrite: false }); n++; }
  ok(n >= 2, "FP2 (setup) the repo's conformance logs that fold cleanly were each re-signed, grown and compared", { n, seen }); }
{ const src = path.join(W, "noopc-src"); fs.mkdirSync(src, { recursive: true }); const w = open(src); grow(w, 120, "nc");   // a hand-made line: a create of a thing already live (noop:create-live), by ash
  const E = w.entries.map((e) => JSON.parse(JSON.stringify(e))), id = Object.keys(w.state().entities).find((k) => k !== "@world" && creatorOf(w, k)?.by === "rowan");   // rowan made it; the no-op create is ash's
  const ashAct = E.findLastIndex((e) => e.kind === "act" && e.actor === "ash"); T += 700;
  E.push({ world: w.worldId, kind: "change", actor: "ash", cause: ashAct, verb: "create", body: { id }, ts: T });
  const dir = path.join(W, "noopc"); fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(logP(dir), resealed(E));
  const { r: x } = await said(() => open(dir)); ok(x.state().diagnostics.some(([, c, d]) => c === "noop:create-live" && d === id), "FP10 (setup) a log whose fold holds a no-op create of a live thing", id);
  ok(creatorOf({ entries: x.entries, touching: x.touching }, id)?.by === "ash", "FP10 (setup) …whose walk names the no-op create's author (the born line names another)");
  grow(x, 20, "nc"); x.saveCache(); grow(x, 3, "nc"); await equivalent("a log with a no-op create", dir, { mustWrite: false }); }
if (process.env.FP_FROM) { const dir = path.join(W, "from"); fs.mkdirSync(dir, { recursive: true });
  if (fs.existsSync(path.join(process.env.FP_FROM, "blobs"))) fs.cpSync(path.join(process.env.FP_FROM, "blobs"), path.join(dir, "blobs"), { recursive: true });
  fs.writeFileSync(logP(dir), resealed(readLog(fs.readFileSync(logP(process.env.FP_FROM)))));
  const { r: w } = await said(() => open(dir)); T = Math.max(T, w.entries.at(-1).ts + 1000); grow(w, 50, "from"); T += 100; checkpointNow(w, { every: 1 }); w.saveCache(); grow(w, 5, "from");
  await equivalent(`${path.basename(process.env.FP_FROM)} (re-signed)`, dir); }

// ---- FP4 ----
{ const dir = path.join(W, "fp4"); fs.mkdirSync(dir, { recursive: true }); const w = open(dir); grow(w, 200, "fp4"); w.saveCache(); grow(w, 10, "fp4");
  const good = cacheOf(dir);
  const bumped = copyDir(dir, path.join(W, "fp4-bumped")); { const L = fs.readFileSync(logP(bumped), "utf8").split("\n"); L[5] = L[5].replace(/^\{/, "{ "); fs.writeFileSync(logP(bumped), L.join("\n")); }   // same entry, one byte more
  const { r: x, lines } = await said(() => open(bumped));
  ok(onDisk(x) === 0 && x.bootedFromCache === good.coversIndex && canon(x.state()) === truth(bumped) && lines.some((l) => /isn't at its offset/.test(l)),
    "FP4 a prefix one byte longer: the covered line isn't at its offset, so the whole log is read (the state cache still used), equal to the fold", { onDisk: onDisk(x), from: x.bootedFromCache, lines });
  for (const d of [-1, 1]) { const off = copyDir(dir, path.join(W, `fp4-off${d}`)); const c = cacheOf(off); c.at.start += d; fs.writeFileSync(cacheP(off), JSON.stringify(c));
    const { r: y } = await said(() => open(off));
    ok(onDisk(y) === 0 && canon(y.state()) === truth(off), `FP4 a cache whose offset is off by ${d}: the whole log read, equal to the fold`, { onDisk: onDisk(y) }); } }

{ const dir = path.join(W, "fp4c"); fs.mkdirSync(dir, { recursive: true }); const w = open(dir); grow(w, 200, "fp4c"); w.saveCache(); grow(w, 10, "fp4c");
  const L = fs.readFileSync(logP(dir), "utf8").split("\n"); L[7] = L[7].slice(0, 20) + "\n" + L[7].slice(21); fs.writeFileSync(logP(dir), L.join("\n"));   // one byte becomes a newline: the same bytes before the covered line, one more line
  const { r: b, lines } = await said(async () => { const b = open(dir); let threw = null; try { b.entries[7].kind; } catch (x) { threw = String(x.message); } b.threw = threw; b.checked = await b.cacheChecked; return b; });
  ok(b.bootedFromCache != null && /lines before byte/.test(b.threw ?? ""), "FP4 a prefix with one more line in the same bytes: a prefix read refuses, never a shifted entry", { threw: b.threw, from: b.bootedFromCache });
  T += 900; const n0 = fs.statSync(logP(dir)).size; let r; try { r = request(b, "rowan", "say", { text: "after it" }); } catch (x) { r = { ok: false, threw: String(x.message) }; }   // refused, or thrown by a prefix read: either way nothing written
  ok(fs.statSync(logP(dir)).size === n0, "FP4 …nothing is written to it", r);
  ok(b.checked === false && lines.some((l) => /BUG: the fold cache/.test(l)) && lines.some((l) => /writes refused until then/.test(l)) && !r.ok && !fs.existsSync(cacheP(dir)),
    "FP4 …and the re-derive finds the log isn't the one the cache covered: BUG said, the cache gone, writes refused until a reopen", { lines, r: r.refused ?? r });
  const again = open(dir); ok(onDisk(again) === 0 && canon(again.state()) === truth(dir), "FP4 …and the reopen reads the whole log, equal to the fold"); }

// ---- FP5 ----
{ const dir = path.join(W, "fp5"); fs.mkdirSync(dir, { recursive: true }); const w = open(dir); grow(w, 400, "fp5"); w.saveCache(); grow(w, 10, "fp5");
  const c = cacheOf(dir); const says = c.views.says; ok(says.length > 3, "FP5 (setup) the cache lists says", says.length);
  c.views.says = says.slice(0, -2).concat([says.at(-2) + says.at(-1)]); fs.writeFileSync(cacheP(dir), JSON.stringify(c));   // the second-newest say in the prefix dropped
  const wl = copyDir(dir, path.join(W, "fp5wl"));   // the same lie, under a WorldLog (review L21)
  const ref = copyDir(dir, path.join(W, "fp5-ref")); SC.dropCache(ref); const r = open(ref);
  const { r: b, lines } = await said(async () => { const b = open(dir); b.lied = J(b.saySeqs?.()); b.checked = await b.cacheChecked; return b; });
  ok(b.lied !== J(r.saySeqs?.()) && b.bootedFromCache === c.coversIndex, "FP5 (setup) a stale view that passes the boot's checks is booted from", { from: b.bootedFromCache });
  const d = first(readers(b), readers(r));
  ok(b.checked === false && lines.some((l) => /BUG: the fold cache.*\(views\)/.test(l)) && !fs.existsSync(cacheP(dir)) && J(b.saySeqs?.()) === J(r.saySeqs?.()) && !d,
    "FP5 …the re-derive finds it: BUG said (views), the cache discarded, every view rebuilt from genesis, the readers as the whole-log boot", { checked: b.checked, lines, d });
  const calls = []; const { r: L } = await said(async () => { const L = new WorldLog(path.basename(wl)); L.attach({ broadcast() {}, rightsChanged() {}, debug() {}, resync: (why) => calls.push(why) }); L.checked = await L.live.cacheChecked; return L; });
  ok(L.checked === false && calls.length === 1, "FP5 …and a WorldLog over it asks its World to resync every client (the state was replaced under them)", { checked: L.checked, calls }); }

// ---- FP6 ----
{ const dir = path.join(W, "fp6"); fs.mkdirSync(dir, { recursive: true }); const w = open(dir); grow(w, 300, "fp6"); w.saveCache(); grow(w, 10, "fp6");
  const ref = copyDir(dir, path.join(W, "fp6-ref")); SC.dropCache(ref); const r = open(ref);
  const b = open(dir); ok(onDisk(b) > 0, "FP6 (setup) a tail boot");
  const target = r.entries.findIndex((e, s) => s > 20 && e.kind === "change" && e.verb === "set");
  const purge = { kind: "purge", actor: "system", verb: "purge", body: { values: [{ seq: target }] } };
  T += 900; const p1 = { ok: Number.isInteger(b.append(purge)) }, p2 = { ok: Number.isInteger(r.append(purge)) };
  ok(p1.ok && p2.ok && onDisk(b) === 0 && canon(b.state()) === canon(r.state()) && !b.__guests?.seeded, "FP6 a purge after a tail boot reads the prefix in and folds as the whole-log boot", { p1: p1.refused ?? p1.ok, p2: p2.refused ?? p2.ok, onDisk: onDisk(b) });
  const d = first(readers(b), readers(r)); ok(!d, "FP6 …every reader answers alike after it", d);
  b.saveCache(); const c = fs.existsSync(cacheP(dir)) ? cacheOf(dir) : null;
  ok(!p1.ok || !c?.views, "FP6 a log holding a purge gets no views in its cache", c && Object.keys(c));
  const again = open(dir); ok(onDisk(again) === 0 && canon(again.state()) === truth(dir), "FP6 …so the boot after it reads the whole log, equal to the fold"); }

// ---- FP7 / FP8 ----
{ const dir = path.join(W, "fp7"); fs.mkdirSync(dir, { recursive: true }); const w = open(dir); grow(w, 120, "fp7"); w.saveCache(); grow(w, 4, "fp7");
  const size = fs.statSync(logP(dir)).size; fs.appendFileSync(logP(dir), '{"kind":"say","torn');
  const { r: b, lines } = await said(() => open(dir));
  ok(onDisk(b) > 0 && fs.statSync(logP(dir)).size === size && lines.some((l) => /cut a torn last line/.test(l)) && canon(b.state()) === truth(dir), "FP7 a torn last line is cut at a tail boot, as readLogBytes cuts it", { size, now: fs.statSync(logP(dir)).size, lines });
  T += 900; ok(request(b, "rowan", "say", { text: "after the cut" }).ok && readLog(fs.readFileSync(logP(dir))).every((e) => e && e.constructor?.name !== "Malformed"), "FP7 …and the next write lands on a whole line");
  await pause("one turn of the event loop: a synchronous run's open log closes after it (the booted inode is read while it lasts)", 0);
  const moved = logP(dir) + ".moved"; fs.renameSync(logP(dir), moved); fs.copyFileSync(moved, logP(dir));   // same bytes, another file
  let threw = null; let q = 1; while (Object.hasOwn(b.entries, q)) q++;   // the first line still on disk
  try { b.entries[q].kind; threw = `read line ${q}`; } catch (x) { threw = String(x.message); }
  ok(/no longer the log this world booted from/.test(threw ?? ""), "FP8 a log replaced under a live world: a prefix read throws, never reads the other file", threw); }

// ---- FP9 ----
{ const K = Number(process.env.FP_ENTRIES ?? 30000);
  const dir = path.join(W, "big"); fs.mkdirSync(dir, { recursive: true }); const w = open(dir); grow(w, 60, "big");
  const cause = w.entries.findLastIndex((e) => e.kind === "act"), E = w.entries.map((e) => JSON.parse(JSON.stringify(e)));
  const ids = Object.keys(w.state().entities).filter((k) => k !== "@world");
  for (let i = 0; i < K; i++) E.push({ world: w.worldId, kind: "change", actor: "rowan", cause, verb: "set", body: { id: ids[i % ids.length], comp: "label", value: `label ${i}` }, ts: T += 1000 });
  fs.writeFileSync(logP(dir), resealed(E)); T += 1000;
  const boot = (every) => { Bun.gc(true); const r0 = process.memoryUsage().rss, t0 = performance.now(); const b = open(dir, every); const ms = performance.now() - t0; Bun.gc(true); return { ms, rss: (process.memoryUsage().rss - r0) / 1e6, b }; };
  boot(1000).b.saveCache();
  const off = boot(0), on = boot(1000), left = onDisk(on.b);
  const wr = (b) => { const t0 = performance.now(); T += 900; const r = request(b, "rowan", "set", { id: ids[3], component: "label", value: `bench ${T}` }); return [performance.now() - t0, r.ok]; };
  const [offW, offOk] = wr(off.b), [onW, onOk] = wr(on.b); const read = left - onDisk(on.b);
  console.log(`  FP9 ${E.length} entries (${(fs.statSync(logP(dir)).size / 1e6).toFixed(1)} MB): boot ${off.ms.toFixed(0)} ms (+${off.rss.toFixed(0)} MB RSS) reading the whole log, ${on.ms.toFixed(0)} ms (+${on.rss.toFixed(0)} MB) from the tail (${left} lines left on disk); first write to a thing with ${K / ids.length | 0} sets ${offW.toFixed(1)} ms vs ${onW.toFixed(1)} ms (${read} prefix lines read)`);
  ok(left >= K && on.ms * 3 < off.ms, "FP9 the tail boot leaves the prefix on disk and is under a third of the whole-log boot", { on: on.ms, off: off.ms, left, from: on.b.bootedFromCache, sim: on.b.simFromCache });
  ok(offOk && onOk && read < 20, `FP9 the first write to a thing with a long history reads its create line and the rate window, not its ${K / ids.length | 0} sets (creatorOf's born shortcut)`, { read }); 
  { const t0 = performance.now(); let same = true; for (let q = 1; q <= 5000; q++) same &&= J(on.b.entries[q]) === J(off.b.entries[q]); const walk = performance.now() - t0;   // review L20
    console.log(`  FP9 a reader walking 5000 prefix lines: ${walk.toFixed(0)} ms, ${onDisk(on.b)} lines left on disk after it`);
    ok(same && onDisk(on.b) === 0, "FP9 a reader walking the prefix line by line loads the rest at once after a few thousand (lazylog BULK), and reads what the whole-log boot reads", { left: onDisk(on.b) }); } }

// ---- FP11 (review L18): the boot sweep's script peek reads the log in chunks, and finds the bytes across a chunk's edge ----
{ const D = await import("../../server/durable.ts"), f = path.join(root, "peek.jsonl"), M = 1 << 20, N = '"script:', E = M + N.length;   // E: the first read's size
  const at = (bytes) => { fs.writeFileSync(f, bytes); return D.fileIncludes?.(f, N); };
  const got = [at(""), at(N), at("x".repeat(E - 3) + N + "y"), at("x".repeat(3 * M) + N), at("x".repeat(3 * M) + N.slice(0, -1)), at("x".repeat(E - 4) + N.slice(0, 4) + "\n" + N.slice(4))];
  ok(JSON.stringify(got) === JSON.stringify([false, true, true, true, false, false]), "FP11 fileIncludes: none, all, across the first read's edge, chunks later, a cut needle, a split one", got); }

console.log(`\n${fail ? `FAIL ${fail}` : "ok"}: ${pass} passed${fail ? `, ${fail} failed` : ""}`);
process.exit(fail ? 1 : 0);
