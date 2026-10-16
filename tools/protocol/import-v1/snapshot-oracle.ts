// tools/protocol/import-v1/snapshot-oracle.ts — the old-world translator checked against the OLD ENGINE, without rendering.
//
// The translator's own checks (translate-v1's per-entry projection equality, the sweep's inverse) prove it agrees with
// ITSELF: its copy of the old fold (./fold.js), its projection, its v4 fold. This proves it agrees with the old server.
// Every first-protocol world directory holds, beside its log.jsonl, a snapshot.json = the old server's own folded state
// ({v: 1, seq, bytes, ts, state: {entities, terrain, grass, sky, assets, roles, bans, …}}). When snapshot.seq is the log's
// last seq AND snapshot.bytes is log.jsonl's size, the snapshot is the old engine's answer to "what does this whole log
// mean". A snapshot that isn't complete is SKIPPED (with its reason), never compared.
//
// Per world:
//   1. translate log.jsonl with the real path (translateV1World, as `world.ts translate --no-founder-key`) into a scratch
//      worlds dir (its own custody, directory and model index; the source directory is only read);
//   A. the translated world.jsonl, read by the strict reader and folded by the real fold (shared/protocol/fold.js), against
//      the snapshot put through the translator's own mapping table (translate-v1 `project`: lib→model, comp→flat
//      components, yaw→q, light fields, door→openable, guard→lock, motion rpm, sockets' v4 spelling, imported:<k>, the
//      namespace), with the translated world's identities (read back from its directory: a name → the id it was given)
//      and content addresses (computed here from the same host files) in place of names and paths;
//   B. the SERVER's view: the same world opened as the server opens it (server/livehost.ts openLive with the engine's
//      catalogue), then lifted as server/worldlog.ts lifts it at first load (authority.js liftWorld: a stored `sockets`
//      map becomes socket child entities, a mounted thing's parent names the child, its pose is re-expressed in the
//      child's frame), against side A's old projection put through the SAME lift (sockets.js legacyHosts/liftHostOps),
//      plus an independent check that every old seat is a child entity with that name at that pose.
//   Ids: the translator keeps every entity id (enc() only escapes what the §2.3 grammar refuses), so ids are matched
//   through enc(); people's names (roles, bans, authors) are matched through the translated world's directory.
//   Numbers compare with a 1e-9 tolerance; everything else exactly. What the comparison leaves out is only the
//   translator's own DROPPED table (printed by name with its reason), and nothing else.
//
// usage: bun tools/protocol/import-v1/snapshot-oracle.ts [<world dir> …]
//   no args: ORACLE_WORLDS=<dir>[:<dir>…] (a world dir, or a dir of worlds), else PROTOCOL_WORLDS, else the checkout's parent
//   (walked like the sweep), each distinct complete snapshot once. Exit 0 only when every compared world has 0 differences.
//   OPT_DIR=<serving checkout>/assets/opt so store models get the content address they get on this host (read only).
//   ORACLE_SCRATCH=<dir> where the scratch worlds go (default $PROTOCOL_SCRATCH or the OS temp dir); ORACLE_KEEP=1 keeps it.
// @ts-nocheck
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

const ENGINE = path.resolve(import.meta.dir, "../../..");
// the server modules read WORLDS_DIR and OPT_DIR at import: a scratch for both before any of them loads. OPT_DIR holds
// the model index the translator writes (eido-index.json); the store's blobs are read through a link to the real store
// (read only), so a store model gets the same content address it gets on this host
const SCRATCH = fs.mkdtempSync(path.join(process.env.ORACLE_SCRATCH ?? process.env.PROTOCOL_SCRATCH ?? os.tmpdir(), "oracle-"));
if (!process.env.ORACLE_KEEP) process.on("exit", () => fs.rmSync(SCRATCH, { recursive: true, force: true }));
const realOpt = path.resolve(process.env.OPT_DIR ?? path.join(ENGINE, "assets", "opt"));
const opt = path.join(SCRATCH, "opt"); fs.mkdirSync(opt, { recursive: true });
// (this host's uploads live in the serving checkout's OPT_DIR: point OPT_DIR there; with no store here, a store model is
// compared as its path on both sides, and the header says so)
const realStore = path.join(realOpt, "store");
const STORE = fs.existsSync(realStore) ? realStore : null;
if (STORE) fs.symlinkSync(STORE, path.join(opt, "store"));
process.env.OPT_DIR = opt;
process.env.WORLDS_DIR = path.join(SCRATCH, "worlds");

const { project, DROPPED, namespaceOf, hasEpoch, canon } = await import("./translate-v1.js");
const { enc } = await import("../../../shared/protocol/names.js");
const { readLog, fold, emptyState, applyInPlace } = await import("../../../shared/protocol/fold.js");
const { translateV1World } = await import("./world.ts");
const { contentAddressOf } = await import("../../../server/eidoindex.ts");
const { openLive } = await import("../../../server/livehost.ts");
const { ENGINE_CATALOGUE } = await import("../../../server/modelcatalogue.ts");
const { liftWorld } = await import("../../../shared/protocol/authority.js");
const { legacyHosts, liftHostOps, isSocketC } = await import("../../../shared/protocol/authority/sockets.js");
const { socketQ } = await import("../../../shared/components.js");
const { directoryFileIn } = await import("../../../server/keyfiles.ts");

const TOL = 1e-9;
const SHOW = Number(process.env.ORACLE_SHOW ?? 8);
const jclone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const fmt = (v) => { const s = JSON.stringify(v); return s === undefined ? "(absent)" : s.length > 160 ? s.slice(0, 157) + "…" : s; };

// ---------- which worlds ----------
function lastSeqOf(file) {
  // the log's last parseable line, read from the end (a 79k-entry log is 11 MB; nothing needs all of it)
  const fd = fs.openSync(file, "r"); const size = fs.fstatSync(fd).size; let tail = ""; let at = size; const CH = 1 << 16;
  try { while (at > 0) { const n = Math.min(CH, at); at -= n; const b = Buffer.alloc(n); fs.readSync(fd, b, 0, n, at); tail = b.toString("utf8") + tail;
      const lines = tail.split("\n").filter((l) => l.trim());
      for (let i = lines.length - 1; i >= (at > 0 ? 1 : 0); i--) { try { const e = JSON.parse(lines[i]); return { seq: e?.seq, size }; } catch { /* a torn line */ } } } }
  finally { fs.closeSync(fd); }
  return { seq: undefined, size };
}
/** {ok: true, snap} when the snapshot is the old engine's fold of the WHOLE log, else {ok: false, why}. */
export function completeSnapshot(dir) {
  const log = path.join(dir, "log.jsonl"), sf = path.join(dir, "snapshot.json");
  if (!fs.existsSync(log)) return { ok: false, why: "no log.jsonl" };
  if (!fs.existsSync(sf)) return { ok: false, why: "no snapshot.json" };
  let snap; try { snap = JSON.parse(fs.readFileSync(sf, "utf8")); } catch (x) { return { ok: false, why: `snapshot.json doesn't parse (${x.message})` }; }
  if (snap?.v !== 1 || !snap.state || typeof snap.state !== "object") return { ok: false, why: `snapshot.json isn't a v:1 snapshot with a state (v ${fmt(snap?.v)})` };
  const { seq, size } = lastSeqOf(log);
  if (snap.seq !== seq) return { ok: false, why: `snapshot.seq ${snap.seq} ≠ the log's last seq ${seq}: a fold of part of the log` };
  if (snap.bytes !== size) return { ok: false, why: `snapshot.bytes ${snap.bytes} ≠ log.jsonl's ${size} bytes` };
  return { ok: true, snap };
}
function findWorlds(roots) {
  const dirs = [];
  const walk = (d, depth) => { if (depth > 5) return; let ents = []; try { ents = fs.readdirSync(d); } catch { return; }
    if (ents.includes("log.jsonl")) { dirs.push(d); return; }
    for (const n of ents) { if (n === "node_modules" || n === ".git" || n.startsWith("oracle-")) continue; const p = path.join(d, n);
      try { if (fs.statSync(p).isDirectory()) walk(p, depth + 1); } catch { /* gone */ } } };
  for (const r of roots) walk(path.resolve(r), 0);
  return dirs;
}

// ---------- the comparison ----------
/** Deep difference of two JSON values: [{path, old, new}] (numbers within TOL are equal). */
function deepDiff(a, b, at = "", out = []) {
  if (typeof a === "number" && typeof b === "number") { if (!(a === b || Math.abs(a - b) <= TOL)) out.push({ path: at, old: a, new: b }); return out; }
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) { out.push({ path: at, old: a, new: b }); return out; }
    a.forEach((x, i) => deepDiff(x, b[i], `${at}[${i}]`, out)); return out; }
  if (a && b && typeof a === "object" && typeof b === "object" && !Array.isArray(a) && !Array.isArray(b)) {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
      if (!(k in b)) out.push({ path: `${at}.${k}`, old: a[k], new: undefined });
      else if (!(k in a)) out.push({ path: `${at}.${k}`, old: undefined, new: b[k] });
      else deepDiff(a[k], b[k], `${at}.${k}`, out); }
    return out; }
  if (canon(a) !== canon(b)) out.push({ path: at, old: a, new: b });
  return out;
}
/** Two {id: {component: value}} maps: entity sets and every component. */
function compareWorlds(oldP, newP) {
  const oldIds = Object.keys(oldP), newIds = new Set(Object.keys(newP));
  const missing = oldIds.filter((k) => !newIds.has(k)), extra = [...newIds].filter((k) => !(k in oldP));
  const diffs = [];
  for (const id of oldIds) if (newIds.has(id)) for (const d of deepDiff(oldP[id], newP[id])) diffs.push({ id, field: d.path.slice(1), old: d.old, new: d.new });
  const ents = (ids) => [...ids].filter((k) => k !== "@world").length;   // things; @world is compared too, as one more record
  return { old: ents(oldIds), new: ents(newIds), matched: ents(oldIds.filter((k) => newIds.has(k))), missing, extra, diffs };
}

// a v4 state's components, as plain JSON (the fold's records are null-prototype objects; a purged value is a marker)
const v4comps = (st) => Object.fromEntries(Object.entries(st.entities).map(([id, e]) => [id, jclone(e.c)]));

/** The translated world's people, read back from its directory: (name, {sub}) → the id it was given there. */
function whoFrom(worldsDir) {
  const f = directoryFileIn(worldsDir);
  const ids = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")).ids ?? {} : {};
  const bySub = new Map(), byName = new Map();
  for (const [id, e] of Object.entries(ids)) { for (const s of e.subs ?? []) bySub.set(s, id); const a = byName.get(e.name) ?? []; a.push(id); byName.set(e.name, a); }
  const unresolved = [];
  const who = (name, { sub } = {}) => {
    const acct = sub ?? (/^(human|agent|aid1):/.test(name) ? name : undefined);
    if (acct && bySub.has(acct)) return bySub.get(acct);
    const a = byName.get(name) ?? [];
    if (a.length === 1) return a[0];
    unresolved.push({ name, sub, candidates: a.length }); return `?unresolved:${name}`; };
  return { who, unresolved, people: Object.keys(ids).length };
}

/** The old projection put through the server's load-time lift: the same functions liftWorld calls (legacyHosts, then
 *  liftHostOps per host, in its order), applied by the real fold's applyInPlace. */
function liftPlain(P, ever) {
  const st = emptyState(); delete st.entities["@world"];
  for (const [id, c] of Object.entries(P)) st.entities[id] = { born: 0, c: Object.assign(Object.create(null), jclone(c)) };
  const hosts = legacyHosts(st, ever);
  for (const h of hosts) { if (!st.entities[h]) continue; const { ops } = liftHostOps(st, ever, h); applyInPlace(st, ops, 1); }
  return { lifted: v4comps(st), hosts };
}

/** C, independent of the translator's projection (so a bug in `project` itself, which side A shares, still shows): the
 *  fields the old engine's snapshot states plainly, read straight off it — every thing's id, its model (the content
 *  address of its lib on this host, else the lib), its pose (pos; q, else a yaw turn; scale, uniform) when it rides
 *  nothing, and what it rides (parent.to, and the slot as parent.socket); the world's terrain and grass as they are (with
 *  any key v4's component doesn't define read from imported:<k> beside it, the translator's documented carry). */
function coreCheck(snapState, newA, content) {
  const diffs = []; const push = (id, field, o, n) => diffs.push({ id, field, old: o, new: n });
  const yq = (y) => [0, Math.sin(y / 2), 0, Math.cos(y / 2)];
  for (const [id0, e] of Object.entries(snapState.entities ?? {})) {
    const id = enc(id0), c = newA[id];
    if (!c) { push(id, "(the thing)", "present", undefined); continue; }
    if (e.lib !== undefined) { const want = (typeof e.lib === "string" && content(e.lib)) || e.lib; if (c.model !== want) push(id, "model", want, c.model); }
    else if (c.model !== undefined) push(id, "model", undefined, c.model);
    if (!e.parent) {
      const want = { pos: e.pos ?? [0, 0, 0], q: Array.isArray(e.q) ? e.q : yq(e.yaw ?? 0), scale: typeof e.scale === "number" ? [e.scale, e.scale, e.scale] : (e.scale ?? [1, 1, 1]) };
      for (const d of deepDiff(want, { pos: c.transform?.pos, q: c.transform?.q, scale: c.transform?.scale })) push(id, `transform${d.path}`, d.old, d.new);
    } else if (typeof e.parent.to === "string") {
      if (c.parent?.to !== enc(e.parent.to)) push(id, "parent.to", enc(e.parent.to), c.parent?.to);
      if ((e.parent.slot ?? undefined) !== (c.parent?.socket ?? undefined)) push(id, "parent.socket (v1 slot)", e.parent.slot, c.parent?.socket);
    }
  }
  // a key the v4 component doesn't define rides beside it in imported:<k> (translate-v1 splitUnknown, R10: carried, never
  // dropped): the world's ground is the two together (under-the-eves' terrain `amp`, a key no terrain reader ever read)
  const W = newA["@world"] ?? {};
  for (const k of ["terrain", "grass"]) { const n = W[k] == null && W[`imported:${k}`] == null ? null : { ...(W[k] ?? {}), ...(W[`imported:${k}`] ?? {}) };
    for (const d of deepDiff(snapState[k] ?? null, n)) push("@world", `${k}${d.path}`, d.old, d.new); }
  return diffs;
}

export function oracleWorld(dir) {
  const name = path.basename(dir);
  const c = completeSnapshot(dir);
  if (!c.ok) return { name, dir, skipped: c.why };
  const t0 = performance.now();
  const old = fs.readFileSync(path.join(dir, "log.jsonl"), "utf8").split("\n").filter((l) => l.trim()).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
  if (hasEpoch(old)) return { name, dir, skipped: "a physics-era log (dialect 3): v4 holds her sim's rests, which the old snapshot (the instant fold) never had; this oracle has no independent reading of them" };
  // 1. the real translation, into its own scratch worlds dir
  const worldsDir = path.join(SCRATCH, name.replace(/[^A-Za-z0-9_-]/g, "_") + "-" + crypto.randomBytes(3).toString("hex"), "worlds");
  fs.mkdirSync(worldsDir, { recursive: true });
  const dest = path.join(worldsDir, name);
  const r = translateV1World(dir, dest);
  const tTranslate = performance.now();
  // A. the strict reader and the real fold over what was written
  const text = fs.readFileSync(path.join(dest, "world.jsonl"));
  const st = fold(readLog(text));
  if (st.status !== "ok") return { name, dir, error: `the translated world folds to ${st.status}` };
  const newA = v4comps(st);
  // the snapshot through the translator's own mapping, with the translated world's people and model addresses
  const { who, unresolved, people } = whoFrom(worldsDir);
  const content = (p) => { const h = contentAddressOf(p); return h ? `eido:sha256/${h}` : null; };
  const snapState = jclone(c.snap.state);
  const oldA = project(snapState, null, who, namespaceOf(name), content);
  const A = compareWorlds(oldA, newA);
  const C = coreCheck(snapState, newA, content);
  const tA = performance.now();
  // B. the server's view: opened as the server opens it, lifted as it lifts at first load
  const live = openLive(dest, name, { catalogue: ENGINE_CATALOGUE, scripts: null });
  const ever = new Set(live.everIds());
  const lifted = liftWorld(live);
  const failedLift = lifted.filter((x) => x.failed || x.skipped);
  const newB = v4comps(live.state());
  const { lifted: oldB, hosts } = liftPlain(oldA, ever);
  const B = compareWorlds(oldB, newB);
  // B', independent of the lift's code: every seat the OLD snapshot has is a socket child of its host, by name, at its pose
  const seatDiffs = [];
  let seats = 0;
  for (const [id, e] of Object.entries(snapState.entities ?? {})) {
    const S = e?.comp?.sockets; if (!S || typeof S !== "object" || Array.isArray(S)) continue;
    const host = enc(id);
    if (newB[host]?.sockets !== undefined) seatDiffs.push({ id: host, field: "sockets", old: "lifted to socket children", new: newB[host].sockets });
    for (const [slot, s] of Object.entries(S)) { if (!s || typeof s !== "object") continue; seats++;
      const kids = Object.entries(newB).filter(([, k]) => k.parent?.to === host && isSocketC(k) && k.socket.name === slot);
      if (kids.length !== 1) { seatDiffs.push({ id: host, field: `seat '${slot}'`, old: s, new: `${kids.length} socket children named so` }); continue; }
      const t = kids[0][1].transform; const want = { pos: Array.isArray(s.pos) ? s.pos : [0, 0, 0], q: socketQ({ ...s, ...(Number.isFinite(s.yaw) && s.yaw !== 0 ? { q: [0, Math.sin(s.yaw / 2), 0, Math.cos(s.yaw / 2)] } : {}) }) };
      for (const d of deepDiff(want, { pos: t?.pos, q: t?.q })) seatDiffs.push({ id: kids[0][0], field: `seat '${slot}' transform${d.path}`, old: d.old, new: d.new }); } }
  const tB = performance.now();
  return { name, dir, entries: old.length, out: r.entries, people, unresolved, lift: { hosts: hosts.length, failed: failedLift, seats, seatDiffs },
    A, B, C, ms: { translate: tTranslate - t0, compareA: tA - tTranslate, serverB: tB - tA, total: tB - t0 } };
}

// ---------- the report ----------
const unexplained = (w) => (w.skipped ? 0 : w.error ? 1 : w.A.missing.length + w.A.extra.length + w.A.diffs.length + w.B.missing.length + w.B.extra.length + w.B.diffs.length
  + w.lift.seatDiffs.length + w.C.length + w.lift.failed.length + w.unresolved.length);
function printWorld(w) {
  if (w.skipped) { if (w.skipped !== "no snapshot.json") console.log(`\n-- ${w.name} (${w.dir}): SKIPPED (${w.skipped})`); return; }
  if (w.error) { console.log(`\n-- ${w.name}: FAIL ${w.error}`); return; }
  const n = unexplained(w);
  console.log(`\n-- ${w.name} (${w.dir}): ${w.entries} old entries → ${w.out} entries; ${(w.ms.total / 1000).toFixed(1)} s (translate ${(w.ms.translate / 1000).toFixed(1)}, compare ${(w.ms.compareA / 1000).toFixed(2)}, server load+lift ${(w.ms.serverB / 1000).toFixed(2)}) — ${n ? `FAIL ${n} unexplained` : "ok"}`);
  for (const [tag, X] of [["A translated log vs snapshot", w.A], ["B server view (lifted) vs snapshot (lifted)", w.B]]) {
    console.log(`   ${tag}: entities old ${X.old} / new ${X.new}, matched ${X.matched} (and @world), missing ${X.missing.length}, extra ${X.extra.length}, field diffs ${X.diffs.length}`);
    if (X.missing.length) console.log(`     missing (old has, new doesn't): ${X.missing.slice(0, SHOW).join(", ")}${X.missing.length > SHOW ? " …" : ""}`);
    if (X.extra.length) console.log(`     extra (new has, old doesn't): ${X.extra.slice(0, SHOW).join(", ")}${X.extra.length > SHOW ? " …" : ""}`);
    for (const d of X.diffs.slice(0, SHOW)) console.log(`     DIFF ${d.id} ${d.field}: old ${fmt(d.old)}  new ${fmt(d.new)}`);
    if (X.diffs.length > SHOW) console.log(`     … ${X.diffs.length - SHOW} more`);
  }
  console.log(`   C core fields read straight off the snapshot (model, pose, parent, terrain, grass; not through the projection): ${w.C.length ? `${w.C.length} DIFF` : "all agree"}`);
  for (const d of w.C.slice(0, SHOW)) console.log(`     DIFF ${d.id} ${d.field}: old ${fmt(d.old)}  new ${fmt(d.new)}`);
  console.log(`   lift: ${w.lift.hosts} socket host(s), ${w.lift.seats} old seat(s), each a socket child at its pose: ${w.lift.seatDiffs.length ? `${w.lift.seatDiffs.length} DIFF` : "yes"}${w.lift.failed.length ? `; lift refused/skipped: ${fmt(w.lift.failed)}` : ""}`);
  for (const d of w.lift.seatDiffs.slice(0, SHOW)) console.log(`     DIFF ${d.id} ${d.field}: old ${fmt(d.old)}  new ${fmt(d.new)}`);
  console.log(`   people: ${w.people} identities in the translated world's directory${w.unresolved.length ? `; UNRESOLVED names: ${fmt(w.unresolved.slice(0, SHOW))}` : ", every old name/account found"}`);
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const dirs = args.length ? args.map((a) => path.resolve(a)) : findWorlds((process.env.ORACLE_WORLDS ?? process.env.PROTOCOL_WORLDS ?? path.resolve(ENGINE, "..")).split(":"));
  console.log(`snapshot oracle: the translator against the OLD ENGINE's own folded state (snapshot.json), ${dirs.length} world dir(s)`);
  console.log(`not compared (translate-v1 DROPPED, the translator's documented table; nothing else is left out):`);
  for (const [k, why] of Object.entries(DROPPED)) console.log(`   - ${k}: ${why}`);
  console.log(`model addresses: library ${process.env.EIDOVERSE_DIR ?? path.resolve(ENGINE, "..", "eidoverse-video")}; store ${STORE ?? "NONE (set OPT_DIR to the serving checkout's assets/opt): store models compare as paths on both sides"}`);
  console.log(`   (comp.guard, comp.door, motion.rpm and a mounted thing's own pose are not left out: they ARE compared, through the mapping above)`);
  const seen = new Map(); const results = [];
  for (const d of dirs) {
    // the same log under several names (a copy, a worktree's) is one world: compared once
    const c = completeSnapshot(d);
    if (c.ok && !args.length) { const k = `${c.snap.seq}:${c.snap.bytes}:${crypto.createHash("sha256").update(fs.readFileSync(path.join(d, "snapshot.json"))).digest("hex")}`;
      if (seen.has(k)) { results.push({ name: path.basename(d), dir: d, skipped: `the same log and snapshot as ${seen.get(k)}` }); continue; } seen.set(k, d); }
    let w; try { w = oracleWorld(d); } catch (x) { w = { name: path.basename(d), dir: d, error: `threw: ${x?.stack ?? x}` }; }
    results.push(w); printWorld(w);
  }
  const compared = results.filter((w) => !w.skipped), bad = compared.filter((w) => unexplained(w));
  console.log(`\nworld                 entries   ents old/new   matched  missing  extra  diffs(A/B/C/seats)   time`);
  for (const w of compared) { if (w.error) { console.log(`${w.name.padEnd(20)}  ERROR`); continue; }
    console.log(`${w.name.padEnd(20)} ${String(w.entries).padStart(8)}   ${String(w.A.old).padStart(5)}/${String(w.A.new).padEnd(5)}   ${String(w.A.matched).padStart(7)}  ${String(w.A.missing.length + w.B.missing.length).padStart(7)}  ${String(w.A.extra.length + w.B.extra.length).padStart(5)}  ${`${w.A.diffs.length}/${w.B.diffs.length}/${w.C.length}/${w.lift.seatDiffs.length}`.padStart(18)}   ${(w.ms.total / 1000).toFixed(1)} s`); }
  const skipped = results.filter((w) => w.skipped), bare = skipped.filter((w) => w.skipped === "no snapshot.json"), other = skipped.filter((w) => w.skipped !== "no snapshot.json");
  if (skipped.length) console.log(`skipped ${skipped.length}: ${bare.length} log(s) with no snapshot.json (fixtures, scratch copies)${other.length ? `; ${other.map((w) => `${w.name} (${w.skipped.slice(0, 70)})`).join("; ")}` : ""}`);
  for (const w of bad) { const d = w.error ? null : [...w.A.diffs, ...w.B.diffs, ...w.C, ...w.lift.seatDiffs][0];
    console.log(`  FAIL ${w.name}: ${w.error ? w.error.split("\n")[0] : d ? `${d.id} ${d.field}: old ${fmt(d.old)} new ${fmt(d.new)}` : `missing ${fmt(w.A.missing.concat(w.B.missing).slice(0, 3))} extra ${fmt(w.A.extra.concat(w.B.extra).slice(0, 3))} unresolved ${fmt(w.unresolved.slice(0, 2))}`}`); }
  console.log(`oracle: ${compared.length - bad.length}/${compared.length} compared world(s) agree with the old engine${bad.length ? `; DIFFER: ${bad.map((w) => w.name).join(", ")}` : ""}`);
  process.exit(bad.length || !compared.length ? 1 : 0);
}
