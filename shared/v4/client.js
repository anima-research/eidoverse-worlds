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
// What the renderer still reads: today's realizers draw a v1 WorldState. So after each ingest the client computes the
// v1 verbs that take what it holds (`held`) to legacyState(its v4 fold), checks them with the v1 fold exactly as the
// server used to (legacy.js), and folds them into its own shadow state. If no v1 verbs can say it, it re-hydrates its
// shadow from the projection, locally (`rehydrate`): the server's projection deltas and resyncs are no longer needed by
// a client that does this. The panels read the v4 fold directly (v4.st), and the door's views by asking the door.
import { opsOf, applyInPlace, emptyState, PURGED, Malformed } from "./fold.js";
import { legacyState, legacyDelta, foldLegacy, legacyDiff } from "./legacy.js";
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
  const v = { active: false, st: null, head: -1, worldId: null, stats: { ingested: 0, projected: 0, rehydrated: 0, resyncs: 0 } };
  v.adopt = (snap) => {
    v.st = stateFromView(snap.state); v.head = Number.isInteger(snap.head) ? snap.head : -1; v.worldId = snap.worldId ?? null; v.active = true;
  };
  v.reset = () => { v.active = false; v.st = null; v.head = -1; v.worldId = null; };
  /** The projection the renderer draws, carrying the chat window of what the client already holds. */
  v.legacy = (held) => legacyState(v.st, { recentChat: held?.recentChat ?? [], chatTotal: held?.chatTotal ?? 0 });
  /** Fold the door's fresh entries. Returns {v1: [entries], rehydrate: v1 state | null, resync: bool, throughSeq}. */
  v.ingest = (entries, from, held) => {
    if (!v.active) return { v1: [], rehydrate: null, resync: false };
    const says = []; let changed = false, last = null;
    for (let i = 0; i < (entries?.length ?? 0); i++) {
      const seq = from + i; const e = entries[i];
      if (seq <= v.head) continue;                                   // already folded (a re-delivery)
      if (seq !== v.head + 1) { v.stats.resyncs++; return { v1: [], rehydrate: null, resync: true, why: `gap ${v.head} → ${seq}` }; }
      if (e && typeof e === "object" && (e.kind === "purge" || e.kind === "genesis" || e.kind === "sequencer")) { v.stats.resyncs++; return { v1: [], rehydrate: null, resync: true, why: e.kind }; }
      if (e?.kind === "state") { try { applyInPlace(v.st, opsOf(e), seq); changed = true; } catch (x) { if (!(x instanceof Malformed)) throw x; } }
      if (e?.kind === "say") says.push({ seq: seq * 1000, ts: e.ts, actor: idOut(String(e.actor)), verb: "say", args: { text: String(e.body?.text ?? ""), ...(e.body?.to ? { to: idOut(String(e.body.to)) } : {}) } });
      v.head = seq; last = e; v.stats.ingested++;
    }
    if (!changed) return { v1: says, rehydrate: null, resync: false, throughSeq: v.head * 1000 + 999 };
    // the verbs, numbered by the v4 entry they came from (as the server numbered them): v4seq × 1000 + k
    const next = v.legacy(held);
    const delta = legacyDelta(held, next);
    const ts = Number.isInteger(last?.ts) ? last.ts : 0;
    const actor = idOut(String(entries.find((e) => e?.kind === "act" || e?.kind === "say")?.actor ?? last?.actor ?? "world"));
    if (delta && delta.length < 999) {
      const out = [...says, ...delta.map((x, k) => ({ seq: v.head * 1000 + k + 1, ts, actor, verb: x.verb, args: x.args }))];
      if (!legacyDiff(foldLegacy(held, out), next)) { v.stats.projected += delta.length; return { v1: out, rehydrate: null, resync: false, throughSeq: v.head * 1000 + 999 }; }
    }
    v.stats.rehydrated++;
    return { v1: says, rehydrate: next, resync: false, throughSeq: v.head * 1000 + 999 };
  };
  return v;
}
