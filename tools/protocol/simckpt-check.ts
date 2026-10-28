// tools/protocol/simckpt-check.ts — periodic sim checkpoints (authority checkpointSim's tail bound; server policy SIM_CHECKPOINT_EVERY):
// a physics world that builds for a long time without launches still checkpoints, so a boot replays at most N entries into the engine.
// usage: BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun tools/protocol/simckpt-check.ts   (PC_ENTRIES=205000 for the full bench; PC_FROM=<world dir>
//        derives the bench from that world's log instead of a generated one, as the 10-28 gym measurement did)
//   PC1 a physics world with no launches gets a checkpoint once N entries follow the last one, and again after N more
//   PC2 a boot replays at most N entries into the engine, and lands on the bits a replay from genesis gets
//   PC3 an unchanged state writes nothing: a tail of says alone writes no checkpoint; an unchanged engine shares one blob
//   PC4 a purge still forces a full replay: earlier blobs gone, a boot right after it is from genesis; the next one follows it
//   PC5 an audit re-run accepts the log: the strict fold, a sim replay from genesis (no disagreement), every checkpoint bootable,
//       and the reference reader and chain verifier (spec/conformance, when python3 has `cryptography`)
//   PC6 a clean shutdown (checkpointNow) writes one for a non-trivial tail, none for a trivial one
//   PC7 the fold cache covers the last checkpoint, so a boot's cut takes its state from the resume (no second fold)
//   PC8 an older checkpoint (time inside the blob) still boots
//   PC9 log-size cost on a busy world (printed) and boot before/after on a generated large log (printed; the replay must shrink)
// @ts-nocheck
import "./fixture-ids.ts";   // fixtures seed the ids they read (R 10-17: writers never choose ids)
import fs from "node:fs";
import path from "node:path";
import { scratch, ENGINE } from "./common.ts";

const root = scratch("simckpt");
const W = path.join(root, "worlds");
Object.assign(process.env, { WORLDS_DIR: W, BACKUPS_DIR: path.join(root, "backups"), OPT_DIR: path.join(root, "opt"), SKIP_OPT_SWEEP: "1" });
const A = await import("../../shared/protocol/authority.js"); const { request, settle } = A;
const checkpointNow = A.checkpointNow ?? (() => 0);   // absent before 10-28: its rows go red, the rest still run
const { readLog, fold, worldIdOf, digest } = await import("../../shared/protocol/fold.js");
const { seal } = await import("../../shared/protocol/authority/storage.js");
const { simFold, simCutOf, digestOf } = await import("../../shared/protocol/simlayer.js");
const { openLive } = await import("../../server/livehost.ts");
const { custodyAt } = await import("../../server/custody.ts");
const SC = await import("../../server/statecache.ts");

let pass = 0, fail = 0;
const ok = (cond, what, detail?) => { if (cond) pass++; else { fail++; console.log(`  FAIL ${what}${detail !== undefined ? ` — ${JSON.stringify(detail).slice(0, 500)}` : ""}`); } };
const N = 40, TICK = 33;
const isCk = (e) => e?.kind === "sim" && e.verb === "checkpoint";
const cks = (w) => w.entries.map((e, s) => (isCk(e) ? s : -1)).filter((s) => s >= 0);
const blobFile = (dir, h) => path.join(dir, "blobs", `${String(h).replace(/[^a-z0-9]/g, "-")}.json`);
let T = 1800000000000;
const opts = (extra = {}) => ({ now: () => T, custodyFile: path.join(W, ".custody.json"), nameOf: () => null, kindOf: () => "human", scripts: null, ...extra });
/** a physics world of `n` crates at rest, opened with the tail bound `every` (0: none) */
function world(name, n = 6, every = N, extra = {}) {
  const dir = path.join(W, name); fs.mkdirSync(dir, { recursive: true });
  const w = openLive(dir, name, opts({ ...(every ? { simCheckpoint: { every } } : {}), ...extra }));
  const call = (verb, args = {}, step = 100) => { T += step; return request(w, "rowan", verb, args); };
  call("create-world", { title: name });
  call("set", { id: "@world", component: "physics-engine", value: { engine: "eidosim@1.0.0", tickMs: TICK } });
  for (let i = 0; i < n; i++) call("create", { id: `cr-${i}`, model: "crate", components: { physics: { kind: "dynamic", who: "inhabitant" } }, place: { at: [i * 2, 3] } });
  const beat = (ms = TICK) => { T += ms; return settle(w); };
  for (let k = 0; k < 400 && Object.values(w.simPeek().sim?.bodies ?? {}).some((b) => !b.resting); k++) beat();
  return { dir, w, call, beat };
}
/** k label writes (a request and a beat each): the fold moves, the engine doesn't */
const labels = (x, k, tag = "l") => { for (let i = 0; i < k; i++) { x.call("set", { id: `cr-${i % 3}`, component: "label", value: `${tag} ${i}` }); x.beat(); } };
const reopen = (dir, extra = {}) => openLive(dir, path.basename(dir), opts(extra));
const replayed = (b) => b.entries.length - 1 - (b.bootedFrom ?? -1);   // what the boot fed into the engine
const sameAsGenesis = (b) => digestOf(b.sim().sim) === digestOf(simFold(b.entries, b.now(), { models: {} }).sim);

// ---- PC1 / PC2 ----
{ const x = world("a"); const n0 = cks(x.w).length;
  labels(x, Math.floor((N - 4 - x.w.entries.length) / 2));   // a request writes two entries (its act and its change)
  ok(cks(x.w).length === n0, "PC1 (setup) under N entries since genesis: no checkpoint yet", { n0, now: cks(x.w).length, len: x.w.entries.length });
  labels(x, 2 * N);
  const C = cks(x.w), gaps = C.map((s, i) => s - (i ? C[i - 1] : -1));
  ok(C.length >= 3 && gaps.every((g) => g >= N && g <= N + 6), "PC1 no launches, and a checkpoint every N (40) entries", { C, gaps, len: x.w.entries.length });
  labels(x, 7);
  const b = reopen(x.dir);
  ok(b.bootedFrom === C.at(-1) && replayed(b) <= N && replayed(b) > 0, "PC2 a boot starts the engine from the last checkpoint and replays at most N", { from: b.bootedFrom, replayed: replayed(b), last: C.at(-1) });
  ok(sameAsGenesis(b) && digestOf(b.sim().sim) === digestOf(x.w.sim().sim), "PC2 …and lands on the bits a replay from genesis gets (and the running host's)");
  // the engine is still the world's: a throw after the reopen flies and rests on the record
  T += 100; request(b, "rowan", "move", { to: [0, 0, 2.5] }); T += 100; const g = request(b, "rowan", "grab", { id: "cr-0" }); T += 100; const th = g.ok ? request(b, "rowan", "throw", { id: "cr-0", v: [0, 1, 4] }) : null;
  let rested = false; for (let k = 0; k < 600 && !rested; k++) { T += TICK; settle(b); rested = b.entries.some((e, s) => s > (th?.seq ?? 1e9) && e.kind === "change" && b.entries[e.cause]?.verb === "launch"); }
  ok(!!th?.ok && rested && sameAsGenesis(b), "PC2 …and a throw after it flies and rests in the same engine a replay from genesis has", { g: g.refused, th: th?.refused, rested }); }

// ---- PC3 ----
{ const x = world("c"); labels(x, N); T += 100; checkpointNow(x.w); const c0 = cks(x.w);
  ok(c0.length >= 2 && c0.at(-1) === x.w.entries.length - 1, "PC3 (setup) checkpoints after N label writes, the last at the head", c0);
  let said = 0; for (let i = 0; i < 2 * N; i++) { said += x.call("say", { text: `hello ${i}` }, 600).ok ? 1 : 0; x.beat(); }   // under the says rate (20 in 10 s)
  ok(said === 2 * N, "PC3 (setup) 2N says, none refused", said);
  ok(cks(x.w).length === c0.length, "PC3 a tail of says alone (nothing the sim folds) writes no checkpoint", { before: c0.length, after: cks(x.w).length });
  labels(x, 3 * N, "m"); const C = cks(x.w), states = new Set(C.map((s) => x.w.entries[s].body.state));
  ok(C.length >= 3 && states.size === 1 && fs.readdirSync(path.join(x.dir, "blobs")).filter((f) => f.startsWith("sha256-")).length >= 1,
    "PC3 checkpoints of an unchanged engine (labels only) share one blob", { C, states: [...states] });
  ok(new Set(C.map((s) => x.w.entries[s].body.tick)).size === C.length, "PC3 …while each entry carries its own tick", C.map((s) => x.w.entries[s].body.tick));
  x.call("set", { id: "cr-1", component: "transform", value: { pos: [9, 0, 9], q: [0, 0, 0, 1], scale: 1 } }); x.beat(); labels(x, N + 2, "n");
  const D = cks(x.w).filter((s) => s > C.at(-1));
  ok(D.length >= 1 && !states.has(x.w.entries[D[0]].body.state), "PC3 …and a moved crate is a new blob", D.map((s) => x.w.entries[s].body.state)); }

// ---- PC4 ----
{ const x = world("p"); x.call("set", { id: "cr-0", component: "label", value: "secret" }); labels(x, 2 * N + 3);
  const C = cks(x.w); const files = C.map((s) => blobFile(x.dir, x.w.entries[s].body.state));
  ok(C.length >= 2 && files.every((f) => fs.existsSync(f)), "PC4 (setup) checkpoints with their blobs on disk", { C });
  const target = x.w.entries.findIndex((e) => e.kind === "change" && e.verb === "set" && e.body?.value === "secret");
  T += 100; const pseq = x.w.append({ kind: "purge", actor: "system", verb: "purge", body: { values: [{ seq: target }] } });
  ok(files.every((f) => !fs.existsSync(f)), "PC4 the purge deleted every checkpoint's blob", files.filter((f) => fs.existsSync(f)));
  const b = reopen(x.dir);
  ok(b.bootedFrom === null && replayed(b) === b.entries.length && sameAsGenesis(b), "PC4 a boot right after the purge replays the engine from genesis", { from: b.bootedFrom });
  x.beat(); const after = cks(x.w).filter((s) => s > pseq);
  ok(after.length === 1, "PC4 …and the next quiet beat checkpoints after it (the whole log is the tail again)", { after, pseq });
  const b2 = reopen(x.dir);
  ok(b2.bootedFrom === after[0] && sameAsGenesis(b2), "PC4 …which the next boot starts from, on the same bits", { from: b2.bootedFrom }); }

// ---- PC5 ----
{ const x = world("r"); labels(x, N + 1);
  x.call("set", { id: "cr-2", component: "transform", value: { pos: [5, 0, 5], q: [0, 0, 0, 1], scale: 1 } }); x.beat(); labels(x, N + 1, "s");
  T += 100; request(x.w, "rowan", "move", { to: [2, 0, 2.5] }); T += 100; const g = request(x.w, "rowan", "grab", { id: "cr-1" }); T += 100; const th = request(x.w, "rowan", "throw", { id: "cr-1", v: [0, 1, 6] });
  ok(g.ok && th.ok, "PC5 (setup) a throw among the checkpoints", { g: g.refused, th: th.refused });
  for (let k = 0; k < 600; k++) x.beat(); labels(x, N + 1, "t");
  const L = readLog(fs.readFileSync(path.join(x.dir, "world.jsonl"))), C = cks({ entries: L });
  const st = fold(L), sf = simFold(L, x.w.now(), { models: {} });
  ok(C.length >= 3 && st.status === "ok" && !st.diagnostics.some(([q]) => C.includes(q)), "PC5 the strict fold reads every checkpoint without a diagnostic", { C, diags: st.diagnostics.slice(0, 5) });
  ok(sf.checks.disagree.length === 0 && sf.checks.agree > 0 && digestOf(sf.sim) === digestOf(x.w.sim().sim), "PC5 a sim replay from genesis disagrees with nothing and has the host's bits", { dis: sf.checks.disagree.slice(0, 3), agree: sf.checks.agree });
  // every checkpoint is one a boot accepts: cut back to just after it, reopened, the engine starts there
  const bootable = C.map((s) => { const d = path.join(W, `r-cut-${s}`); fs.mkdirSync(d, { recursive: true }); fs.cpSync(path.join(x.dir, "blobs"), path.join(d, "blobs"), { recursive: true });
    fs.writeFileSync(path.join(d, "world.jsonl"), fs.readFileSync(path.join(x.dir, "world.jsonl"), "utf8").split("\n").slice(0, s + 1).join("\n") + "\n");
    const b = reopen(d); return b.bootedFrom === s && sameAsGenesis(b); });
  ok(bootable.every(Boolean), "PC5 every checkpoint is bootable (right after the entry it names, its blob there, its digest the cut's)", bootable);
  const py = process.env.PYTHON ?? "python3"; const has = Bun.spawnSync([py, "-c", "import cryptography"]).exitCode === 0;
  if (!has) console.log("  PC5 skipped the reference reader and chain verifier: python3 with `cryptography` not found");
  else { const log = path.join(x.dir, "world.jsonl");
    const rd = Bun.spawnSync([py, path.join(ENGINE, "spec/conformance/reader.py"), log, "--json"]); const ch = Bun.spawnSync([py, path.join(ENGINE, "spec/conformance/chain.py"), "verify", log]);
    let r = null, c = null; try { r = JSON.parse(rd.stdout.toString()); } catch { /* below */ } try { c = JSON.parse(ch.stdout.toString()); } catch { /* below */ }
    ok(r?.status === "ok" && r.digest === digest(st) && !r.diagnostics.some(([q]) => C.includes(q)), "PC5 the reference reader (reader.py) reads the log to the same digest, no checkpoint diagnosed", { r: JSON.stringify(r).slice(0, 300), err: rd.stderr.toString().slice(0, 300) });
    ok(c?.status === "ok" && c.unsigned_tail === 0, "PC5 the chain verifier (chain.py) verifies every line's signature, checkpoints included", { c, err: ch.stderr.toString().slice(0, 300) }); } }

// ---- PC6 ----
{ const x = world("s", 6, 1000); const c0 = cks(x.w).length; labels(x, 3);
  T += 100; ok(checkpointNow(x.w, { every: 100 }) === 0 && cks(x.w).length === c0, "PC6 a shutdown with a trivial tail (under a tenth of N) writes nothing", { len: x.w.entries.length });
  labels(x, 50); T += 100; const n = checkpointNow(x.w, { every: 100 });
  ok(n === 1 && isCk(x.w.entries.at(-1)), "PC6 a shutdown with a non-trivial tail writes one", { n, len: x.w.entries.length });
  ok(reopen(x.dir).bootedFrom === x.w.entries.length - 1, "PC6 …and the next boot replays nothing into the engine"); }

// ---- PC7 ----
{ const x = world("k", 6, N, { stateCache: { every: 50 } }); labels(x, N + 3); const C = cks(x.w);
  labels(x, 30);   // fewer than the cache's 50 since the checkpoint
  x.w.saveCache(); const cov = JSON.parse(fs.readFileSync(path.join(x.dir, SC.CACHE_FILE), "utf8")).coversIndex; const last = cks(x.w).at(-1);
  ok(C.length >= 1 && cov === last && cov < x.w.entries.length - 1, "PC7 the fold cache covers the last checkpoint while it is under the cache's N behind", { cov, last, len: x.w.entries.length });
  const b = openLive(x.dir, "k", opts({ simCheckpoint: { every: N }, stateCache: { every: 50 } }));
  ok(b.bootedFromCache === last && b.bootedFrom === last && sameAsGenesis(b) && JSON.stringify(SC.encodeState(b.state())) === JSON.stringify(SC.encodeState(fold(b.entries))),
    "PC7 a boot resumes the fold from the cache and starts the engine from the checkpoint on the same line, on the right bits", { fromCache: b.bootedFromCache, from: b.bootedFrom }); }

// ---- PC8 ----
{ const x = world("o", 6, 0); labels(x, 4); T += 25000; x.beat();
  const sf = x.w.sim(); const cut = simCutOf(sf, x.w.entries); const state = x.w.putBlob({ cutJson: JSON.stringify(cut) });   // the shape before 10-28: time inside
  const s = x.w.append({ kind: "sim", actor: "sim", verb: "checkpoint", body: { at: x.w.entries.length - 1, engine: { engine: sf.spec.engine }, tick: sf.sim.tick, clock: sf.clock, sim: digestOf(sf.sim), state } });
  labels(x, 3); const b = reopen(x.dir);
  ok(b.bootedFrom === s && sameAsGenesis(b), "PC8 a checkpoint whose blob holds its own clock and tick (written before 10-28) still boots", { from: b.bootedFrom, s }); }

// ---- PC9: log-size cost on a busy world, and boot before/after on a generated large log ----
{ const x = world("busy", 40, 1000); const n0 = x.w.entries.length; const K = Number(process.env.PC_BUSY ?? 3000);
  for (let i = 0; i < K; i++) { const id = `cr-${i % 40}`; const p = x.w.state().entities[id].c.transform.pos;
    const r = x.call("set", { id, component: "transform", value: { pos: [p[0] + ((i % 5) - 2) * 0.01, p[1], p[2]], q: [0, 0, 0, 1], scale: 1 } }, 400); if (!r.ok) { ok(false, "PC9 (setup) a busy write refused", r.refused); break; } if (i % 4 === 0) x.beat(); }
  x.beat(); const C = cks(x.w).filter((s) => s >= n0); const lines = fs.readFileSync(path.join(x.dir, "world.jsonl"), "utf8").split("\n");
  const logB = lines.reduce((a, l) => a + l.length + 1, 0), ckB = C.reduce((a, s) => a + lines[s].length + 1, 0);
  const blobs = new Set(C.map((s) => x.w.entries[s].body.state)), blobB = [...blobs].reduce((a, h) => a + fs.statSync(blobFile(x.dir, h)).size, 0);
  console.log(`  PC9 busy world: ${K} transform writes (40 crates), ${x.w.entries.length - n0} entries, ${C.length} checkpoints; log ${(logB / 1e6).toFixed(2)} MB of which checkpoint lines ${(ckB / 1e3).toFixed(1)} KB (${(100 * ckB / logB).toFixed(2)}%); ${blobs.size} blobs ${(blobB / 1e3).toFixed(0)} KB (${(100 * blobB / logB).toFixed(1)}% of the log)`);
  ok(C.length >= Math.floor((x.w.entries.length - n0) / 1000) - 1 && C.length <= Math.ceil((x.w.entries.length - n0) / 1000) + 1, "PC9 one checkpoint per N (1000) entries on a busy world", { C: C.length, entries: x.w.entries.length - n0 }); }
{ const K = Number(process.env.PC_ENTRIES ?? 20000), FROM = process.env.PC_FROM;
  const dir = path.join(W, "big"); fs.mkdirSync(path.join(dir, "blobs"), { recursive: true });
  let E;
  if (FROM) { for (const f of fs.readdirSync(path.join(FROM, "blobs"))) fs.copyFileSync(path.join(FROM, "blobs", f), path.join(dir, "blobs", f)); E = readLog(fs.readFileSync(path.join(FROM, "world.jsonl"))).map((e) => JSON.parse(JSON.stringify(e))); }
  else { const x = world("big-src", 40, 0); E = x.w.entries.map((e) => JSON.parse(JSON.stringify(e))); for (const f of fs.existsSync(path.join(x.dir, "blobs")) ? fs.readdirSync(path.join(x.dir, "blobs")) : []) fs.copyFileSync(path.join(x.dir, "blobs", f), path.join(dir, "blobs", f)); }
  // re-founded under this run's custody key (the source's key isn't ours), then K transform sets on its bodies, signed
  const cu = custodyAt(path.join(W, ".custody.json")); E[0].body.sequencer = cu.sequencer(); const wid = worldIdOf(E[0]); for (let i = 1; i < E.length; i++) E[i].world = wid;
  const st0 = fold(E); const ids = Object.keys(st0.entities).filter((id) => st0.entities[id].c.physics && st0.entities[id].c.transform);
  const actor = E[1].actor, cause = E.findLastIndex((e) => e.kind === "act"); let ts = E.at(-1).ts;
  for (let i = 0; i < K; i++) { const id = ids[i % ids.length], tf = st0.entities[id].c.transform;
    E.push({ world: wid, kind: "change", actor, cause, verb: "set", body: { id, comp: "transform", value: { ...tf, pos: tf.pos.map((v, j) => (j === 1 ? v : v + ((i % 7) - 3) * 1e-3)) } }, ts: ++ts }); }
  fs.writeFileSync(path.join(dir, "world.jsonl"), seal(E, { sign: (m) => cu.sign(m) }).map((e) => JSON.stringify(e)).join("\n") + "\n");
  T = Math.max(T, ts + 1000);
  const boot = () => { const a = performance.now(); const b = reopen(dir, { stateCache: { every: 1000 }, simCheckpoint: { every: 1000 } }); return [performance.now() - a, b]; };
  const best = () => { let m = Infinity, w; for (let i = 0; i < 2; i++) { const [t, b] = boot(); if (t < m) m = t; w = b; } return [m, w]; };
  boot()[1].saveCache();   // the fold cache on, as the server runs: what's measured is the engine's replay
  const [beforeMs, b0] = best(); const before = replayed(b0);
  T += 100; settle(b0);   // the first quiet beat writes the checkpoint the tail bound asks for
  const [afterMs, b1] = best(); const after = replayed(b1);
  console.log(`  PC9 ${E.length} entries (${(fs.statSync(path.join(dir, "world.jsonl")).size / 1e6).toFixed(1)} MB${FROM ? `, from ${path.basename(FROM)}` : ""}): boot ${beforeMs.toFixed(0)} ms replaying ${before} entries into the engine before; ${afterMs.toFixed(0)} ms replaying ${after} after`);
  ok(before >= K && after <= 1000 && afterMs < beforeMs && sameAsGenesis(b1), "PC9 after the first beat the boot replays at most N, faster, on the same bits", { before, after, beforeMs, afterMs }); }

console.log(`\n${fail ? `FAIL ${fail}` : "ok"}: ${pass} passed${fail ? `, ${fail} failed` : ""}`);
process.exit(fail ? 1 : 0);
