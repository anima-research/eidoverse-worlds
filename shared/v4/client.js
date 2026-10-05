// shared/v4/client.js — a v4 world as a CLIENT holds it (slice 3b). Pure; the browser (client/lib/net.js) and the
// suites (tools/v4/door-check.ts) run the same code.
//
// The client folds v4 itself, from the server's own v4 stream:
//   adopt(snap)        the join snapshot's v4 part: {state: stateView(fold), head, worldId, mine?}, the fold as the
//                      server holds it at `head` (a client can't refold the whole log on join; it adopts a cut, as
//                      v1 clients adopt the v1 snapshot);
//   ingest(entries, from, held)
//                      the `v4-log` message: the raw entries the door just wrote, folded with the fold's own ops
//                      (opsOf + applyInPlace, the strict reader's code). A gap, a purge (retroactive by law, L1) or a
//                      genesis means this client can't continue its cut: it asks for a fresh snapshot (`resync`).
//
// What the renderer reads (slice 3c): the VIEW of this fold (record.js viewState), recomputed from the fold itself,
// so there's nothing held beside it to drift; client/lib/state.js diffs successive views and tells the realizers
// what changed, in v4 terms. No v1 verbs are made. `say` entries come back as chat lines ({seq, ts, actor, text,
// to?}): chat isn't world state, it's the log's own kind.
import { opsOf, applyInPlace, emptyState, PURGED, Malformed } from "./fold.js";
import { viewState } from "./record.js";
import { dec } from "./names.js";

const idOut = (s) => dec(s) ?? s;

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
  const v = { active: false, st: null, head: -1, worldId: null, stats: { ingested: 0, resyncs: 0 } };
  v.adopt = (snap) => {
    v.st = stateFromView(snap.state); v.head = Number.isInteger(snap.head) ? snap.head : -1; v.worldId = snap.worldId ?? null; v.active = true;
  };
  v.reset = () => { v.active = false; v.st = null; v.head = -1; v.worldId = null; };
  /** The view the renderer and panels read, carrying a chat window (chat isn't in the fold). */
  v.view = (chat) => viewState(v.st, { recentChat: chat?.recentChat ?? [], chatTotal: chat?.chatTotal ?? 0 });
  /** Fold the door's fresh entries. Returns {changed, says: [chat lines], resync, why?, ts?, actor?}. */
  v.ingest = (entries, from) => {
    if (!v.active) return { changed: false, says: [], resync: false };
    const says = []; let changed = false, ts = null, actor = null;
    for (let i = 0; i < (entries?.length ?? 0); i++) {
      const seq = from + i; const e = entries[i];
      if (seq <= v.head) continue;                                   // already folded (a re-delivery)
      if (seq !== v.head + 1) { v.stats.resyncs++; return { changed: false, says: [], resync: true, why: `gap ${v.head} → ${seq}` }; }
      if (e && typeof e === "object" && (e.kind === "purge" || e.kind === "genesis" || e.kind === "sequencer")) { v.stats.resyncs++; return { changed: false, says: [], resync: true, why: e.kind }; }
      if (e?.kind === "state") { try { applyInPlace(v.st, opsOf(e), seq); changed = true; } catch (x) { if (!(x instanceof Malformed)) throw x; } }
      if (e?.kind === "say") says.push({ seq, ts: e.ts, actor: idOut(String(e.actor)), text: String(e.body?.text ?? ""), ...(e.body?.to ? { to: idOut(String(e.body.to)) } : {}) });
      if (e?.kind === "act" && actor === null) actor = idOut(String(e.actor));
      if (Number.isInteger(e?.ts)) ts = e.ts;
      v.head = seq; v.stats.ingested++;
    }
    return { changed, says, resync: false, ts, actor };
  };
  return v;
}
