// shared/v4/client.js — a v4 world as a CLIENT holds it (slice 3b). Pure; the browser (client/lib/net.js) and the
// suites (tools/v4/door-check.ts) run the same code.
//
// The client folds v4 itself, from the server's own v4 stream:
//   adopt(snap)        the join snapshot's v4 part: {state: stateView(fold), head, worldId, mine?}, the fold as the
//                      server holds it at `head` (a client can't refold the whole log on join; it adopts a cut);
//   ingest(entries, from, held)
//                      the `v4-log` message: the raw entries the door just wrote, folded with the fold's own ops
//                      (opsOf + applyInPlace, the strict reader's code). A gap, a purge (retroactive by law, L1) or a
//                      genesis means this client can't continue its cut: it asks for a fresh snapshot (`resync`).
//
// What the renderer reads (slice 3c): the VIEW of this fold (record.js viewState), recomputed from the fold itself,
// so there's nothing held beside it to drift; client/lib/state.js diffs successive views and tells the realizers
// what changed, in v4 terms. `say` entries come back as chat lines ({seq, ts, actor, text,
// to?}): chat isn't world state, it's the log's own kind.
import { opsOf, applyInPlace, emptyState, PURGED, Malformed } from "./fold.js";
import { simFolder, simCutOf } from "./simlayer.js";
import { advanceSim, tickOf } from "../sim.js";
import { viewState } from "./record.js";
import { dec, learnNames, actorName } from "./names.js";

const idOut = (s) => dec(s) ?? s;
/** A say's spoken trio (the door validated it at admission; this is a reader's own guard): display metadata only. */
export const spokenOf = (b) => (b?.spoken === true && Number.isSafeInteger(b.utt) ? { spoken: true, utt: b.utt, ...(Number.isFinite(b.t0) ? { t0: b.t0 } : {}) } : {});

/** The fold as plain JSON (server side): {id: {born, c: {comp: {v: value} | {purged: true}}}}, the digest's own
 *  wrapping (§2.4), so a purged value can't be mistaken for a value. */
export function stateView(st) {
  const out = {};
  for (const id of Object.keys(st.entities)) { const e = st.entities[id]; const c = {};
    for (const k of Object.keys(e.c)) c[k] = e.c[k] === PURGED ? { purged: true } : { v: e.c[k] };
    out[id] = { born: e.born, c }; }
  return out;
}
/** …and back into a fold state (null prototypes, PURGED as the fold's own sentinel). */
export function stateFromView(view) {
  const st = emptyState();
  for (const id of Object.keys(view ?? {})) { const c = Object.create(null); const e = view[id];
    for (const k of Object.keys(e.c ?? {})) c[k] = e.c[k]?.purged === true && !("v" in e.c[k]) ? PURGED : e.c[k]?.v;
    st.entities[id] = { born: e.born ?? 0, c }; }
  return st;
}

export function makeV4Client() {
  const v = { active: false, st: null, head: -1, worldId: null, you: null, names: Object.create(null), stats: { ingested: 0, resyncs: 0 } };
  // actors are opaque ids (u-…); their display names come from the door's directory, never from the log (§2.3)
  const learn = (names) => { if (names && typeof names === "object") { learnNames(names); for (const [k, n] of Object.entries(names)) if (typeof n === "string") v.names[k] = n; } };
  v.nameOf = (id) => actorName(id);
  // The sim layer beside the fold (design 20 on the client): the SAME simFolder the door runs, fed the same entries, with
  // no catalogue of its own (geometry is the log's physics.shape, as on the server). Canonical: it advances only by the
  // entries' own ts, never by this machine's clock (a fast clock would otherwise apply a later entry at the wrong tick).
  // What the screen shows is a COPY of it advanced to display time (simAt / simClone): a flight on screen is the
  // engine's flight, and it rests bit for bit where the door will log the rest.
  let E = [], folder = null;
  v.sim = null; v.simVersion = 0;
  const startSim = (snap) => {
    E = []; const cut = snap.sim ?? null;
    for (const [q, e] of Object.entries(cut?.launches ?? {})) E[Number(q)] = e;
    folder = simFolder(E, { models: {}, from: { st: stateFromView(snap.state), clock: cut?.clock ?? 0, spec: cut?.spec ?? null, foreign: !!cut?.foreign, sim: cut?.sim ?? null, launched: cut?.launched ?? {} } });
    v.sim = folder.view(); v.simVersion++;
  };
  v.adopt = (snap) => {
    v.st = stateFromView(snap.state); v.head = Number.isInteger(snap.head) ? snap.head : -1; v.worldId = snap.worldId ?? null; v.active = true;
    v.you = typeof snap.you === "string" ? snap.you : null; learn(snap.names);
    startSim(snap);
  };
  v.reset = () => { v.active = false; v.st = null; v.head = -1; v.worldId = null; E = []; folder = null; v.sim = null; v.simVersion++; };
  /** A copy of the canonical sim (null when the world runs no carried engine), to advance for display. */
  v.simClone = () => (v.sim?.sim ? JSON.parse(JSON.stringify(v.sim.sim)) : null);
  /** The engine's state at display time t (ms, the door's clock): a cached copy, advanced forward only. */
  let pres = null, presV = -1;
  v.simAt = (t) => {
    if (!v.sim?.sim) return null;
    if (presV !== v.simVersion || !pres || tickOf(pres, t) < pres.tick) { pres = v.simClone(); presV = v.simVersion; }
    const k = tickOf(pres, t); if (k > pres.tick) advanceSim(pres, k);
    return pres;
  };
  /** The view the renderer and panels read, carrying a chat window (chat isn't in the fold). */
  v.view = (chat) => viewState(v.st, { recentChat: chat?.recentChat ?? [], chatTotal: chat?.chatTotal ?? 0 });
  /** Fold the door's fresh entries. Returns {changed, says: [chat lines], resync, why?, ts?, actor?}. */
  v.ingest = (entries, from, names) => {
    learn(names);
    if (!v.active) return { changed: false, says: [], resync: false };
    const says = []; let changed = false, ts = null, actor = null;
    for (let i = 0; i < (entries?.length ?? 0); i++) {
      const seq = from + i; const e = entries[i];
      if (seq <= v.head) continue;                                   // already folded (a re-delivery)
      if (seq !== v.head + 1) { v.stats.resyncs++; return { changed: false, says: [], resync: true, why: `gap ${v.head} → ${seq}` }; }
      if (e && typeof e === "object" && (e.kind === "purge" || e.kind === "genesis" || e.kind === "sequencer")) { v.stats.resyncs++; return { changed: false, says: [], resync: true, why: e.kind }; }
      let ok = !!(e && typeof e === "object" && !(e instanceof Malformed));
      if (e?.kind === "change") { try { applyInPlace(v.st, opsOf(e), seq); changed = true; } catch (x) { if (!(x instanceof Malformed)) throw x; ok = false; } }
      // (only launches are kept: a later rest names its launch as its cause; nothing else is read back)
      if (ok && folder) { E[seq] = e; folder.feed(seq); if (!(e.kind === "sim" && e.verb === "launch")) delete E[seq]; v.simVersion++; }
      if (e?.kind === "say" && typeof e.body?.text === "string") says.push({ seq, ts: e.ts, actor: v.nameOf(e.actor), by: String(e.actor), text: String(e.body?.text ?? ""), ...(e.body?.to ? { to: v.nameOf(e.body.to) } : {}), ...spokenOf(e.body) });
      if (e?.kind === "act" && actor === null) actor = v.nameOf(e.actor);
      if (Number.isInteger(e?.ts)) ts = e.ts;
      v.head = seq; v.stats.ingested++;
    }
    return { changed, says, resync: false, ts, actor };
  };
  return v;
}

/** The cut a joining client adopts (server side; server/v4/world.ts clientCut): the fold, its head, and the sim layer
 *  where the door's clock stands (what flies, from which launch), so a joiner sees a flight already in the air. */
export function clientCutOf(w) {
  const sf = w.sim();
  return { state: stateView(w.state()), head: w.entries.length - 1, worldId: w.worldId ?? null, sim: simCutOf(sf, w.entries) };
}
