// shared/protocol/view.js — the fold as the records the renderer, the panels and the agent's tools read (slice 3c).
// A VIEW, not a protocol: no verbs, no second fold. Pure; browser, server and agent run the same code.
//   tf(c) / parentOf(c) / compOf(c)  the accessors every reader of a fold record shares (C7): its transform, its parent, its bag
//   viewOf(id, c)      one entity: {lib, pos, q, yaw, scale (one number), scale3? (non-uniform), parent?, comp?, …}
//   viewState(folded) the whole world: {entities, sky, terrain, grass, assets, roles, bans, …}
// The record's field names are the ones every reader already uses (it began life as legacy.js's projection):
//   - ids, roles and parent targets come back through names.dec (the translator's x-- escapes undone);
//   - transform → pos / q (+ yaw = q's heading) / scale; a non-uniform scale also rides as scale3 [x,y,z] (R 10-04);
//   - parent {to, order, socket?} (transform LOCAL to it) → parent {to, socket?, offset, q};
//   - model → lib; every other component → comp.<name>; imported:<field> (a field an imported world's translation carried) → that field;
//   - @world: roles:<id> → roles, default-role → roles['*'], imported-bans:<id> → bans, assets:<k> → assets,
//     sky/terrain/grass → themselves, imported:<k> → st[k]. Not shown: physics-engine, imported-epoch, about, bounds, spawn, imported-behavior:<k>.
import { dec } from "./names.js";
import { qNorm, qHeading } from "../rot.js";

export const idOut = (id) => dec(id) ?? id;
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const HIDDEN_WORLD = new Set(["physics-engine", "imported-epoch", "about", "bounds", "spawn"]);
const IMP = "imported:", IMP_BANS = "imported-bans:";
export const emptyView = () => ({ entities: {}, terrain: null, grass: null, sky: null, assets: [], recentChat: [], chatTotal: 0, roles: {}, bans: {} });

/** The fold record's transform as readers hold it: {pos, q, yaw, scale (one number), scale3? ([x,y,z] when non-uniform)}.
 *  A missing or malformed part is its default (the origin, no turn, unit scale), never undefined. */
export function tf(c) {
  const t = c?.transform ?? {};
  const pos = Array.isArray(t.pos) && t.pos.length === 3 ? t.pos.slice() : [0, 0, 0];
  const q = qNorm(t.q) ?? [0, 0, 0, 1];
  const s = Array.isArray(t.scale) && t.scale.length === 3 ? t.scale : [1, 1, 1];
  const uniform = s[0] === s[1] && s[1] === s[2];
  return { pos, q, yaw: qHeading(q), scale: uniform ? s[0] : s[1], ...(uniform ? {} : { scale3: s.slice() }) };
}
/** The fold record's parent as readers hold it: {to (names.dec'd), socket?}, or null when it stands on its own. */
export function parentOf(c) {
  const p = c?.parent;
  return p && typeof p.to === "string" ? { to: idOut(p.to) } : null;
}
/** Is this key of a fold record a component (not its model/transform/parent, not an imported:* field)? */
export const isCompKey = (k) => k !== "model" && k !== "transform" && k !== "parent" && !k.startsWith(IMP);
/** The record's component keys, as the fold spells them. */
export const compKeys = (c) => Object.keys(c ?? {}).filter(isCompKey);
/** …and its [key, value] pairs. */
export const compEntries = (c) => Object.entries(c ?? {}).filter(([k]) => isCompKey(k));
/** The record's component bag (every key but model/transform/parent/imported:*), keys names.dec'd, values cloned; undefined when empty. */
export function compOf(c) {
  let comp;
  for (const [k, v] of Object.entries(c ?? {})) {
    if (!isCompKey(k)) continue;
    (comp ??= {})[idOut(k)] = clone(v);
  }
  return comp;
}

/** The one-line adapter the editor's entry points stand behind (C7b): a fold record `c` ({transform?, model?, parent?,
 *  …components}) reads as its view; a view record (the suites' fixtures, an agent's foldRecord) passes through. A view
 *  is told by ITS invariant — viewOf always writes `pos`, and the fixtures carry `lib`/`comp` — never by the fold's
 *  spelling: the authority accepts `delete {component: "transform"}`, so a record may be {label} alone (review S2-1).
 *  The limit: a world naming a component `pos`, `lib` or `comp` (the door refuses the bare names) would be misread. */
export const isFoldRecord = (x) => !!x && typeof x === "object" && !Array.isArray(x)
  && x.pos === undefined && x.lib === undefined && x.comp === undefined;
export const recordOf = (x, id = "") => (isFoldRecord(x) ? viewOf(id, x) : x);

/** One entity's components as the record readers use. */
export function viewOf(id, c) {
  const rec = {};
  if (typeof c.model === "string") rec.lib = c.model;
  const t = tf(c);
  rec.pos = t.pos; rec.yaw = t.yaw; rec.q = t.q; rec.scale = t.scale;
  if (t.scale3) rec.scale3 = t.scale3;
  const p = parentOf(c);
  if (p) rec.parent = { ...p, offset: t.pos.slice(), q: t.q.slice() };
  for (const [k, v] of Object.entries(c)) if (k.startsWith(IMP)) rec[idOut(k.slice(IMP.length))] = clone(v);
  const comp = compOf(c);
  if (comp) rec.comp = comp;
  return rec;
}

/** The whole fold as the world view. chat: an optional recentChat window to carry (chat isn't in the fold). */
export function viewState(folded, { recentChat = [], chatTotal = 0 } = {}) {
  const st = emptyView();
  st.recentChat = clone(recentChat); st.chatTotal = chatTotal;
  for (const id of Object.keys(folded.entities ?? {})) {
    const c = folded.entities[id].c;
    if (id === "@world") {
      for (const [k, v] of Object.entries(c)) {
        if (HIDDEN_WORLD.has(k) || k.startsWith("imported-behavior:")) continue;
        if (k === "sky" || k === "terrain" || k === "grass") st[k] = clone(v);
        else if (k === "default-role") st.roles["*"] = clone(v);
        else if (k.startsWith("roles:")) st.roles[idOut(k.slice(6))] = clone(v);
        else if (k.startsWith(IMP_BANS)) st.bans[idOut(k.slice(IMP_BANS.length))] = clone(v);
        else if (k.startsWith("assets:")) st.assets.push(v && typeof v === "object" && Object.keys(v).length ? clone(v) : idOut(k.slice("assets:".length)));
        else if (k.startsWith(IMP)) st[idOut(k.slice(IMP.length))] = clone(v);
      }
      continue;
    }
    st.entities[idOut(id)] = { ...viewOf(id, c), born: folded.entities[id].born };
  }
  return st;
}
