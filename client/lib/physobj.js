// physobj — the first entity physics plugin (docs/leases.md).
//
// Balls that fly and roll, boxes that fly and land, anything /kick-able.
// Deliberately a PLUGIN in the honest sense: everything here goes through
// surfaces any runtime script could reach — the lease wire (claim / state /
// release), the entities map, terrain heightAt, the collider boxes. No
// engine hooks. A different plugin could claim the same objects and simulate
// them completely differently, from the ground up; the engine only cares who
// holds the lease.
//
// The sim itself is proudly minimal — this is the reference holder, not the
// last word: ballistic flight, sphere rolling with friction, box landing
// that rights itself as it settles. Spin streams as a quaternion so remotes
// see the ball ROLL, not slide. At rest: release → the SERVER commits the
// final transform as an ordinary `place` (fold-clean, late-joiner-true),
// and the lease table forgets us.

import { THREE, bus, CONFIG } from './core.js';
import { entities, comps } from './world.js';
import { remotes } from './remotes.js';
import { heightAt } from './terrain.js';
import { colliders, nearColliders } from './colliders.js';
import { sendLease, sendVerb } from './net.js';
import { flashHint } from './ui.js';
import { logChat } from './chat.js';
import { state } from './state.js';

const GRAVITY = -9.8;
const STREAM_MS = 66;
const KICK_REACH = 2.5;        // an object must be at your feet to kick
const SETTLE_V = 0.25;         // m/s under which things come to rest
const MAX_KICK = 10;

let hooks = null;              // { myPos: () => Vector3 }
export function initPhysObj(h) { hooks = h; }

// ---------------------------------------------------------------- the switch
//
// Base physics is a BUILT-IN MOD, and mods can be turned off. What the
// switch governs is precisely the SENDER half of this file: simulating,
// volunteering for punts, kicking. Off = this client never holds a lease;
// other clients volunteer and you watch — which is also the low-end-device
// story (let someone else's machine do the physics).
//
// The RECEIVER half — applying other holders' lease streams to entities —
// is CORE and has no switch, deliberately: disable that and the world
// forks (a ball frozen on your screen mid-air while everyone else watches
// it fly). Plugins extend senders, never receivers.

let enabled = localStorage.getItem('ew-phys') !== '0';
export const physicsEnabled = () => enabled;
export function setPhysicsEnabled(v) {
  enabled = !!v;
  localStorage.setItem('ew-phys', enabled ? '1' : '0');
  if (!enabled) {
    // hand everything off honestly: commit each held sim where it stands and
    // release — the server (or the next volunteer) takes it from there
    for (const id of [...sims.keys()]) stopSim(id, true);
    pendingKicks.clear();
  }
}

// ---------------------------------------------------------------- my sims

// id -> live sim state. Several at once is fine (juggling is legal).
const sims = new Map();
const _v = new THREE.Vector3();
const _cl = new THREE.Vector3();   // contact clamp scratch — no per-pair alloc
const _axis = new THREE.Vector3();
const _q = new THREE.Quaternion();
const UP = new THREE.Vector3(0, 1, 0);

/** What shape is this thing? Read off its collider box — the same box the
 *  walking world collides with, so the sim and the feet agree. */
function shapeOf(id) {
  const c = colliders.get(id);
  const obj = entities.get(id);
  if (!c || !obj) return null;
  const size = c.box.getSize(new THREE.Vector3()).multiplyScalar(obj.scale?.x || 1);
  const dims = [size.x, size.y, size.z].sort((a, b) => a - b);
  // round-ish in all three = ball; anything else lands like a crate
  const ball = dims[0] > 0.01 && dims[2] / dims[0] < 1.35;
  return {
    kind: ball ? 'ball' : 'box',
    r: ball ? (size.x + size.y + size.z) / 6 : Math.max(0.05, size.y / 2),
    footprint: Math.max(size.x, size.z),
  };
}

function startSim(id, launch, fromState = null) {
  const obj = entities.get(id);
  const shape = shapeOf(id);
  if (!obj || !shape) { sendLease('release', id); return; }
  const p = fromState?.p
    ? new THREE.Vector3(fromState.p[0], fromState.p[1], fromState.p[2])
    : obj.position.clone();
  sims.set(id, {
    obj, shape,
    p, v: launch.clone(),
    q: obj.quaternion.clone(),
    baseYaw: obj.userData.base?.yaw ?? obj.rotation.y,
    settling: 0, sentAt: 0,
  });
}

function stopSim(id, commit) {
  const s = sims.get(id);
  sims.delete(id);
  if (!s) return;
  if (commit) sendLease('release', id, { p: [s.p.x, s.p.y, s.p.z], yaw: s.baseYaw });
}

/** One frame of every sim I hold. Runs in the main frame loop. */
export function tickPhysObj(dt, now = performance.now()) {
  for (const [id, s] of sims) {
    const { shape } = s;
    // integrate
    s.v.y += GRAVITY * dt;
    s.p.addScaledVector(s.v, dt);

    // ground: terrain under the object, supported at its own radius
    const floor = heightAt(s.p.x, s.p.z) + shape.r;
    if (s.p.y <= floor) {
      s.p.y = floor;
      if (s.v.y < 0) {
        // bounce — balls keep most of it, crates almost none
        s.v.y = -s.v.y * (shape.kind === 'ball' ? 0.45 : 0.08);
        if (Math.abs(s.v.y) < 0.6) s.v.y = 0;
      }
      // rolling / sliding friction, per shape
      const mu = shape.kind === 'ball' ? 0.55 : 3.5;
      const f = Math.max(0, 1 - mu * dt);
      s.v.x *= f; s.v.z *= f;
    }

    // world colliders: a sphere test against the same boxes feet use — enough
    // to bounce a ball off a crate. Interiors and self are skipped; a plugin
    // wanting real contacts can hold the same lease and do better. The grid
    // bounds the scan (§14.2 6a — this was O(sims × ALL colliders) with an
    // allocation per pair, hot-path offender #2).
    for (const [cid, c] of nearColliders(s.p.x, s.p.z, 8)) {
      // A structure's collider ids are SYNTHETIC (house1#s7) — there is no entity
      // behind them, so requiring one made every wall invisible to a punted
      // object: crates sailed straight through buildings. structOwner names the
      // building the box belongs to, which is the identity this guard wanted.
      if (cid === id || c.interior || !c.box || (!entities.get(cid) && !c.structOwner)) continue;
      // the collider entry's OWN frame, not the entity's: for a model they are
      // the same object, but a structure box has only the former, and reaching
      // through the entity map would have thrown on every wall
      const co = c.obj ?? entities.get(cid);
      if (!co?.position) continue;
      _v.copy(s.p).sub(co.position);                 // object-local (box is local too)
      const cl = _cl.copy(_v).clamp(c.box.min, c.box.max);
      const d = _v.distanceTo(cl);
      if (d < shape.r && d > 1e-6) {
        const n = _v.sub(cl).normalize();
        s.p.addScaledVector(n, shape.r - d);
        const vn = s.v.dot(n);
        if (vn < 0) s.v.addScaledVector(n, -1.6 * vn); // reflect, a bit lossy
      }
    }

    // spin: a rolling ball turns with its travel; a flying crate tumbles a
    // little. Streamed as q so remotes see it — spheres SLIDING read as bugs.
    const flat = Math.hypot(s.v.x, s.v.z);
    if (shape.kind === 'ball' && flat > 0.01) {
      _axis.set(s.v.x, 0, s.v.z).normalize().cross(UP).negate();
      _q.setFromAxisAngle(_axis, (flat * dt) / shape.r);
      s.q.premultiply(_q);
    } else if (shape.kind === 'box' && s.p.y > floor + 0.02) {
      _axis.set(s.v.z, 0, -s.v.x).normalize();
      _q.setFromAxisAngle(_axis, 2.2 * dt);
      s.q.premultiply(_q);
    }

    const speed = s.v.length();
    const onGround = s.p.y <= floor + 0.01;
    if (onGround && speed < SETTLE_V) {
      // settle: crates right themselves as they stop (the mid-air tumble is
      // presence, the log gets a flat crate at its own yaw), balls just stop
      s.settling += dt;
      _q.setFromAxisAngle(UP, s.baseYaw);
      s.q.slerp(_q, Math.min(1, 6 * dt));
      if (s.settling > 0.45) {
        s.obj.position.copy(s.p);
        s.obj.quaternion.copy(_q);
        stopSim(id, true);
        continue;
      }
    } else s.settling = 0;

    // drive my own view directly; stream to everyone else at presence cadence
    s.obj.position.copy(s.p);
    s.obj.quaternion.copy(s.q);
    if (now - s.sentAt >= STREAM_MS) {
      s.sentAt = now;
      sendLease('state', id, { p: [s.p.x, s.p.y, s.p.z], q: [s.q.x, s.q.y, s.q.z, s.q.w] });
    }
  }
}

// ---------------------------------------------------------------- kicking
//
// A kick is a VERB — a cause in history, like force — and simulation is a
// separate act any present plugin VOLUNTEERS for. /kick emits the verb;
// the volunteer machinery below picks it up off the log echo exactly as it
// picks up an agent's world_verb punt or a behavior's emit. One path.

const pendingKicks = new Map();  // id -> { launch, silent }, waiting on a grant
const lastClaimed = new Map();   // id -> ts of the last claim we heard — race suppressor

/** /kick [name] [power] — kick the nearest (or named) object. Emits the
 *  kick verb; the sim follows through the volunteer path. */
export function kick(arg) {
  if (!hooks) return;
  if (!enabled) return logChat('*', 'your physics mod is off — flip it in 🧩 mods (someone else present can still simulate your punts)');
  const parts = (arg || '').trim().split(/\s+/).filter(Boolean);
  const named = parts.find((x) => !/^[\d.]+$/.test(x));
  const power = Math.min(MAX_KICK, Math.max(1, parseFloat(parts.find((x) => /^[\d.]+$/.test(x))) || 5));
  const me = hooks.myPos();

  let id = named ?? null;
  if (!id) {
    let best = KICK_REACH;
    for (const [eid, obj] of entities) {
      if (!obj || !colliders.get(eid) || colliders.get(eid).interior) continue;
      const d = Math.hypot(obj.position.x - me.x, obj.position.z - me.z);
      if (d < best) { best = d; id = eid; }
    }
    if (!id) return logChat('*', 'nothing at your feet to kick');
  }
  const obj = entities.get(id);
  if (!obj) return logChat('*', `nothing here called "${id}"`);
  if (comps.get(id)?.motion || obj.userData.lib === '(light)') {
    return logChat('*', `${id} is animated by its motion — it can't be kicked loose (yet)`);
  }
  const at = sims.get(id)?.p ?? obj.position;
  if (Math.hypot(at.x - me.x, at.z - me.z) > KICK_REACH + 0.8) {
    return logChat('*', `${id} is too far away to kick`);
  }
  // direction: through the object from where I stand — stamped into the verb
  // so history says which way, whoever ends up simulating it
  const dx = at.x - me.x, dz = at.z - me.z;
  const d = Math.hypot(dx, dz) || 1;
  // Dialect 3: under a sim epoch the intent carries its WHOLE vector — the
  // upward component included, since the sim adds no launch lift of its own
  // (the volunteer path added 0.45·power itself; here the ratio rides dir).
  const lift = state.sim?.epoch && !state.sim.epoch.foreign ? 0.45 : 0;
  sendVerb('punt', { id, power, dir: [dx / d, lift, dz / d] });
}

/** Every punt in the world lands here off the live log — mine, another
 *  human's, an agent's world_verb, a behavior's emit. If I already hold the
 *  object's lease, the kick is an impulse into my running sim (no handoff).
 *  Otherwise I volunteer to simulate: the kicker's own client claims
 *  immediately, everyone else jitters and stands down if a claim is heard —
 *  the lease table settles any remaining race. */
bus.on('punt', ({ actor, id, dir, power }) => {
  if (!enabled) return;                       // volunteering is the mod's act
  // Dialect 3 (PROTOCOL_v2): under a sim epoch the SIM owns punt flights —
  // recomputation, not volunteering. Standing down here is what retires
  // the lease race for punts without touching any other physics this mod
  // does (drags, hand-offs, non-punt sims stay exactly as they were).
  if (state.sim?.epoch && !state.sim.epoch.foreign) return;
  const obj = entities.get(id);
  if (!obj || comps.get(id)?.motion) return;
  const p = Math.min(MAX_KICK, Math.max(0.5, Number(power) || 5));
  let d3 = Array.isArray(dir) && dir.length === 3 ? new THREE.Vector3(dir[0], dir[1], dir[2]) : null;
  if (!d3) {
    // no direction stamped: from the kicker's body through the object
    const from = actor === CONFIG.name ? hooks?.myPos()
      : remotes.get(actor)?.avatar?.root.position;
    d3 = from
      ? new THREE.Vector3(obj.position.x - from.x, 0, obj.position.z - from.z)
      : new THREE.Vector3(0, 0, 1);
  }
  const flat = Math.hypot(d3.x, d3.z) || 1;
  const launch = new THREE.Vector3((d3.x / flat) * p, p * 0.45, (d3.z / flat) * p);

  if (sims.has(id)) { sims.get(id).v.add(launch); return; }   // my sim, more boot

  const mine = actor === CONFIG.name;
  const delay = mine ? 0 : 120 + Math.random() * 200;
  setTimeout(() => {
    if (!mine && Date.now() - (lastClaimed.get(id) ?? 0) < 1200) return;  // someone's on it
    if (sims.has(id) || pendingKicks.has(id)) return;
    pendingKicks.set(id, { launch, silent: !mine });
    sendLease('claim', id, mine ? { take: true } : {});
  }, delay);
});

// ---------------------------------------------------------------- the wire

bus.on('lease', (msg) => {
  const { op, id } = msg;
  if (op === 'claimed') lastClaimed.set(id, Date.now());
  if (op === 'granted') {
    const pk = pendingKicks.get(id);
    pendingKicks.delete(id);
    if (pk) { startSim(id, pk.launch, msg.from ?? null); if (!pk.silent) flashHint(`you kick ${id}`); }
    else sendLease('release', id);          // a grant nothing wanted anymore
    return;
  }
  if (op === 'denied') {
    const pk = pendingKicks.get(id);
    pendingKicks.delete(id);
    // a volunteer losing the race is the system working — only MY OWN kick
    // failing outright is worth a line
    if (pk && !pk.silent) logChat('*', `can't kick ${id} — ${msg.why}`);
    return;
  }
  if (op === 'lost') {
    // someone kicked it out from under my sim — theirs now, cleanly
    sims.delete(id);
    flashHint(`${msg.to} took ${id}`);
    return;
  }
  if (op === 'state' && !sims.has(id)) {
    // another holder's sim, rendered verbatim — this is the whole receiver,
    // and it is CORE, not the mod: it runs whether or not physics is enabled
    // (see the switch above — a receiver you can disable forks the world)
    const obj = entities.get(id);
    if (!obj || !Array.isArray(msg.p)) return;
    obj.position.set(msg.p[0], msg.p[1], msg.p[2]);
    if (Array.isArray(msg.q) && msg.q.length === 4) obj.quaternion.set(msg.q[0], msg.q[1], msg.q[2], msg.q[3]);
    else if (msg.yaw != null) obj.rotation.y = msg.yaw;
    return;
  }
  // 'claimed' / 'released': nothing to do — states carry the motion, and the
  // release's `place` entry arrives through the ordinary log path
});

/** The curated surface a runtime plugin script gets (docs/leases.md §self-
 *  animation): the wire, the world, and the sims table to cooperate with. */
export const leaseApi = {
  claim: (id, take = false) => sendLease('claim', id, take ? { take: true } : {}),
  state: (id, p, q) => sendLease('state', id, { p, ...(q ? { q } : {}) }),
  release: (id, p, yaw) => sendLease('release', id, { ...(p ? { p } : {}), ...(yaw != null ? { yaw } : {}) }),
  on: (fn) => bus.on('lease', fn),
  mySims: sims,
};
