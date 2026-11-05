// shared/protocol/features.js — feature declarations (docs/DESIGN-log-vocabulary.md §F F-1): genesis.body.requires, governance.body.requiresAdd.
// Pure: the fold (fold.js checkGenesis, fold) calls in here; this module decides what the lists mean.

/** namespace:name@major, ≤ 88 characters; a new major is a new id. */
export const FEATURE_ID = /^[a-z][a-z0-9-]{0,31}:[a-z][a-z0-9-]{0,47}@[1-9][0-9]{0,3}$/;
export const MAX_FEATURES = 64;
export const MAX_FEATURE_ID_LEN = 88;
/** The feature ids this reader implements: none yet (a world requiring any id is unsupported here). */
export const KNOWN_FEATURES = new Set([]);
/** verb → the feature id that owns it, registered by the feature's implementation; the authority refuses a use before the world declares it. */
export const FEATURE_VERBS = new Map();

const sortedUnique = (xs) => xs.every((x, i) => i === 0 || xs[i - 1] < x);
/** Why `list` is not a feature list ({code, detail}), or null. Absent (undefined) is the empty list. */
export function checkRequires(list, at = "requires") {
  if (list === undefined) return null;
  if (!Array.isArray(list)) return { code: `${at}-shape`, detail: `${at} is a list of feature ids` };
  if (list.length > MAX_FEATURES) return { code: `${at}-count`, detail: `${list.length} ids; at most ${MAX_FEATURES} per world` };
  for (const id of list) if (typeof id !== "string" || id.length > MAX_FEATURE_ID_LEN || !FEATURE_ID.test(id)) return { code: `${at}-id`, detail: `${JSON.stringify(id)} is not namespace:name@major` };
  if (!sortedUnique(list)) return { code: `${at}-order`, detail: "ids are sorted and unique" };
  return null;
}

/** The monotonic union: `current` plus `add` (both checked lists). `add` may not remove, reorder or repeat what is there. */
export function requiresAdd(current, add) {
  const bad = checkRequires(add, "requiresAdd"); if (bad) return { ok: false, ...bad };
  // a governance decision that changes nothing is invalid (gov.py; docs/DESIGN-log-vocabulary.md §2.3)
  if (!add.length) return { ok: false, code: "requiresAdd-empty", detail: "requiresAdd adds at least one feature id" };
  const have = new Set(current);
  const dup = add.find((id) => have.has(id)); if (dup !== undefined) return { ok: false, code: "requiresAdd-present", detail: `${dup} is already required` };
  const out = [...current, ...add].sort();
  if (out.length > MAX_FEATURES) return { ok: false, code: "requiresAdd-count", detail: `${out.length} ids; at most ${MAX_FEATURES} per world` };
  return { ok: true, requires: out };
}

/** Walk a log's declarations: genesis `requires`, then each governance `requiresAdd` in order, against the ids this reader
 *  knows. {requires, declaredAt: {id: seq}, unsupported: null | {seq, ids}}. From `unsupported.seq` on, nothing is applied. */
export function featureDecision(entries, known) {
  const declaredAt = Object.create(null); let requires = [];
  const unknownIn = (ids, seq) => { const u = ids.filter((id) => !known.has(id)); return u.length ? { seq, ids: u } : null; };
  const g = entries[0]?.body ?? {};
  const bad0 = checkRequires(g.requires); if (bad0) return { requires, declaredAt, unsupported: null, malformed: { seq: 0, ...bad0 } };
  requires = g.requires ?? [];
  for (const id of requires) declaredAt[id] = 0;
  const u0 = unknownIn(requires, 0); if (u0) return { requires, declaredAt, unsupported: u0 };
  for (let seq = 1; seq < entries.length; seq++) {
    const e = entries[seq]; if (!e || e.kind !== "governance" || e.body?.requiresAdd === undefined) continue;
    const r = requiresAdd(requires, e.body.requiresAdd);
    if (!r.ok) return { requires, declaredAt, unsupported: null, malformed: { seq, code: r.code, detail: r.detail } };
    for (const id of e.body.requiresAdd) declaredAt[id] = seq;
    requires = r.requires;
    const u = unknownIn(e.body.requiresAdd, seq); if (u) return { requires, declaredAt, unsupported: u };
  }
  return { requires, declaredAt, unsupported: null };
}

/** May an entry at `seq` use feature `id`? Only once declared at an earlier (or the same governance) seq. */
export const declaredBefore = (decision, id, seq) => decision.declaredAt[id] !== undefined && decision.declaredAt[id] <= seq;
