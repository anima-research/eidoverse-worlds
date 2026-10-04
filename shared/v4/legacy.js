// shared/v4/legacy.js — the compatibility projection (slice 2): a v4 world, shown to TODAY's client, which still
// folds v1. Three pieces, all pure:
//   legacyState(v4state)      the v4 fold read as a v1 WorldState (the shape shared/fold.js builds);
//   legacyDelta(prev, next)   the v1 verbs that take a client holding `prev` to `next` (null when no verb can);
//   sameLegacy(a, b)          the comparison the server checks every delta with: it folds the verbs with the
//                             client's OWN fold (shared/fold.js) and compares the result with a fresh projection.
// A delta that doesn't reproduce the projection is never sent; the server re-sends the whole state instead (a
// "resync", the reconnect path). So what a client holds is checked against the v4 fold after every request.
//
// What the projection says, and what it can't (research 37 has the table):
//   - ids, roles and parent targets come back through names.dec (the translator's x-- escapes undone), so a person
//     sees the names they typed; an h-- (hashed) name stays hashed;
//   - transform → pos / q (+ yaw = q's heading) / scale. v1 scale is one number: a non-uniform v4 scale shows its
//     y factor (lossy, named); a uniform one is exact;
//   - a parent ({to, order, slot?}: transform LOCAL to it, whether the door or translate-v1@2 wrote it) → v1
//     `parent {to, slot?, offset, q}` (slice 3a retired the `order` stopgap that told translate-v1@1's carried v1
//     records apart; a world translated by @1 should be translated again);
//   - model → lib; every other component → comp.<name> (so `lock` is comp.lock: the same lock, PROTOCOL-v4 §5);
//     legacy:<field> (a v1 field the translator carried) → that field;
//   - @world: roles:<id> → roles, default-role → roles['*'], bans:<id> → bans, palette:<k> → assets,
//     sky/terrain/grass → themselves, legacy:<k> → st[k].
//   - NOT projected: @world.sim (v4 physics: old clients see things jump to rest), behavior:<k> (scripts don't run in
//     v4 worlds yet), epoch (the v1 sim), about/bounds/spawn (no v1 field), actor/ts/placer (views over the log).
import { dec } from "./names.js";
import { foldEntry, emptyState as v1Empty } from "../fold.js";
import { qNorm, qHeading } from "../rot.js";

const idOut = (id) => dec(id) ?? id;
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const NOT_PROJECTED_WORLD = new Set(["sim", "epoch", "about", "bounds", "spawn"]);
/** The v1 fields a delta never carries (views, or per-entry stamps the client folds from its own entries). */
export const LEGACY_DROPPED = ["actor", "ts", "born", "placer"];

/** One v4 entity as a v1 record. */
export function legacyEntity(id, c) {
  const rec = {};
  if (typeof c.model === "string") rec.lib = c.model;
  const t = c.transform ?? {};
  rec.pos = Array.isArray(t.pos) && t.pos.length === 3 ? t.pos.slice() : [0, 0, 0];
  const qn = qNorm(t.q) ?? [0, 0, 0, 1];
  rec.yaw = qHeading(qn); rec.q = qn;
  const s = Array.isArray(t.scale) && t.scale.length === 3 ? t.scale : [1, 1, 1];
  rec.scale = s[0] === s[1] && s[1] === s[2] ? s[0] : s[1];
  const p = c.parent;
  // every parent is the door's shape now (translate-v1@2 writes it too): the transform is LOCAL to the parent, which is
  // exactly v1's offset + q. A socket name rides along for the UI; with an explicit offset v1 draws it at the offset.
  if (p && typeof p.to === "string") rec.parent = { to: idOut(p.to), ...(typeof p.slot === "string" ? { slot: p.slot } : {}), offset: rec.pos.slice(), q: qn.slice() };
  for (const [k, v] of Object.entries(c)) {
    if (k === "model" || k === "transform" || k === "parent") continue;
    if (k.startsWith("legacy:")) { rec[idOut(k.slice(7))] = clone(v); continue; }
    (rec.comp ??= {})[idOut(k)] = clone(v);
  }
  return rec;
}

/** The v4 fold (fold.js's state) as a v1 WorldState. chat: an optional v1 recentChat window to carry. */
export function legacyState(v4st, { recentChat = [], chatTotal = 0 } = {}) {
  const st = v1Empty();
  st.recentChat = clone(recentChat); st.chatTotal = chatTotal;
  for (const id of Object.keys(v4st.entities ?? {})) {
    const c = v4st.entities[id].c;
    if (id === "@world") {
      for (const [k, v] of Object.entries(c)) {
        if (NOT_PROJECTED_WORLD.has(k) || k.startsWith("behavior:")) continue;
        if (k === "sky" || k === "terrain" || k === "grass") st[k] = clone(v);
        else if (k === "default-role") st.roles["*"] = clone(v);
        else if (k.startsWith("roles:")) st.roles[idOut(k.slice(6))] = clone(v);
        else if (k.startsWith("bans:")) st.bans[idOut(k.slice(5))] = clone(v);
        else if (k.startsWith("palette:")) st.assets.push(v && typeof v === "object" && Object.keys(v).length ? clone(v) : idOut(k.slice(8)));
        else if (k.startsWith("legacy:")) st[idOut(k.slice(7))] = clone(v);
      }
      continue;
    }
    st.entities[idOut(id)] = { ...legacyEntity(id, c), born: v4st.entities[id].born };
  }
  return st;
}

// ---- comparison: what a client would hold vs the projection ----
const EPS = 1e-9;
function near(a, b) {
  if (typeof a === "number" && typeof b === "number") return a === b || Math.abs(a - b) <= EPS * Math.max(1, Math.abs(a), Math.abs(b));
  if (Array.isArray(a) || Array.isArray(b)) return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => near(x, b[i]));
  if (a && b && typeof a === "object" && typeof b === "object") { const ka = Object.keys(a).filter((k) => a[k] !== undefined), kb = Object.keys(b).filter((k) => b[k] !== undefined);
    return ka.length === kb.length && ka.every((k) => Object.hasOwn(b, k) && near(a[k], b[k])); }
  return a === b;
}
const shapeOf = (e) => { const out = {}; for (const [k, v] of Object.entries(e ?? {})) if (!LEGACY_DROPPED.includes(k)) out[k] = v; return out; };
const WORLD_KEYS = ["sky", "terrain", "grass", "assets", "roles", "bans", "blueprints"];
/** First difference between two v1 states (entities by shape, the world's fields), or null. */
export function legacyDiff(a, b) {
  for (const id of new Set([...Object.keys(a.entities), ...Object.keys(b.entities)]))
    if (!near(shapeOf(a.entities[id]), shapeOf(b.entities[id]))) return { id, have: a.entities[id] ?? null, want: b.entities[id] ?? null };
  for (const k of WORLD_KEYS) { const x = a[k] ?? (k === "assets" ? [] : k === "roles" || k === "bans" ? {} : null), y = b[k] ?? (k === "assets" ? [] : k === "roles" || k === "bans" ? {} : null);
    if (!near(x, y)) return { world: k, have: x, want: y }; }
  return null;
}
export const sameLegacy = (a, b) => legacyDiff(a, b) === null;

// ---- the delta: v1 verbs from one projection to the next ----
const ORIENT = (e) => ({ q: e.q });
const SPAWN_KEYS = new Set(["lib", "pos", "yaw", "q", "scale", "collide", "comp", "parent", ...LEGACY_DROPPED]);
/** The v1 verbs (as {verb, args}) that take `prev` to `next`, or null if some change has no v1 spelling. Entities
 *  only change through spawn / place / mount / dismount / comp / remove; roles through grant; terrain and grass
 *  through their own verbs. Anything else (a sky, a removed role, a v1 field a verb can't write) → null: resync. */
export function legacyDelta(prev, next) {
  const out = [];
  const P = prev.entities, N = next.entities;
  for (const id of Object.keys(P)) if (!N[id]) out.push({ verb: "remove", args: { id } });
  for (const [id, n] of Object.entries(N)) {
    const p = P[id];
    for (const k of Object.keys(n)) if (!SPAWN_KEYS.has(k) && !near(n[k], p?.[k])) return null; // a carried v1 field with no verb
    const fresh = !p || (p.lib ?? null) !== (n.lib ?? null) || p.kind !== n.kind;
    if (fresh) {
      if (p) out.push({ verb: "remove", args: { id } });
      out.push({ verb: "spawn", args: { id, ...(n.lib != null ? { lib: n.lib } : {}), pos: n.pos, ...ORIENT(n), scale: n.scale, ...(n.collide != null ? { collide: n.collide } : {}) } });
    } else if (!near(p.pos, n.pos) || !near(p.q, n.q) || !near(p.scale, n.scale)) {
      out.push({ verb: "place", args: { id, pos: n.pos, ...ORIENT(n), scale: n.scale } });
    }
    if (!near(fresh ? undefined : p?.parent, n.parent)) {
      if (n.parent) out.push({ verb: "mount", args: { id, ...n.parent } });
      else out.push({ verb: "dismount", args: { id, pos: n.pos, ...ORIENT(n) } });
    }
    const pc = fresh ? {} : p.comp ?? {}, nc = n.comp ?? {};
    for (const type of new Set([...Object.keys(pc), ...Object.keys(nc)])) {
      if (type === "captions") return null; // the v1 fold refuses a comp of this type (one writer: the caption verb)
      if (!near(pc[type], nc[type])) out.push({ verb: "comp", args: { id, type, data: nc[type] ?? null } });
    }
  }
  const pr = prev.roles ?? {}, nr = next.roles ?? {};
  for (const k of Object.keys(pr)) if (!nr[k]) return null; // v1 has no "ungrant"
  for (const [k, v] of Object.entries(nr)) if (!near(pr[k], v)) {
    if (k === "*" || !v || typeof v !== "object") return null;
    out.push({ verb: "grant", args: { id: k, role: v.role, gen: !!v.gen, fly: !!v.fly, ...(v.sub ? { sub: v.sub } : {}) } });
  }
  if (!near(prev.terrain ?? null, next.terrain ?? null)) { if (next.terrain == null) return null; out.push({ verb: "terrain", args: next.terrain }); }
  if (!near(prev.grass ?? null, next.grass ?? null)) out.push({ verb: "grass", args: next.grass ?? { clear: true } });
  for (const k of ["sky", "assets", "bans", "blueprints"]) if (!near(prev[k] ?? null, next[k] ?? null) && !(k === "assets" && !(prev[k]?.length) && !(next[k]?.length)) && !(k === "bans" && !Object.keys(prev[k] ?? {}).length && !Object.keys(next[k] ?? {}).length)) return null;
  return out;
}

/** Fold v1 entries into a COPY of a v1 state with the client's own fold. */
export function foldLegacy(st, entries) {
  const s = clone(st);
  for (const e of entries) foldEntry(s, e);
  return s;
}
