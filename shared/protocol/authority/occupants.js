// shared/protocol/authority/occupants.js — who occupies what (presence, never logged): a body occupying a station (sitting,
// today), setting and clearing it, vacating it when what it occupies is moved or let go, and the occupant rule that keeps a
// thing someone occupies from being kicked, shoved, grabbed or thrown out from under them (refactor split, 2026-10-17, as
// riders.js; occupants.js since R 10-17 13:46: occupy is the one word family; moved from
// authority.js's "physics" section unchanged; occupyRights, a socket joining a host, from its gate section). lastTouch,
// lacks, lockCheck and needWords (the write path's and the gate's) are above it, reached through UP.
import { TRACK } from "../../mover.js";
import { baseOf } from "../componentspec.js";
import { offChain } from "../simlayer.js";
import { feetOn } from "../../shove.js";
import { r3 } from "../round.js";
import { UP } from "./ctx.js";
import { refuse, said } from "./refuse.js";
import { lockedC } from "./storage.js";
import { aabb, ancestors, descendants, worldT } from "./math.js";
import { isSocketC } from "./sockets.js";
// the layers above this one (a leaf may not import them: authority-layers-check), reached through UP (ctx.js), which
// authority.js binds at load
const lacks = (...a) => UP.lacks(...a);
const lastTouch = (...a) => UP.lastTouch(...a);
const lockCheck = (...a) => UP.lockCheck(...a);
const needWords = (...a) => UP.needWords(...a);

// A body that walks more than a metre from its seat has stood up (a seated client sends no steps; standing, it walks)
// Who sits where (presence, never logged: review 10-12 S1-1): {to: <socket id>}. A seat whose socket is gone or switched
// off is no seat (its occupant was let go by every client), so a reader never sees one.
function occupantOf(w, st, who) { const s = w.presence.occupants?.[who];
  return s && typeof s.to === "string" && isSocketC(st.entities[s.to]?.c) && !offChain(st, s.to) ? s : null; }
// `since`: the log's length when they sat (review r9 M1): what was written from then on isn't part of the ride they consented to
// `near`: the body was tracked within sitting reach when it sat (review r10 M1): only then does leaving re-anchor the track at the seat
const setOccupant = (w, who, to, near = false) => { (w.presence.occupants ??= {})[who] = { to, since: w.entries.length, ...(near ? { near: true } : {}) }; w.presenceDirty = true; };
const clearOccupant = (w, who) => { if (w.presence.occupants?.[who]) { delete w.presence.occupants[who]; w.presenceDirty = true; } };
// Leaving a seat is presence, like arriving (scars r9 M2): a seated client sends no steps, so the authority's track of the
// body is where it boarded. When the seat lets them go (vacated, the socket removed or switched off, or their own first
// step off it), the track starts again from the seat's world pose with a full speed budget, writing nothing to the log: the
// next step is measured from where they really are, never refused too-fast from the boarding point (which, in a world with
// a spawn, a non-builder couldn't teleport out of). The seat's logged pose (a motion's swing isn't evaluated here: the full
// budget covers it). Returns where, or null (no body tracked).
// Only for a body that boarded within reach (`near`, review r10 M1); otherwise the track stays where it was (a presence file from
// before r10 has no `near`: its riders keep their old track, the safe direction).
function vacateAt(w, st, who, seat) {
  const b = w.presence.bodies?.[who]; if (!b || !st?.entities[seat] || w.presence.occupants?.[who]?.near !== true) return null;
  const at = worldT(st, seat).pos.map(r3); if (!at.every(Number.isFinite)) return null;
  w.presence.bodies[who] = { ...b, at, ts: w.pace ? w.pace() : w.now(), tokens: TRACK.cap }; w.presenceDirty = true;
  return at;
}
// another present body seated on this socket (one body per socket: VRChat Station, Roblox Seat), or the thing sitting in it
function occupantOn(w, st, sock, actor) {
  for (const who of Object.keys(w.presence.occupants ?? {})) if (who !== actor && w.presence.bodies[who] && occupantOf(w, st, who)?.to === sock) return { who };
  const thing = Object.keys(st.entities).find((k) => st.entities[k].c.parent?.to === sock); return thing ? { thing } : null; }
function leftOccupied(w, st, actor, to) {
  const s = occupantOf(w, st, actor); if (!s) return clearOccupant(w, actor);
  const p = worldT(st, s.to).pos;
  if (Math.hypot(to[0] - p[0], to[2] - p[2]) > 1) clearOccupant(w, actor);
}
// Who a hand or a foot acting on `id` would move with it: another present body seated on it or on anything riding it, or
// standing on it or on anything riding it (review 10-12 S1-1/S1-2: a kick, a shove, a grab or a throw went round body
// consent through the chair). Bodies are presence and never things, so this is the only way one is moved by moving a thing.
function occupant(w, st, id, actor) {
  const fam = new Set([id, ...descendants(st, id)]);
  for (const who of Object.keys(w.presence.occupants ?? {})) { const s = occupantOf(w, st, who); if (who !== actor && s && fam.has(s.to)) return { who, how: "sits on" }; }
  const boxes = [...fam].map((k) => aabb(st, k)).filter(Boolean);
  for (const [who, b] of Object.entries(w.presence.bodies)) if (who !== actor && Array.isArray(b?.at) && boxes.some((x) => feetOn(x, b.at))) return { who, how: "is standing on" };
  return null;
}
// Riders (scars r8 M1 / holes M2; replaces consent gaps 1's occupant check on edits): sitting is consent, standing up is the
// exit (Second Life's sit, VRChat's station). A seat carries its rider through whatever moves it, and an edit never waits on
// or is refused for a body on it:
//   - an edit by anyone but the rider that would move a seat someone sits on (transform, parent or motion of the seat or of
//     anything it hangs from) VACATES each occupant on it, every one, not the first found: the edit lands, the rider is let go
//     where they were, standing (presence, nothing logged), and told why (their inbox, and a note in the reply);
//   - what the seat's own assembly does to it is the ride: a reaction or a script on a thing with the same root as the seat
//     (a swing's push, a carousel's turn, an elevator's script) carries its riders, whoever pressed the button;
//   - moving the seat you sit on yourself is yours: you stay seated (others on it are let go);
//   - a standing body never blocks an edit and is never a reason to refuse one: what you stand on carries you, as ever (the
//     client's own walker keeps you on it). A griefer can't freeze an owner's stage by standing on it.
// The authority's follow-ups (rest, system), a hand (handle: the hand verbs refuse `occupied` themselves, before admit), the
// load's lift and a fork's copy vacate no one.
const MOVES_BODIES = (comp) => comp === "transform" || comp === "parent" || baseOf(comp) === "motion";
function vacatesFor(w, st, who, norm) {
  const cap = who.cap; if (cap && ["rest", "system", "handle"].includes(cap.kind)) return [];
  const riders = Object.keys(w.presence.occupants ?? {}).filter((k) => k !== who.actor); if (!riders.length) return [];
  const rootOf = (id) => { const a = ancestors(st, id); return a.length ? a[a.length - 1] : id; };
  const from = cap?.kind === "reaction" ? cap.ids[0] : cap?.kind === "script" ? cap.id : null;   // the thing whose own behaviour this is
  const own = from && st.entities[from] ? rootOf(from) : null;
  // the ride is the assembly as it was when they sat (review r9 M1): the handler or script doing it, and every parent link from
  // its host up to the root, were last written before the rider sat. A reaction added to the chair after you sat, or a thing
  // hung under it since, is someone's edit, not the ride (a builder can't move an occupied seat in two steps)
  const key = cap?.kind === "reaction" ? "reactions" : cap?.kind === "script" ? cap.key : null;
  // (the authority's follow-ups aren't edits: a reference cleared on the seat since is skipped, claims r10 O3, as §5 says)
  const rideBefore = (since) => Number.isInteger(since) && [from, ...ancestors(st, from)].every((id, k) =>
    (lastTouch(w, id, "parent", { authored: true })?.seq ?? -1) < since && (k > 0 || (lastTouch(w, from, key, { authored: true })?.seq ?? Infinity) < since));
  const out = new Map();
  for (const op of norm) {
    if (op.verb === "create" || op.comp === undefined || !MOVES_BODIES(op.comp) || !st.entities[op.id]) continue;
    const fam = new Set([op.id, ...descendants(st, op.id)]);
    for (const r of riders) { if (out.has(r)) continue; const s = occupantOf(w, st, r); if (!s || !fam.has(s.to)) continue;
      if (own && rootOf(s.to) === own && rideBefore(s.since)) continue;   // the seat's own assembly moving it, as it was when they sat: the ride
      out.set(r, { who: r, socket: s.to, host: st.entities[s.to]?.c.parent?.to ?? null, id: op.id, field: op.comp }); } }
  return [...out.values()];
}
const vacateWhy = (u) => `${u.id}.${u.field} was changed by someone else, and it moves what ${u.who} occupied: they were let go where they were, standing (occupying is consent to its own ride, not to anyone's edit)`;
function occupiedRefuse(w, st, id, actor, what) {
  const o = occupant(w, st, id, actor);
  if (o) refuse("occupied", `${said(o.who)} ${o.how} ${id} (or something on it), so it can't be ${what}`, "wait till they get up or step off", { by: o.who });
}
// A socket is part of its host (review 10-12 S1-1): before the cut a seat was the host's own `sockets` component, so
// adding one to someone else's thing needed editOthers on it and an owner-level lock refused it. Now it's a child entity,
// and a create needs only build, and a lock check reads the op's own id. So a socket JOINING a host (made under it,
// re-parented onto it, or a thing under it made a socket) needs the host's rights (as `set <host>.sockets`), and every
// write touching a socket child (those, and any set or delete on one) meets the locks over its host's chain, the host it
// had and the host it ends on.
// The legacy map's lifted creates are in `norm`, so both spellings meet the same rule. A host made in this same write is
// the asker's own. The authority's follow-ups (rest, system: the load's lift) and a hand carry no seat edits.
function occupyRights(w, st, s, who, role, norm, made) {
  const cap = who.cap; if (cap && cap.kind !== "reaction" && cap.kind !== "script") return;
  const holder = cap?.kind === "reaction" ? cap.author : cap?.kind === "script" ? cap.sponsor : who.actor;
  const hosts = new Map(); const joins = new Set();
  for (const op of norm) { const was = st.entities[op.id]?.c, now = s.entities[op.id]?.c;
    const h0 = isSocketC(was) ? was.parent?.to : null, h1 = isSocketC(now) ? now.parent?.to : null;
    for (const h of [h0, h1]) if (h && !hosts.has(h)) hosts.set(h, op);
    if (h1 && h1 !== h0) joins.add(h1); }
  for (const [h, op] of hosts) { if (made.has(h) || !st.entities[h]) continue;
    const at = h + "'s sockets (" + op.verb + " " + op.id + (op.comp !== undefined ? "." + op.comp : "") + ")"; const as = { verb: "set", id: h, comp: "sockets" };
    // a socket joining h (made, re-parented onto it, or a thing made one) needs h's rights; an edit of a socket already
    // on h is judged on the socket's own rights in rights() (its creator, or the builder the load's lift names: RL4)
    const n = joins.has(h) ? lacks(w, st, holder, as, made, { viaCap: !!cap }) : null;
    const whose = cap ? " (" + said(holder) + "'s, whose rights this write carries)" : "; you are " + role;
    if (n) refuse("rights", "a socket is part of its host, so " + op.id + " is an edit of " + at + ": that needs " + needWords(n) + whose, "ask " + h + "'s builder or an owner; a socket on a thing of your own needs nothing more", { needs: n, host: h });
    const k = lockedC(st.entities[h]?.c) ? h : ancestors(st, h).find((x) => lockedC(st.entities[x]?.c));
    if (k) lockCheck(w, st, who, role, k, { ...as, id: op.id }, at); }
}
export { clearOccupant, leftOccupied, occupiedRefuse, occupantOf, occupyRights, setOccupant, occupantOn, vacateAt, vacateWhy, vacatesFor };
