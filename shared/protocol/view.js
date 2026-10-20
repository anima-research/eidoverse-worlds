// shared/protocol/view.js — the fold as the records the renderer, the panels and the agent's tools read (slice 3c).
// PROTOCOL.md §0: "the scene a client draws … is a view: derived, disposable, rebuildable from the log." This is that
// view. A VIEW, not a protocol: no verbs, no second fold, nothing a reader can't rebuild from the fold itself. Pure;
// browser, server and agent run the same code.
//   viewOf(id, c)      one entity: its components, flat, in the protocol's own names — model, transform, sockets, label,
//                      light, … — plus the DERIVED conveniences every reader wants: pos / q / yaw (q's heading) / scale
//                      (one number) / scale3 (non-uniform, when it is) / parent {to, socket?, offset, q} (the local
//                      transform said as an offset). DERIVED names the derived set; recordComponents(rec) is the rest.
//   tf(c) / parentOf(c) / compOf(c)  the accessors every reader of a fold record shares (C7): its transform, its parent, its bag
//   viewState(folded) the whole world: {entities, sky, terrain, grass, assets, roles, bans, …}
//   - ids, roles and parent targets come back through names.dec (an imported world's x-- escapes undone);
//   - imported:<field> (a field an imported world's translation carried) → that field;
//   - @world: roles:<id> → roles, default-role → roles['*'], imported-bans:<id> → bans, assets:<k> → assets,
//     sky/terrain/grass → themselves, imported:<k> → st[k]. Not shown: physics-engine, about, bounds, spawn, imported-behavior:<k>.
// Until 2026-10-14 this record spoke the old protocol's names (model as `lib`, every other component inside a `comp`
// bag): one vocabulary on the wire and another in every reader. tools/protocol/vocab-check.ts keeps the old one out.
import { dec } from "./names.js";
import { qNorm, qHeading } from "../rot.js";

export const idOut = (id) => dec(id) ?? id;
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const HIDDEN_WORLD = new Set(["physics-engine", "about", "bounds", "spawn"]);
const IMP = "imported:", IMP_BANS = "imported-bans:";
/** The record's derived fields (and its stamps): not components. The authority refuses a component named like one. */
export const DERIVED = new Set(["id", "pos", "q", "yaw", "scale", "scale3", "born", "kind", "actor", "ts", "placer"]);
/** The components on a record (its facts), without the derived fields. */
export const recordComponents = (rec) => { const out = {}; for (const k in rec ?? {}) if (!DERIVED.has(k)) out[k] = rec[k]; return out; };
export const emptyView = () => ({ entities: {}, terrain: null, grass: null, sky: null, water: null, assets: [], recentChat: [], chatTotal: 0, roles: {}, bans: {} });

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
 *  is told by ITS invariant — viewOf always writes `pos` — never by the fold's spelling: the authority accepts
 *  `delete {component: "transform"}`, so a record may be {label} alone (review S2-1). The limit: a world naming a
 *  component `pos` (the door refuses the bare name: DERIVED) would be misread. */
export const isFoldRecord = (x) => !!x && typeof x === "object" && !Array.isArray(x) && x.pos === undefined;
/** A record either way: a fold record (component keys flat on it) is projected through viewOf; anything else — the OLD test
 *  shape, {pos, yaw, lib, comp: {...}} — is returned as it is. This is a TEST-CORPUS adapter, not a protocol one: at 2026-10-14
 *  18 files under tools/ still build the old shape by hand, and this line is what keeps them loading (complexity sweep 10-14,
 *  "vocab-check skips tools/"). Retire it by flattening those fixtures, then deleting the fallback; nothing at runtime takes
 *  the old shape (vocab-check pins that for shared/ client/ server/ mcpl/). */
export const recordOf = (x, id = "") => (isFoldRecord(x) ? viewOf(id, x) : x);

/** One entity's components as the record readers use. */
export function viewOf(id, c) {
  const rec = {};
  const t = tf(c);
  rec.pos = t.pos; rec.yaw = t.yaw; rec.q = t.q; rec.scale = t.scale;
  if (t.scale3) rec.scale3 = t.scale3;
  const p = parentOf(c);
  if (p) rec.parent = { ...p, offset: t.pos.slice(), q: t.q.slice() };
  for (const [k, v] of Object.entries(c)) {
    if (k === "transform" || k === "parent" || k.startsWith(IMP)) continue;
    rec[idOut(k)] = clone(v);
  }
  // what an imported world's translation carried (imported:<name>) shows under its name only where nothing else does: the
  // active component (translation splits a component's unknown fields off into imported:<it>), the derived pose fields and
  // the parent stay as they are
  for (const [k, v] of Object.entries(c)) if (k.startsWith(IMP)) { const n = idOut(k.slice(IMP.length)); if (!(n in rec) && !DERIVED.has(n) && n !== "parent") rec[n] = clone(v); }
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
        if (k === "sky" || k === "terrain" || k === "grass" || k === "water") st[k] = clone(v);   // water: its own component (shape audit 10-16)
        else if (k === "default-role") st.roles["*"] = clone(v);
        else if (k.startsWith("roles:")) st.roles[idOut(k.slice(6))] = clone(v);
        else if (k.startsWith(IMP_BANS)) st.bans[idOut(k.slice(IMP_BANS.length))] = clone(v);
        else if (k.startsWith("assets:")) st.assets.push(v && typeof v === "object" && Object.keys(v).length ? clone(v) : idOut(k.slice("assets:".length)));
      }
      // what translation carried (imported:<name>) fills only a slot nothing else holds, as on a thing (viewOf): never
      // the world's active sky, terrain, grass or water, nor the view's own fields (entities, roles, bans, assets, chat)
      for (const [k, v] of Object.entries(c)) if (k.startsWith(IMP)) { const n = idOut(k.slice(IMP.length)); if (st[n] == null) st[n] = clone(v); }
      continue;
    }
    st.entities[idOut(id)] = { ...viewOf(id, c), born: folded.entities[id].born };
  }
  return st;
}
