// world — the authored plane's scene registries and world-scope builders.
//
// The log's meaning lives in shared/protocol/fold.js (net.js folds it through replica.js; realize/ projects it into
// the scene). Here is what every consumer shares: the entity registry and fold readers, the world-build queue that
// gates arrival on ground, the world-scope appliers the environment/social realizers drive, and mount transforms.

import { bodyOf } from '../../shared/components.js';
import { socketsUnder, resolveSeat } from '../../shared/sockbody.js';
import { THREE, scene, camera, renderer } from './core.js';
import { report, bus, CONFIG } from './base.js';
import { net, replica } from './net.js';   // net.js does not import this module: no cycle
import { enc, dec } from '../../shared/protocol/names.js';
import { loadEidoModule, noiseTexture, loadTrack, loadDone, libLabels } from './assets.js';
import { prepareObject } from './render/materials.js';
import { beginWork } from './render/loadwork.js';
import { reindexCollider } from './colliders.js';
import { setTerrain, setGrass, clearGrass, heightAt, setFlatGround } from './terrain.js';
import { flatHeightOf } from '../../shared/terrainmath.js';
import { shapeParams, shapedHeightAt, requestGrid, setGridFetcher, gridRetryIn, shapeReady } from '../../shared/terrainshape.js';
import { materialLayerSpecs } from '../../shared/terrainlayers.js';
setGridFetcher(async (ref) => { const r = await fetch(`/library/${ref}`); if (!r.ok) throw new Error(`${r.status}`); return r.json(); });
import { applyWater } from './water.js';
import { buildFloraField, warmField, loadFloraModule } from './vegetation/flora.js';
import { applySky, whenSkyWarm } from './sky/sky.js';
import { whenBooted, bootDone } from './boot.js';
import { warm, P_GATE } from './render/warmqueue.js';
import { occupyCorrectionFor } from './player/occupants.js';
import { applySeatCorrection } from '../../shared/seatcore.js';
import { isOwner } from '../../shared/protocol/roles.js';

/** id -> Object3D. `null` is a reservation held while the GLB downloads, so a duplicate spawn can't make two bodies. */
export const entities = new Map();
/** A thing's fold record (shared/protocol/replica.js): {model?, transform, parent?, …components}, keys as the fold
 *  spells them (shared/protocol/names.js). The one record for every reader, so nothing is held beside the fold to
 *  drift. Frozen in dev. Never keep it across an ingest: a write replaces the record. */
export const bagOf = (id) => replica.st?.entities?.[enc(String(id))]?.c ?? null;
/** Every placed thing's [id, record], ids as the page spells them (the world entity excluded). */
export function* bags() {
  const es = replica.st?.entities; if (!es) return;
  for (const k in es) if (k !== '@world') yield [dec(k) ?? k, es[k].c];
}
/** A thing's model, for the panels: {model?}, read from the fold. */
export const metaOf = (id) => { const c = bagOf(id); return c ? { ...(typeof c.model === 'string' ? { model: c.model } : {}) } : null; };
/** The tree's edges as the fold indexes them (shared/protocol/replica.js): a carrier's children (id order), a thing's
 *  carrier, the ids above it nearest first; ids as the page spells them. */
const out = (k) => dec(k) ?? k;
export const childrenOf = (id) => replica.childrenOf?.(enc(String(id))).map(out) ?? [];
export const parentIdOf = (id) => { const p = replica.parentOf?.(enc(String(id))); return p == null ? null : out(p); };
export const ancestorsOf = (id) => replica.ancestors?.(enc(String(id))).map(out) ?? [];
/** A host's sockets (a socket is a child entity with a `socket` component): [{id, name, sock}], from the fold's
 *  children index. The one reader every client surface shares. */
export const socketsOn = (host) => socketsUnder(String(host), childrenOf, bagOf);
/** A socket child as a seat reads it: {id (the socket), host, name, sock (its socket component)}, or null when `id` isn't
 *  a socket in the fold (yet, or any more), or is switched off. */
export function seatSocket(id) {
  const c = id == null ? null : bagOf(id);
  if (!c?.socket || typeof c.socket !== 'object') return null;
  // a socket switched off (or under something switched off) is closed to occupying, as the authority reads it
  if (c.disabled === true || ancestorsOf(id).some((a) => bagOf(a)?.disabled === true)) return null;
  return { id: String(id), host: parentIdOf(id), name: c.socket.name, sock: c.socket, station: c.station && typeof c.station === 'object' ? c.station : null };
}
// the map is mounts.js's (a leaf, so the lite client's net.js can read it); re-exported for the rest
import { avatarMounts } from './player/mounts.js';
export { avatarMounts };
/** A body's seat is presence, not logged: its owner's pose frame carries `seat: {to: <socket id>}` while seated, so
 *  every receiver sets it from the frame and clears it when a frame comes without one. An older frame's {to: <host>,
 *  slot} names the host's socket child of that name (shared/sockbody.js resolveSeat). My own is set by localbody.js. */
export function setBodySeat(id, seat) {
  const cur = avatarMounts.get(id);
  const to = seat?.to ? seatSocketId(seat) : null;
  if (!to) { if (cur) { avatarMounts.delete(id); bus.emit('mount', { id, to: null }); } return; }
  if (cur?.to === to) { seatExtras(cur, seat); return; }
  const m = { to };
  seatExtras(m, seat);
  avatarMounts.set(id, m);
  bus.emit('mount', { id, to });
}
function seatSocketId(seat) {
  if (seatSocket(seat.to)) return String(seat.to);
  if (typeof seat.slot !== 'string' || !replica.st) return null;
  const hit = resolveSeat(replica.st, { to: enc(String(seat.to)), slot: seat.slot });   // the old frame: the host's socket of that name
  return hit ? (dec(hit.to) ?? hit.to) : null;
}
/** What else a seat frame carries: the pose the occupant chose and when (`pose`, `at`), and their input (`in`:
 *  throttle, steer, aimYaw, aimPitch) when the socket routes it. Read by occupybody.js for every occupant. */
function seatExtras(m, seat) {
  const fin = Number.isFinite;
  if (typeof seat.pose === 'string' && /^[a-z0-9][a-z0-9_-]{0,31}$/i.test(seat.pose)) { m.pose = seat.pose; m.at = fin(seat.at) ? seat.at : 0; } else { delete m.pose; delete m.at; }
  const i = seat.in;
  if (i && typeof i === 'object') { m.in = {}; for (const k of ['throttle', 'steer', 'aimYaw', 'aimPitch']) if (fin(i[k])) m.in[k] = i[k]; } else delete m.in;
}


/** ids someone is actively editing; the residency sweep (realize/models.js) must never demote them. */
export const editHolds = new Set();

// Heavy world construction (terrain, grass: seconds of main-thread geometry) runs on its own ordered chain so log
// replay doesn't wait behind it; the terrain step re-seats ground objects when it lands.
let worldBuild = Promise.resolve();
let buildDepth = 0;
let gatingDepth = 0;
// terrain gates arrival (you cannot stand in a world with no ground); grass is decoration and grows around you
const GATING = new Set(['terrain']);
function enqueueWorldBuild(what, fn) {
  buildDepth++;
  if (GATING.has(what)) gatingDepth++;
  bus.emit('build-queue', { depth: buildDepth, what });
  worldBuild = worldBuild
    .then(() => {
      loadTrack(`build:${what}`, `growing ${what}`);
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
// the sky's arrival gate rides its own counter, not the worldBuild chain: grass parks that chain on whenBooted(), so
// a sky queued behind it would hold the curtain against itself (applySkyFolded)
let skyGate = 0;
export const buildsPending = () => gatingDepth + skyGate;
export const anyBuildsPending = () => buildDepth + skyGate;

// dedupe keys: a re-join that replays the log must not regenerate an identical world
let lastTerrainArgs = null;
let stageFloor = true;   // no terrain built: the stage floor stands (with the world's water, if any)
let lastGrassArgs = null;

// ---- world-scope state application ------------------------------------------
// Driven by the environment/social realizers (realize/environment.js, realize/social.js).

/** Build (or rebuild) the terrain from its authored bag; deduped by args. */
export function applyTerrainState(args) {
  // no terrain, or a flat one: the stage floor at that height, with the world's water on it when it has some
  // (realize/environment.js groundArgs)
  const flat = flatHeightOf(args);
  if (!args || args.stageFloor === true || flat !== null) {
    const key = args ? JSON.stringify(args) : null;
    if (lastTerrainArgs !== key) { lastTerrainArgs = key; if (!stageFloor) { stageFloor = true; setTerrain(null); } setFlatGround(flat ?? 0);
      try { applyWater(args, heightAt); } catch (e) { report('water', e); } }
    return;
  }
  stageFloor = false; setFlatGround(0);
  const key = JSON.stringify(args);
  if (pendingTerrain && JSON.stringify(pendingTerrain.args) === key) pendingTerrain = null;   // our edit, echoed
  if (lastTerrainArgs === key) return;
  lastTerrainArgs = key;
  enqueueWorldBuild('terrain', async () => {
    await loadEidoModule('terrain.js');
    // a heightmap's grid is fetched before the build, so the ground arrives shaped; no grid, no build: the ground
    // already standing stays and the build runs once the grid lands
    const shape = shapeParams(args);
    if (shape?.heightmap && !(await requestGrid(shape.heightmap.grid))) {
      if (lastTerrainArgs !== key) return;
      report(`heightmap ${shape.heightmap.grid} has not loaded — keeping the ground already here, retrying`, new Error('grid unavailable'));
      retryTerrainWhenGridLands(args, key, shape.heightmap.grid);
      return;
    }
    if (lastTerrainArgs !== key) return;   // a newer terrain arrived while the grid was in flight
    const layers = materialLayerSpecs(args.layers).map((l) => ({
      map: noiseTexture(l.color ?? '#4a5d33'), repeat: l.repeat ?? 16,
    }));
    const t = globalThis.makeTerrain({ ...args, layers });
    if (t && shape) reshapeTerrain(t, args);
    // the layer textures ride the colorNode, unreachable from material properties: carry them so terrain.js can free them
    if (t) t.layerTextures = layers.map((l) => l.map);
    // dress the ground (wetness, cloud shade, receiveShadow) before its compile
    if (t?.mesh) prepareObject(t.mesh, { kind: 'terrain' });
    // compile the ground's pipelines before it enters the scene (an uncompiled material codegens synchronously in the
    // first render that sees it); awaited fully at P_GATE, since arrival waits on this
    if (t?.mesh) {
      await warm('compile terrain', () => renderer.compileAsync(t.mesh, camera, scene).catch(() => {}), { p: P_GATE });
    }
    setTerrain(t);
    // the water reads the ground it fills (per-vertex depth), so it is built on this terrain
    try { applyWater(args, heightAt); } catch (e) { report('water', e); }
    // re-seat only ground-level entities; anything with a meaningful y keeps its logged height
    for (const [id, obj] of entities) {
      if (obj && !obj.userData.mountedTo && Math.abs(obj.position.y) < 0.02) {   // a parented thing's y is in its parent's frame
        obj.position.y = heightAt(obj.position.x, obj.position.z);
        if (obj.userData.base) obj.userData.base.pos[1] = obj.position.y;
        reindexCollider(id);
      }
    }
  });
}

// a heightmap terrain whose grid did not come: retry as the fetch backoff allows (shared/terrainshape.js gridRetryIn)
// and build this bag once, unless a newer terrain has arrived
let terrainRetry = null;
function retryTerrainWhenGridLands(args, key, ref) {
  clearTimeout(terrainRetry);
  terrainRetry = setTimeout(async () => {
    if (lastTerrainArgs !== key) return;
    if (!(await requestGrid(ref))) { if (lastTerrainArgs === key) retryTerrainWhenGridLands(args, key, ref); return; }
    if (lastTerrainArgs !== key) return;
    lastTerrainArgs = null;   // let the same bag through the dedupe, this once
    applyTerrainState(args);
  }, Math.max(250, gridRetryIn(ref)));
}
/** Whether the world's terrain is waiting on its heightmap's grid (the ground shown is the last one built). */
export const terrainPending = () => terrainRetry !== null && lastTerrainArgs !== null && !shapeReady(shapeParams(JSON.parse(lastTerrainArgs)));

/** The authored terrain bag this client last built from — what EW.terrain(patch) edits. */
export function currentTerrainArgs() { return lastTerrainArgs ? JSON.parse(lastTerrainArgs) : null; }

// edits sent but not yet echoed: two quick patches must compose, so a sent bag is the base until the world echoes
// something or PENDING_MS passes (the edit was refused)
let pendingTerrain = null;   // { args, at }
const PENDING_MS = 5000;
/** The bag a new terrain edit should build on: the newest sent-but-unechoed edit, else the built one. */
export function terrainEditBase() {
  if (pendingTerrain && Date.now() - pendingTerrain.at < PENDING_MS) return structuredClone(pendingTerrain.args);
  return currentTerrainArgs();
}
/** Record a terrain bag as sent, so the next edit composes with it. Returns the bag. */
export function noteTerrainSent(args) { pendingTerrain = { args, at: Date.now() }; return args; }

/** Placed features and heightmaps (shared/terrainshape.js) over the toolkit's noise mesh, the same law the agents
 *  ground bodies on: every vertex re-heighted, normals redone, and the walking heightAt swapped for the shaped one. */
function reshapeTerrain(t, args) {
  const hf = shapedHeightAt(t.heightAt, args);
  const pos = t.mesh.geometry.attributes.position;
  for (let i = 0; i < pos.count; i++) pos.setY(i, hf(pos.getX(i), pos.getZ(i)));
  pos.needsUpdate = true;
  t.mesh.geometry.computeVertexNormals();
  t.mesh.geometry.computeBoundingBox();
  t.mesh.geometry.computeBoundingSphere();
  t.heightAt = hf;
}

// def hot-reload: on `defs-updated`, re-hydrate the flora registry and regrow the meadow from the same authored args
// (the dedupe key is cleared so the regrow counts as new work)
bus.on('defs-updated', async () => {
  try {
    const mod = await loadFloraModule();
    await mod.refreshFloraDefs?.();
    if (!lastGrassArgs) return;
    const args = JSON.parse(lastGrassArgs);
    lastGrassArgs = null;
    applyGrassState(args);
  } catch (e) {
    console.warn('[defs] hot reload failed — old defs stand:', e);
  }
});

/** Grow (or mow) the grass field; deduped by args. */
export function applyGrassState(args) {
  if (!args) return;
  const key = JSON.stringify(args);
  if (lastGrassArgs === key) return;
  lastGrassArgs = key;
  if (args.clear) { clearGrass(); return; }
  enqueueWorldBuild('grass', async () => {
    await whenBooted();   // yields the main thread to arrival; instant once booted
    // legacy makeGrass bags in old logs are mapped inside buildFloraField; the log is never rewritten
    const field = await buildFloraField(args, { scene, heightFn: heightAt });
    if (field?.mesh) prepareObject(field.mesh, { kind: 'grass' });   // wet sheen, sweep markers, no shadow receipt
    // warm every render object off the render path: a field-level compileAsync would skip whatever the boot camera
    // culled (flora.js warmField)
    if (field?.mesh) await warmField(field, renderer, camera, scene);
    setGrass(field);
  });
}

// During initial hydration, arrival gates on the sky's pipeline warm, so the dome compiles are splash rather than jank
// after the curtain. Capped: past SKY_GATE_MAX_MS the curtain lifts and the warm continues behind it (a degraded or
// headless sky must never brick arrival). A mid-session sky verb gates nothing.
let skyGated = false;
const SKY_GATE_MAX_MS = 25000;   // covers the first bake's cloud-graph compile on a cold GPU cache; whenSkyWarm usually resolves far sooner
/** Apply an already-folded sky bag (state.st.sky). `ts` anchors live transition timing; a snapshot passes the bag's own. */
export function applySkyFolded(bag, ts) {
  if (!bag) return Promise.resolve();
  const p = Promise.resolve(applySky(bag, ts ?? bag.ts)).catch((e) => report('sky', e));
  if (!skyGated && !bootDone()) {
    skyGated = true;
    skyGate = 1;
    loadTrack('build:sky', 'warming the sky');
    bus.emit('build-queue', { depth: buildDepth, what: 'sky' });
    const work = beginWork('sky gate');
    work.phase('warm');
    Promise.race([
      whenSkyWarm(),
      new Promise((r) => setTimeout(() => r('timeout'), SKY_GATE_MAX_MS)),
    ]).then((how) => {
      skyGate = 0;
      loadDone('build:sky');
      bus.emit('build-queue', { depth: buildDepth, what: 'sky' });
      if (how === 'timeout') {
        work.phase('lifted-at-cap');   // named in __loadLog
        setTimeout(() => work.end(), 2);
      } else work.end();
    });
  }
  return p;
}

/** An upload became part of this world's vocabulary: the palette grows for everyone. */
export function applyAssetState(args) {
  if (!args?.path) return;
  libLabels.set(args.path, args.name ?? 'upload');
  bus.emit('asset', { name: args.name ?? 'upload', path: args.path });
}

/** Mirror one role record so the UI can say what someone is here. Enforcement is the server's (`your-rights`). */
export function applyGrantState(id, rec) {
  // a role taken away: back to the world's default
  if (!rec) { worldRoles.delete(id); bus.emit('roles', { id, role: null }); return; }
  worldRoles.set(id, { role: rec.role ?? 'member', gen: rec.can?.generate === true, fly: rec.can?.fly === true || Boolean(rec.fly) });
  bus.emit('roles', { id, ...worldRoles.get(id) });
}

// per-world roles (@world roles:<id>), mirrored from the view for the HUD
const worldRoles = new Map();
export const roleOf = (id) => worldRoles.get(id) ?? null;
export const worldHasOwner = () => [...worldRoles.values()].some(isOwner);

// ---- named parts ------------------------------------------------------------

/** A named part under a root, cached per root. Misses retry once a second rather than caching forever: models load
 *  async, so the part a comp names may simply not exist yet. */
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

/** World-space position of a socket, for reach checks and hints: its host's transform composed with the socket's own.
 *  Ignores a part's motion on purpose ("how far is the seat" should not oscillate with the swing). Null when missing. */
export function socketWorldPos(id, out) {
  const s = seatSocket(id);
  const host = s?.host != null ? entities.get(s.host) : null;
  if (!host) return null;
  host.updateWorldMatrix(true, false);
  const p = bagOf(id)?.transform?.pos;
  return out.set(...(Array.isArray(p) && p.length === 3 ? p : [0, 0, 0])).applyMatrix4(host.matrixWorld);
}

// A seated body's world transform is derived live from the socket's realized object (realize/models.js) through its
// matrixWorld: the host's current transform, a moving part's displacement, then the socket's own pose. That is what
// makes an occupant ride the swing: their body is derived, not streamed.
const _mtQ = new THREE.Quaternion();
const _mtF = new THREE.Vector3();
const _mtV = new THREE.Vector3();
const _mtR = new THREE.Quaternion(), _mtS = new THREE.Quaternion(), _UP = new THREE.Vector3(0, 1, 0);
/** Fill outPos with the occupant's root position on its seat; returns {q, socketPos, socketQ, body, sock, upright, yaw,
 *  pose, to (the socket), host, slot, seatState, seatReason} or null when not mounted. `occ` is {path, av}.
 *
 *  The root goes where the socket's anchor (shared/sockbody.js: hips, feet, head or root) lands on the socket,
 *  measured from the occupant's posed skeleton (avatar.anchorOffset); a pose may add an offset. Until the body is
 *  measured the root sits at the socket, declared approximate. A 'surface' anchor takes the seat-profile correction
 *  (occupants.js) instead. */
const _mtP = new THREE.Vector3(), _mtW = new THREE.Quaternion();
export function mountTransform(occupantId, outPos, occ, poseOffset = null) {
  const m = avatarMounts.get(occupantId);
  if (!m) return null;
  const s = seatSocket(m.to);
  const sObj = s ? entities.get(s.id) : null;
  if (!sObj) return null;
  const sock = s.sock;
  const body = bodyOf(s.station);
  sObj.updateWorldMatrix(true, false);
  _mtF.setFromMatrixPosition(sObj.matrixWorld);
  // the socket's whole world rotation (a rocket seat lies on its back), part displacement and host included
  const socketQw = sObj.getWorldQuaternion(_mtW);
  // the occupant's rotation: the socket's, or, where the occupant set a heading, the socket's frame without its own turn then that heading
  if (Number.isFinite(m.yaw)) { const lq = bagOf(s.id)?.transform?.q; _mtR.copy(socketQw).multiply(_mtS.fromArray(Array.isArray(lq) && lq.length === 4 ? lq : [0, 0, 0, 1]).invert()).multiply(_mtQ.setFromAxisAngle(_UP, m.yaw)); }
  else _mtR.copy(socketQw);
  const upright = _mtV.set(0, 1, 0).applyQuaternion(_mtR).y > 0.966;   // within 15°
  const socketPos = _mtF.toArray();
  let state = 'approximate', reason = null;
  if (body && body.anchor !== 'surface') {
    if (poseOffset) _mtF.add(_mtP.fromArray(poseOffset).applyQuaternion(socketQw));
    if (body.anchor === 'root') state = 'anchored';
    else {
      occ?.av?.setAnchorWant?.(body.anchor);
      const off = occ?.av?.anchorOffset?.();
      if (off) { _mtF.sub(_mtP.fromArray(off).multiply(occ.av.root.scale).applyQuaternion(_mtR)); state = 'anchored'; }
      else reason = occ?.av ? `measuring the ${body.anchor}` : 'body loading';
    }
  } else {
    // the seat-height correction is a world-up subtraction, so it only holds while the socket stands upright
    const seat = upright ? occupyCorrectionFor(occ, s.station) : { applied: false, reason: 'the socket is tilted (the seat profile assumes upright)' };
    if (seat.applied) { const c = applySeatCorrection([_mtF.x, _mtF.y, _mtF.z], seat.contactY, seat.scale); if (c) _mtF.set(c[0], c[1], c[2]); state = 'profiled'; }
    else reason = seat.reason;
  }
  outPos.copy(_mtF);
  _mtF.set(0, 0, 1).applyQuaternion(_mtR);
  return { q: _mtR.toArray(), socketPos, socketQ: socketQw.toArray(), body, sock, upright, yaw: Math.atan2(_mtF.x, _mtF.z), pose: body?.clip ?? 'sitchair', to: s.id, host: s.host, slot: s.name ?? null,
    seatState: state, seatReason: reason };
}

// sky.js owns the current sky args; main.js hands in the reader so the module graph stays one-directional
let currentSkyArgs = () => ({});
export function setSkyArgsSource(fn) { currentSkyArgs = fn; }

