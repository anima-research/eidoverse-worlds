// shared/protocol/authority/capacity.js — how much a world holds: this server's CAPACITY defaults and the CAPACITY_CEILING
// an owner may raise them to, the world's own @world.capacity, the guests' shared budget, and the check a write that adds
// entities meets (refactor split, 2026-10-17; moved from authority.js's gate section unchanged).
import { resolveVersioned } from "../componentspec.js";
import { CTX } from "./ctx.js";
import { refuse } from "./refuse.js";
import { isE, opsQuiet } from "./storage.js";
import { SOCKETS_PER_HOST, isSocketC } from "./sockets.js";
import { RESERVED, entryBy } from "./rights.js";

// How much a world holds (review 10-06 S0-2, security pass 2; ONE budget since R 10-15 22:48): at most
// @world.capacity.entities entities, every one but @world, sockets included (a socket is a child entity); and the world's
// account-less people TOGETHER at most capacity.guestEntities standing entities they made: a guest is a fresh identity
// per connection, so no per-identity budget stopped one from filling a world. Only a write that adds entities is refused
// (full); deleting, and every other change, stay open at the cap. capacity.avatar isn't enforced (no avatar trees yet).
// CAPACITY is this server's default for each absent field, and CAPACITY_CEILING the most an owner may set: server policy
// (PROTOCOL §9.2), reported by schema, never pinned in the registry. entities 10 000 is what scale-check C2 fills under
// budget; 50 000 is the owner's ceiling, not measured.
export const CAPACITY = { entities: 10000, guestEntities: 500, avatar: 2000 };
export const CAPACITY_CEILING = { entities: 50000, guestEntities: 50000, avatar: 5000 };
const capacityOf = (st) => { const ok = (x) => Number.isInteger(x) && x >= 0;
  // read through the registry's one versioned-name reader (§4); with no capacity@n registered it is plain `capacity`
  const { name, value: v } = resolveVersioned(st.entities["@world"]?.c, "capacity"); const D = CAPACITY;
  return { ...Object.fromEntries(Object.keys(D).map((k) => [k, ok(v?.[k]) ? v[k] : D[k]])), name }; };   // name: the registry key the world is read under, for refusals to cite
// Whose rights made a thing count in the guests' pool: an identity the directory calls anonymous, or one it doesn't know
// at all. The directory writes every account and imported identity (a translated world's are written with it) and never
// an anonymous one, which lives only in the process that minted it. So after a restart an earlier guest is an id nobody
// here knows, and what it made still counts. The rule rests on every other actor having a directory entry here: a
// creator from before the directory, or from a world made on another server, counts too (said apart in the refusal).
// The authority's own identities and an unknown author (a purged cause: null) are nobody's guest; with no directory,
// nobody is. → "anon" | "unknown" | null
const guestKind = (w, id) => { if (typeof id !== "string" || !w.kindOf || RESERVED.has(id)) return null; const k = w.kindOf(id);
  return k === "anon" ? "anon" : k == null ? "unknown" : null; };
// how many entities in the guests' pool still stand in st, how many of those an unknown creator made, and how many of
// them the write's state s no longer holds (a log view, kept incrementally like everIds)
/** The scan behind guestMade: made (id → its creator's rights, while it stands) and the ids whose kind isn't read yet
 *  (pending). A host seeds {n, made} from its fold cache (server/foldviews.ts), every id pending, as a scan from genesis has it. */
export function guestScan(w, G = (w.__guests ??= { n: 0, made: new Map(), pending: new Map(), ids: new Map() })) {
  for (; G.n < w.entries.length; G.n++) { const e = w.entries[G.n]; if (!isE(e) || e.kind !== "change") continue; let rights;
    for (const o of opsQuiet(e)) { if (o.verb === "create") { if (rights === undefined) rights = entryBy(w, e).rights; G.made.set(o.id, rights); G.pending.set(o.id, rights); } else if (o.verb === "delete" && o.comp === undefined) { G.made.delete(o.id); G.pending.delete(o.id); G.ids.delete(o.id); } } }
  return G;
}
function guestMade(w, st, s = st) {
  const G = guestScan(w); G.seeded = false;
  for (const [id, r] of G.pending) { const kind = guestKind(w, r); if (kind) G.ids.set(id, kind); } G.pending.clear();   // a kind is read once, at the first call after its create
  let n = 0, unknown = 0, gone = 0; for (const [id, k] of G.ids) if (st.entities[id]) { n++; if (k === "unknown") unknown++; if (!s.entities[id]) gone++; }
  return { n, unknown, gone };
}
const entityCount = (st) => Object.keys(st.entities).length - (st.entities["@world"] ? 1 : 0);
function capacityCheck(w, st, s, who, norm) {
  if (who.lifting) return;   // the maintenance command's lift carries what the log already holds (sockets in the old spelling): never refused
  const made = norm.filter((o) => o.verb === "create" && s.entities[o.id]).length;
  // the hosts that sockets join in this write (made, re-parented onto one, or a thing made one): one holds at most SOCKETS_PER_HOST
  const joined = new Set();
  for (const id of new Set(norm.map((o) => o.id))) { const now = s.entities[id]?.c, was = st.entities[id]?.c;
    const h = isSocketC(now) ? now.parent?.to : null; if (h && (!isSocketC(was) || was.parent?.to !== h)) joined.add(h); }
  if (!made && !joined.size) return;
  const cap = capacityOf(s);
  if (made) { const before = entityCount(st), after = entityCount(s);
    if (after > before && after > cap.entities) refuse("full", `this world holds ${before} entities and its limit is ${cap.entities} (@world.${cap.name}.entities): ${after - before} more won't fit (every entity counts, sockets too)`, `delete something first; the world's owner may raise it: set {id: '@world', component: '${cap.name}', value: {entities: <n>}, merge: true} (at most ${CAPACITY_CEILING.entities} on this server)`, { limit: cap.entities, entities: before }); }
  if (joined.size) { const per = new Map([...joined].map((h) => [h, [0, 0]]));
    for (const e of Object.values(s.entities)) { const h = isSocketC(e.c) ? e.c.parent?.to : null; if (per.has(h)) per.get(h)[1]++; }
    for (const e of Object.values(st.entities)) { const h = isSocketC(e.c) ? e.c.parent?.to : null; if (per.has(h)) per.get(h)[0]++; }
    for (const [h, [before, after]] of per) if (after > before && after > SOCKETS_PER_HOST) refuse("full", `${h} has ${before} sockets, and one thing holds at most ${SOCKETS_PER_HOST}: ${after - before} more won't fit`, "a thing with that many seats is several things: split it, or delete some of its sockets", { limit: SOCKETS_PER_HOST, sockets: before, host: h }); }
  if (!made) return;
  const holder = who.cap?.kind === "reaction" ? who.cap.author : who.cap?.kind === "script" ? who.cap.sponsor : who.actor;
  if (!CTX.isAnon(holder)) return;
  // as the world's own cap reads it: a write that leaves the pool no bigger is never refused (a delete in the same request
  // makes room), and one that grows it past the limit is
  const { n: g, unknown, gone } = guestMade(w, st, s); if (made <= gone || g - gone + made <= cap.guestEntities) return;
  const whose = unknown ? `things by account-less people (guests), and ${unknown} by creators this server doesn't know (a guest from before a restart, or someone from before its directory or another server), together make ${g}` : `account-less people (guests) together have ${g} entities standing here`;
  refuse("full", `${whose}, and this world lets them have ${cap.guestEntities} (@world.${cap.name}.guestEntities), all of them together: ${made - gone} more won't fit`, `delete something the guests made first (a delete in the same request makes room), sign in to build more, or ask the world's owner to raise it: set {id: '@world', component: '${cap.name}', value: {guestEntities: <n>}, merge: true} (at most ${CAPACITY_CEILING.guestEntities} on this server)`, { limit: cap.guestEntities, entities: g });
}
export { capacityCheck };
