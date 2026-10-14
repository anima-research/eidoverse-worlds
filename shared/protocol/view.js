// shared/protocol/view.js — the fold as the records the renderer, the panels and the agent's tools read (slice 3c).
// PROTOCOL.md §0: "the scene a client draws … is a view: derived, disposable, rebuildable from the log." This is that
// view. A VIEW, not a protocol: no verbs, no second fold, nothing a reader can't rebuild from the fold itself. Pure;
// browser, server and agent run the same code.
//   viewOf(id, c)      one entity: its components, flat, in the protocol's own names — model, transform, sockets, label,
//                      light, … — plus the DERIVED conveniences every reader wants: pos / q / yaw (q's heading) / scale
//                      (one number) / scale3 (non-uniform, when it is) / parent {to, socket?, offset, q} (the local
//                      transform said as an offset). DERIVED names the derived set; recordComponents(rec) is the rest.
//   viewState(folded) the whole world: {entities, sky, terrain, grass, assets, roles, bans, …}
//   - ids, roles and parent targets come back through names.dec (an imported world's x-- escapes undone);
//   - imported:<field> (a field an imported world's translation carried) → that field;
//   - @world: roles:<id> → roles, default-role → roles['*'], imported-bans:<id> → bans, assets:<k> → assets,
//     sky/terrain/grass → themselves, imported:<k> → st[k]. Not shown: physics-engine, imported-epoch, about, bounds, spawn, imported-behavior:<k>.
// Until 2026-10-14 this record spoke the old protocol's names (model as `lib`, every other component inside a `comp`
// bag): one vocabulary on the wire and another in every reader. tools/protocol/vocab-check.ts keeps the old one out.
import { dec } from "./names.js";
import { qNorm, qHeading } from "../rot.js";

export const idOut = (id) => dec(id) ?? id;
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const HIDDEN_WORLD = new Set(["physics-engine", "imported-epoch", "about", "bounds", "spawn"]);
const IMP = "imported:", IMP_BANS = "imported-bans:";
/** The record's derived fields (and its stamps): not components. The authority refuses a component named like one. */
export const DERIVED = new Set(["id", "pos", "q", "yaw", "scale", "scale3", "born", "kind", "actor", "ts", "placer"]);
/** The components on a record (its facts), without the derived fields. */
export const recordComponents = (rec) => { const out = {}; for (const k in rec ?? {}) if (!DERIVED.has(k)) out[k] = rec[k]; return out; };
export const emptyView = () => ({ entities: {}, terrain: null, grass: null, sky: null, assets: [], recentChat: [], chatTotal: 0, roles: {}, bans: {} });

/** One entity's components as the record readers use. */
export function viewOf(id, c) {
  const rec = {};
  const t = c.transform ?? {};
  rec.pos = Array.isArray(t.pos) && t.pos.length === 3 ? t.pos.slice() : [0, 0, 0];
  const qn = qNorm(t.q) ?? [0, 0, 0, 1];
  rec.yaw = qHeading(qn); rec.q = qn;
  const s = Array.isArray(t.scale) && t.scale.length === 3 ? t.scale : [1, 1, 1];
  rec.scale = s[0] === s[1] && s[1] === s[2] ? s[0] : s[1];
  if (!(s[0] === s[1] && s[1] === s[2])) rec.scale3 = s.slice();
  const p = c.parent;
  if (p && typeof p.to === "string") rec.parent = { to: idOut(p.to), ...(typeof p.socket === "string" ? { socket: p.socket } : {}), offset: rec.pos.slice(), q: qn.slice() };
  for (const [k, v] of Object.entries(c)) {
    if (k === "transform" || k === "parent") continue;
    if (k.startsWith(IMP)) { rec[idOut(k.slice(IMP.length))] = clone(v); continue; }
    rec[idOut(k)] = clone(v);
  }
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
