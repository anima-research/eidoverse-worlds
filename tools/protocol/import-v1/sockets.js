// tools/protocol/import-v1/sockets.js — v1's attachment points (a stored `sockets` map, a parent {to, socket}, a home naming
// a slot, a socket's body block) as today's socket children (PLAN-sockets-entities). The translation's tail lift-sockets
// acts are its one user (./shapes.js liftHostOps); the write door refuses these spellings (authority/checks.js "legacy").
import { socketQ } from "../../../shared/components.js";
import { COMPONENTS, materialize } from "../../../shared/protocol/componentspec.js";
import { REDACTED, cowState, applyCow } from "../../../shared/protocol/fold.js";
import { sha256, hexBytes } from "../../../shared/protocol/hash.js";
import { worldT, qrot, qinv, qmul } from "../../../shared/protocol/authority/math.js";
import { setOp, delOp } from "../../../shared/protocol/authority/storage.js";
import { isSocketC } from "../../../shared/protocol/authority/sockets.js";

const bag = (v) => !!v && typeof v === "object" && !Array.isArray(v) && v !== REDACTED;
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
const legacyParent = (v) => bag(v) && typeof v.to === "string" && typeof v.socket === "string";
/** Is this a parent in v1's spelling ({to, socket})? */
export const isLegacyParent = legacyParent;
const legacyHome = (v) => bag(v) && legacyParent(v.parent);

/** v1's attachment points in today's spelling: a stored map's slots as socket children. `ever` is every id the world has
 *  made (a lifted id is never a reused one). */
export function lifter(st, ever) {
  const s = cowState(st); const out = []; const taken = new Set();
  const emit = (o) => { out.push(o); applyCow(s, [o]); };
  const fresh = (host, name) => { for (let n = 1; ; n++) { const id = socketId(host, n === 1 ? name : `${name}\0${n}`);
    if (!ever.has(id) && !s.entities[id] && !taken.has(id)) { taken.add(id); return id; } } };
  const kidsOf = (h) => Object.keys(s.entities).filter((k) => s.entities[k].c.parent?.to === h);
  const childNamed = (h, name) => kidsOf(h).find((k) => isSocketC(s.entities[k].c) && s.entities[k].c.socket.name === name) ?? null;
  const make = (h, name, sk) => { const id = fresh(h, name);
    emit({ op: "create", id }); emit(setOp(id, "parent", { to: h }));
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
