// shared/protocol/authority/sockets.js — sockets as child entities (PLAN-sockets-entities 2026-10-12). A socket is
// {transform, parent: {to: host}, socket: {name, part?, accepts?, radius?}, station?}: an attachment point with a pose of
// its own (Godot's Marker3D, Unity's child Transform), and what a person's body does there, its station (shape audit
// 10-16: once socket.body). What it is for is read from what it has, never stored: a seat if a station, a snap point if
// accepts, else an attach point.
import { REDACTED } from "../fold.js";
import { kidsMap } from "./spatial.js";
import { worldT } from "./math.js";

const bag = (v) => !!v && typeof v === "object" && !Array.isArray(v) && v !== REDACTED;
export const isSocketC = (c) => bag(c?.socket);
export { socketRole } from "../../sockbody.js";
// one host holds at most this many sockets (review 10-12 S1-2): a seat map past it is several things. No setting raises it;
// a socket is an entity, so it also counts in @world.capacity.entities (authority.js CAPACITY)
export const SOCKETS_PER_HOST = 64;
const UNIT = (sc) => sc === undefined || (Array.isArray(sc) && sc.length === 3 && sc.every((x) => x === 1));

/** The door's rules for socket entities, over the state a write leaves: the first that breaks, as {code, reason, fix}, or
 *  null. Only the sockets the write touches are read, and their siblings. */
export function socketRules(s, ids) {
  let kids = null;
  const kidsOf = (p) => { if (!kids) { kids = new Map(); for (const [k, e] of Object.entries(s.entities)) { const to = e.c.parent?.to; if (to) { let a = kids.get(to); if (!a) kids.set(to, (a = [])); a.push(k); } } } return kids.get(p) ?? []; };
  const hosts = new Set();
  for (const id of ids) { const e = s.entities[id]; if (!e) continue;
    if (!isSocketC(e.c)) { if (bag(e.c.station)) return { code: "shape", reason: `${id} has a station but no socket: a station is what a body does at a socket`, fix: `give it a socket {name} (a child of the thing it belongs to), or delete station` }; continue; }
    const host = e.c.parent?.to;
    if (!host) return { code: "shape", reason: `${id} is a socket, and a socket needs a host`, fix: `give it parent {to: <the thing it belongs to>}, or delete it` };
    if (isSocketC(s.entities[host]?.c)) return { code: "shape", reason: `${id} is a socket, and ${host} is a socket too: a socket hangs on a thing, never on another socket`, fix: `parent it to ${s.entities[host].c.parent?.to ?? "the thing it belongs to"}` };
    if (!UNIT(e.c.transform?.scale)) return { code: "shape", reason: `${id}.transform.scale is ${JSON.stringify(e.c.transform.scale)}; a socket's scale is [1, 1, 1] (its host's scale already applies, and a scaled socket would scale what attaches)`, fix: "scale the host, or what attaches to it" };
    const under = kidsOf(id).find((k) => isSocketC(s.entities[k].c));
    if (under) return { code: "shape", reason: `${under} is a socket under the socket ${id}: a socket hangs on a thing, never on another socket`, fix: `parent ${under} to ${host}` };
    hosts.add(host); }
  // the helm (station.input {move: 'drive'}): one per host, and only on a host with drive (shared/drive.js)
  const helmHosts = new Set(hosts); for (const id of ids) if (s.entities[id] && !isSocketC(s.entities[id].c)) helmHosts.add(id);
  for (const h of helmHosts) { const helms = kidsOf(h).filter((k) => isSocketC(s.entities[k].c) && s.entities[k].c.station?.input?.move === "drive");
    if (helms.length > 1) return { code: "shape", reason: `${h} has ${helms.length} helms (${helms.join(", ")}): one seat drives a thing`, fix: "keep input {move: 'drive'} on one; passengers' seats leave it out" };
    if (helms.length && !bag(s.entities[h]?.c.drive)) return { code: "shape", reason: `${helms[0]} is a helm, but ${h} has no drive to steer`, fix: `set {id: '${h}', component: 'drive', value: {maxSpeed, turnRate}}, or take input off the station` }; }
  for (const h of hosts) { const socks = kidsOf(h).filter((k) => isSocketC(s.entities[k].c)); const byName = new Map();
    for (const k of socks) { const v = s.entities[k].c.socket; const n = v.name;
      if (byName.has(n)) return { code: "name-taken", reason: `${h} already has a socket called '${v.name}' (${byName.get(n)})`, fix: "a socket's name is unique among its host's sockets: give it another", taken: byName.get(n) };
      byName.set(n, k); } }
  return null;
}

// what a toggle reaction toggles, and whether an openable thing answers 'open' itself: here, beside the station rules, and read by use.js
export const toggleOf = (h) => { const comp = h.component ?? "openable"; return { comp, field: h.field ?? (comp === "openable" ? "open" : undefined) }; };   // toggling an openable opens/closes it, named or not (10-07 merge)
// only a toggle of openable.open itself (toggleOf's own default) stands in for the implicit open: one of its lock doesn't
export function implicitOpens(e) { return !!(e?.c.openable && typeof e.c.openable === "object") && !Object.values(e.c.reactions ?? {}).some((h) => { if (h?.kind !== "toggle") return false; const { comp: target, field } = toggleOf(h); return target === "openable" && field === "open"; }); }
/** One action namespace per thing (shape audit 10-16, R's call 3): what `use {id, action}` names must mean one thing. A
 *  reaction key, or a name grabbable.use fires, never equals a station action of the thing's own sockets (several of its
 *  sockets may share one: a sofa's seats all sit). Over the state a write leaves; the hosts the write touches, directly or
 *  through one of their sockets. The first clash as {code: 'action-taken', reason, fix}, or null. */
export function actionRules(s, ids) {
  const hosts = new Set();
  for (const id of ids) { const e = s.entities[id]; if (!e) continue; if (isSocketC(e.c) && e.c.parent?.to) hosts.add(e.c.parent.to); else hosts.add(id); }
  let kids = null;   // the children index, built once and only if a touched host could clash
  for (const h of hosts) { const c = s.entities[h]?.c; if (!c) continue;
    if (!bag(c.reactions) && !bag(c.grabbable) && !bag(c.openable)) continue;
    if (!kids) { kids = new Map(); for (const [k, e] of Object.entries(s.entities)) { const to = e.c.parent?.to; if (to && isSocketC(e.c) && bag(e.c.station)) { let a = kids.get(to); if (!a) kids.set(to, (a = [])); a.push(k); } } }
    const seats = new Map();
    for (const k of kids.get(h) ?? []) seats.set(s.entities[k].c.station.action ?? "sit", k);
    if (!seats.size) continue;
    for (const act of bag(c.reactions) ? Object.keys(c.reactions) : []) if (seats.has(act))
      return { code: "action-taken", reason: `${h}: '${act}' is both a reaction and what its socket ${seats.get(act)}'s station does: use {id, action: '${act}'} would mean two things`, fix: `name the reaction something else, or give the station another action`, taken: seats.get(act) };
    // an openable host that answers 'open' itself (implicitOpens), so a station can't take that name either
    if (seats.has("open") && implicitOpens(s.entities[h]))
      return { code: "action-taken", reason: `${h} is openable, so 'open' opens and shuts it, and its socket ${seats.get("open")}'s station does 'open' too: use {id, action: 'open'} would mean two things`, fix: "give the station another action", taken: seats.get("open") };
    const u = bag(c.grabbable) ? c.grabbable.use : undefined;
    for (const act of typeof u === "string" ? [u] : bag(u) ? [u.down, u.up].filter((x) => typeof x === "string") : []) if (seats.has(act))
      return { code: "action-taken", reason: `${h}.grabbable.use names '${act}', which is what its socket ${seats.get(act)}'s station does: use while held fires a reaction`, fix: `name a reaction of ${h} (its reactions keys), not a station's action`, taken: seats.get(act) }; }
  return null;
}

/** A host's sockets, in its children's order: [{id, name, sock, host}]. A socket switched off on its own is a closed seat:
 *  not listed. */
export function socketsOf(st, host, { off = false } = {}) {   // off: switched-off ones too (they're still its sockets to delete or undo)
  if (!st.entities[host]) return [];
  const out = [];
  for (const k of kidsMap(st).get(host) ?? []) { const c = st.entities[k]?.c; if (isSocketC(c) && (off || c.disabled !== true)) out.push({ id: k, name: c.socket.name, sock: c.socket, station: bag(c.station) ? c.station : null, host }); }
  return out;
}
/** Every socket in the world, as socketsOf lists them. */
export function allSockets(st) {
  const out = [];
  for (const [k, e] of Object.entries(st.entities)) if (isSocketC(e.c) && e.c.disabled !== true && e.c.parent?.to) out.push({ id: k, name: e.c.socket.name, sock: e.c.socket, station: bag(e.c.station) ? e.c.station : null, host: e.c.parent.to });
  return out;
}
/** Where a socket is in the world. */
export const socketPoint = (st, x) => worldT(st, x.id).pos;
