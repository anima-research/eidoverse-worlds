// shared/protocol/authority/sockets.js — sockets as child entities (PLAN-sockets-entities 2026-10-12). A socket is
// {transform, parent: {to: host}, socket: {name, part?, body?, accepts?, radius?}}: an attachment point with a pose of its
// own (Godot's Marker3D, Unity's child Transform). What it is for is read from what it has, never stored: a seat if body,
// a snap point if accepts, else an attach point.
import { ONE_PLACE, socketQ } from "../../components.js";
import { checkSockets } from "../../sockbody.js";
import { COMPONENTS } from "../componentspec.js";
import { PURGED, cowState, applyCow } from "../fold.js";
import { sha256, hexBytes } from "../hash.js";
import { kidsMap } from "./spatial.js";
import { modelOf } from "./catalogue.js";
import { worldT, qrot, qinv, qmul } from "./math.js";
import { setOp, delOp } from "./storage.js";
import { refuse } from "./refuse.js";

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
const SOCK_FIELDS = ["part", "body", "accepts", "radius"];
const socketOfSlot = (name, sk) => ({ name, ...Object.fromEntries(SOCK_FIELDS.filter((k) => sk[k] !== undefined).map((k) => [k, sk[k]])) });
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
const legacyHome = (v) => bag(v) && legacyParent(v.parent);

/** Does this write carry the old spelling anywhere? (The common write doesn't, and costs one pass.) */
export function carriesLegacy(ops) {
  return ops.some((o) => o.comp === "sockets" || (o.verb === "set" && ((o.comp === "parent" && legacyParent(o.value)) || (o.comp === "home" && legacyHome(o.value))
    || (o.comp === "grabbable" && legacyHome(o.value?.home)) || (o.comp === "model" && typeof o.value === "string" && bag(modelOf(o.value)?.sockets)))));
}

/** The write in the new spelling: {ops, notes}. `ever` is every id the world has made (a lifted id is never a reused one). */
export function liftOps(st, ops, ever = new Set()) {
  if (!carriesLegacy(ops)) return { ops, notes: [] };
  const s = cowState(st); const out = []; const notes = []; const taken = new Set();
  const via = new Map();   // a thing given a legacy parent in this write: a later transform of it is in its host's frame
  const models = new Set();
  const emit = (o) => { out.push(o); applyCow(s, [o]); };
  const fresh = (host, name) => { for (let n = 1; ; n++) { const id = socketId(host, n === 1 ? name : `${name}\0${n}`);
    if (!ever.has(id) && !s.entities[id] && !taken.has(id)) { taken.add(id); return id; } } };
  const kidsOf = (h) => Object.keys(s.entities).filter((k) => s.entities[k].c.parent?.to === h);
  const childNamed = (h, name) => kidsOf(h).find((k) => isSocketC(s.entities[k].c) && s.entities[k].c.socket.name === name) ?? null;
  const make = (h, name, sk) => { const id = fresh(h, name);
    emit({ verb: "create", id }); emit(setOp(id, "parent", { to: h, order: "a0" }));
    emit(setOp(id, "transform", { pos: Array.isArray(sk.pos) ? sk.pos.slice() : [0, 0, 0], q: socketQ(sk), scale: [1, 1, 1] }));
    emit(setOp(id, "socket", socketOfSlot(name, sk))); return id; };
  // a home (or grabbable.home) naming a legacy socket: in that socket child's frame
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
      if (legacyHome(c.home) && c.home.parent.to === h) emit(setOp(k, "home", homeLifted(c.home, made)));
      if (bag(c.grabbable) && legacyHome(c.grabbable.home) && c.grabbable.home.parent.to === h) emit(setOp(k, "grabbable", { ...c.grabbable, home: homeLifted(c.grabbable.home, made) })); }
    return made; };
  const liftStored = (h) => (bag(s.entities[h]?.c.sockets) ? liftHost(h, s.entities[h].c.sockets, { stored: true }) : {});
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
        if (JSON.stringify(c.socket) !== JSON.stringify(v)) emit(setOp(id, "socket", v)); }
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
    if (o.verb === "set" && o.comp === "grabbable" && legacyHome(o.value?.home)) { liftStored(o.value.home.parent.to); emit(setOp(o.id, "grabbable", { ...o.value, home: homeLifted(o.value.home) })); continue; }
    if (o.verb === "set" && o.comp === "model") models.add(o.id);
    emit(o);
  }
  // a catalogue model that declares seats: they are made as children ("the log holds every number"), once
  for (const h of models) { const e = s.entities[h]; const ms = modelOf(e?.c.model)?.sockets;
    if (!bag(ms) || bag(e.c.sockets) || kidsOf(h).some((k) => isSocketC(s.entities[k].c))) continue;
    const made = liftHost(h, ms, { stored: false }); notes.push({ legacy: "model sockets", id: h, wrote: made, why: `its model declares ${Object.keys(made).join(", ")}: made as socket children` }); }
  return { ops: out, notes };
}
