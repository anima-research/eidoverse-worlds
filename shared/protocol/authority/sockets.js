// shared/protocol/authority/sockets.js — sockets as child entities (PLAN-sockets-entities 2026-10-12). A socket is
// {transform, parent: {to: host}, socket: {name, part?, accepts?, radius?}, station?}: an attachment point with a pose of
// its own (Godot's Marker3D, Unity's child Transform), and what a person's body does there, its station (shape audit
// 10-16: once socket.body). What it is for is read from what it has, never stored: a seat if a station, a snap point if
// accepts, else an attach point.
import { ONE_PLACE, socketQ } from "../../components.js";
import { checkSockets } from "../../sockbody.js";
import { COMPONENTS, materialize } from "../componentspec.js";
import { PURGED, cowState, applyCow } from "../fold.js";
import { sha256, hexBytes } from "../hash.js";
import { kidsMap } from "./spatial.js";
import { modelOf } from "./catalogue.js";
import { worldT, qrot, qinv, qmul } from "./math.js";
import { setOp, delOp } from "./storage.js";
import { refuse } from "./refuse.js";

const bag = (v) => !!v && typeof v === "object" && !Array.isArray(v) && v !== PURGED;
export const isSocketC = (c) => bag(c?.socket);
export { socketRole } from "../../sockbody.js";
// what a socket may carry besides its pose and its name: what reads it (label, description), what switches or freezes it
// (disabled, lock, hidden), a motion of its own (R 10-12 20:44), and the blueprint mark every placed part carries
// one host holds at most this many sockets (review 10-12 S1-2): a seat map past it is several things. No setting raises it;
// a socket is an entity, so it also counts in @world.capacity.entities (authority.js CAPACITY)
export const SOCKETS_PER_HOST = 64;
export const ON_A_SOCKET = new Set(["transform", "parent", "socket", "station", "label", "description", "disabled", "lock", "hidden", "motion", "copy-of"]);
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
    const extra = Object.keys(e.c).find((k) => !ON_A_SOCKET.has(k));
    if (extra) return { code: "one-place", reason: ONE_PLACE.socket.reason(id, extra), fix: ONE_PLACE.socket.fix(id, extra) };
    if (!UNIT(e.c.transform?.scale)) return { code: "shape", reason: `${id}.transform.scale is ${JSON.stringify(e.c.transform.scale)}; a socket's scale is [1, 1, 1] (its host's scale already applies, and a scaled socket would scale what attaches)`, fix: "scale the host, or what attaches to it" };
    const under = kidsOf(id).find((k) => isSocketC(s.entities[k].c));
    if (under) return { code: "shape", reason: `${under} is a socket under the socket ${id}: a socket hangs on a thing, never on another socket`, fix: `parent ${under} to ${host}` };
    hosts.add(host); }
  // (the one-driver rule went with station.input, reserved for later: shape audit 10-16)
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
/** The names of the seats a catalogue entry declares (find's answer; they're made as children when the model is). */
export const modelSocketNames = (m) => (bag(m?.sockets) ? Object.keys(m.sockets) : null);

// ---------- the old spelling, lifted at the door (PLAN §3) ----------
// Every write enters through admit, so admit is where `sockets` maps and parent {to, socket} edges become socket
// children: requests, undo, a fork's copy, a blueprint's parts, a catalogue model's seats. Nothing after the door
// stores the old spelling, so nothing after it reads it.
const B32 = "abcdefghijklmnopqrstuvwxyz234567";
const base32 = (bytes) => { let out = "", bits = 0, v = 0; for (const b of bytes) { v = (v << 8) | b; bits += 8; while (bits >= 5) { out += B32[(v >>> (bits - 5)) & 31]; bits -= 5; } } if (bits) out += B32[(v << (5 - bits)) & 31]; return out; };
const slugOf = (s, n) => String(s).toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, n).replace(/-+$/, "") || "socket";
/** A lifted socket's id: the same from every loader, fork and agent, so two forks lifting apart agree, and a merge sees
 *  one entity. Readable (its slot's name first), 130 bits after it. */
export const socketId = (host, slot) => `${slugOf(slot, 20)}-${base32(hexBytes(sha256(`eido-socket\0${host}\0${slot}`))).slice(0, 26)}`;
const SOCK_FIELDS = ["part", "accepts", "radius"];
const socketOfSlot = (name, sk) => ({ name, ...Object.fromEntries(SOCK_FIELDS.filter((k) => sk[k] !== undefined).map((k) => [k, sk[k]])) });
// an old body block as the station it is (shape audit 10-16), materialized as the door writes one. `stored`: a value the log
// or a catalogue already held is re-spelled with the keys the station registers (the reserved and cut ones no stored value
// uses are dropped); a request's own body keeps them, and the door refuses them in the station's words
const STATION_KEYS = Object.keys(COMPONENTS.station.fields);
// A body block's `pose` is the station's `anim` (R 10-17 15:11: the map's body block keeps its old spelling; the station
// takes the name of the family).
export const stationOfBody = (b0, { stored = false } = {}) => { if (!bag(b0)) return null;
  const b = "pose" in b0 && !("anim" in b0) ? (({ pose, ...r }) => ({ ...r, anim: pose }))(b0) : b0;
  const v = stored ? Object.fromEntries(Object.entries(b).filter(([k]) => STATION_KEYS.includes(k))) : { ...b };
  return materialize("station", v).value; };
const tfOf = (c) => ({ ...COMPONENTS.transform.defaults, ...(c?.transform ?? {}) });
// a pose written in the host's frame, re-expressed in its socket's (the socket's scale is 1; the host's world scale is
// carried through so the world pose is the same, a non-uniform host included)
function underSocket(st, host, sockT, t) {
  const hs = worldT(st, host)?.scale ?? [1, 1, 1]; const qi = qinv(sockT.q);
  const d = qrot(qi, t.pos.map((v, i) => (v - sockT.pos[i]) * hs[i])).map((v, i) => v / hs[i]);
  return { ...t, pos: d, ...(t.q ? { q: qmul(qi, t.q) } : {}) };
}
function overSocket(st, host, sockT, t) {
  const hs = worldT(st, host)?.scale ?? [1, 1, 1];
  const d = qrot(sockT.q, t.pos.map((v, i) => v * hs[i])).map((v, i) => v / hs[i] + sockT.pos[i]);
  return { ...t, pos: d, ...(t.q ? { q: qmul(sockT.q, t.q) } : {}) };
}
const legacyParent = (v) => bag(v) && typeof v.to === "string" && typeof v.socket === "string";
/** Is this a parent in the old spelling ({to, socket})? Undo reads it from before the cut, to put back a parent and a
 *  transform written in the host's frame as one group (the door then re-expresses the pose in the socket child's). */
export const isLegacyParent = legacyParent;
const legacyHome = (v) => bag(v) && legacyParent(v.parent);

/** Does this write carry the old spelling anywhere? (The common write doesn't, and costs one pass.) */
export function carriesLegacy(ops) {
  return ops.some((o) => o.comp === "sockets" || (o.verb === "set" && ((o.comp === "parent" && legacyParent(o.value)) || (o.comp === "home" && legacyHome(o.value))
    || (o.comp === "socket" && bag(o.value) && o.value.body !== undefined) || (o.comp === "model" && typeof o.value === "string" && bag(modelOf(o.value)?.sockets)))));
}

/** The write in the new spelling: {ops, notes}. `ever` is every id the world has made (a lifted id is never a reused one). */
function lifter(st, ever) {
  const s = cowState(st); const out = []; const taken = new Set();
  const emit = (o) => { out.push(o); applyCow(s, [o]); };
  const fresh = (host, name) => { for (let n = 1; ; n++) { const id = socketId(host, n === 1 ? name : `${name}\0${n}`);
    if (!ever.has(id) && !s.entities[id] && !taken.has(id)) { taken.add(id); return id; } } };
  const kidsOf = (h) => Object.keys(s.entities).filter((k) => s.entities[k].c.parent?.to === h);
  const childNamed = (h, name) => kidsOf(h).find((k) => isSocketC(s.entities[k].c) && s.entities[k].c.socket.name === name) ?? null;
  const make = (h, name, sk) => { const id = fresh(h, name);
    emit({ verb: "create", id }); emit(setOp(id, "parent", { to: h }));
    emit(setOp(id, "transform", { pos: Array.isArray(sk.pos) ? sk.pos.slice() : [0, 0, 0], q: socketQ(sk), scale: [1, 1, 1] }));
    emit(setOp(id, "socket", socketOfSlot(name, sk)));
    if (bag(sk.body)) emit(setOp(id, "station", stationOfBody(sk.body, { stored: storedBodies })));
    return id; };
  let storedBodies = false;
  // a socket child that still holds the old body block (a log stored before station): the block becomes its station
  const liftBodies = (h) => { for (const k of kidsOf(h)) { const c = s.entities[k].c; if (!isSocketC(c) || c.socket.body === undefined) continue;
    const { body, ...rest } = c.socket; emit(setOp(k, "socket", rest)); if (bag(body) && !bag(c.station)) emit(setOp(k, "station", stationOfBody(body, { stored: true }))); } };
  // a home naming a legacy socket: in that socket child's frame
  const homeLifted = (hv, made) => { const p = hv.parent; const id = made?.[p.socket] ?? childNamed(p.to, p.socket);
    if (!id) { const { socket, ...rest } = p; return { ...hv, parent: rest }; }
    const T = underSocket(s, p.to, tfOf(s.entities[id].c), { pos: hv.pos ?? [0, 0, 0], ...(hv.q ? { q: hv.q } : {}) });
    return { ...hv, pos: T.pos, ...(T.q ? { q: T.q } : {}), parent: { to: id } }; };
  // a host's stored map (or its model's seats) becomes its socket children; what sat at a slot sits in its child, where it was
  const liftHost = (h, map, { stored }) => { const made = {};
    for (const [name, sk] of Object.entries(map)) if (bag(sk)) made[name] = childNamed(h, name) ?? make(h, name, sk);
    if (stored) emit(delOp(h, "sockets"));
    for (const k of Object.keys(s.entities)) { const c = s.entities[k].c;
      if (c.parent?.to === h && typeof c.parent.socket === "string") { const id = made[c.parent.socket] ?? childNamed(h, c.parent.socket); const { socket, ...rest } = c.parent;
        if (!id) { emit(setOp(k, "parent", rest)); continue; }
        emit(setOp(k, "parent", { ...rest, to: id })); emit(setOp(k, "transform", underSocket(s, h, tfOf(s.entities[id].c), tfOf(c)))); }
      if (legacyHome(c.home) && c.home.parent.to === h) emit(setOp(k, "home", homeLifted(c.home, made))); }
    return made; };
  const liftStored = (h) => (bag(s.entities[h]?.c.sockets) ? liftHost(h, s.entities[h].c.sockets, { stored: true }) : {});
  return { s, out, emit, make, kidsOf, childNamed, homeLifted, liftHost, liftStored, liftBodies, stored: (x) => { storedBodies = x; } }; }

export function liftOps(st, ops, ever = new Set()) {
  if (!carriesLegacy(ops)) return { ops, notes: [] };
  const L = lifter(st, ever); const { s, out, emit, make, kidsOf, childNamed, homeLifted, liftStored, liftHost } = L; const notes = [];
  const via = new Map();   // a thing given a legacy parent in this write: a later transform of it is in its host's frame
  const models = new Set();
  // a socket child taken away: what sat in it stays with the host, where it was
  const retire = (h, id) => { const T = tfOf(s.entities[id].c);
    for (const k of kidsOf(id)) { const c = s.entities[k].c; emit(setOp(k, "parent", { ...c.parent, to: h })); emit(setOp(k, "transform", overSocket(s, h, T, tfOf(c)))); }
    emit(delOp(id)); };
  for (const o of ops) {
    const e = s.entities[o.id];
    if (o.comp === "sockets" && e) {
      if (o.verb === "set" && checkSockets(o.value)) { emit(o); continue; }   // malformed: the door refuses it in its own words
      const before = liftStored(o.id);
      const want = o.verb === "set" ? o.value : {};
      const socks = kidsOf(o.id).filter((k) => isSocketC(s.entities[k].c));
      if (o.verb === "delete" && !socks.length && !Object.keys(before).length) { emit(o); continue; }   // nothing there: refused as not-found
      const wrote = {};
      for (const k of socks) if (!Object.hasOwn(want, s.entities[k].c.socket.name)) retire(o.id, k);
      for (const [name, sk] of Object.entries(want)) { const id = childNamed(o.id, name);
        if (!id) { wrote[name] = make(o.id, name, sk); continue; }
        wrote[name] = id; const c = s.entities[id].c;
        const t = { pos: sk.pos.slice(), q: socketQ(sk), scale: [1, 1, 1] }, v = { ...socketOfSlot(name, sk) };
        if (JSON.stringify(c.transform) !== JSON.stringify(t)) emit(setOp(id, "transform", t));
        if (JSON.stringify(c.socket) !== JSON.stringify(v)) emit(setOp(id, "socket", v));
        // the slot's body is the child's station: a body written sets it, none takes it away
        if (bag(sk.body)) { const st2 = stationOfBody(sk.body); if (JSON.stringify(c.station) !== JSON.stringify(st2)) emit(setOp(id, "station", st2)); }
        else if (c.station !== undefined) emit(delOp(id, "station")); }
      notes.push({ legacy: "sockets", id: o.id, wrote, why: "sockets are child entities now: each slot is a socket child (parent {to: <its id>} attaches to it)" });
      continue;
    }
    if (o.verb === "set" && o.comp === "parent" && e && legacyParent(o.value)) {
      const h = o.value.to; liftStored(h);
      const id = childNamed(h, o.value.socket);
      if (!id) refuse("not-found", `${h} has no socket called '${o.value.socket}'`, `its sockets: ${kidsOf(h).filter((k) => isSocketC(s.entities[k].c)).map((k) => s.entities[k].c.socket.name).join(", ") || "none"}`);
      const { socket, ...rest } = o.value; const was = e.c.parent?.to;
      emit(setOp(o.id, "parent", { ...rest, to: id }));
      if (was !== id || via.has(o.id)) emit(setOp(o.id, "transform", underSocket(s, h, tfOf(s.entities[id].c), tfOf(e.c))));
      via.set(o.id, { h, id });
      notes.push({ legacy: "parent.socket", id: o.id, wrote: { parent: { to: id } }, why: `${h}'s '${socket}' socket is the entity ${id}` });
      continue;
    }
    if (o.verb === "set" && o.comp === "transform" && via.has(o.id) && bag(o.value) && Array.isArray(o.value.pos)) { const { h, id } = via.get(o.id);
      emit(setOp(o.id, "transform", underSocket(s, h, tfOf(s.entities[id].c), o.value))); continue; }
    if (o.comp === "parent") via.delete(o.id);
    if (o.verb === "set" && o.comp === "home" && legacyHome(o.value)) { liftStored(o.value.parent.to); emit(setOp(o.id, "home", homeLifted(o.value))); continue; }
    // a socket written with the old body block: the socket without it, and the block as the station beside it
    if (o.verb === "set" && o.comp === "socket" && bag(o.value) && bag(o.value.body)) { const { body, ...rest } = o.value;
      emit(setOp(o.id, "socket", rest)); emit(setOp(o.id, "station", stationOfBody(body)));
      notes.push({ legacy: "socket.body", id: o.id, wrote: { station: true }, why: "what a person's body does at a socket is its station now" }); continue; }
    if (o.verb === "set" && o.comp === "model") models.add(o.id);
    emit(o);
  }
  // a catalogue model that declares seats: they are made as children ("the log holds every number"), once
  for (const h of models) { const e = s.entities[h]; const ms = modelOf(e?.c.model)?.sockets;
    // never one of its seats made before: a seat someone deleted stays deleted, as the maintenance command's lift (modelSeatsDue) reads it
    if (!bag(ms) || bag(e.c.sockets) || kidsOf(h).some((k) => isSocketC(s.entities[k].c)) || Object.keys(ms).some((n) => ever.has(socketId(h, n)))) continue;
    L.stored(true); const made = liftHost(h, ms, { stored: false }); L.stored(false); notes.push({ legacy: "model sockets", id: h, wrote: made, why: `its model declares ${Object.keys(made).join(", ")}: made as socket children` }); }
  return { ops: out, notes };
}

// ---------- the old spelling, lifted by the maintenance command (lift-sockets; it ran at load until 10-18) ----------
const modelSeatsDue = (st, ever, k) => { const c = st.entities[k].c; const ms = modelOf(c.model)?.sockets;
  return bag(ms) && !bag(c.sockets) && !Object.keys(ms).some((n) => ever.has(socketId(k, n))) && !Object.keys(st.entities).some((x) => st.entities[x].c.parent?.to === k && isSocketC(st.entities[x].c)); };
/** The hosts a stored world still holds in the old spelling, in id order: one that stores a map; one a parent or a home
 *  names a slot of; one whose model declares seats it was never given (none of their ids was ever made, so a seat
 *  someone deleted stays deleted). */
/** The hosts a stored world holds in the OLD STORED FORMAT (a sockets map, a parent or home naming a slot, a socket child
 *  with a body block): the subset of legacyHosts that is a stale stored format rather than a catalogue model that gained
 *  sockets after the host was stored (modelSeatsDue: a library update, lead 10-18, never a reason to refuse writes). */
export function storedLegacyHosts(st) {
  const hosts = new Set();
  for (const [k, e] of Object.entries(st.entities)) { const c = e.c;
    if (bag(c.sockets)) hosts.add(k);
    if (legacyParent(c.parent) && st.entities[c.parent.to]) hosts.add(c.parent.to);
    if (legacyHome(c.home) && st.entities[c.home.parent.to]) hosts.add(c.home.parent.to);
    if (isSocketC(c) && c.socket.body !== undefined && st.entities[c.parent?.to]) hosts.add(c.parent.to); }
  return [...hosts].sort();
}
export function legacyHosts(st, ever = new Set()) {
  const hosts = new Set();
  for (const [k, e] of Object.entries(st.entities)) { const c = e.c;
    if (bag(c.sockets)) hosts.add(k);
    if (legacyParent(c.parent) && st.entities[c.parent.to]) hosts.add(c.parent.to);
    if (legacyHome(c.home) && st.entities[c.home.parent.to]) hosts.add(c.home.parent.to);
    if (isSocketC(c) && c.socket.body !== undefined && st.entities[c.parent?.to]) hosts.add(c.parent.to);
    if (modelOf(c.model)?.sockets && modelSeatsDue(st, ever, k)) hosts.add(k); }
  return [...hosts].sort();
}
/** One host's lift: the ops (the system's own), the children it made by slot, and the things it moved. */
export function liftHostOps(st, ever, h) {
  const L = lifter(st, ever); const c = L.s.entities[h].c; L.stored(true);   // what a log or a catalogue holds is re-spelled, not judged anew
  const made = bag(c.sockets) ? L.liftStored(h) : modelSeatsDue(L.s, ever, h) ? L.liftHost(h, modelOf(c.model).sockets, { stored: false }) : L.liftHost(h, {}, { stored: false });
  L.liftBodies(h);
  const mine = new Set([h, ...Object.values(made)]);
  return { ops: L.out, made, moved: [...new Set(L.out.map((o) => o.id).filter((id) => !mine.has(id)))] };
}
