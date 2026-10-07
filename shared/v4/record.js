// shared/v4/record.js — the v4 fold as the records the renderer, the panels and the agent's tools read (slice 3c).
// A VIEW, not a protocol: no verbs, no second fold. Pure; browser, server and agent run the same code.
//   viewOf(id, c)      one entity: {lib, pos, q, yaw, scale (one number), scale3? (non-uniform), parent?, comp?, …}
//   viewState(v4st)    the whole world: {entities, sky, terrain, grass, assets, roles, bans, …}
// The record's field names are the ones every reader already uses (it began life as legacy.js's projection):
//   - ids, roles and parent targets come back through names.dec (the translator's x-- escapes undone);
//   - transform → pos / q (+ yaw = q's heading) / scale; a non-uniform scale also rides as scale3 [x,y,z] (R 10-04);
//   - parent {to, order, slot?} (transform LOCAL to it) → parent {to, slot?, offset, q};
//   - model → lib; every other component → comp.<name>; legacy:<field> (a field an imported world's translation carried) → that field;
//   - @world: roles:<id> → roles, default-role → roles['*'], bans:<id> → bans, palette:<k> → assets,
//     sky/terrain/grass → themselves, legacy:<k> → st[k]. Not shown: sim, epoch, about, bounds, spawn, behavior:<k>.
import { dec } from "./names.js";
import { qNorm, qHeading } from "../rot.js";

export const idOut = (id) => dec(id) ?? id;
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const HIDDEN_WORLD = new Set(["sim", "epoch", "about", "bounds", "spawn"]);
export const emptyView = () => ({ entities: {}, terrain: null, grass: null, sky: null, assets: [], recentChat: [], chatTotal: 0, roles: {}, bans: {} });

/** One v4 entity's components as the record readers use. */
export function viewOf(id, c) {
  const rec = {};
  if (typeof c.model === "string") rec.lib = c.model;
  const t = c.transform ?? {};
  rec.pos = Array.isArray(t.pos) && t.pos.length === 3 ? t.pos.slice() : [0, 0, 0];
  const qn = qNorm(t.q) ?? [0, 0, 0, 1];
  rec.yaw = qHeading(qn); rec.q = qn;
  const s = Array.isArray(t.scale) && t.scale.length === 3 ? t.scale : [1, 1, 1];
  rec.scale = s[0] === s[1] && s[1] === s[2] ? s[0] : s[1];
  if (!(s[0] === s[1] && s[1] === s[2])) rec.scale3 = s.slice();
  const p = c.parent;
  if (p && typeof p.to === "string") rec.parent = { to: idOut(p.to), ...(typeof p.slot === "string" ? { slot: p.slot } : {}), offset: rec.pos.slice(), q: qn.slice() };
  for (const [k, v] of Object.entries(c)) {
    if (k === "model" || k === "transform" || k === "parent") continue;
    if (k.startsWith("legacy:")) { rec[idOut(k.slice(7))] = clone(v); continue; }
    (rec.comp ??= {})[idOut(k)] = clone(v);
  }
  return rec;
}

/** The whole v4 fold as the world view. chat: an optional recentChat window to carry (chat isn't in the fold). */
export function viewState(v4st, { recentChat = [], chatTotal = 0 } = {}) {
  const st = emptyView();
  st.recentChat = clone(recentChat); st.chatTotal = chatTotal;
  for (const id of Object.keys(v4st.entities ?? {})) {
    const c = v4st.entities[id].c;
    if (id === "@world") {
      for (const [k, v] of Object.entries(c)) {
        if (HIDDEN_WORLD.has(k) || k.startsWith("behavior:")) continue;
        if (k === "sky" || k === "terrain" || k === "grass") st[k] = clone(v);
        else if (k === "default-role") st.roles["*"] = clone(v);
        else if (k.startsWith("roles:")) st.roles[idOut(k.slice(6))] = clone(v);
        else if (k.startsWith("bans:")) st.bans[idOut(k.slice(5))] = clone(v);
        else if (k.startsWith("palette:")) st.assets.push(v && typeof v === "object" && Object.keys(v).length ? clone(v) : idOut(k.slice(8)));
        else if (k.startsWith("legacy:")) st[idOut(k.slice(7))] = clone(v);
      }
      continue;
    }
    st.entities[idOut(id)] = { ...viewOf(id, c), born: v4st.entities[id].born };
  }
  return st;
}
