// shared/protocol/replica.js — a world as a CLIENT holds it (slice 3b). Pure; the browser (client/lib/net.js) and the
// suites (tools/protocol/authority-check.ts) run the same code.
//
// The client folds the log itself, from the server's own log stream:
//   adopt(snap)        the join snapshot: {dialect, v, world, seq, state: wireState(fold), physics, mine?}, the fold as the
//                      server holds it at `seq` (a client can't refold the whole log on join; it adopts a snapshot). An unknown
//                      {dialect, v} is refused before anything is folded: status `unknown-version`, no state (D5)
//   ingest(entries, from, held)
//                      the `log` message: the raw entries the authority just wrote, folded with the fold's own ops
//                      (opsOf + applyInPlace, the strict reader's code). A gap, a redaction (retroactive by law, L1), a
//                      governance entry or a genesis means this client can't continue: it asks for a fresh snapshot (`resync`).
//
// What the renderer reads (slice 3c): the VIEW of this fold (view.js viewState), recomputed from the fold itself,
// so there's nothing held beside it to drift; client/lib/state.js diffs successive views and tells the realizers
// what changed, in the protocol's terms. `say` entries come back as chat lines ({seq, ts, actor, text,
// to?}): chat isn't world state, it's the log's own kind.
import { opsOf, applyInPlace, emptyState, REDACTED, Malformed, DIALECT, VERSION } from "./fold.js";
import { simFolder, simSnapshotOf, advanceSim, tickOf, carried } from "./simlayer.js";
import { viewState } from "./view.js";
import { dec, learnNames, actorName } from "./names.js";
import { simInputsMissing } from "./siminputs.js";

const idOut = (s) => dec(s) ?? s;
/** A say's spoken trio (the authority validated it at admission; this is a reader's own guard): display metadata only. */
export const spokenOf = (b) => (b?.spoken === true && Number.isSafeInteger(b.utt) ? { spoken: true, utt: b.utt, ...(Number.isFinite(b.t0) ? { t0: b.t0 } : {}) } : {});

/** The fold ON THE WIRE (server side): {id: {born, c: {comp: {v: value} | {redacted: true}}}}, the digest's own wrapping
 *  (§2.4), so a redacted value can't be mistaken for a value. Not a view: view.js viewState is what readers draw from. */
export function wireState(st) {
  const out = {};
  for (const id of Object.keys(st.entities)) { const e = st.entities[id]; const c = {};
    for (const k of Object.keys(e.c)) c[k] = e.c[k] === REDACTED ? { redacted: true } : { v: e.c[k] };
    out[id] = { born: e.born, c }; }
  return out;
}
/** …and back into a fold state (null prototypes, REDACTED as the fold's own sentinel). */
export function stateFromWire(wire) {
  const st = emptyState();
  for (const id of Object.keys(wire ?? {})) { const c = Object.create(null); const e = wire[id];
    for (const k of Object.keys(e.c ?? {})) c[k] = e.c[k]?.redacted === true && !("v" in e.c[k]) ? REDACTED : e.c[k]?.v;
    st.entities[id] = { born: e.born ?? 0, c }; }
  return st;
}

/** Freeze one entity's record in place: its bag and every value under it. The fold never mutates a value (a set
 *  replaces one), so a frozen record only ever stops a READER's stray write — which, with the realizer's clone gone
 *  (C7), would otherwise corrupt the fold this client holds. */
function freezeRecord(e) {
  if (!e || Object.isFrozen(e.c)) return;
  const deep = (x) => { if (x && typeof x === "object" && !Object.isFrozen(x)) { Object.freeze(x); for (const k of Object.keys(x)) deep(x[k]); } };
  deep(e.c);
}
/** The same entity, thawed for the fold to write (a shallow copy of its bag: the values stay frozen and are never
 *  mutated in place, only replaced). */
const thawed = (e) => ({ born: e.born, c: Object.assign(Object.create(null), e.c) });

/** `freeze`: dev-mode guard (on by default for every caller, so every suite runs with it; client/lib/net.js
 *  passes CONFIG.dev, so the browser has it only on a dev host): the fold's records are frozen, so a reader that mutates one throws where it stands. */
export function makeReplica({ freeze = true } = {}) {
  const v = { active: false, status: null, st: null, seq: -1, world: null, you: null, names: Object.create(null), stats: { ingested: 0, resyncs: 0 }, frozen: !!freeze };
  const freezeAll = () => { if (freeze && v.st) for (const id of Object.keys(v.st.entities)) freezeRecord(v.st.entities[id]); };
  // The tree's edges, indexed from the records' own `parent` fields (ids as the fold spells them): rebuilt at adopt,
  // kept at every ingest from the ops' ids (an op names the one record it touched; a parent edge lives on the child).
  // One index for every reader — the realizer's carrier checks, the sockets re-seat, the Hierarchy — in place of
  // the maps each kept by hand beside the fold (C12b, survey #11). A carrier that is gone while a child still names
  // it keeps that child listed: the index answers what the records say, exactly as a scan would.
  const kids = new Map(), par = new Map();
  const link = (id, to) => { let s = kids.get(to); if (!s) kids.set(to, (s = new Set())); s.add(id); par.set(id, to); };
  const unlink = (id) => { const was = par.get(id); if (was === undefined) return; const s = kids.get(was); if (s) { s.delete(id); if (!s.size) kids.delete(was); } par.delete(id); };
  const reindex = (id) => { const to = v.st?.entities?.[id]?.c?.parent?.to; const want = typeof to === "string" ? to : null; if (par.get(id) === want) return; unlink(id); if (want !== null) link(id, want); };
  const rebuildIndex = () => { kids.clear(); par.clear(); if (v.st) for (const id of Object.keys(v.st.entities)) reindex(id); };
  /** Children of `id` in id order (the fold's edges; [] for an id with none). */
  v.childrenOf = (id) => { const s = kids.get(id); return s ? [...s].sort() : []; };
  v.parentOf = (id) => par.get(id) ?? null;
  /** The ids above `id`, nearest first; stops at a carrier that is absent or a cycle (an old log may hold one). */
  v.ancestors = (id) => { const out = []; const seen = new Set([id]); for (let p = par.get(id); p !== undefined && v.st?.entities?.[p] && !seen.has(p); p = par.get(p)) { out.push(p); seen.add(p); } return out; };
  // actors are opaque ids (u-…); their display names come from the authority's directory, never from the log (§2.3)
  const learn = (names) => { if (names && typeof names === "object") { learnNames(names); for (const [k, n] of Object.entries(names)) if (typeof n === "string") v.names[k] = n; } };
  v.nameOf = (id) => actorName(id);
  // The sim layer beside the fold (design 20 on the client): the SAME simFolder the authority runs, fed the same entries, with
  // no catalogue of its own (geometry is the log's physics.shape, as on the server). Canonical: it advances only by the
  // entries' own ts, never by this machine's clock (a fast clock would otherwise apply a later entry at the wrong tick).
  // What the screen shows is a COPY of it advanced to display time (simAt / simClone): a flight on screen is the
  // engine's flight, and it rests bit for bit where the authority will log the rest.
  let E = [], folder = null;
  v.sim = null; v.simVersion = 0;
  // An input the log only names (siminputs.js: a heightmap's grid) may land after the entries that read it: keep the cut
  // from before the first such entry and refold from it when it lands (#144); WAIT_MAX bounds an input that never comes.
  let waiting = null; const WAIT_MAX = 5000;
  const feedOne = (seq, e) => { E[seq] = e; folder.feed(seq); if (!(e.kind === "physics" && e.verb === "launch")) delete E[seq]; };
  const snapNow = () => { const f = folder.view(); return JSON.parse(JSON.stringify({ state: wireState(f.st), physics: simSnapshotOf(f, E) })); };
  const inputsLanded = () => {
    if (!waiting || simInputsMissing(v.st).length) return;
    const { snap, fed } = waiting; waiting = null;
    startSim(snap); for (const [seq, e] of fed) feedOne(seq, e);
    v.sim = folder.view(); v.simVersion++;
  };
  /** The browser's draw clones v.sim itself (never simAt): its door to the refold once a late input lands. */
  v.settleInputs = inputsLanded;
  const startSim = (snap) => {
    E = []; const cut = snap.physics ?? null;
    for (const [q, e] of Object.entries(cut?.launches ?? {})) E[Number(q)] = e;
    // a joiner decides for itself whether it carries the cut's engine build (audit FIX-2): the sender's word isn't evidence
    // …and a cut with no engine state (its sender doesn't carry the build) can't be flown here either: mid-epoch, a sim
    // is only ever started from a cut (review of 8377ec52 #10)
    const spec = cut?.spec ?? null, foreign = !!spec && (!carried(spec) || !cut?.sim);
    folder = simFolder(E, { models: {}, from: { st: stateFromWire(snap.state), clock: cut?.clock ?? 0, spec, foreign, sim: foreign ? null : cut?.sim ?? null, launched: cut?.launched ?? {}, lifted: cut?.lifted ?? [], unknownEpoch: !!cut?.unknownEpoch, unknownHold: !!cut?.unknownHold } });
    v.sim = folder.view(); v.simVersion++;
  };
  /** Adopt a join snapshot. False, with v.status "unknown-version" and no state, when its {dialect, v} isn't this reader's (D5): never a half-read. */
  v.adopt = (snap) => {
    if (!snap || typeof snap !== "object" || snap.dialect !== DIALECT || snap.v !== VERSION) { v.reset(); v.status = "unknown-version"; return false; }
    v.status = "ok"; v.st = stateFromWire(snap.state); v.seq = Number.isInteger(snap.seq) ? snap.seq : -1; v.world = snap.world ?? null; v.active = true;
    v.you = typeof snap.actor === "string" ? snap.actor : null;   // the snapshot's `actor`: this joiner's id in the log (`you` is the connection's)
    learn(snap.names);
    freezeAll();
    rebuildIndex();
    startSim(snap);
    waiting = simInputsMissing(v.st).length ? { snap: snapNow(), fed: [] } : null;   // the snapshot is the folder's, as mid-session
    return true;
  };
  v.reset = () => { waiting = null; v.active = false; v.status = null; v.st = null; v.seq = -1; v.world = null; E = []; folder = null; v.sim = null; v.simVersion++; kids.clear(); par.clear(); };
  /** A copy of the canonical sim (null when the world runs no carried engine), to advance for display. */
  v.simClone = () => (v.sim?.sim ? JSON.parse(JSON.stringify(v.sim.sim)) : null);
  /** The engine's state at display time t (ms, the authority's clock): a cached copy, advanced forward only. */
  let pres = null, presV = -1;
  v.simAt = (t) => {
    inputsLanded();
    if (!v.sim?.sim) return null;
    if (presV !== v.simVersion || !pres || tickOf(pres, t) < pres.tick) { pres = v.simClone(); presV = v.simVersion; }
    const k = tickOf(pres, t); if (k > pres.tick) advanceSim(pres, k);
    return pres;
  };
  /** The view the renderer and panels read, carrying a chat window (chat isn't in the fold). */
  v.view = (chat) => viewState(v.st, { recentChat: chat?.recentChat ?? [], chatTotal: chat?.chatTotal ?? 0 });
  /** Fold the authority's fresh entries. Returns {changed, says: [chat lines], resync, why?, ts?, actor?}. */
  v.ingest = (entries, from, names) => {
    learn(names);
    if (!v.active) return { changed: false, says: [], resync: false };
    inputsLanded();
    const says = []; let changed = false, ts = null, actor = null, lastAct = null, sky = null;
    for (let i = 0; i < (entries?.length ?? 0); i++) {
      const seq = from + i; const e = entries[i];
      if (seq <= v.seq) continue;                                    // already folded (a re-delivery)
      if (seq !== v.seq + 1) { v.stats.resyncs++; return { changed: false, says: [], resync: true, why: `gap ${v.seq} → ${seq}` }; }
      if (e && typeof e === "object" && (e.kind === "redaction" || e.kind === "genesis" || e.kind === "governance")) { v.stats.resyncs++; return { changed: false, says: [], resync: true, why: e.kind }; }
      let ok = !!(e && typeof e === "object" && !(e instanceof Malformed));
      if (e?.kind === "change") {
        try {
          const ops = opsOf(e);
          if (freeze) for (const o of ops) { const ent = typeof o?.id === "string" ? v.st.entities[o.id] : undefined; if (ent && Object.isFrozen(ent.c)) v.st.entities[o.id] = thawed(ent); }
          // the sky's provenance (#260 I286): a stored sky carries no seq/by (the log does), so the entry that wrote it names them
          if (ops.some(({ id, comp } = {}) => id === "@world" && comp === "sky"))   /* an op's comp field, not a record's bag */ sky = { seq, by: lastAct ?? v.nameOf(e.actor) };
          try { applyInPlace(v.st, ops, seq); changed = true; }
          finally { for (const o of ops) if (typeof o?.id === "string") { if (freeze) freezeRecord(v.st.entities[o.id]); reindex(o.id); } }
        } catch (x) { if (!(x instanceof Malformed)) throw x; ok = false; }
      }
      // (only launches are kept: a later rest names its launch as its cause; nothing else is read back)
      if (ok && folder) { const rev = v.sim?.rev;
        // v.st already holds this entry: if it names an input this machine lacks, the cut is the folder from just before it
        if (!waiting && e.kind === "change" && simInputsMissing(v.st).length) waiting = { snap: snapNow(), fed: [] };
        feedOne(seq, e);
        if (waiting && waiting.fed.push([seq, e]) > WAIT_MAX) waiting = null;
        if (v.sim?.rev !== rev) v.simVersion++; }   // the engine moved: the screen re-copies; a say or a label didn't: it keeps its copy
      if (e?.kind === "say" && typeof e.body?.text === "string") says.push({ seq, ts: e.ts, actor: v.nameOf(e.actor), by: String(e.actor), text: String(e.body?.text ?? ""), ...(e.body?.to ? { to: v.nameOf(e.body.to) } : {}), ...spokenOf(e.body) });
      if (e?.kind === "request") { lastAct = v.nameOf(e.actor); if (actor === null) actor = lastAct; }
      if (Number.isInteger(e?.ts)) ts = e.ts;
      v.seq = seq; v.stats.ingested++;
    }
    return { changed, says, resync: false, ts, actor, ...(sky ? { sky } : {}) };
  };
  return v;
}

/** The snapshot a joining client adopts (server side; server/worldlog.ts clientSnapshot): the fold, its seq, and the physics layer
 *  where the authority's clock stands (what flies, from which launch), so a joiner sees a flight already in the air. */
export function clientSnapshotOf(w) {
  const sf = w.sim();
  return { ...snapshotVersion(), state: wireState(w.state()), seq: w.entries.length - 1, world: w.worldId ?? null, physics: simSnapshotOf(sf, w.entries) };
}
/** The version a snapshot carries ({dialect, v}: what adopt checks first), for a snapshot built by hand. */
export const snapshotVersion = () => ({ dialect: DIALECT, v: VERSION });
