// shared/protocol/authority/sockets.js — sockets as child entities (PLAN-sockets-entities 2026-10-12). A socket is
// {transform, parent: {to: host}, socket: {name, part?, body?, accepts?, radius?}}: an attachment point with a pose of its
// own (Godot's Marker3D, Unity's child Transform). What it is for is read from what it has, never stored: a seat if body,
// a snap point if accepts, else an attach point.
import { ONE_PLACE } from "../../components.js";
import { PURGED } from "../fold.js";
import { kidsMap } from "./spatial.js";
import { modelOf } from "./catalogue.js";
import { worldT, qrot } from "./math.js";

const bag = (v) => !!v && typeof v === "object" && !Array.isArray(v) && v !== PURGED;
export const isSocketC = (c) => bag(c?.socket);
export const socketRole = (c) => (bag(c?.socket?.body) ? "seat" : Array.isArray(c?.socket?.accepts) ? "snap" : "attach");
// what a socket may carry besides its pose and its name: what reads it (label, description), what switches or freezes it
// (disabled, lock, hidden), a motion of its own (R 10-12 20:44), and the blueprint mark every placed part carries
export const ON_A_SOCKET = new Set(["transform", "parent", "socket", "label", "description", "disabled", "lock", "hidden", "motion", "copy-of"]);
const UNIT = (sc) => sc === undefined || (Array.isArray(sc) && sc.length === 3 && sc.every((x) => x === 1));

/** The door's rules for socket entities, over the state a write leaves: the first that breaks, as {code, reason, fix}, or
 *  null. Only the sockets the write touches are read, and their siblings. */
export function socketRules(s, ids) {
  let kids = null;
  const kidsOf = (p) => { if (!kids) { kids = new Map(); for (const [k, e] of Object.entries(s.entities)) { const to = e.c.parent?.to; if (to) { let a = kids.get(to); if (!a) kids.set(to, (a = [])); a.push(k); } } } return kids.get(p) ?? []; };
  const hosts = new Set();
  for (const id of ids) { const e = s.entities[id]; if (!e) continue;
    if (!isSocketC(e.c)) continue;
    const host = e.c.parent?.to;
    if (!host) return { code: "shape", reason: `${id} is a socket, and a socket needs a host`, fix: `give it parent {to: <the thing it belongs to>}, or delete it` };
    if (isSocketC(s.entities[host]?.c)) return { code: "shape", reason: `${id} is a socket, and ${host} is a socket too: a socket hangs on a thing, never on another socket`, fix: `parent it to ${s.entities[host].c.parent?.to ?? "the thing it belongs to"}` };
    const extra = Object.keys(e.c).find((k) => !ON_A_SOCKET.has(k));
    if (extra) return { code: "one-place", reason: ONE_PLACE.socket.reason(id, extra), fix: ONE_PLACE.socket.fix(id, extra) };
    if (!UNIT(e.c.transform?.scale)) return { code: "shape", reason: `${id}.transform.scale is ${JSON.stringify(e.c.transform.scale)}; a socket's scale is [1, 1, 1] (its host's scale already applies, and a scaled socket would scale what attaches)`, fix: "scale the host, or what attaches to it" };
    const under = kidsOf(id).find((k) => isSocketC(s.entities[k].c));
    if (under) return { code: "shape", reason: `${under} is a socket under the socket ${id}: a socket hangs on a thing, never on another socket`, fix: `parent ${under} to ${host}` };
    hosts.add(host); }
  for (const h of hosts) { const socks = kidsOf(h).filter((k) => isSocketC(s.entities[k].c)); const byName = new Map(); const drivers = [];
    for (const k of socks) { const v = s.entities[k].c.socket; const n = v.name;
      if (byName.has(n)) return { code: "name-taken", reason: `${h} already has a socket called '${v.name}' (${byName.get(n)})`, fix: "a socket's name is unique among its host's sockets: give it another", taken: byName.get(n) };
      byName.set(n, k); if (bag(v.body) && v.body.input?.move === "drive") drivers.push(k); }
    if (drivers.length > 1) return { code: "shape", reason: `${h}: only one socket may drive (${drivers.join(", ")} all have input.move 'drive')`, fix: "one driver per thing (a vehicle has one wheel); passengers' input can still shape their own pose: input.move 'walk'" }; }
  return null;
}

/** A host's sockets, in its children's order: [{id, name, sock, host}]. A socket switched off on its own is a closed seat:
 *  not listed. Until every world is lifted, a host's stored `sockets` map (else its model's, when it has no socket
 *  children) is read here too, with id null: the one reader of the old spelling. */
export function socketsOf(st, host) {
  const e = st.entities[host]; if (!e) return [];
  const out = [];
  for (const k of kidsMap(st).get(host) ?? []) { const c = st.entities[k]?.c; if (isSocketC(c) && c.disabled !== true) out.push({ id: k, name: c.socket.name, sock: c.socket, host }); }
  const old = bag(e.c.sockets) ? e.c.sockets : out.length ? null : modelOf(e.c.model)?.sockets;
  if (bag(old)) for (const [name, sk] of Object.entries(old)) if (bag(sk)) out.push({ id: null, name, sock: sk, host });
  return out;
}
/** Every socket in the world, as socketsOf lists them. */
export function allSockets(st) {
  const out = [];
  for (const [k, e] of Object.entries(st.entities)) {
    if (isSocketC(e.c)) { if (e.c.disabled !== true && e.c.parent?.to) out.push({ id: k, name: e.c.socket.name, sock: e.c.socket, host: e.c.parent.to }); }
    else if (bag(e.c.sockets) || modelOf(e.c.model)?.sockets) out.push(...socketsOf(st, k).filter((x) => !x.id)); }
  return out;
}
/** Where a socket is in the world. */
export function socketPoint(st, x) {
  if (x.id) return worldT(st, x.id).pos;
  const ht = worldT(st, x.host); const off = qrot(ht.q, x.sock.pos.map((v, i) => v * ht.scale[i])); return ht.pos.map((v, i) => v + off[i]);
}
