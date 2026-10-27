// world — the authored plane's scene registries and world-scope builders.
//
// The log's MEANING lives in shared/fold.js (state.js folds it; the
// realizers in realize/ project it into the scene). What remains here is
// what every consumer shares: the entity/comp/mount registries, the
// world-build queue that gates arrival on ground, the world-scope
// application functions the environment/social realizers drive, mount
// transforms, and the deferred shadow drain. The applyEntry switch that
// once folded entries directly into the scene — and the pendingOps/
// pendingMounts machinery that reconstructed ordering downstream — is
// gone: state is folded once, realizers read it, and every load
// completion re-reads current state (TEL0S_NOTES §11).

import { bodyOf } from '../../shared/components.js';
import { socketsUnder, resolveSeat } from '../../shared/sockbody.js';
import { THREE, scene, camera, renderer } from './core.js';
import { report, bus, CONFIG } from './base.js';
// net.js does NOT import this module (its own note: "live grants keep it fresh
// via world.js"), so this direction closes no cycle.
import { net, replica } from './net.js';
import { enc, dec } from '../../shared/protocol/names.js';
import { kindOf } from '../../shared/protocol/kind.js';
import { loadEidoModule, noiseTexture, loadTrack, loadDone, libLabels } from './assets.js';
import { prepareObject } from './materials.js';
import { beginWork } from './loadwork.js';
import { reindexCollider } from './colliders.js';
import { setTerrain, setGrass, clearGrass, heightAt, setFlatGround } from './terrain.js';
import { flatHeightOf } from '../../shared/terrainmath.js';
import { shapeParams, shapedHeightAt, requestGrid, setGridFetcher, gridRetryIn, shapeReady } from '../../shared/terrainshape.js';
import { materialLayerSpecs } from '../../shared/terrainlayers.js';
setGridFetcher(async (ref) => { const r = await fetch(`/library/${ref}`); if (!r.ok) throw new Error(`${r.status}`); return r.json(); });
import { applyWater } from './water.js';
import { buildFloraField, warmField, loadFloraModule } from './flora.js';
import { applySky, whenSkyWarm } from './sky.js';
import { whenBooted, bootDone } from './boot.js';
import { warm, P_GATE } from './warmqueue.js';
// seat correction for mounted occupants (upstream #101) — the me-drive frame
// calls these for every seated body; their import fell on the fork side of
// a merge hunk while the call site auto-merged, and every SIT threw 56
// ReferenceErrors a second (antra, live, from a swing in commons2)
import { occupyCorrectionFor } from './occupants.js';
import { applySeatCorrection } from './seatcore.js';
import { isOwner } from '../../shared/protocol/roles.js';

/** id -> Object3D. `null` is a reservation held while the GLB downloads, so a
 *  duplicate spawn in the same tick can't create two bodies for one id. */
export const entities = new Map();
/** A thing's fold record as this client folds it (shared/protocol/replica.js): {model?, transform, parent?, …components},
 *  component keys as the fold spells them (shared/protocol/names.js). ONE record for every reader — the Hierarchy, the
 *  Inspector, every evaluator (motion.js reads `motion`; a seat reads its socket child's `socket`; the server reads `reactions`) — so
 *  nothing is held beside the fold to drift (C7c; the `comps` Map the realizer mirrored it into is gone). Frozen in
 *  dev: a reader that writes into it throws. Data is opaque here, as on the server: unknown types just sit in it.
 *  Read it where you need it; never keep it across an ingest — a write replaces the record (the frozen one is thawed
 *  by copy), so a kept reference goes stale. */
export const bagOf = (id) => replica.st?.entities?.[enc(String(id))]?.c ?? null;
/** Every placed thing's [id, record], ids as the page spells them (the world entity excluded). */
export function* bags() {
  const es = replica.st?.entities; if (!es) return;
  for (const k in es) if (k !== '@world') yield [dec(k) ?? k, es[k].c];
}
/** What a thing IS as realized and where from, for the panels: {kind, lib?} — the fold's word (shared/protocol/kind.js),
 *  the realizer keeps no second copy (entityMeta is gone, C7c). */
export const metaOf = (id) => { const c = bagOf(id); return c ? { kind: kindOf({ c }), ...(typeof c.model === 'string' ? { model: c.model } : {}) } : null; };
/** The tree's edges as this client's fold indexes them (shared/protocol/replica.js, kept at every ingest): the ids a
 *  carrier holds (id order), a thing's carrier, the ids above it nearest first — ids as the page spells them. One
 *  index for the realizer's carrier checks, the panels and the seats; no map is kept beside the fold (C12b). */
const out = (k) => dec(k) ?? k;
export const childrenOf = (id) => replica.childrenOf?.(enc(String(id))).map(out) ?? [];
export const parentIdOf = (id) => { const p = replica.parentOf?.(enc(String(id))); return p == null ? null : out(p); };
export const ancestorsOf = (id) => replica.ancestors?.(enc(String(id))).map(out) ?? [];
/** A host's sockets (PLAN-sockets-entities: a socket is a child entity {transform, parent: {to: host}, socket: {name,
 *  part?, body?, accepts?, radius?}}): [{id, name, sock}], from the fold's children index. The one reader every client
 *  surface shares (clickuse, localbody, seatbody, the Inspector, xrpointer, the scene panel). */
export const socketsOn = (host) => socketsUnder(String(host), childrenOf, bagOf);
/** A socket child as a seat reads it: {id (the socket), host, name, sock (its socket component)}, or null when `id` isn't
 *  a socket in the fold (yet, or any more), or is switched off. */
export function seatSocket(id) {
  const c = id == null ? null : bagOf(id);
  if (!c?.socket || typeof c.socket !== 'object') return null;
  // a socket switched off (or under something switched off) is closed to occupying, as the authority reads it (occupants.js: offChain):
  // whoever sits there lets go (localbody's per-frame check), and a frame naming it seats nobody (review 10-12 S3-3)
  if (c.disabled === true || ancestorsOf(id).some((a) => bagOf(a)?.disabled === true)) return null;
  return { id: String(id), host: parentIdOf(id), name: c.socket.name, sock: c.socket, station: c.station && typeof c.station === 'object' ? c.station : null };
}
// Avatar attachments: the map is mounts.js's (a leaf, so the lite client's net.js can read it); re-exported for the rest
import { avatarMounts } from './mounts.js';
export { avatarMounts };
/** A body's seat is PRESENCE (PROTOCOL: bodies aren't entities; nothing is logged): its owner's pose frame carries
 *  `seat: {to: <socket id>}` while seated, so every receiver sets it from the frame and clears it when a frame comes
 *  without one. A frame from a client before sockets were entities says {to: <host>, slot}: it names the host's socket
 *  child of that name (shared/sockbody.js resolveSeat, one release). A seat naming no socket here is no seat. My own is
 *  set here by localbody.js and rides my frames (net.js sendPose). */
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
/** What else a seat frame carries (shared/sockbody.js): the pose the occupant chose from the socket's menu and when
 *  (`pose`, `at`: a sync group follows the latest choice), and their input (`in`: throttle, steer, aimYaw, aimPitch)
 *  when the socket routes it. Read by occupybody.js for every occupant, mine and everyone else's, the same way. */
function seatExtras(m, seat) {
  const fin = Number.isFinite;
  if (typeof seat.pose === 'string' && /^[a-z0-9][a-z0-9_-]{0,31}$/i.test(seat.pose)) { m.pose = seat.pose; m.at = fin(seat.at) ? seat.at : 0; } else { delete m.pose; delete m.at; }
  const i = seat.in;
  if (i && typeof i === 'object') { m.in = {}; for (const k of ['throttle', 'steer', 'aimYaw', 'aimPitch']) if (fin(i[k])) m.in[k] = i[k]; } else delete m.in;
}


export const liveEntities = () => [...entities.values()].filter(Boolean);

/** ids someone is actively editing — the residency sweep must never demote
 *  them (review S4: id-based, because promote/demote SWAPS the object a
 *  userData flag would ride). build.js and panel editors add/remove. */
export const editHolds = new Set();

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
// The sky's arrival gate rides its own counter, NOT the worldBuild chain:
// grass parks that chain on whenBooted(), so a sky queued behind it would
// hold the curtain against itself (see applySkyFolded).
let skyGate = 0;
export const buildsPending = () => gatingDepth + skyGate;
export const anyBuildsPending = () => buildDepth + skyGate;

// Guards so a re-join (avatar switch, reconnect) that replays the log doesn't
// regenerate an identical world.
let lastTerrainArgs = null;
let stageFloor = true;   // no terrain built: the stage floor stands (with the world's water, if any)
let lastGrassArgs = null;

// ---- world-scope state application ------------------------------------------
// Driven by the environment/social realizers (realize/environment.js,
// realize/social.js). Written during the migration window as one
// implementation under two drivers; the legacy driver is gone, the names
// stay.

/** Build (or rebuild) the terrain from its authored bag. Dedupes by args so
 *  a re-join replaying the same world does not regenerate identical ground. */
export function applyTerrainState(args) {
  // no terrain: the stage floor returns, with the world's water on it when it has some (environment.js groundArgs
  // {stageFloor, water}; house review I8) and without the old ground's water when it doesn't
  // …and a flat terrain is that floor at its height (componentspec terrain kind flat)
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
    // A heightmap's grid is fetched BEFORE the build, so the ground arrives shaped rather than snapping from
    // noise to image a moment later (and the walking heightAt never disagrees with the mesh in between).
    // No grid, no build: the ground already standing stays (noise is not this world's ground), and the
    // build runs once the grid lands — the same readiness the sim waits on (shapeReady).
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
    // the layer textures ride the engine's colorNode, unreachable from
    // material properties — carry them so terrain disposal can free them
    // (review S5)
    if (t) t.layerTextures = layers.map((l) => l.map);
    // the factory dresses the ground BEFORE its compile: wetness + cloud
    // shade + receiveShadow (real terrain never received before — only the
    // stage floor did, and that hides when this lands)
    if (t?.mesh) prepareObject(t.mesh, { kind: 'terrain' });
    // compile the ground's pipelines BEFORE it enters the scene — an
    // unprecompiled terrain material otherwise codegens synchronously
    // inside the first render() that sees it. UNCAPPED, through the warm
    // conductor and awaited fully (§16.2.A): this build gates arrival, so
    // the splash simply holds a moment longer and the ground enters
    // compiled. (A 1200ms Promise.race cap lived here for slow-compile
    // Safari boots — but past the cap the biggest material in the world
    // entered the scene UNCOMPILED and codegen'd inside the first render()
    // that saw it, §16.1c. An uncompiled ground is worse than a longer
    // splash.)
    if (t?.mesh) {
      // P_GATE: arrival waits on THIS item — the first 8b gate measured a
      // rain world booting in 16s because the cloud-march compiles queued
      // ahead of the ground the curtain was actually waiting for
      await warm('compile terrain', () => renderer.compileAsync(t.mesh, camera, scene).catch(() => {}), { p: P_GATE });
    }
    setTerrain(t);
    // the water reads the ground it fills (its per-vertex depth), so it is built on THIS terrain
    try { applyWater(args, heightAt); } catch (e) { report('water', e); }
    // re-seat only ground-level entities — anything with a meaningful y
    // (seated on furniture, elevated) keeps its logged height
    for (const [id, obj] of entities) {
      if (obj && !obj.userData.mountedTo && Math.abs(obj.position.y) < 0.02) {   // a parented thing's y is in its parent's frame
        obj.position.y = heightAt(obj.position.x, obj.position.z);
        if (obj.userData.base) obj.userData.base.pos[1] = obj.position.y;
        reindexCollider(id);
      }
    }
  });
}

// A heightmap terrain whose grid did not come: ask again as the fetch backoff allows (shared/terrainshape.js
// gridRetryIn), and build THIS bag once — unless a newer terrain has arrived meanwhile.
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

// Edits sent but not yet echoed: two quick patches must compose (the second builds on the first), not both
// build on the last echo and the second erase the first. A sent bag stands as the base until the world
// echoes something, or PENDING_MS passes with no echo (the edit was refused).
let pendingTerrain = null;   // { args, at }
const PENDING_MS = 5000;
/** The bag a new terrain edit should build on: the newest sent-but-unechoed edit, else the built one. */
export function terrainEditBase() {
  if (pendingTerrain && Date.now() - pendingTerrain.at < PENDING_MS) return structuredClone(pendingTerrain.args);
  return currentTerrainArgs();
}
/** Record a terrain bag as sent, so the next edit composes with it. Returns the bag. */
export function noteTerrainSent(args) { pendingTerrain = { args, at: Date.now() }; return args; }

/** Placed features and heightmaps (shared/terrainshape.js) over the toolkit's noise mesh: the same law the
 *  agents and the sim ground bodies on. Every vertex re-heighted, normals redone, and the walking heightAt
 *  swapped for the shaped one — so what you see is what you stand on. The vertex-colour layer weights stay
 *  the toolkit's (baked from the unshaped noise); the panel's single-layer ground has none to disagree. */
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

// Def hot-reload (§24): the sequencer pushes `defs-updated` when a def file
// changes on disk. Re-hydrate the registry (replacing — edits land, removals
// leave) and regrow the meadow from the SAME authored args: the world state
// is untouched, only the content the defs shape rebuilds. The dedupe key is
// cleared so applyGrassState treats the regrow as new work.
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

/** Grow (or mow) the grass field. Same dedupe-by-args contract. */
export function applyGrassState(args) {
  if (!args) return;
  const key = JSON.stringify(args);
  if (lastGrassArgs === key) return;
  lastGrassArgs = key;
  if (args.clear) { clearGrass(); return; }   // an empty field: mow it
  enqueueWorldBuild('grass', async () => {
    // yields the main thread to arrival; resolves instantly once booted
    await whenBooted();
    // vegetation brush (createFlora) — makeGrass's replacement upstream.
    // Legacy makeGrass bags persisted in old world logs are mapped
    // inside buildFloraField; the log itself is never rewritten.
    const field = await buildFloraField(args, { scene, heightFn: heightAt });
    // factory pass before the precompile (field.mesh is the whole stroke
    // group): wet sheen on the meadow, sweep markers, no shadow receipt
    // (grass never received, and its fragment cost is the client's biggest)
    if (field?.mesh) prepareObject(field.mesh, { kind: 'grass' });
    // warm EVERY render object off the render path. The old field-level
    // compileAsync silently skipped whatever applyTiles had culled against
    // the boot camera (visible=false / out of frustum), and those tiles
    // compiled synchronously inside render() when first looked at.
    // warmField (flora.js) detaches per object, defeats culling, compiles
    // one per frame, then re-settles tile counts against the live camera —
    // still inside this build's beginWork('build grass') accounting.
    if (field?.mesh) await warmField(field, renderer, camera, scene);
    setGrass(field);
  });
}

/** Apply an already-FOLDED sky bag (state.st.sky or foldSkyEntry output).
 *  `ts` anchors live transition timing; a snapshot passes the bag's own. */
// During INITIAL hydration, arrival gates on the sky's pipeline warm
// (§16.2.D): the dome compiles are ~3s of splash instead of ~3s of visible
// jank — the warm used to await whenBooted() and land squarely AFTER the
// curtain lifted (§16.1g). Capped: a degraded or headless sky must never
// brick arrival (lightbench's bolt-seam section knows sky can degrade) —
// past the cap the curtain lifts and the warm continues in the conductor
// behind it. A mid-session sky verb (bootDone) gates nothing and behaves
// exactly as before; a world with no sky verb never reaches this and gates
// on nothing. The gate registers synchronously inside the hydration
// realizer pass — before checkReady can ever observe an empty queue (same
// ordering guarantee terrain leans on, realize/environment.js).
let skyGated = false;
// 25s, was 8: the gate now covers the first bake's cloud-graph compile
// (§19a — measured 9.3s ending at t=15.3s on THIS box's cold GPU cache;
// a slower GPU must not have the curtain lift mid-stall, and the gate
// resolves EARLY via whenBakeReady the moment the pipeline is warm — the
// cap only binds pathological cases. Near-zero on warm Dawn caches.
// tel0s chose splash over a mid-session stall until upstream can cache
// the graph per flavour.)
const SKY_GATE_MAX_MS = 25000;
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
        // visible in __loadLog: the gate line names the giving-up, and the
        // still-running warm keeps its own conductor records
        work.phase('lifted-at-cap');
        setTimeout(() => work.end(), 2);
      } else work.end();
    });
  }
  return p;
}

/** An upload became part of this world's vocabulary: the palette grows for
 *  everyone, live (broadcast) and forever (replay/snapshot for joiners). */
export function applyAssetState(args) {
  if (!args?.path) return;
  libLabels.set(args.path, args.name ?? 'upload');
  bus.emit('asset', { name: args.name ?? 'upload', path: args.path });
}

/** Mirror one role record so the UI can say what you are here, live.
 *  Enforcement is the server's; narration is the LIVE driver's business
 *  (legacy case or livechat.js), not this mirror's. */
export function applyGrantState(id, rec) {
  // a role taken away: back to the world's default (the authority reads @world default-role)
  if (!rec) { worldRoles.delete(id); bus.emit('roles', { id, role: null }); return; }
  worldRoles.set(id, { role: rec.role ?? 'inhabitant', gen: rec.can?.generate === true, fly: rec.can?.fly === true || Boolean(rec.fly) });
  bus.emit('roles', { id, ...worldRoles.get(id) });
  // (What I MAY DO is the server's answer, `your-rights`, re-sent whenever a role changes; this mirror is the HUD's.)
}

// (The deferred shadow-in drain that lived here — markShadowless /
// drainShadows, one caster per 250ms beat, lanes-idle trigger, 30s fallback
// — is gone: object.castShadow is in no pipeline cache key, so the light
// rig budgets the caster set live by camera distance, reversibly.
// lightrig.js §12.5.)

// Per-world roles (@world roles:<id>), mirrored from the view. A mirror for UI honesty — the authority enforces; this only
// lets the client SAY what someone is.
const worldRoles = new Map();
export const roleOf = (id) => worldRoles.get(id) ?? null;
export const worldHasOwner = () => [...worldRoles.values()].some(isOwner);

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

/** World-space position of a socket (a socket child's id), for reach checks and hints: its host's transform composed
 *  with the socket's own (local to the host). Ignores a part's motion on purpose: "how far is the seat" should not
 *  oscillate with the swing. Fills out; returns null when either half is missing. */
export function socketWorldPos(id, out) {
  const s = seatSocket(id);
  const host = s?.host != null ? entities.get(s.host) : null;
  if (!host) return null;
  host.updateWorldMatrix(true, false);
  const p = bagOf(id)?.transform?.pos;
  return out.set(...(Array.isArray(p) && p.length === 3 ? p : [0, 0, 0])).applyMatrix4(host.matrixWorld);
}

// A seated body's world transform, live: the SOCKET's realized object (realize/models.js: an Empty attached to its host,
// or into the host's moving part at rest), read through its matrixWorld — the host's CURRENT transform (mid-pendulum,
// mid-path: motion.js has already ticked it this frame), the part's displacement when the socket rides one, then the
// socket's own pose. This is what makes an occupant actually RIDE the swing: their body is derived, not streamed. The
// scene graph carries the part, so an occupant and a thing on that socket ride it the same way.
const _mtQ = new THREE.Quaternion();
const _mtF = new THREE.Vector3();
const _mtV = new THREE.Vector3();
const _mtR = new THREE.Quaternion(), _mtS = new THREE.Quaternion(), _UP = new THREE.Vector3(0, 1, 0);
/** Fill outPos with the occupant's ROOT position on its seat; returns {q (the root's whole rotation), socketPos, socketQ,
 *  body, sock, upright, yaw, pose, to (the socket), host, slot (its name), seatState, seatReason} or null when not
 *  mounted (or the socket isn't live yet). `occ` is {path, av} — the roster path and live wrapper of the body.
 *
 *  Where the root goes is the socket's ANCHOR (shared/sockbody.js): the body point that lands on the socket — hips for
 *  a seat, feet for a standing place, head, or the root itself — measured from the occupant's posed skeleton
 *  (avatar.anchorOffset), so any body in any clip puts its hips on the cushion. A pose may add an offset (socket frame).
 *  Until the body has been measured the root sits at the socket, declared approximate. A socket whose body anchors at
 *  'surface' (the seat authors its support plane, D14) takes the seat-profile correction (#101) instead. */
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
  // the occupant's: the socket's, or, where the occupant set its own heading, the socket's frame without its own turn (the
  // host's, a part's displacement included) then that heading
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
    // the seat-height correction (#101) is a world-up subtraction, so it only holds while the socket stands upright
    const seat = upright ? occupyCorrectionFor(occ, s.station) : { applied: false, reason: 'the socket is tilted (the seat profile assumes upright)' };
    if (seat.applied) { const c = applySeatCorrection([_mtF.x, _mtF.y, _mtF.z], seat.contactY, seat.scale); if (c) _mtF.set(c[0], c[1], c[2]); state = 'profiled'; }
    else reason = seat.reason;
  }
  outPos.copy(_mtF);
  _mtF.set(0, 0, 1).applyQuaternion(_mtR);
  return { q: _mtR.toArray(), socketPos, socketQ: socketQw.toArray(), body, sock, upright, yaw: Math.atan2(_mtF.x, _mtF.z), pose: body?.clip ?? 'sitchair', to: s.id, host: s.host, slot: s.name ?? null,
    seatState: state, seatReason: reason };
}

// sky.js owns the current args; world.js only needs them to merge a weather
// verb on top. Imported lazily to keep the module graph one-directional.
let currentSkyArgs = () => ({});
export function setSkyArgsSource(fn) { currentSkyArgs = fn; }

