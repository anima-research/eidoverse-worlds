// shared/v4/fold.js — ported from the v4 lab (code/v4-lab/fold.js), unchanged. Pure; server, browser and tests import it.
// The v4 fold, fold version 1. It knows nothing about any component type (R1): it creates entities, replaces
// component values, deletes components and entities. It reads nothing outside the entry except immutable,
// content-addressed blobs the entry names by hash. It never throws (v1 §1: folding is total).

export const FOLD_VERSION = 1;

export function emptyState() {
  return { fold: null, seq: -1, entities: {} };
}

export function fold(entries, getBlob, state = emptyState()) {
  for (const e of entries) apply(state, e, getBlob);
  return state;
}

export function apply(s, e, getBlob) {
  s.seq = e.seq;
  if (e.verb === "genesis") { s.fold = e.args?.fold ?? null; return; }
  if (e.kind !== "state") return; // timeline entries (say, act, …) never shape the world (R5)
  op(s, e.verb, e.args ?? {}, e.seq, getBlob);
}

function op(s, verb, a, seq, getBlob) {
  switch (verb) {
    case "create": {
      if (a.expanded) {
        const blob = safe(() => getBlob(a.expanded));
        if (!Array.isArray(blob)) { s.entities[a.id] = { born: seq, c: { missing: { blob: a.expanded } } }; return; }
        for (const part of blob) s.entities[part.id] = { born: seq, c: clone(part.components ?? {}) };
        return;
      }
      if (typeof a.id === "string") s.entities[a.id] = { born: seq, c: clone(a.components ?? {}) };
      return;
    }
    case "set": {
      const ent = s.entities[a.id];
      if (ent && typeof a.component === "string") ent.c[a.component] = clone(a.value);
      return;
    }
    case "delete": {
      if (typeof a.id !== "string") return;
      if (typeof a.component === "string") { const ent = s.entities[a.id]; if (ent) delete ent.c[a.component]; }
      else delete s.entities[a.id];
      return;
    }
    case "batch": {
      for (const o of Array.isArray(a.ops) ? a.ops : []) op(s, o.verb, o.args ?? {}, seq, getBlob);
      return;
    }
    default: return; // unknown state verbs shape nothing; the log keeps them
  }
}

const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const safe = (f) => { try { return f(); } catch { return undefined; } };
