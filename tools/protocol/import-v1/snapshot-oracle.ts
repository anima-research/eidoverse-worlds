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
//      and model hashes (computed here from the same host files) beside the paths;
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
//   a world dir translated in place is read through its kept originals (log.original.jsonl, snapshot.original.json)
//   no args: ORACLE_WORLDS=<dir>[:<dir>…] (a world dir, or a dir of worlds), else PROTOCOL_WORLDS; always the repo's spec/fixtures (folded.json as each snapshot)
//   (walked like the sweep), each distinct complete snapshot once. Exit 0 only when every compared world has 0 differences.
//   OPT_DIR=<serving checkout>/assets/opt so store models get the model-hash they get on this host (read only).
//   ORACLE_SCRATCH=<dir> where the scratch worlds go (default $PROTOCOL_SCRATCH or the OS temp dir); ORACLE_KEEP=1 keeps it.
// @ts-nocheck
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

const ENGINE = path.resolve(import.meta.dir, "../../..");
// the server modules read WORLDS_DIR and OPT_DIR at import: a scratch for both before any of them loads. OPT_DIR holds
// the model index the translator writes (eido-index.json); the store's blobs are read through a link to the real store
// (read only), so a store model gets the same model-hash it gets on this host
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
const { opsOf: _opsOf } = await import("../../../shared/protocol/fold.js");
const opsQuiet = (e: any) => { try { return _opsOf(e); } catch { return []; } };
const { legacyHosts, liftHostOps, isSocketC } = await import("../../../shared/protocol/authority/sockets.js");
const { socketQ } = await import("../../../shared/components.js");
const { shapeRepairOps, shapesMarked } = await import("../../../shared/protocol/shaperepair.js");
const FA = await import("../../../shared/flora_args.js");   // the grass reader's own mapping, for C
const { directoryFileIn } = await import("../../../server/keyfiles.ts");
const { HN_ISS } = await import("../../../server/auth.ts");

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
/** The conformance fixtures as old worlds in the scratch: log.jsonl, and snapshot.json whose state is folded.json (the
 *  reference implementation's fold of the whole log: its last seq, the log's byte size), so completeSnapshot takes it. */
function fixtureWorlds() {
  const src = path.join(ENGINE, "spec/fixtures"), out = [];
  for (const n of fs.readdirSync(src).sort()) {
    const d = path.join(src, n); if (!fs.existsSync(path.join(d, "log.jsonl")) || !fs.existsSync(path.join(d, "folded.json"))) continue;
    const w = path.join(SCRATCH, "fixture-worlds", n); fs.mkdirSync(w, { recursive: true });
    const text = fs.readFileSync(path.join(d, "log.jsonl"), "utf8"); fs.writeFileSync(path.join(w, "log.jsonl"), text);
    const last = JSON.parse(text.trim().split("\n").at(-1));
    fs.writeFileSync(path.join(w, "snapshot.json"), JSON.stringify({ v: 1, seq: last.seq, bytes: Buffer.byteLength(text), ts: last.ts, state: JSON.parse(fs.readFileSync(path.join(d, "folded.json"), "utf8")) }));
    out.push(w);
  }
  if (!out.length) throw new Error(`no conformance fixtures under ${src}`);
  return out;
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
  const ents = (ids) => [...ids].filter((k) => k !== "@world").length;   // entities, not counting @world (which is compared too, as one more record)
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
  const who = (name, { sub, lowered = false } = {}) => {
    const acct = sub ?? (/^(human|agent|aid1):/.test(name) ? name : undefined);   // a name that is an account (local: is one only as a sub)
    if (acct && bySub.has(acct)) return bySub.get(acct);
    if (acct && bySub.has(`aid1:${HN_ISS}:${acct}`)) return bySub.get(`aid1:${HN_ISS}:${acct}`);   // a v1 agent's home-node sub, as the importer files it
    // exact, as v1 kept names; a lowered ban key is the one name that lowercases to it, as the importer reads it
    const a = byName.get(name) ?? (lowered ? [...byName].filter(([n]) => n.toLowerCase() === name).flatMap(([, ids]) => ids) : []);
    if (a.length === 1) return a[0];
    unresolved.push({ name, sub, candidates: a.length }); return `?unresolved:${name}`; };
  return { who, unresolved, people: Object.keys(ids).length };
}

/** The old projection put through the server's load-time lift: the same functions liftWorld calls (legacyHosts, then
 *  liftHostOps per host, in its order), applied by the real fold's applyInPlace. */
function liftPlain(P, ever, repair = true) {
  const st = emptyState(); delete st.entities["@world"];
  for (const [id, c] of Object.entries(P)) st.entities[id] = { born: 0, c: Object.assign(Object.create(null), jclone(c)) };
  const hosts = legacyHosts(st, ever);
  for (const h of hosts) { if (!st.entities[h]) continue; const { ops } = liftHostOps(st, ever, h); applyInPlace(st, ops, 1); }
  // …then the shape repair (shape audit 10-16), as liftWorld does: once per world, so not on a log that is already marked
  // (a translate-v1@12 log is: its projection is the repaired one; review r7 F2)
  if (repair) { const ops = shapeRepairOps(st); if (ops.length) applyInPlace(st, ops, 1); }
  return { lifted: v4comps(st), hosts };
}

/** C, independent of the translator's projection (so a bug in `project` itself, which side A shares, still shows): the
 *  fields the old engine's snapshot states plainly, read straight off it — every thing's id, its model (its lib as written)
 *  and model-hash (the sha256 of that lib's bytes on this host, else none), its pose (pos; q, else a yaw turn; scale, uniform) when it rides
 *  nothing, and what it rides (parent.to, and the slot as parent.socket); the world's terrain and grass as they are (with
 *  any key v4's component doesn't define read from imported:<k> beside it, the translator's documented carry). */
function coreCheck(snapState, newA, content) {
  const diffs = []; const push = (id, field, o, n) => diffs.push({ id, field, old: o, new: n });
  const yq = (y) => [0, Math.sin(y / 2), 0, Math.cos(y / 2)];
  for (const [id0, e] of Object.entries(snapState.entities ?? {})) {
    const id = enc(id0), c = newA[id];
    if (!c) { push(id, "(the entity)", "present", undefined); continue; }
    // R 10-17: the model is v1's path as written; its bytes' hash beside it where this host has them
    if (e.lib !== undefined) { if (c.model !== e.lib) push(id, "model", e.lib, c.model);
      const h = typeof e.lib === "string" ? content(e.lib) ?? undefined : undefined; if (c["model-hash"] !== h) push(id, "model-hash", h, c["model-hash"]); }
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
  for (const k of ["terrain", "grass", "water"]) { const n = W[k] == null && W[`imported:${k}`] == null ? null : { ...(W[k] ?? {}), ...(W[`imported:${k}`] ?? {}) };
    for (const d of deepDiff(declaredGround(snapState)[k] ?? null, n)) push("@world", `${k}${d.path}`, d.old, d.new); }
  return diffs;
}

// declared (translate-v1@12, the shape audit's render-media-env family), written here independently of shared/protocol/shaperepair.js:
// a terrain's layer colours are ints, the sim's defaults (shared/terrainmath.js) are written where absent, and its water is
// the world's water component (its colour an int); grass is read in the flora spelling (the grass READER's own mapping:
// flora_args), a preset kept by its name (R 10-17)
function declaredGround(snap) {
  const isO = (v) => !!v && typeof v === "object" && !Array.isArray(v); const hx = (x) => (typeof x === "string" && /^#[0-9a-f]{6}$/i.test(x) ? parseInt(x.slice(1), 16) : x);
  const out = { terrain: snap.terrain ?? null, grass: snap.grass ?? null, water: null };
  if (isO(out.terrain)) { let t = { ...out.terrain };
    if (Array.isArray(t.layers)) t.layers = t.layers.map((l) => (isO(l) ? { ...l, color: hx(l.color) } : l));
    if (t.kind === undefined || t.kind === "noise") t = { kind: "noise", seed: 1, size: 80, amplitude: 3, octaves: 4, frequency: 2.5, flatRadius: 0, flatHeight: 0, ...t };
    if ("water" in t) { const { water, ...rest } = t; t = rest; if (isO(water)) out.water = Object.fromEntries(Object.entries(water).map(([k, v]) => [k, k === "color" ? hx(v) : v])); }
    out.terrain = t; }
  if (isO(out.grass)) { let g = out.grass;
    if (FA.isLegacyArgs(g)) { const m = FA.mapGrassArgs(g); g = { ...Object.fromEntries(Object.entries(g).filter(([k]) => !["bladeHeight", "spacing", "perCell", "colorTip", "windSpeed", "lean", "fade", "fadeStart", "fadeEnd", "fadeColor", "backlight", "color"].includes(k) && !(k in m))), ...m }; }
    out.grass = g; }
  return out;
}

/** A world translated in place (world.ts translate <world>) keeps its old files beside the new world as log.original.jsonl
 *  and snapshot.original.json: read them through a scratch directory of the same name whose log.jsonl / snapshot.json /
 *  poses.json are links to them (read only), so the oracle can be re-run on the original after the swap. Else `dir`. */
function originalsOf(dir) {
  if (fs.existsSync(path.join(dir, "log.jsonl")) || !fs.existsSync(path.join(dir, "log.original.jsonl"))) return dir;
  const d = path.join(SCRATCH, "originals-" + crypto.randomBytes(3).toString("hex"), path.basename(dir)); fs.mkdirSync(d, { recursive: true });
  for (const [from, to] of [["log.original.jsonl", "log.jsonl"], ["snapshot.original.json", "snapshot.json"], ["poses.original.json", "poses.json"]])
    if (fs.existsSync(path.join(dir, from))) fs.symlinkSync(path.join(dir, from), path.join(d, to));
  return d;
}

/** What the server's load says a lifted world still lacks: a host it refused or skipped, or maintenance it still needs
 *  (liftWorld's repairNeeded: a translation runs the maintenance itself, so a fresh one never needs any). */
export const liftFailures = (lifted) => lifted.filter((x) => x.failed || x.skipped || x.repairNeeded);

export function oracleWorld(given) {
  const dir = originalsOf(given);
  const name = path.basename(dir);
  const c = completeSnapshot(dir);
  if (!c.ok) return { name, dir, skipped: c.why };
  const t0 = performance.now();
  let unparsed = 0;
  const old = fs.readFileSync(path.join(dir, "log.jsonl"), "utf8").split("\n").filter((l) => l.trim()).flatMap((l) => { try { return [JSON.parse(l)]; } catch { unparsed++; return []; } });
  if (hasEpoch(old)) return { name, dir, skipped: "a physics-era log (dialect 3): v4 holds her sim's rests, which the old snapshot (the instant fold) never had; this oracle has no independent reading of them" };
  // 1. the real translation, into its own scratch worlds dir
  const worldsDir = path.join(SCRATCH, name.replace(/[^A-Za-z0-9_-]/g, "_") + "-" + crypto.randomBytes(3).toString("hex"), "worlds");
  fs.mkdirSync(worldsDir, { recursive: true });
  const dest = path.join(worldsDir, name);
  const r = translateV1World(dir, dest);
  const tTranslate = performance.now();
  // A. the strict reader and the real fold over what was written
  const text = fs.readFileSync(path.join(dest, "world.jsonl"));
  // the translate command runs the maintenance command on its output (lead 10-18: a load never writes; the lift is the
  // translation's own act, by: "translate"). A compares the PROJECTION, so it folds the log up to that lift; B compares the
  // served state (lifted) with the snapshot put through the same lift
  const all = readLog(text); const liftAt = all.findIndex((e: any) => e?.kind === "act" && e.verb === "lift-sockets" && e.actor === "system" && e.body?.by === "translate");
  const preLift = liftAt >= 0 ? all.slice(0, liftAt) : all;
  const st = fold(preLift);
  if (st.status !== "ok") return { name, dir, error: `the translated world folds to ${st.status}` };
  const newA = v4comps(st);
  const everPre = new Set(Object.keys(st.entities)); for (const e of preLift) if ((e as any)?.kind === "change") for (const o of opsQuiet(e)) if (o.verb === "create") everPre.add(o.id);
  // the snapshot through the translator's own mapping, with the translated world's people and model addresses
  const { who, unresolved, people } = whoFrom(worldsDir);
  const content = (p) => { const h = contentAddressOf(p); return h ? `sha256:${h}` : null; };
  const snapState = jclone(c.snap.state);
  const oldA = project(snapState, null, who, namespaceOf(name), content);
  const A = compareWorlds(oldA, newA);
  const C = coreCheck(snapState, newA, content);
  const tA = performance.now();
  // B. the server's view: opened as the server opens it, lifted as it lifts at first load
  const live = openLive(dest, name, { catalogue: ENGINE_CATALOGUE, scripts: null });
  const ever = everPre;   // what the lift saw: the ids before it (its children's ids are minted against these)
  const lifted = liftWorld(live);   // the LOAD: writes nothing; says what the world still needs (nothing, for a translation)
  const failedLift = liftFailures(lifted);
  const newB = v4comps(live.state());
  const { lifted: oldB, hosts } = liftPlain(oldA, ever, !shapesMarked(live.entries));
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
      const t = kids[0][1].transform; const y = Number(s.yaw ?? 0); const want = { pos: Array.isArray(s.pos) ? s.pos : [0, 0, 0], q: socketQ({ ...s, yaw: undefined, ...(Number.isFinite(y) && y !== 0 ? { q: [0, Math.sin(y / 2), 0, Math.cos(y / 2)] } : {}) }) };   // v1 turned a seat by its yaw as JS coerces it
      for (const d of deepDiff(want, { pos: t?.pos, q: t?.q })) seatDiffs.push({ id: kids[0][0], field: `seat '${slot}' transform${d.path}`, old: d.old, new: d.new }); } }
  const tB = performance.now();
  return { name, dir, entries: old.length, unparsed, out: r.entries, people, unresolved, lift: { hosts: hosts.length, failed: failedLift, seats, seatDiffs },
    A, B, C, ms: { translate: tTranslate - t0, compareA: tA - tTranslate, serverB: tB - tA, total: tB - t0 } };
}

// ---------- the report ----------
const unexplained = (w) => (w.skipped ? 0 : w.error ? 1 : w.A.missing.length + w.A.extra.length + w.A.diffs.length + w.B.missing.length + w.B.extra.length + w.B.diffs.length
  + w.lift.seatDiffs.length + w.C.length + w.lift.failed.length + w.unresolved.length);
function printWorld(w) {
  if (w.skipped) { if (w.skipped !== "no snapshot.json") console.log(`\n-- ${w.name} (${w.dir}): SKIPPED (${w.skipped})`); return; }
  if (w.error) { console.log(`\n-- ${w.name}: FAIL ${w.error}`); return; }
  const n = unexplained(w);
  console.log(`\n-- ${w.name} (${w.dir}): ${w.entries} old entries${w.unparsed ? ` (and ${w.unparsed} line(s) that don't parse, read by neither engine)` : ""} → ${w.out} entries; ${(w.ms.total / 1000).toFixed(1)} s (translate ${(w.ms.translate / 1000).toFixed(1)}, compare ${(w.ms.compareA / 1000).toFixed(2)}, server load+lift ${(w.ms.serverB / 1000).toFixed(2)}) — ${n ? `FAIL ${n} unexplained` : "ok"}`);
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
  // no args: the repo's own old worlds first (spec/fixtures/0*: each log with the reference implementation's fold of it,
  // folded.json, as its snapshot), then any host worlds ORACLE_WORLDS / PROTOCOL_WORLDS name. It never walks outside the
  // checkout unasked; not comparing a host's own worlds is an OPTIONAL line the gate counts.
  const roots = process.env.ORACLE_WORLDS ?? process.env.PROTOCOL_WORLDS;
  const dirs = args.length ? args.map((a) => path.resolve(a)) : [...fixtureWorlds(), ...(roots ? findWorlds(roots.split(":")) : [])];
  if (!args.length && !roots) console.log("OPTIONAL oracle-host-worlds: compared the repo's reference fixtures only (set ORACLE_WORLDS or PROTOCOL_WORLDS=<dir>[:<dir>…] to add a host's old worlds: log.jsonl + snapshot.json)");
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
    let w; try { w = { ...oracleWorld(d), dir: d }; } catch (x) { w = { name: path.basename(d), dir: d, error: `threw: ${x?.stack ?? x}` }; }
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
  // one machine-readable line for a caller (tools/protocol/world.ts translate <world>, which runs this before an in-place swap)
  if (process.env.ORACLE_SUMMARY) console.log(`oracle-summary ${JSON.stringify(results.map((w) => ({ dir: w.dir, ...(w.skipped ? { skipped: w.skipped } : w.error ? { error: w.error.split("\n")[0] } : { agree: !unexplained(w), unexplained: unexplained(w), entities: [w.A.old, w.A.new], seats: w.lift.seats }) })))}`);
  process.exit(bad.length || !compared.length ? 1 : 0);
}
