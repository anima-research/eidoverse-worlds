// v1/v2 → v4 translator (lab). Runs the REAL v1 fold (anima/main shared/fold.js, extracted to legacy/) one entry at a
// time, projects its state into v4 entity/component form, and emits, per old entry:
//   - the old entry as sent: an `act` (verb "legacy", body {verb, args, from: old seq}, ts: old ts), or a `say`, and
//   - at most one state entry with the plain results that bring v4 to the same place (cause = that act).
// The output is in the PROTOCOL-v4 §2.4 wire format, and every name and id follows §2.3: an old id or name the
// grammar refuses is mapped by `enc` (injective, deterministic). After every entry it folds the v4 entry with the v4
// fold and checks the projections agree. The original log is never written (R9); the output is a regenerable cache.
// Ported from the v4 lab (code/v4-lab/translate-v1.js @ 11db981). Engine changes: the v1 fold is the engine's own
// ../fold.js (the lab carried an older anima/main copy in legacy/), hashing and hex come from ./hash.js (no node:
// imports; the browser may import this file), and the lab's CLI is tools/v4/sweep.ts.
import { emptyState as v1Empty, foldEntry } from "../fold.js";
import { emptyState as v4Empty, applyInPlace, opsOf, worldIdOf, VERSION } from "./fold.js";
import { enc, encName, dec } from "./names.js";

// The engine's translator has its own name (research 35, slice-2 #1): it projects the ENGINE's v1 fold, which differs
// from the lab's older copy on two of 35 logs (tilt-demo's q, 06-components' newer verbs), so the lab's name
// "translate-v1@0.3" would claim output this code didn't make. @1 also differs from the lab in names.js's escape
// (a component name the grammar refuses is always x--, never n-prefixed). The exact v1 fold build is stamped beside
// it when the caller knows it (translate(…, {foldBuild}); server/v4/build.ts computes it from the files).
export const TRANSLATOR = "eidoverse/translate-v1@1";
export { enc, encName, dec };
const yawQ = (y) => [0, Math.sin(y / 2), 0, Math.cos(y / 2)];
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
// §2.3 grammar for old names: names.js (one encoding, shared with the live door).
const keyed = (prefix, k) => `${prefix}:${enc(k)}`;

// The projection: what the old fold's state MEANS, in v4 terms. Every deliberate difference is named in DROPPED.
const ENTITY_SKIP = new Set(["actor", "ts", "born"]); // provenance lives in the entry envelope in v4; born is per-log
export const DROPPED = {
  "entity.actor / entity.ts": "last writer and time: in v4 these are the entry envelope's actor and the act's at, not state",
  "entity.born": "incarnation seq: re-derived from the v4 log (the translated create's seq)",
  "mounts": "bodies sitting: presence in v4, never history (00:50 ruling 1); their old entries survive as acts",
  "recentChat / chatTotal": "the chat window: a reader of `say` entries does this in v4, not world state",
  "placer": "who placed it: a view over the log in v4 (L2: no stored derived values); the old value survives in the old entry",
  "roles['*']": "becomes @world `default-role` (the declared role for anyone not named); '*' is not an identity (§2.3)",
};
export function project(st) {
  const out = {};
  for (const [id, e] of Object.entries(st.entities ?? {})) {
    const c = {};
    const t = { pos: e.pos ?? [0, 0, 0], q: Array.isArray(e.q) ? e.q : yawQ(e.yaw ?? 0), scale: typeof e.scale === "number" ? [e.scale, e.scale, e.scale] : (e.scale ?? [1, 1, 1]) };
    c.transform = t;
    if (e.lib !== undefined) c.model = e.lib;
    if (e.kind === "light") c.light = Object.fromEntries(["color", "intensity", "range", "keep", "day"].filter((k) => e[k] !== undefined).map((k) => [k, e[k]]));
    for (const [k, v] of Object.entries(e.comp ?? {})) c[encName(k)] = v;
    if (e.parent) c.parent = { ...e.parent, ...(typeof e.parent.to === "string" ? { to: enc(e.parent.to) } : {}) };
    for (const [k, v] of Object.entries(e)) {
      if (["pos", "yaw", "q", "scale", "lib", "kind", "color", "intensity", "range", "keep", "day", "comp", "parent", "placer"].includes(k) || ENTITY_SKIP.has(k)) continue;
      c[keyed("legacy", k)] = v; // anything the mapping doesn't know is carried, never dropped (R10)
    }
    out[enc(id)] = c;
  }
  const w = {};
  for (const k of ["sky", "terrain", "grass", "epoch"]) if (st[k] != null) w[k] = st[k];
  for (const a of st.assets ?? []) w[keyed("palette", typeof a === "string" ? a : a.path ?? JSON.stringify(a))] = typeof a === "string" ? {} : a;
  for (const [k, v] of Object.entries(st.roles ?? {})) if (k === "*") w["default-role"] = v; else w[keyed("roles", k)] = v;
  for (const [k, v] of Object.entries(st.bans ?? {})) w[keyed("bans", k)] = v;
  for (const [k, v] of Object.entries(st.behaviors ?? {})) w[keyed("behavior", k)] = v;
  const known = new Set(["entities", "sky", "terrain", "grass", "epoch", "assets", "roles", "bans", "behaviors", "mounts", "recentChat", "chatTotal"]);
  for (const [k, v] of Object.entries(st)) if (!known.has(k) && v != null) w[keyed("legacy", k)] = v;
  out["@world"] = w; // @world is live from genesis (§2.3)
  return clone(out); // a copy: the old fold mutates some records in place (bstate), and aliasing would hide the change
}

const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
export function diff(prev, now) {
  const ops = [];
  for (const id of Object.keys(prev)) if (!(id in now)) ops.push({ verb: "delete", id });
  for (const [id, comps] of Object.entries(now)) {
    if (!(id in prev)) { ops.push({ verb: "create", id }); for (const [k, v] of Object.entries(comps)) ops.push({ verb: "set", id, comp: k, value: clone(v) }); continue; }
    for (const k of Object.keys(prev[id])) if (!(k in comps)) ops.push({ verb: "delete", id, comp: k });
    for (const [k, v] of Object.entries(comps)) if (!eq(prev[id][k], v)) ops.push({ verb: "set", id, comp: k, value: clone(v) });
  }
  return ops;
}
export const v4project = (s) => Object.fromEntries(Object.keys(s.entities).map((id) => [id, { ...s.entities[id].c }]));
export const canon = (o) => JSON.stringify(o, (k, v) => (v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map((x) => [x, v[x]])) : v));
// one entry in the §2.4 envelope; the door's re-read discipline applies: what we emit must parse back unchanged
export const stateBody = (ops) => (ops.length === 1 ? (({ verb, ...body }) => ({ verb, body }))(ops[0]) : { verb: "batch", body: { ops } });
// I-JSON has no -0; an old log may hold one (the same number, written as 0)
export const unNegZero = (v) => (Object.is(v, -0) ? 0 : Array.isArray(v) ? v.map(unNegZero) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, unNegZero(x)])) : v);

export function translate(oldEntries, { onDivergence, foldBuild } = {}) {
  const v1 = v1Empty(); const v4 = v4Empty(); const out = [];
  const stats = { in: oldEntries.length, out: 0, state: 0, verbs: {}, ops: 0, divergences: 0, firstDivergence: null, renamed: 0 };
  let world = null;
  let lastTs = -Infinity; // §2.1: ts never decreases. v1 voice says carry speech time, which can run behind; clamp,
  // and stats.tsClamped counts them (the original ts stays in the source log, which is never overwritten, R9)
  const push = (e) => { if (e.kind !== "genesis") e = { world, ...e };
    if (Number.isInteger(e.ts)) { if (e.ts < lastTs) { e.ts = lastTs; stats.tsClamped = (stats.tsClamped ?? 0) + 1; } lastTs = e.ts; }
    const seq = out.length; out.push(e);
    if (e.kind === "genesis") world = worldIdOf(e); if (e.kind === "state") applyInPlace(v4, opsOf(e), seq); return seq; };
  const genesis = oldEntries[0]?.verb === "genesis" ? oldEntries[0].args : { v: 1, dialect: "eidoverse-log", implicit: true };
  const owners = Object.entries(genesis.roles ?? {}).filter(([, r]) => r?.role === "owner").map(([k]) => enc(k));
  push({ kind: "genesis", actor: "door", verb: "genesis", ...(Number.isInteger(oldEntries[0]?.ts) ? { ts: oldEntries[0].ts } : {}), body: { version: VERSION, owners, translatedFrom: unNegZero({ ...genesis, translator: TRANSLATOR, ...(foldBuild ? { fold: foldBuild } : {}) }) } });
  let prev = project(v1);
  for (const e of oldEntries) {
    if (e.verb === "genesis") continue;
    stats.verbs[e.verb] = (stats.verbs[e.verb] ?? 0) + 1;
    foldEntry(v1, e);
    const now = project(v1);
    const actor = enc(e.actor ?? "door"); if (actor !== e.actor) stats.renamed++;
    const ts = Number.isInteger(e.ts) ? e.ts : undefined; // §2.1: the door's admission time, carried from the old entry
    const tl = push({ ...(e.verb === "say" ? { kind: "say", actor, verb: "say", body: unNegZero(clone(e.args) ?? {}) }
      : { kind: "act", actor, verb: "legacy", body: unNegZero({ verb: e.verb, args: clone(e.args) ?? null, from: e.seq ?? null }) }), ...(ts !== undefined ? { ts } : {}) });
    const ops = diff(prev, now);
    if (ops.length) { push({ kind: "state", actor, cause: tl, ...stateBody(unNegZero(ops)), ...(ts !== undefined ? { ts } : {}) }); stats.state++; stats.ops += ops.length; }
    if (canon(v4project(v4)) !== canon(now)) { stats.divergences++; if (!stats.firstDivergence) { stats.firstDivergence = { oldSeq: e.seq, verb: e.verb }; onDivergence?.(e, now, v4project(v4)); } }
    prev = now;
  }
  stats.out = out.length;
  return { out, stats, final: { v1: project(v1), v4: v4project(v4) } };
}

