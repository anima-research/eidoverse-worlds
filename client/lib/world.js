// world — the authored plane. Folds log entries into scene state.
//
// Every entry is an intent verb; applying one is the ONLY way anything appears
// in this world. Replay of the whole log on join and a single live entry take
// exactly the same path, which is what makes late joiners see what everyone
// else sees.

import { THREE, scene, camera, renderer, report, bus } from './core.js';
import { loadGLB, loadEidoModule, noiseTexture, loadTrack, loadDone, libLabels } from './assets.js';
import { beginWork } from './loadwork.js';
import { fitCollider, removeCollider, reindexCollider, refitCollider } from './colliders.js';
import { setTerrain, setGrass, clearGrass, heightAt } from './terrain.js';
import { buildFloraField } from './flora.js';
import { applySky, attachLocalLights } from './sky.js';
import { foldSkyEntry } from './forecast.js';
import { seatCorrectionFor } from './seats.js';
import { applySeatCorrection } from './seatcore.js';
import { makeLight, updateLight, disposeLight } from './lights.js';
import { logChat } from './chat.js';
import { whenBooted } from './boot.js';

/** id -> Object3D. `null` is a reservation held while the GLB downloads, so a
 *  duplicate spawn in the same tick can't create two bodies for one id. */
export const entities = new Map();
/** id -> { actor, lib, ts } — provenance, for the build inspector. */
export const entityMeta = new Map();
/** id -> component bag, fed by `comp` verbs (and `motion`, which is sugar for
 *  the motion component). Mirrors the server's blind fold: data is opaque
 *  here too — meaning lives in whichever evaluator consumes a type (motion.js
 *  reads `motion`; mounting reads `sockets`; the server reads `reactions`).
 *  Unknown types just sit in the bag, forward-compatible. */
export const comps = new Map();
/** Avatar attachments (a sitter, a passenger) — bodies aren't entities, so
 *  their mounts live here for remotes/controller to consume. */
export const avatarMounts = new Map();
/** id -> bound runtime scripts (server sandbox AND client-mod offers), from
 *  `behavior` entries. mods.js consumes the runtime:"client" ones. */
export const behaviors = new Map();
// A mount whose parent or child is still downloading waits here and is
// retried whenever a spawn completes — same reasoning as pendingOps.
const pendingMounts = new Map(); // id -> mount args

// A spawn reserves its id synchronously but its GLB arrives later. Anything
// that addresses the entity in that window (a `place` right behind it in the
// log, a `remove` of something still downloading) used to hit `null` and be
// silently dropped. Now it is remembered and applied when the body lands —
// which also makes it safe to stop waiting for every asset before replaying.
const pendingOps = new Map(); // id -> { pos, yaw, scale, removed }

export const liveEntities = () => [...entities.values()].filter(Boolean);

// Heavy world construction (terrain ~2s, grass ~1s of main-thread geometry
// generation) runs on its own ordered chain so log replay — and everything
// after it — doesn't wait behind it. Safe because spawns carry their logged y,
// and the terrain step re-seats ground objects when it lands.
let worldBuild = Promise.resolve();
let buildDepth = 0;
let gatingDepth = 0;
// Terrain gates arrival — you cannot stand in a world with no ground. Grass
// does not: it is decoration, it costs seconds of main-thread geometry
// generation, and it can grow around someone who is already walking.
const GATING = new Set(['terrain']);
function enqueueWorldBuild(what, fn) {
  buildDepth++;
  if (GATING.has(what)) gatingDepth++;
  bus.emit('build-queue', { depth: buildDepth, what });
  worldBuild = worldBuild
    .then(() => {
      loadTrack(`build:${what}`, `growing ${what}`);
      // a work record too — terrain/grass builds were the biggest UNNAMED
      // frame gaps in the first Safari beacon (2.4s "(unattributed)")
      const work = beginWork(`build ${what}`);
      return Promise.resolve(fn()).finally(() => work.end());
    })
    .catch((e) => report(`world build (${what})`, e))
    .finally(() => {
      loadDone(`build:${what}`);
      buildDepth--;
      if (GATING.has(what)) gatingDepth--;
      bus.emit('build-queue', { depth: buildDepth, what });
    });
}
export const buildsPending = () => gatingDepth;
export const anyBuildsPending = () => buildDepth;

// Guards so a re-join (avatar switch, reconnect) that replays the log doesn't
// regenerate an identical world.
let lastTerrainArgs = null;
let lastGrassArgs = null;

// ---- deferred shadow-in -----------------------------------------------------
// Spawned objects come in without castShadow (see the spawn case). Once every
// queued load has finished — or after a hard 30s fallback, so a world where
// something never drains still gets its light right — shadows switch on one
// object per beat, spreading the per-caster depth-pipeline compiles that
// would otherwise stack into the load window.
const shadowless = new Set();
let drainingShadows = false;
async function drainShadows() {
  if (drainingShadows) return;
  drainingShadows = true;
  try {
    while (shadowless.size) {
      const id = shadowless.values().next().value;
      shadowless.delete(id);
      const obj = entities.get(id);
      if (obj) {
        obj.castShadow = true;
        obj.traverse((o) => { if (o.isMesh) o.castShadow = true; });
        await new Promise((r) => setTimeout(r, 250)); // one depth compile per beat
      }
    }
  } finally { drainingShadows = false; }
}
bus.on('lanes-idle', drainShadows);
setTimeout(drainShadows, 30000);

// Per-world roles as replayed from grant entries. A mirror for UI honesty —
// the sequencer enforces; this only lets the client SAY what you are.
const worldRoles = new Map();
export const roleOf = (id) => worldRoles.get(id) ?? null;
export const worldHasOwner = () => [...worldRoles.values()].some((r) => r.role === 'owner');

export async function applyEntry(entry, live, ctx = {}) {
  const { verb, args = {}, actor, ts } = entry;
  try {
    switch (verb) {
      case 'spawn': {
        if (entities.has(args.id)) return;
        entities.set(args.id, null); // reserve
        const obj = await loadGLB(args.lib);
        // it may have been moved or unmade while its bytes were in flight
        const queued = pendingOps.get(args.id);
        pendingOps.delete(args.id);
        if (queued?.removed) { entities.delete(args.id); return; }
        obj.userData.lib = args.lib;
        obj.userData.entityId = args.id;
        // receiveShadow now, castShadow LATER: a caster's depth-pass pipeline
        // compiles synchronously at its first shadow render, and during a
        // load that is one more freeze per object in the window that hurts.
        // Shadows are the last thing a world needs — they arrive one object
        // per beat once every queued load has drained (see drainShadows).
        obj.traverse((o) => { if (o.isMesh) o.receiveShadow = true; });
        shadowless.add(args.id);
        const sc = queued?.scale ?? args.scale;
        // decision sees the SPAWN scale: wrong-sized imports that arrive with a
        // corrective scale still classify by their real-world size
        fitCollider(args.id, obj, { collide: args.collide, scale: sc || 1 });
        obj.position.set(...(queued?.pos ?? args.pos ?? [0, 0, 0]));
        obj.rotation.y = queued?.yaw ?? args.yaw ?? 0;
        if (sc) obj.scale.setScalar(sc);
        // the logged rest pose — what motion composes on and rest returns to
        obj.userData.base = { pos: obj.position.toArray(), yaw: obj.rotation.y };
        reindexCollider(args.id);
        attachLocalLights(obj);   // async, deliberately not awaited
        entities.set(args.id, obj);
        entityMeta.set(args.id, { actor, lib: args.lib, ts });
        scene.add(obj);
        bus.emit('entity', { id: args.id, kind: 'spawn' });
        retryMounts();            // a waiting mount may have just become possible
        break;
      }
      case 'light': {
        if (entities.has(args.id)) {
          // re-issuing `light` on an existing id is a partial UPDATE
          // (brightness, color, range, keep, position) — the server fold
          // merges the same way; a live client mirrors it here instead of
          // ignoring the entry. A non-light holding the id (or a spawn still
          // downloading) refuses, same as before.
          const existing = entities.get(args.id);
          if (!existing?.userData?.isLight) return;
          updateLight(existing, args);
          if (args.pos) existing.position.set(...args.pos);
          bus.emit('entity', { id: args.id, kind: 'light' });
          return;
        }
        const g = makeLight({ color: args.color, intensity: args.intensity, range: args.range, keep: args.keep });
        g.userData.entityId = args.id;
        g.position.set(...(args.pos ?? [0, 1, 0]));
        entities.set(args.id, g);
        entityMeta.set(args.id, { actor, kind: 'light', ts });
        scene.add(g);
        bus.emit('entity', { id: args.id, kind: 'light' });
        break;
      }
      case 'place': {
        const obj = entities.get(args.id);
        if (!obj) {
          if (entities.has(args.id)) {           // reserved, still downloading
            const q = pendingOps.get(args.id) ?? {};
            if (args.pos) q.pos = args.pos;
            if (args.yaw != null) q.yaw = args.yaw;
            if (args.scale != null) q.scale = args.scale;
            pendingOps.set(args.id, q);
          }
          return;
        }
        if (args.pos) obj.position.set(...args.pos);
        if (args.yaw != null) obj.rotation.y = args.yaw;
        if (args.scale != null) obj.scale.setScalar(args.scale);
        if (!obj.userData.mountedTo) {
          obj.userData.base = { pos: obj.position.toArray(), yaw: obj.rotation.y };
        }
        // rescale can cross the room-scale threshold: re-decide, not just re-bucket
        refitCollider(args.id);
        bus.emit('entity', { id: args.id, kind: 'place' });
        break;
      }
      case 'remove': {
        const obj = entities.get(args.id);
        if (!obj && entities.has(args.id)) {      // reserved, still downloading
          pendingOps.set(args.id, { ...(pendingOps.get(args.id) ?? {}), removed: true });
          return;
        }
        if (obj) {
          if (obj.userData?.isLight) disposeLight(obj);
          // anything mounted ON it steps off first, keeping its world pose —
          // removal must not vaporize the cargo along with the truck
          for (const [cid, cobj] of entities) {
            if (cobj?.userData?.mountedTo === args.id) {
              scene.attach(cobj);
              delete cobj.userData.mountedTo;
              cobj.userData.base = { pos: cobj.position.toArray(), yaw: cobj.rotation.y };
              fitCollider(cid, cobj, { scale: cobj.scale?.x || 1 });
            }
          }
          (obj.parent ?? scene).remove(obj);
        }
        entities.delete(args.id);
        entityMeta.delete(args.id);
        comps.delete(args.id);
        pendingMounts.delete(args.id);
        shadowless.delete(args.id);
        removeCollider(args.id);
        bus.emit('entity', { id: args.id, kind: 'remove' });
        break;
      }
      case 'terrain': {
        const key = JSON.stringify(args);
        if (lastTerrainArgs === key) return;
        lastTerrainArgs = key;
        enqueueWorldBuild('terrain', async () => {
          await loadEidoModule('terrain.js');
          const layers = (args.layers ?? []).map((l) => ({
            map: noiseTexture(l.color ?? '#4a5d33'), repeat: l.repeat ?? 16,
          }));
          const t = globalThis.makeTerrain({ ...args, layers });
          // compile the ground's pipelines BEFORE it enters the scene — an
          // unprecompiled terrain material otherwise codegens synchronously
          // inside the first render() that sees it. BOUNDED: this build GATES
          // arrival, and on Safari one compile can cost seconds (measured
          // 08-02: boot went 10.7s) — past the cap the ground arrives anyway
          // and the still-running compile finishes warming it moments later.
          if (t?.mesh) {
            await Promise.race([
              renderer.compileAsync(t.mesh, camera, scene).catch(() => {}),
              new Promise((r) => setTimeout(r, 1200)),
            ]);
          }
          setTerrain(t);
          // re-seat only ground-level entities — anything with a meaningful y
          // (seated on furniture, elevated) keeps its logged height
          for (const [id, obj] of entities) {
            if (obj && Math.abs(obj.position.y) < 0.02) {
              obj.position.y = heightAt(obj.position.x, obj.position.z);
              if (obj.userData.base) obj.userData.base.pos[1] = obj.position.y;
              reindexCollider(id);
            }
          }
        });
        break;
      }
      case 'grass': {
        const key = JSON.stringify(args);
        if (lastGrassArgs === key) return;
        lastGrassArgs = key;
        if (args.clear) { clearGrass(); break; }   // an empty field: mow it
        enqueueWorldBuild('grass', async () => {
          // yields the main thread to arrival; resolves instantly once booted
          await whenBooted();
          // vegetation brush (createFlora) — makeGrass's replacement upstream.
          // Legacy makeGrass bags persisted in old world logs are mapped
          // inside buildFloraField; the log itself is never rewritten.
          const field = await buildFloraField(args, { scene, heightFn: heightAt });
          // borrow the mesh back out for a precompile
          // (compileAsync skips invisible objects, so hiding wouldn't work —
          // detach, compile against the scene's lighting, re-add warm)
          if (field?.mesh) {
            const parent = field.mesh.parent;
            parent?.remove(field.mesh);
            await renderer.compileAsync(field.mesh, camera, scene).catch(() => {});
            (parent ?? scene).add(field.mesh);
          }
          setGrass(field);
        });
        break;
      }
      case 'sky':
        // The shared fold stamps forecast provenance the same way the server
        // does (synthetic pre-history entries pass through already stamped) —
        // live viewers and late joiners must derive the same sky.
        await applySky(foldSkyEntry(null, { verb: 'sky', args, ts, seq: entry.seq, actor }), ts);
        break;
      case 'weather':
        // Weather is its own verb rather than a sky arg because DESIGN.md names
        // `transitionTo('storm')` as a first-class world event — it is a thing
        // that HAPPENS at a moment, not a property you set. The fold rebases
        // `hours` under a rated sky (no day-snap), records the manual
        // override when a forecast is active, and owns `keepSky` — all in
        // lockstep with the server's fold of the same entry.
        await applySky(foldSkyEntry(currentSkyArgs(),
          { verb: 'weather', args, ts, seq: entry.seq, actor }), ts);
        break;
      case 'asset':
        // An upload became part of this world's vocabulary: the palette grows
        // for everyone, live (broadcast) and forever (replay for late joiners).
        libLabels.set(args.path, args.name ?? 'upload');
        bus.emit('asset', { name: args.name ?? 'upload', path: args.path });
        break;
      case 'say': {
        const isAgent = ctx.agents?.has(actor);
        logChat(actor, args.text, isAgent ? 'agent' : '', {
          seq: entry.seq, ts,
          // spoken-say protocol only: display metadata for a voice that
          // already performed as captions (server sanitizes; this is the
          // client's own guard for old/foreign servers)
          ...(args.spoken === true && Number.isSafeInteger(args.utt)
            ? { spoken: true, utt: args.utt, t0: args.t0 } : {}),
        });
        // spoken:true = this utterance was already PERFORMED as presence
        // (captions paced the bubble to the voice); the say is its record.
        // Log always, re-perform never — the full timer-free decoupling.
        if (live && !args.spoken) bus.emit('speech', { actor, text: args.text });
        break;
      }
      case 'grant': {
        // permissions are log entries like everything else — mirror them so
        // the UI can say what you are here, live. Enforcement is the server's.
        const cur = worldRoles.get(args.id) ?? { role: 'visitor' };
        worldRoles.set(args.id, {
          role: args.role ?? cur.role,
          gen: args.gen != null ? Boolean(args.gen) : cur.gen,
        });
        if (live) {
          const bits = [args.role, args.gen != null ? (args.gen ? '+gen' : '-gen') : null].filter(Boolean);
          logChat('*', `${actor === 'world' ? 'the world' : actor} made ${args.id} ${bits.join(' ')}`);
        }
        bus.emit('roles', { id: args.id, ...worldRoles.get(args.id) });
        break;
      }
      case 'ban': case 'unban': case 'kick': {
        // Moderation is log history like everything else; enforcement is the
        // server's (fold + expel). Here it only narrates, and only LIVE —
        // replaying an old ban as if it just happened would be a lie.
        if (live) {
          const what = verb === 'ban' ? 'banned' : verb === 'unban' ? 'lifted the ban on' : 'removed';
          logChat('*', `${actor} ${what} ${args.id}${verb !== 'unban' && args.reason ? ` — ${args.reason}` : ''}`);
        }
        break;
      }
      case 'comp': {
        // The generic component fold — mirror of the server's blind one.
        if (!args.id || typeof args.type !== 'string') return;
        const bag = comps.get(args.id) ?? {};
        if (args.data == null) delete bag[args.type]; else bag[args.type] = args.data;
        if (Object.keys(bag).length) comps.set(args.id, bag); else comps.delete(args.id);
        if (args.type === 'motion' && args.data == null) restAtBase(args.id);
        bus.emit('comp', { id: args.id, type: args.type, data: args.data ?? null });
        break;
      }
      case 'motion': {
        // sugar for the motion component; {type: null} = come to rest
        const { id, ...m } = args;
        // mirror of the server fold: an epoch-less motion starts when spoken
        if (m.type != null && m.t0 == null) m.t0 = ts;
        const bag = comps.get(id) ?? {};
        if (m.type == null) { delete bag.motion; restAtBase(id); }
        else bag.motion = m;
        if (Object.keys(bag).length) comps.set(id, bag); else comps.delete(id);
        bus.emit('comp', { id, type: 'motion', data: bag.motion ?? null });
        break;
      }
      case 'mount': {
        if (!args.id || !args.to) return;
        applyMount(args);
        break;
      }
      case 'dismount': {
        const obj = entities.get(args.id);
        if (obj && obj.userData.mountedTo) {
          scene.attach(obj);                     // keeps the world transform it had
          delete obj.userData.mountedTo;
          // plane-transition stamp wins over wherever the ride left it
          if (args.pos) obj.position.set(...args.pos);
          if (args.yaw != null) obj.rotation.set(0, args.yaw, 0);
          obj.userData.base = { pos: obj.position.toArray(), yaw: obj.rotation.y };
          // its collider was parked while mounted — stand it back up
          // (size-derived collide decision; an explicit spawn override is lost
          // across a mount cycle, acceptable until colliders learn to ride)
          fitCollider(args.id, obj, { scale: obj.scale?.x || 1 });
        }
        avatarMounts.delete(args.id);
        pendingMounts.delete(args.id);
        bus.emit('mount', { id: args.id, to: null });
        break;
      }
      case 'use':
        // a cause, not an effect: nothing to render — reactions arrive as
        // their own log entries. Surfaced for UI/behaviors that care.
        if (live) bus.emit('use', { actor, ...args });
        break;
      case 'behavior':
        // the client's mirror of the binding roster: the QuickJS tier runs
        // server-side, but client-runtime MOD OFFERS (runtime: "client") are
        // consumed here — mods.js watches this map and asks the person.
        if (args.remove) behaviors.delete(args.id);
        else if (args.id && args.src) {
          behaviors.set(args.id, {
            src: args.src,
            ...(args.runtime ? { runtime: args.runtime } : {}),
            ...(args.knobs ? { knobs: args.knobs } : {}),
            author: args.by ?? actor,
          });
        }
        bus.emit('behavior-roster', { live });
        break;
      case 'punt':
        // a cause, like force: folds to nothing, and live clients with a
        // physics plugin VOLUNTEER to simulate it (physobj.js) — the lease
        // table arbitrates who wins. History keeps the kicker's name.
        if (live) bus.emit('punt', { actor, ...args });
        break;
      case 'force':
        // an instantaneous radial cause (blast, gust): no state to fold, so a
        // replay never re-detonates — the log keeps the historical fact, and
        // only bodies present at the moment feel it (main.js applies it to
        // MY body under my own consent; everyone else's tumble arrives as
        // their streamed poses, like any motion of theirs).
        if (live) bus.emit('force', { actor, ...args });
        break;
      default:
        // Unknown verbs are not errors — a newer client may author verbs this
        // one doesn't render yet, and the log must stay forward-compatible.
        console.debug('unhandled verb', verb, args);
    }
  } catch (e) { report(`entry ${verb}`, e); }
}

// ---- named parts ------------------------------------------------------------

/** root Object3D -> Map(partName -> {obj|null, at}). Misses retry once a
 *  second rather than caching forever: models load ASYNC, so the part a comp
 *  names may simply not exist yet — freezing out a legitimate name because
 *  the GLB was still downloading would be a load-order bug, not a contract.
 *  Shared by motion.js (animating parts) and mounting (riding them). */
const _partCache = new WeakMap();
export function findPart(root, name) {
  let map = _partCache.get(root);
  if (!map) { map = new Map(); _partCache.set(root, map); }
  const hit = map.get(name);
  if (hit && (hit.obj || Date.now() - hit.at < 1000)) return hit.obj;
  let found = null;
  root.traverse((c) => { if (!found && c !== root && c.name === name) found = c; });
  map.set(name, { obj: found, at: Date.now() });
  return found;
}

// ---- mounting ---------------------------------------------------------------

/** A named attachment point, from the entity's `sockets` component:
 *  comp {id, type: 'sockets', data: {seat: {pos:[...], yaw, pose?, part?}}}
 *  Coords are the MODEL's local frame — the frame `measure` reports, so a
 *  flat-zone center is a socket pos verbatim. A socket that names a `part`
 *  (a node motion.js animates, e.g. a swing's seat assembly) keeps the same
 *  coords but RIDES that part's motion instead of standing on the rest pose. */
const socketOf = (id, slot) => (slot ? comps.get(id)?.sockets?.[slot] : null);

/** World-space position of a socket, for reach checks and hints. Ignores the
 *  part's motion on purpose: "how far is the seat" should not oscillate with
 *  the swing. Fills out; returns null when either half is missing. */
export function socketWorldPos(id, slot, out) {
  const parent = entities.get(id);
  const sock = socketOf(id, slot);
  if (!parent || !sock) return null;
  parent.updateWorldMatrix(true, false);
  return out.set(...(sock.pos ?? [0, 0.5, 0])).applyMatrix4(parent.matrixWorld);
}

function applyMount(args) {
  if (!entities.has(args.id)) {
    // a body, not a thing — remotes/controller consume this (sitter on a
    // swing seat rides the parent frame; wiring lands with avatar mounting)
    avatarMounts.set(args.id, { to: args.to, slot: args.slot, offset: args.offset, yaw: args.yaw });
    bus.emit('mount', { id: args.id, to: args.to, slot: args.slot });
    return;
  }
  const child = entities.get(args.id);
  const parent = entities.get(args.to);
  if (!child || !parent) {                 // either end still downloading
    pendingMounts.set(args.id, args);
    return;
  }
  pendingMounts.delete(args.id);
  const sock = socketOf(args.to, args.slot);
  const off = args.offset ?? sock?.pos ?? [0, 0, 0];
  parent.add(child);                       // transform becomes parent-relative
  child.position.set(...off);
  child.rotation.set(0, args.yaw ?? sock?.yaw ?? 0, 0);
  // a part socket glues the cargo INTO the moving node, so it rides the
  // part's motion. Same glue-don't-teleport rule as /mount: attach preserves
  // the world transform, which bakes the part's current phase into the offset.
  const partNode = sock?.part ? findPart(parent, String(sock.part)) : null;
  if (partNode) partNode.attach(child);
  child.userData.mountedTo = args.to;
  // its collider would go stale the moment the parent moves; the parent's own
  // collider is what the pair collides as while attached
  removeCollider(args.id);
  bus.emit('mount', { id: args.id, to: args.to, slot: args.slot });
}

function retryMounts() {
  for (const args of [...pendingMounts.values()]) applyMount(args);
}

// A seated body's world transform, live: parent entity's CURRENT transform
// (mid-pendulum, mid-path — motion.js has already ticked it this frame)
// composed with the socket. This is what makes a sitter actually RIDE the
// swing: their body is derived, not streamed.
//
// When the socket names a `part`, the seat point additionally rides that
// part's motion: the model-frame point is carried through the part's current
// DISPLACEMENT (live transform ∘ rest⁻¹, in world terms). At rest the
// displacement is identity, so a part socket sits exactly where a plain one
// does — declaring the part only adds the arc. This is the missing half of
// motion:<part>: without it a rider sat still while the plank swung through
// them (the fox's swing, commons, 2026-08-03).
//
// The socket offset goes through the parent's full matrixWorld (scale
// included) rather than quaternion+position: socket coords are model-frame,
// and a spawn-scaled model renders its seat scaled too.
const _mtQ = new THREE.Quaternion();
const _mtF = new THREE.Vector3();
const _mtV = new THREE.Vector3();
const _mtM = new THREE.Matrix4();
/** Fill outPos with rider's world seat position; returns {yaw, pose, to,
 *  seatState, seatReason} or null when not mounted (or the parent isn't live
 *  yet). `rider` is {path, av} — the roster path and live wrapper of the
 *  body being seated; without it the seat is declared approximate, because
 *  a correction we cannot gate is a correction we may not apply (#101). */
export function mountTransform(riderId, outPos, rider) {
  const m = avatarMounts.get(riderId);
  if (!m) return null;
  const parent = entities.get(m.to);
  if (!parent) return null;
  const sock = (comps.get(m.to)?.sockets ?? {})[m.slot] ?? {};
  parent.updateWorldMatrix(true, false);
  _mtF.set(...(m.offset ?? sock.pos ?? [0, 0.5, 0])).applyMatrix4(parent.matrixWorld);
  const part = sock.part ? findPart(parent, String(sock.part)) : null;
  if (part && part.parent && part.userData.mbase) {
    // mbase = the part's rest pose, captured by motion.js the first time it
    // animates it. Absent mbase means the part has never moved: identity.
    const b = part.userData.mbase;
    part.updateWorldMatrix(true, false);
    _mtM.compose(_mtV.set(...b.pos), _mtQ.fromArray(b.quat), part.scale)
      .premultiply(part.parent.matrixWorld).invert();       // world → part-at-rest
    _mtF.applyMatrix4(_mtM).applyMatrix4(part.matrixWorld); // …re-emerge from the live part
  }
  // The profile correction (#101): contact plane onto the authored socket
  // plane, applied AFTER part displacement so a profiled rider carries it
  // through a moving part's arc. The subtraction is along WORLD up — mounted
  // bodies render upright (yaw only, below), so a tilted parent's normal
  // would displace the root laterally while the body's contact geometry
  // stays vertical (the B2 discriminator in tools/seatcore-test.ts). Gate
  // closed = today's root-at-socket, declared, never silent.
  const seat = seatCorrectionFor(rider, sock);
  if (seat.applied) {
    const c = applySeatCorrection([_mtF.x, _mtF.y, _mtF.z], seat.contactY, seat.scale);
    if (c) _mtF.set(c[0], c[1], c[2]);
  }
  outPos.copy(_mtF);
  parent.getWorldQuaternion(_mtQ);
  _mtF.set(0, 0, 1).applyQuaternion(_mtQ);
  const parentYaw = Math.atan2(_mtF.x, _mtF.z);
  return { yaw: parentYaw + (m.yaw ?? sock.yaw ?? 0), pose: sock.pose ?? 'sitchair', to: m.to,
    seatState: seat.applied ? 'profiled' : 'approximate', seatReason: seat.applied ? null : seat.reason };
}

/** Motion ended: rest at the logged base pose. Anything that rests AWAY from
 *  base (a ferry stopping mid-route) gets a `place` alongside its stop —
 *  that is the plane-transition stamp, and it rewrites base above. */
function restAtBase(id) {
  const obj = entities.get(id);
  const base = obj?.userData?.base;
  if (!obj || !base) return;
  obj.position.set(...base.pos);
  obj.rotation.set(0, base.yaw ?? 0, 0);
  reindexCollider(id);
}

// sky.js owns the current args; world.js only needs them to merge a weather
// verb on top. Imported lazily to keep the module graph one-directional.
let currentSkyArgs = () => ({});
export function setSkyArgsSource(fn) { currentSkyArgs = fn; }

/** Turn a folded snapshot back into the verbs that would have produced it.
 *
 *  Deliberately NOT a second way of building a world. The state goes back
 *  through applyEntry as synthetic entries, so there is exactly one code path
 *  that puts things in a scene — if snapshot-joining and log-joining could
 *  drift apart, they eventually would, and the difference would be a world
 *  that looks different depending on when you arrived.
 *
 *  Order matters the way it does in a log: ground before the things standing
 *  on it. */
export function stateToEntries(state, { skipChatFromSeq = Infinity } = {}) {
  if (!state) return [];
  const out = [];
  let seq = -1;
  const add = (verb, args, actor = 'world', ts = Date.now()) =>
    out.push({ seq: seq--, ts, actor, verb, args });   // negative: pre-history

  for (const [id, r] of Object.entries(state.roles ?? {})) {
    add('grant', { id, role: r.role, ...(r.gen ? { gen: true } : {}) });
  }
  if (state.terrain) add('terrain', state.terrain);
  if (state.grass) add('grass', state.grass);
  if (state.sky) add('sky', state.sky, 'world', state.sky.ts ?? Date.now());
  for (const a of state.assets ?? []) add('asset', a);
  for (const [id, e] of Object.entries(state.entities ?? {})) {
    if (e.kind === 'light') {
      add('light', { id, pos: e.pos, color: e.color, intensity: e.intensity, range: e.range,
        ...(e.keep ? { keep: true } : {}) },
        e.actor ?? 'world', e.ts ?? Date.now());
    } else {
      add('spawn', {
        id, lib: e.lib, pos: e.pos, yaw: e.yaw,
        ...(e.scale != null ? { scale: e.scale } : {}),
        // carried through the snapshot for the same reason as scale: the
        // spawn verb's `collide` override decides exact-vs-box, and rebuilding
        // the entry without it makes a snapshot-joiner's world disagree with a
        // log-joiner's. applyEntry reads args.collide; give it the same value
        // the original spawn carried.
        ...(e.collide != null ? { collide: e.collide } : {}),
      }, e.actor ?? 'world', e.ts ?? Date.now());
    }
  }
  // components and attachments, after every spawn exists (a mount whose GLB
  // is still in flight waits in pendingMounts, same as a trailing `place`)
  for (const [id, e] of Object.entries(state.entities ?? {})) {
    for (const [type, data] of Object.entries(e.comp ?? {})) add('comp', { id, type, data });
    if (e.parent) add('mount', { id, ...e.parent });
  }
  for (const [id, rel] of Object.entries(state.mounts ?? {})) add('mount', { id, ...rel });
  for (const [id, b] of Object.entries(state.behaviors ?? {})) {
    add('behavior', { id, src: b.src, ...(b.runtime ? { runtime: b.runtime } : {}),
      ...(b.knobs ? { knobs: b.knobs } : {}), by: b.author }, b.author ?? 'world', b.ts ?? Date.now());
  }
  // Anything the tail will replay must not also be rendered from the snapshot.
  // Chat keeps its REAL seq, unlike the world-shaping entries above: it is the
  // only part of a snapshot that is a position in history rather than a
  // description of the present, and the scrollback cursor is derived from it.
  // Without this the first page-back re-fetches what is already on screen.
  for (const m of state.recentChat ?? []) {
    if ((m.seq ?? -1) >= skipChatFromSeq) continue;
    const e = { seq: typeof m.seq === 'number' ? m.seq : seq--, ts: m.ts, actor: m.actor,
                verb: 'say', args: { text: m.text } };
    out.push(e);
  }
  return out;
}

export function resetWorld() {
  worldRoles.clear();
  behaviors.clear();
  shadowless.clear();
  for (const [id, obj] of entities) { if (obj) (obj.parent ?? scene).remove(obj); removeCollider(id); }
  entities.clear();
  entityMeta.clear();
  comps.clear();
  avatarMounts.clear();
  pendingMounts.clear();
  lastTerrainArgs = lastGrassArgs = null;
  pendingOps.clear();
  // Anything hanging off entities that owns GPU resources and per-frame hooks
  // (emitters, today) retires here. Announced rather than imported so the
  // owning module stays a leaf — world.js is imported BY it.
  bus.emit('world-reset', {});
}
