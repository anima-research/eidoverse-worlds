// models — the first realizer (TEL0S_NOTES §11.4): entity lifecycle as a
// projection of state.st. The applyEntry switch this replaced is gone.
//
// The design's one trick, and why pendingOps/pendingMounts have no successor
// here: EVERY completion re-reads current state. A `place` landing while the
// GLB is in flight just changes state; the load's completion applies what is
// current. A `remove` mid-download cancels the owner and the completion
// notices the id is gone. A mount whose ends aren't both live yet simply
// STAYS in the fold — state is the pending list — and re-checks when a
// spawn realizes (mountsTouching). Nothing is remembered twice.
//
// This module writes the maps every consumer shares (world.js entities/
// entityMeta/comps/avatarMounts) and emits the bus events they subscribe
// to ('entity', 'comp', 'mount') — motion, emitters, panels, controller,
// remotes, and the terrain re-seat all read those, not this file. Loads go
// through the scheduler: keyed, owned, prioritized by live camera distance
// at dequeue, cancelled on remove.
//
// Fold-faithfulness: a removed carrier's cargo lands at the pose the FOLD
// stamped (the trigonometry every joiner and the server agree on), and a
// same-id spawn REPLACES wholesale — PROTOCOL.md §3.1, the 2026-08-09
// erratum, pinned by fixture 04-overwrite.

import { THREE, scene, camera } from '../core.js';
import { report, bus } from '../base.js';
import { loadGLB, retainGLB, releaseGLB, evictIdleProtos, lodRecipeReady, gpuPressure,
  lodNegotiable, negotiationReady } from '../assets.js';
import { makeModelQuality, chooseTier } from '../lod_policy.js';
import { colliders, fitCollider, removeCollider, reindexCollider, refitCollider } from '../colliders.js';
import { attachLamps, releaseOwner, registerCaster, releaseCaster } from '../lightrig.js';
import { makeLight, updateLight, disposeLight } from '../lights.js';
import { entities, entityMeta, comps, avatarMounts, findPart, editHolds } from '../world.js';
import { state, onWorldChange } from '../state.js';
import { schedule, cancelOwner } from '../scheduler.js';
import { planReconcile, bandForDistance, mountsTouching, collisionOwnedElsewhere } from './models_field.js';

/** The verbs this realizer owns — the whole flat entity-id namespace. */
export const PORTED = new Set(['spawn', 'place', 'remove', 'light', 'comp', 'motion', 'mount', 'dismount']);

/** id → {kind:'model'|'light', lib?, gen} — the realizer's own view of what
 *  it has handled. gen guards a load completion against acting for a
 *  reservation that was retired and re-created while its bytes flew. */
const tracked = new Map();
let nextGen = 1;

const _v = new THREE.Vector3();

// ---- placeholders -----------------------------------------------------------
// The world appears at FOLD time: a translucent box the size of the real
// thing (bbox from the server's geom side-channel), standing at the folded
// transform until the GLB lands. ONE shared geometry + ONE shared material —
// a placeholder tier that cost pipelines would be the disease it treats.
// Placeholders are real entities to the maps (a `place` moves them, a mount
// seats them, motion swings them, panels list them); they are invisible to
// the camera's collision (noCamCollide) and to colliders/shadows, and they
// carry no entityMeta — which is what keeps the parity probe's identity
// check honestly silent about them.

const libGeom = new Map();   // lib -> {bbox} — fed by the 'geom' message
let _phGeo = null;
let _phMat = null;

function makePlaceholder(id, ent, g) {
  _phGeo ??= new THREE.BoxGeometry(1, 1, 1);
  _phMat ??= new THREE.MeshBasicNodeMaterial({ color: 0x8a9099, transparent: true, opacity: 0.22, depthWrite: false });
  const grp = new THREE.Group();
  const mesh = new THREE.Mesh(_phGeo, _phMat);
  mesh.scale.set(Math.max(g.bbox.size?.[0] ?? 0.5, 0.05), Math.max(g.bbox.size?.[1] ?? 0.5, 0.05), Math.max(g.bbox.size?.[2] ?? 0.5, 0.05));
  mesh.position.set(...(g.bbox.center ?? [0, 0, 0]));
  mesh.castShadow = mesh.receiveShadow = false;
  // the shared translucent stand-in material must never be swept into a
  // weather wrap — that would recompile it mid-session for every placeholder
  mesh.userData.noWet = true;
  mesh.userData.noCloudShadow = true;
  grp.add(mesh);
  grp.userData.entityId = id;
  grp.userData.placeholder = true;
  grp.userData.noCamCollide = true;
  grp.position.set(...(ent.pos ?? [0, 0, 0]));
  grp.rotation.y = ent.yaw ?? 0;
  if (ent.scale) grp.scale.setScalar(ent.scale);
  grp.userData.base = { pos: grp.position.toArray(), yaw: grp.rotation.y };
  return grp;
}

/** Stand a placeholder in for a still-loading reservation, if its size is
 *  known. Safe to call again — only a bare `null` reservation upgrades. */
function maybePlaceholder(id) {
  if (entities.get(id) !== null) return;   // realized, placeholdered, or unknown
  const ent = state.st.entities[id];
  const g = ent?.lib ? libGeom.get(ent.lib) : null;
  if (!ent || ent.kind === 'light' || !g?.bbox) return;
  const grp = makePlaceholder(id, ent, g);
  entities.set(id, grp);
  scene.add(grp);
  bus.emit('entity', { id, kind: 'placeholder' });
}

const isPlaceholder = (obj) => Boolean(obj?.userData?.placeholder);

/** Drop a placeholder (or a bare reservation) for an id whose load resolved
 *  some other way than realization. */
function clearReservation(id) {
  const cur = entities.get(id);
  if (cur === null || isPlaceholder(cur)) {
    if (cur) (cur.parent ?? scene).remove(cur);
    entities.delete(id);
  }
}

// ---- mount indices (§16.2.C) ------------------------------------------------
// The promote path used to pay two O(N) scans per promote (the rider step-out
// walked ALL entities; mountsTouching Object.entries'd them again) and the
// 500ms sweep paid O(N) per demote CANDIDATE (canDemote's carrier scan) —
// O(N²) at scale. These two maps are faster spellings of those exact
// predicates, never state: fold parity cannot see them.
//
// TWO indices because the two truths genuinely diverge:
// - FOLD truth (parent-id -> children whose state parent.to is it) serves
//   canDemote's carrier refusal, the sockets re-seat, and mountsTouching —
//   consumers asking "what does the fold WANT mounted here". Maintained at
//   one choke point (indexFoldParent) driven from the verbs that can write a
//   parent record: mount/dismount set/clear the id's own; spawn/light replace
//   the record wholesale; remove deletes the children's records too.
// - SCENE truth (parent-id -> children whose realized object is attached,
//   i.e. userData.mountedTo) serves the two cargo step-out loops — a `remove`
//   folds the children's parent records away BEFORE retire() runs, so at
//   step-out time the scene attachment is all there is left to read.
//   Maintained exactly where userData.mountedTo is written or cleared.
const foldChildren = new Map();  // parent id -> Set(child id)   (state truth)
const foldParentOf = new Map();  // child id -> parent id        (reverse, O(1) moves)
const sceneChildren = new Map(); // parent id -> Set(child id)   (scene truth)
const sceneParentOf = new Map();

function indexFoldParent(id) {
  const to = state.st.entities[id]?.parent?.to ?? null;
  const prev = foldParentOf.get(id) ?? null;
  if (prev === to) return;
  if (prev) {
    const s = foldChildren.get(prev);
    if (s) { s.delete(id); if (!s.size) foldChildren.delete(prev); }
  }
  if (to) {
    let s = foldChildren.get(to);
    if (!s) foldChildren.set(to, s = new Set());
    s.add(id);
    foldParentOf.set(id, to);
  } else foldParentOf.delete(id);
}

/** Re-derive after a verb that can write parent records. For `remove`, the
 *  fold has already stripped the children's records — refresh them too. */
function refoldParents(verb, id) {
  if (!id) return;
  if (verb === 'remove') {
    const kids = foldChildren.get(id);
    if (kids) for (const cid of [...kids]) indexFoldParent(cid);
  }
  indexFoldParent(id);
}

function rebuildFoldIndex() {
  foldChildren.clear();
  foldParentOf.clear();
  for (const [cid, ent] of Object.entries(state.st.entities)) {
    const to = ent.parent?.to;
    if (!to) continue;
    let s = foldChildren.get(to);
    if (!s) foldChildren.set(to, s = new Set());
    s.add(cid);
    foldParentOf.set(cid, to);
  }
}

/** Mirror one userData.mountedTo write (`to` = parent id) or clear (null). */
function indexSceneMount(id, to) {
  const prev = sceneParentOf.get(id) ?? null;
  if (prev === to) return;
  if (prev) {
    const s = sceneChildren.get(prev);
    if (s) { s.delete(id); if (!s.size) sceneChildren.delete(prev); }
  }
  if (to) {
    let s = sceneChildren.get(to);
    if (!s) sceneChildren.set(to, s = new Set());
    s.add(id);
    sceneParentOf.set(id, to);
  } else sceneParentOf.delete(id);
}

// ---- creation ---------------------------------------------------------------

function createModel(id, ent) {
  const gen = nextGen++;
  tracked.set(id, { kind: 'model', lib: ent.lib, gen });
  entities.set(id, null);   // reservation — the contract every consumer knows
  maybePlaceholder(id);     // …upgraded to a sized stand-in when geom is known
  // STREAMING (§13.3 R1 + §16.2.C): the gate works from POSITION, stand-in
  // or not. At hydration the geom side-channel hasn't landed yet, so the old
  // placeholder-only gate was inert exactly when it mattered (§16.1f) —
  // every model in the world loaded just to be demoted by the first sweep.
  // A far entity keeps its reservation (a sized stand-in the moment geom
  // lands) and loads NOTHING; the 500ms sweep promotes it if anything —
  // a walk, a `place`, a grown radius — brings it inside R. Unknown sizes
  // err LARGE via DIAG_DEFAULT. Live spawns share this path, which is what
  // keeps spawn-beyond-radius-never-loads (§13.3) holding.
  if (entDist(ent) > residencyRadius(ent)) return;
  scheduleLoad(id, ent, gen);
}

function scheduleLoad(id, ent, gen, tier = null) {
  const t0 = tracked.get(id);
  if (t0) t0.loading = true;   // the sweep must not re-promote a load in flight
  schedule({
    key: `entity:${id}`, owner: `entity:${id}`, lane: 'net',
    // live distance from the camera to the entity's CURRENT folded position —
    // re-read at dequeue, so walking toward a thing promotes its load
    priority: () => bandForDistance(camera.position.distanceTo(
      _v.set(...(state.st.entities[id]?.pos ?? [0, 0, 0])))),
    run: async (signal) => {
      // a first load chooses its tier at DEQUEUE, once /version has answered
      // (key and recipe are what make a lod ask real — assets.js
      // lodNegotiable) and from the live distance; a re-tier brings the tier
      // the sweep chose
      await negotiationReady;
      if (signal.aborted) return;
      const want = tier ?? tierFor(ent, null);
      const obj = await loadGLB(ent.lib, { tier: want });
      const cur = state.st.entities[id];
      const t = tracked.get(id);
      if (t?.gen === gen) t.loading = false;
      // the world may have moved on while the bytes flew: retired, replaced
      // by a light, re-spawned with a different lib (its own job follows),
      // demoted-then-reset, or this whole realizer generation was reset
      if (signal.aborted || t?.gen !== gen) return;
      if (!cur || cur.kind === 'light' || cur.lib !== ent.lib) {
        clearReservation(id);
        if (tracked.get(id)?.gen === gen) tracked.delete(id);
        return;
      }
      // a TIER SWAP replaces a REAL object, and authority is re-checked at
      // the moment of application, not only when the sweep scheduled it
      // (review of #170, point 3): while the bytes flew a body may have sat
      // down, cargo mounted, a part motion or socket arrived, an edit hold
      // begun — each makes the swap illegal now. The loaded clone is simply
      // not worn (nothing was retained for it; the proto stays pooled) and
      // the standing object keeps its collider, lamps, riders and mounts.
      // The sweep may try again after its cooldown, through the same gate.
      const standing = entities.get(id);
      if (standing && !isPlaceholder(standing) && standing.userData?.lib && !canRetier(id, cur)) {
        resStats.retiersRefused++;
        if (t) t.retierAt = Date.now();
        return;
      }
      realizeModel(id, cur, obj);
    },
  }).done.catch((e) => {
    const t = tracked.get(id);
    if (t?.gen === gen) t.loading = false;
    if (e?.name === 'AbortError') return;
    if (t) t.failedAt = Date.now();   // the sweep backs off, not machine-guns (review S3)
    // a failed load keeps its reservation, exactly like legacy: the id stays
    // addressable (a later remove folds cleanly), it just never renders
    report(`realize spawn ${id}`, e);
  });
}

// The VISIBLE half of a promote is synchronous — the thing appears the same
// frame it always did. The HEAVY TAIL (collider fit incl. possible BVH
// build, lamp scan, caster scan, mount re-checks) drains ≤~4ms per frame
// through 'promote-tail' (main.js frame list): six loads resolving in one
// task batch used to land six boulders in a single frame (§16.1e). A seat/
// surface/camera query in the frames before the collider lands simply
// misses the brand-new object — accepted (§16.2.C).
/** Everything a realized object holds that its replacement must not
 *  inherit — the demote teardown, factored so a tier swap (real → real) and
 *  a demote (real → placeholder) release identically. */
function teardownRealized(id, obj) {
  promoteTail.delete(id);   // a pending heavy tail dies — the replacement earns its own
  indexSceneMount(id, null);
  releaseGLB(obj.userData?.glbKey ?? obj.userData?.lib);
  cancelOwner(`entity:${id}`);
  releaseOwner(`entity:${id}`);          // lamp requests die with the meshes
  releaseCaster(id);
  removeCollider(id);
}

function realizeModel(id, cur, obj) {
  const stand = entities.get(id);
  if (stand && (isPlaceholder(stand) || stand.userData?.lib)) {
    // durable children attach to placeholders by design (execMount takes any
    // truthy parent) — step them out BEFORE the stand's subtree is removed,
    // and clear mountRel so the tail's execMount pass re-attaches them to the
    // real thing instead of early-returning on an identical key (review B1:
    // cargo mounted on a far carrier vanished forever at promote, parity
    // silently green). mountedTo stays (and so does the scene index entry):
    // that is what lets a retire() racing the re-mount still step them off.
    const kids = sceneChildren.get(id);
    if (kids) for (const cid of [...kids]) {
      const cobj = entities.get(cid);
      if (cobj?.userData?.mountedTo === id && cobj.parent) {
        scene.attach(cobj);
        delete cobj.userData.mountRel;
      }
    }
    // the stand itself may have ridden a carrier; the fresh clone starts
    // unattached — the tail's mountsTouching pass re-executes the linkage
    if (stand.userData.mountedTo) indexSceneMount(id, null);
    // a real object being REPLACED (a tier swap) releases what it held; a
    // placeholder held nothing
    if (!isPlaceholder(stand)) teardownRealized(id, stand);
    (stand.parent ?? scene).remove(stand);   // the real thing takes the spot
  }
  retainGLB(obj.userData.glbKey ?? cur.lib);   // the proto is worn — eviction must not undress it
  obj.userData.lib = cur.lib;
  obj.userData.tier = obj.userData.tierServed ?? 'full';   // the server's word, not the request
  // tierAsked rides along from loadGLB: a lod ask the server answered with the
  // original (not baked yet, or honestly refused — 'already light') wears
  // tier 'full' but ASKED 'lod'; the sweep compares wants against the ask, so
  // it is not re-asked every cooldown — only when the policy flips and back.
  obj.userData.entityId = id;
  const sc = cur.scale;
  obj.position.set(...(cur.pos ?? [0, 0, 0]));
  obj.rotation.y = cur.yaw ?? 0;
  if (sc) obj.scale.setScalar(sc);
  obj.userData.base = { pos: obj.position.toArray(), yaw: obj.rotation.y };
  entities.set(id, obj);
  entityMeta.set(id, { actor: cur.actor, lib: cur.lib, ts: cur.ts });
  scene.add(obj);
  bus.emit('entity', { id, kind: 'spawn' });
  // comps that folded while the GLB was in flight (or that rode the
  // snapshot) announce now — emitters and panels attach off these events
  emitCompBag(id);
  promoteTail.set(id, obj);   // the boulders land within the next frames
}

// ---- the promote tail (§16.2.C) ---------------------------------------------

/** id -> the realized object awaiting its heavy tail. Identity IS the guard:
 *  the drain runs an item only while entities.get(id) is still this object —
 *  deleted/demoted/replaced entities drop their tail silently (retire and
 *  demote also cancel eagerly, so a demoted stand-in can never inherit the
 *  real model's collider). */
const promoteTail = new Map();

/** Sharing the per-lib collider derivations is sound exactly when the
 *  subtree is the pristine clone: no rider glued in (a mount verb may have
 *  landed in the gap; stepped-out riders sit at the scene root and don't
 *  count), no part motion that may already have bent a named node since the
 *  clone was cut. Everything else builds per-entity — correctness beats
 *  sharing (§16.2.C). */
function shareableLib(id, cur) {
  if (!cur?.lib) return null;
  const kids = sceneChildren.get(id);
  if (kids) for (const cid of kids) {
    const cobj = entities.get(cid);
    if (cobj && cobj.parent && cobj.parent !== scene) return null;
  }
  const bag = cur.comp;
  if (bag) {
    if (bag.motion?.part) return null;
    for (const k in bag) if (k.startsWith('motion:')) return null;
  }
  return cur.lib;
}

function runPromoteTail(id, obj) {
  const cur = state.st.entities[id];
  if (!cur) return;   // a remove raced the drain; retire already cleaned up
  // receiveShadow came from the factory at parse time (clones inherit);
  // castShadow is the rig's caster budget — nearest K cast, live, toggles
  // free (§12.5). The old markShadowless/drainShadows drip is gone.
  registerCaster(id, obj);
  // a mount verb may have landed in the gap: a mounted child carries no
  // collider of its own (execMount law — the pair collides as the carrier)
  // ...and neither does a BUILDING'S ANCHOR. A `structure` entity's collision
  // is DECLARED by the structure realizer (fitStructureBoxes: walls, floors,
  // corner fills), so inferring a box from its placeholder lib leaves an
  // invisible crate-sized obstacle at the origin of every building — the mesh
  // is hidden, the collider was not. Same law as the mounted case above: an
  // entity whose collision is owned elsewhere does not get one fitted here.
  // …and neither does a REDUCED-TIER placement: collision, support, and
  // raycast semantics stay off the LOD mesh (#156's narrowed claim) — the
  // full tier fits its collider when the placement upgrades on approach.
  if (obj.userData.tier !== 'lod' && !collisionOwnedElsewhere(cur, obj.userData.mountedTo)) {
    // localFrame: the spawn transform is already applied here (unlike the
    // old at-identity fit), so the box must be computed root-local. The fit
    // buckets at the live position — the old post-transform reindexCollider
    // is subsumed.
    fitCollider(id, obj, {
      collide: cur.collide, scale: cur.scale || 1,
      lib: shareableLib(id, cur), localFrame: true,
    });
    // the grass clearing mask repaints on entity events and used to see the
    // interior verdict at 'spawn' (the collider predated the event); the
    // tail landing an interior is the same news, announced when it exists
    if (colliders.get(id)?.interior) bus.emit('entity', { id, kind: 'collider' });
  }
  // emissive surfaces become lamp REQUESTS — a request costs nothing until
  // the rig assigns it a slot, and that is uniform writes
  attachLamps(obj, `entity:${id}`);
  // mounts that were waiting on this id — as child or carrier
  for (const mid of mountsTouching(state.st.entities, id, foldChildren)) execMount(mid);
}

/** Realized objects still owing their heavy tail — the governor's loading
 *  grace (§16.2.D) counts these: fps dips while boulders are still landing
 *  are loading, not a performance regime. */
export const promoteTailPending = () => promoteTail.size;

/** Drain within ~4ms, at least one item per frame — registered as the
 *  'promote-tail' system (main.js, near 'build'). */
export function drainPromoteTail() {
  if (!promoteTail.size) return;
  const t0 = performance.now();
  for (const [id, obj] of promoteTail) {
    promoteTail.delete(id);
    if (entities.get(id) !== obj) continue;   // the guard: same realized object only
    try { runPromoteTail(id, obj); } catch (e) { report(`promote tail ${id}`, e); }
    if (performance.now() - t0 >= 4) break;
  }
}

function createLight(id, ent) {
  tracked.set(id, { kind: 'light', gen: nextGen++ });
  const g = makeLight({ color: ent.color, intensity: ent.intensity, range: ent.range, keep: ent.keep, day: ent.day }, id);
  g.userData.entityId = id;
  g.position.set(...(ent.pos ?? [0, 1, 0]));
  // rest pose, same as models carry — refreshLight re-stamps it on every
  // fold refresh, so create and refresh agree on where "at rest" is
  g.userData.base = { pos: g.position.toArray(), yaw: g.rotation.y };
  entities.set(id, g);
  entityMeta.set(id, { actor: ent.actor, kind: 'light', ts: ent.ts });
  scene.add(g);
  bus.emit('entity', { id, kind: 'light' });
  emitCompBag(id);
}

// ---- refresh ----------------------------------------------------------------

function refreshModel(id, ent) {
  const obj = entities.get(id);
  if (!obj || obj.userData?.isLight) return;   // loading: completion reads state
  // A MOUNTED child's transform is parent-relative; ent.pos is the fold's
  // absolute pre-mount pose, and applying it here would seat the cargo 3m
  // off in the carrier's frame on every reconnect reconcile (review B1 —
  // the mount-pose parity bucket exists because this line got it wrong).
  // While mounted, the mount owns the transform; the dismount stamp will
  // bring the fold's word back when the ride ends.
  if (!obj.userData.mountedTo) {
    if (ent.pos) obj.position.set(...ent.pos);
    if (ent.yaw != null) obj.rotation.y = ent.yaw;
    obj.userData.base = { pos: obj.position.toArray(), yaw: obj.rotation.y };
  }
  if (ent.scale != null) obj.scale.setScalar(ent.scale);
  if (!isPlaceholder(obj) && obj.userData.tier !== 'lod') refitCollider(id);   // placeholders and lod tiers own no collider
  bus.emit('entity', { id, kind: 'place' });
}

/** Live refresh ≡ join create: after this runs, the realized light must be
 *  indistinguishable from what createLight would build off the same folded
 *  entity — EVERY folded field re-applied (params, mount-guarded transform,
 *  entityMeta, comp bag, parent linkage), so a live edit and a rejoin render
 *  identically. (Slice 18a; the divergence was the user-visible bug.) */
function refreshLight(id, ent) {
  const g = entities.get(id);
  if (!g?.userData?.isLight) return;
  // explicit values, not a partial patch: the FOLD already merged, and a
  // cleared keep/day folds as an ABSENT field — passing it through
  // updateLight's null-skip guard would leave the old value stuck on
  // (a live landmine for keep before day existed)
  updateLight(g, {
    color: ent.color, intensity: ent.intensity, range: ent.range,
    keep: ent.keep === true, day: ent.day !== false,
  });
  // A MOUNTED light's transform is carrier-relative; ent.pos is the fold's
  // absolute pre-mount pose, and writing it here jumped the bulb by the
  // carrier offset — live only, which is exactly the live-vs-join drift
  // this function must never produce (same law as refreshModel; the
  // dismount stamp brings the fold's word back when the ride ends).
  if (!g.userData.mountedTo) {
    if (ent.pos) g.position.set(...ent.pos);
    g.userData.base = { pos: g.position.toArray(), yaw: g.rotation.y };
  }
  entityMeta.set(id, { actor: ent.actor, kind: 'light', ts: ent.ts });
  bus.emit('entity', { id, kind: 'light' });
  // comps that folded onto the light and its folded parent re-announce and
  // re-execute, exactly as a join create would (createLight + the tail)
  emitCompBag(id);
  execMount(id);
}

// ---- retirement -------------------------------------------------------------

function retire(id) {
  cancelOwner(`entity:${id}`);
  releaseOwner(`entity:${id}`);   // lamp + placed-light requests die with it
  promoteTail.delete(id);         // a pending heavy tail dies with the id
  const obj = entities.get(id);
  if (obj && !isPlaceholder(obj) && obj.userData?.lib) releaseGLB(obj.userData.glbKey ?? obj.userData.lib);
  if (obj) {
    if (obj.userData?.isLight) disposeLight(obj);
    // cargo steps off before the carrier vanishes — at the pose the FOLD
    // stamped for it, so every joiner and this client agree where it landed.
    // The scene index is the same membership the old all-entities walk
    // filtered for (userData.mountedTo === id), read in O(children).
    const kids = sceneChildren.get(id);
    if (kids) for (const cid of [...kids]) {
      const cobj = entities.get(cid);
      indexSceneMount(cid, null);
      if (cobj?.userData?.mountedTo !== id) continue;
      scene.attach(cobj);
      delete cobj.userData.mountedTo;
      delete cobj.userData.mountRel;
      const cst = state.st.entities[cid];
      if (cst?.pos) cobj.position.set(...cst.pos);
      if (cst?.yaw != null) cobj.rotation.set(0, cst.yaw, 0);
      cobj.userData.base = { pos: cobj.position.toArray(), yaw: cobj.rotation.y };
      fitCollider(cid, cobj, { scale: cobj.scale?.x || 1 });
    }
    (obj.parent ?? scene).remove(obj);
  }
  indexSceneMount(id, null);      // if the retired thing itself rode a carrier
  entities.delete(id);
  entityMeta.delete(id);
  comps.delete(id);
  releaseCaster(id);
  removeCollider(id);
  tracked.delete(id);
  bus.emit('entity', { id, kind: 'remove' });
}

// ---- components -------------------------------------------------------------

/** Mirror the folded bag into the comps map every evaluator reads. Cloned:
 *  evaluators must never alias (and accidentally mutate) shadow state. */
function syncComps(id) {
  const bag = state.st.entities[id]?.comp;
  if (bag && Object.keys(bag).length) comps.set(id, structuredClone(bag));
  else comps.delete(id);
}

function emitCompBag(id) {
  syncComps(id);
  const bag = comps.get(id);
  if (bag) for (const [type, data] of Object.entries(bag)) bus.emit('comp', { id, type, data });
}

function onComp(id, type) {
  syncComps(id);
  const data = comps.get(id)?.[type] ?? null;
  if (type === 'motion' && data == null) restAtBase(id);
  // a sockets change re-seats everything riding this carrier — a mount that
  // landed BEFORE its socket was authored glued to the origin, and the
  // socket's arrival is what makes it right (review S5; the relKey includes
  // the resolved socket for exactly this)
  if (type === 'sockets') {
    const kids = foldChildren.get(id);   // same membership as the old full scan
    if (kids) for (const cid of kids) execMount(cid);
  }
  bus.emit('comp', { id, type, data });
}

/** Motion ended: rest at the logged base pose (the plane-transition `place`
 *  that accompanies an away-from-base stop rewrites base first). */
function restAtBase(id) {
  const obj = entities.get(id);
  const base = obj?.userData?.base;
  if (!obj || !base) return;
  obj.position.set(...base.pos);
  obj.rotation.set(0, base.yaw ?? 0, 0);
  reindexCollider(id);
}

// ---- mounting ---------------------------------------------------------------

/** Execute (or re-execute) the scene linkage for an entity's folded parent.
 *  State is the pending list: if either end isn't realized yet, do nothing —
 *  the spawn completion calls back via mountsTouching. `mountRel` guards
 *  re-execution: re-attaching a part socket mid-motion would re-bake the
 *  phase into the offset. */
function execMount(id) {
  const ent = state.st.entities[id];
  if (!ent) return;
  if (!ent.parent) {
    const obj = entities.get(id);
    if (obj?.userData?.mountedTo) execDismount(id, ent);
    return;
  }
  const rel = ent.parent;
  const child = entities.get(id);
  const parent = entities.get(rel.to);
  if (!child || !parent) return;
  const sock = rel.slot ? state.st.entities[rel.to]?.comp?.sockets?.[rel.slot] : null;
  // the RESOLVED socket is part of the linkage's identity: a socket authored
  // after the mount must re-seat the rider, not be ignored (review S5)
  const relKey = JSON.stringify([rel, sock ?? null]);
  if (child.userData.mountRel === relKey) return;   // already exactly this
  const off = rel.offset ?? sock?.pos ?? [0, 0, 0];
  parent.add(child);   // transform becomes parent-relative
  child.position.set(...off);
  child.rotation.set(0, rel.yaw ?? sock?.yaw ?? 0, 0);
  // a part socket glues the cargo INTO the moving node — attach preserves
  // world transform, baking the part's current phase into the offset
  const partNode = sock?.part ? findPart(parent, String(sock.part)) : null;
  if (partNode) partNode.attach(child);
  child.userData.mountedTo = rel.to;
  child.userData.mountRel = relKey;
  indexSceneMount(id, rel.to);
  // the parent's collider is what the pair collides as while attached
  removeCollider(id);
  bus.emit('mount', { id, to: rel.to, slot: rel.slot });
}

function execDismount(id, ent) {
  const obj = entities.get(id);
  if (obj && obj.userData.mountedTo) {
    scene.attach(obj);   // keeps the world transform it had
    delete obj.userData.mountedTo;
    delete obj.userData.mountRel;
    indexSceneMount(id, null);
    // plane-transition stamp wins over wherever the ride left it
    if (ent?.pos) obj.position.set(...ent.pos);
    if (ent?.yaw != null) obj.rotation.set(0, ent.yaw, 0);
    obj.userData.base = { pos: obj.position.toArray(), yaw: obj.rotation.y };
    fitCollider(id, obj, { scale: obj.scale?.x || 1 });
  }
  bus.emit('mount', { id, to: null });
}

/** Bodies aren't entities: their folded mounts sync into avatarMounts for
 *  remotes/controller, with the same bus events legacy emitted. */
function syncBodyMounts() {
  const want = state.st.mounts ?? {};
  for (const id of [...avatarMounts.keys()]) {
    if (!want[id]) { avatarMounts.delete(id); bus.emit('mount', { id, to: null }); }
  }
  for (const [id, rel] of Object.entries(want)) {
    const next = { to: rel.to, slot: rel.slot, offset: rel.offset, yaw: rel.yaw };
    const cur = avatarMounts.get(id);
    if (!cur || JSON.stringify(cur) !== JSON.stringify(next)) {
      avatarMounts.set(id, next);
      bus.emit('mount', { id, to: rel.to, slot: rel.slot });
    }
  }
}

// ---- residency (§13.3 R1) ---------------------------------------------------
// Demotion is fold→state→realize read BACKWARDS: state never changes, the
// projection coarsens. A far entity swaps back to the placeholder tier —
// already legal to every consumer — freeing its scene subtree, collider BVH,
// camera-collision triangles, lamp requests, and caster slot. Promotion is
// the existing load pipeline rerun: realizeModel re-reads state, re-executes
// mounts, re-announces comp bags (emitters re-attach off those events). The
// clone shared every GPU resource with the cached prototype, so demote frees
// CPU and frame cost; VRAM falls when the proto itself evicts (R2).

// ---- the geometry tier (#156 client contract) ------------------------------
// Chosen BEFORE the fetch, from the resident's dial, the distance against
// the entity's own residency radius, and device pressure (lod_policy.js).
// The recipe comes from the RUNNING sequencer's /version — none published,
// no tier ever asked. A lod-tier placement is VISUAL only: it owns no
// collider, no support surface, until it upgrades to full on approach.
let lodRecipe = null;
lodRecipeReady.then((r) => { lodRecipe = r; }).catch(() => {});
export const modelQuality = makeModelQuality(globalThis.localStorage);
function tierFor(ent, current = null) {
  // the recipe counts only where a lod ask can cross the wire (assets.js
  // lodNegotiable: transcoder + key + recipe + a .glb) — elsewhere the
  // policy sees no recipe, and nothing is asked or reported as asked
  return chooseTier({ dist: entDist(ent), radius: residencyRadius(ent), quality: modelQuality.quality,
    recipe: lodNegotiable(ent?.lib) ? lodRecipe : null, pressure: gpuPressure(), shed: modelQuality.shed, current });
}
/** The models⚙ row's whole behaviour — skypanel.js binds it to the row and
 *  shows what it returns: set the resident's dial, and say honestly whether
 *  a reduced tier can be asked from this browser at all (the variant's
 *  textures are KTX2: no transcoder, or a sequencer that published no
 *  recipe, and every placement stays full detail). Out of the DOM so the
 *  product-door harness gates it (tools/lod-client-test). */
export function dialModelQuality(v) {
  const q = modelQuality.setQuality(v);
  return lodNegotiable('eidoverse/assets/models/any.glb')
    ? `models: ${q} (yours only)`
    : `models: ${q} (yours only) — reduced tiers cannot be asked from this browser; everything stays full detail`;
}
/** Only a placement nothing depends on may change tier in place — the same
 *  predicate as demotion (no riders, no seats, no part motion): a tier swap
 *  is a demote-and-promote with the placeholder frame skipped. */
const canRetier = (id, ent) => canDemote(id, ent);

const R_BASE = 80;     // meters: promote below R, demote above R + R_HYST
const R_HYST = 20;     // the band that keeps a walk along the edge quiet
const DIAG_K = 4;      // big things stay: radius grows with bbox diagonal
const DIAG_DEFAULT = 12; // assumed bbox diagonal (m) before the geom
                         // side-channel lands — err LARGE, so a big thing
                         // near the edge still loads at join (§16.2.C)
const resStats = { demotes: 0, promotes: 0, retiers: 0, retiersRefused: 0 };

function residencyRadius(ent) {
  const s = ent?.lib ? libGeom.get(ent.lib)?.bbox?.size : null;
  const diag = s ? Math.hypot(s[0] ?? 0, s[1] ?? 0, s[2] ?? 0) : DIAG_DEFAULT;
  return R_BASE + diag * DIAG_K;
}
// distance is min(camera, avatar): in photo-mode flight the body may stand
// on something the camera left behind — demoting its floor drops it through
// the world (review S6). main.js injects the avatar-position source.
let residencyFocus = null;
export function setResidencyFocus(fn) { residencyFocus = fn; }
const _f = new THREE.Vector3();
function entDist(ent) {
  _v.set(...(ent?.pos ?? [0, 0, 0]));
  let d = camera.position.distanceTo(_v);
  const p = residencyFocus?.();
  if (p) d = Math.min(d, _f.set(p.x, p.y, p.z).distanceTo(_v));
  return d;
}

/** The audit's three impossibles plus the edit hold — things whose demote
 *  has no clean undo. All are cheap fold-truth predicates. */
function canDemote(id, ent) {
  if (!ent || ent.kind === 'light' || ent.parent) return false;   // lights are cheap; mounted children ride carriers
  const obj = entities.get(id);
  if (!obj || isPlaceholder(obj) || editHolds.has(id)) return false;
  if (!libGeom.get(ent.lib)?.bbox) return false;    // nothing honest to stand in
  // a carrier: children mounted on it would need the cargo step-off, which
  // is semantically a removal (it re-stamps fold poses) — refuse instead.
  // foldChildren holds exactly the ids the old Object.values scan matched
  // (state parent.to === id), maintained at the fold-write choke point —
  // the same predicate, O(1) and allocation-free per candidate (§16.2.C)
  if (foldChildren.get(id)?.size) return false;
  // a body in its seat: someone is sitting on it, wherever WE are standing
  // (avatarMounts is rider-keyed and bounded by bodies present, not
  // entities — the scan stays)
  for (const rel of avatarMounts.values()) if (rel.to === id) return false;
  const bag = state.st.entities[id]?.comp;
  if (bag) {
    // part motions and part sockets need named nodes a placeholder lacks
    // (mbase is per-clone; findPart on a box is null). Whole-entity motion
    // is fine — the stand-in carries userData.base and swings honestly.
    if (bag.motion?.part) return false;
    for (const k in bag) if (k.startsWith('motion:')) return false;
    if (bag.sockets) for (const k in bag.sockets) if (bag.sockets[k]?.part) return false;
  }
  return true;   // a live physobj sim self-clears in ~0.45s and kicks are
                 // near-range by nature — distance already excludes them
}

function demote(id) {
  const ent = state.st.entities[id];
  const obj = entities.get(id);
  teardownRealized(id, obj);   // a demoted stand-in must not inherit the real model's collider/lamps
  (obj.parent ?? scene).remove(obj);
  const grp = makePlaceholder(id, ent, libGeom.get(ent.lib));
  entities.set(id, grp);
  scene.add(grp);
  // entityMeta and comps STAY — labels and evaluators read fold truth, and
  // the parity probe's identity check compares fold-to-fold either way
  resStats.demotes++;
  bus.emit('entity', { id, kind: 'demote' });   // emitters retire their handle
}

let lastEvict = 0;
/** One residency beat (initModelsRealizer runs it at 2Hz; exported so a
 *  headless harness can beat it deterministically — tools/lod-client-test). */
export function residencySweep() {
  // the VRAM tier (R2): every ~5s, if GPU memory is over budget, zero-ref
  // protos dispose. Self-gating and usually a no-op single number read.
  const now = Date.now();
  if (now - lastEvict > 5000) {
    lastEvict = now;
    evictIdleProtos().catch(() => {});
  }
  for (const [id, t] of tracked) {
    if (t.kind !== 'model') continue;
    const ent = state.st.entities[id];
    if (!ent || ent.kind === 'light') continue;
    const obj = entities.get(id);
    const R = residencyRadius(ent);
    const d = entDist(ent);
    if (obj && !isPlaceholder(obj) && d > R + R_HYST) {
      if (canDemote(id, ent)) demote(id);
    // inside the radius, a realized placement may want the OTHER tier now —
    // walked toward (full), walked away from (lod), pressure came or went.
    // Hysteresis lives in the policy; the cooldown keeps a swap from
    // stacking on its own in-flight load. The new tier loads first and
    // replaces in place (realizeModel) — no placeholder frame in between.
    } else if (obj && !isPlaceholder(obj) && !t.loading && obj.userData.lib) {
      const asked = obj.userData.tierAsked ?? obj.userData.tier ?? 'full';
      const want = tierFor(ent, asked);
      if (want !== asked && now - (t.retierAt ?? 0) > 5000 && canRetier(id, ent)) {
        t.retierAt = now;
        resStats.retiers++;
        t.gen = nextGen++;
        scheduleLoad(id, ent, t.gen, want);
      }
    // BOTH stand-in shapes promote by distance: the join gate leaves far
    // entities as bare null reservations (no geom yet, or a geom-less lib
    // that never grows a placeholder) — if only placeholders promoted, a
    // `place` that moves one near before geom arrives would never load
    // (§16.2.C). The invariant: within its radius an entity eventually
    // loads; beyond it, it never fetches a byte.
    } else if ((obj === null || isPlaceholder(obj)) && d < R && !t.loading
      && (!t.failedAt || now - t.failedAt > 30000)) {
      resStats.promotes++;
      t.gen = nextGen++;                 // stale in-flight completions no-op
      scheduleLoad(id, ent, t.gen);
    }
  }
}

export const residencyDebug = () => {
  let real = 0, standins = 0, loading = 0, waiting = 0;
  for (const [id, t] of tracked) {
    if (t.kind !== 'model') continue;
    const obj = entities.get(id);
    // a bare reservation is only "loading" while a job is actually in
    // flight — the join gate leaves far entities unscheduled ("waiting")
    if (obj === null) (t.loading ? loading++ : waiting++);
    else if (isPlaceholder(obj)) standins++;
    else if (obj) real++;
  }
  let lod = 0, lodAsked = 0;   // served vs asked: the gap is the server's honest fall-throughs
  for (const obj of entities.values()) {
    if (obj?.userData?.tier === 'lod') lod++;
    if (obj?.userData?.tierAsked === 'lod') lodAsked++;
  }
  return { real, standins, loading, waiting, lod, lodAsked, quality: modelQuality.quality, recipe: lodRecipe, ...resStats, rBase: R_BASE, rHyst: R_HYST };
};

// ---- reconcile + dispatch ---------------------------------------------------

/** One id, after its identity may have changed: create, retire, rebuild, or
 *  refresh — the fold's current word is final. */
function reconcileId(id) {
  const ent = state.st.entities[id];
  const t = tracked.get(id);
  if (!ent) { if (t || entities.has(id)) retire(id); return; }
  const kind = ent.kind === 'light' ? 'light' : 'model';
  if (!t) { (kind === 'light' ? createLight : createModel)(id, ent); return; }
  if (t.kind !== kind || (kind === 'model' && t.lib !== ent.lib)) {
    retire(id);
    (kind === 'light' ? createLight : createModel)(id, ent);
    return;
  }
  if (kind === 'light') refreshLight(id, ent);
  else refreshModel(id, ent);
}

/** Full idempotent pass — hydration, reconnect. reconcile ∘ reconcile =
 *  reconcile is the contract (§11.4). */
export function reconcileModels() {
  const view = new Map([...tracked].map(([id, t]) => [id, { kind: t.kind, lib: t.lib }]));
  const { create, retire: dead } = planReconcile(state.st.entities, view);
  for (const id of dead) retire(id);
  const created = new Set(create.map((c) => c.id));
  for (const { id, ent } of create) (ent.kind === 'light' ? createLight : createModel)(id, ent);
  // survivors refresh in place — a reconnect may have moved anything
  for (const [id, t] of tracked) {
    if (created.has(id) || !state.st.entities[id]) continue;
    const ent = state.st.entities[id];
    // refreshLight ≡ join create: it re-announces the bag and re-executes
    // the mount itself — calling them again here would double-emit
    if (t.kind === 'light') { refreshLight(id, ent); continue; }
    refreshModel(id, ent);
    emitCompBag(id);
    execMount(id);
  }
  syncBodyMounts();
}

function onEntry(entry) {
  const { verb, args = {} } = entry;
  try {
    // the fold has already written state — refresh the parent index BEFORE
    // any handler runs (retire's step-out reads the SCENE index; canDemote,
    // mountsTouching and the sockets re-seat read this one)
    if (verb === 'spawn' || verb === 'light' || verb === 'remove'
      || verb === 'mount' || verb === 'dismount') refoldParents(verb, args.id);
    switch (verb) {
      case 'spawn':
      case 'light':
        reconcileId(args.id);
        break;
      case 'place': {
        const ent = state.st.entities[args.id];
        if (ent) (ent.kind === 'light' ? refreshLight : refreshModel)(args.id, ent);
        break;
      }
      case 'remove':
        reconcileId(args.id);
        syncBodyMounts();   // body mounts onto the removed id fold away
        break;
      case 'comp':
        if (args.id && typeof args.type === 'string') onComp(args.id, args.type);
        break;
      case 'motion':
        if (args.id) onComp(args.id, 'motion');
        break;
      case 'mount':
        if (state.st.entities[args.id]) execMount(args.id);
        else syncBodyMounts();
        break;
      case 'dismount':
        if (entities.has(args.id) || tracked.has(args.id)) execDismount(args.id, state.st.entities[args.id]);
        syncBodyMounts();
        break;
    }
  } catch (e) { report(`realize ${verb}`, e); }
}

/** Wire the realizer to state. Called once from main.js. */
export function initModelsRealizer() {
  // the geom side-channel lands a beat after the snapshot — upgrade every
  // still-bare reservation to a sized stand-in the moment sizes are known
  bus.on('lib-geom', (geom) => {
    for (const [lib, g] of Object.entries(geom ?? {})) libGeom.set(lib, g);
    for (const id of tracked.keys()) maybePlaceholder(id);
  });
  // a REFUSED `light` verb never folds, but the editor already previewed it —
  // lights.js names the stranded id ('light-refused', off net.js's refusal
  // event) and the rollback is one call: refreshLight re-derives every
  // folded field, so the preview snaps back to exactly what a joiner sees
  bus.on('light-refused', ({ id }) => {
    const ent = state.st.entities[id];
    if (ent?.kind === 'light' && tracked.get(id)?.kind === 'light') refreshLight(id, ent);
  });
  // the residency sweep: fold positions in, demote/promote out. 500ms is
  // plenty — a person covers ~3m between beats at a run
  setInterval(residencySweep, 500);
  onWorldChange((ev) => {
    if (ev.type === 'hydrated') {
      // the snapshot's entities carry folded parent records (#71/#79: the
      // late joiner sees every folded mount) — index them BEFORE the
      // reconcile pass whose promotes will consult mountsTouching
      rebuildFoldIndex();
      reconcileModels();
    } else if (ev.type === 'reset') {
      // a real teardown, not just bookkeeping: leaving the scene populated
      // while tracked empties means the next hydrate re-creates every id ON
      // TOP of its orphaned twin (review S4 — world switch without reload)
      for (const id of [...tracked.keys()]) retire(id);
      rebuildFoldIndex();          // state is empty — so is the index
      sceneChildren.clear();
      sceneParentOf.clear();
    } else if (ev.type === 'entry' && PORTED.has(ev.entry.verb)) onEntry(ev.entry);
  });
  return true;
}
