// models — the entity realizer (docs/history/TEL0S_NOTES.md §11.4): entity lifecycle as a projection of state.st.
//
// The one trick: every completion re-reads current state. A `place` landing while the GLB is in flight just changes
// state; the completion applies what is current. A `remove` mid-download cancels the owner and the completion
// notices the id is gone. A mount whose ends aren't both live yet stays in the fold (state is the pending list) and
// re-checks when a spawn realizes (mountsTouching). Nothing is remembered twice.
//
// This module writes the map every consumer shares (world.js entities; components are the fold's own record,
// world.js bagOf) and emits the bus events they subscribe to ('entity', 'comp', 'mount'). Loads go through
// the scheduler: keyed, owned, prioritized by live camera distance at dequeue, cancelled on remove.
//
// Fold-faithfulness: a removed carrier's cargo lands at the pose the fold stamped, and an entity is whatever the fold
// holds for its id (a create of a live id is a no-op, spec/PROTOCOL.md §3).

import { THREE, scene, camera } from '../core.js';
import { applyScale, entScale } from '../../../shared/scale3.js';
import { isMineHidden, isolatedOut } from '../edit/myview.js';
import { report, bus } from '../base.js';
import { loadGLB, retainGLB, releaseGLB, evictIdleProtos, lodRecipeReady, gpuPressure,
  lodNegotiable, negotiationReady } from '../assets.js';
import { makeModelQuality, chooseTier } from '../render/lod_policy.js';
import { colliders, fitCollider, removeCollider, reindexCollider, refitCollider } from '../colliders.js';
import { registerCaster, releaseCaster, requestLight, updateRequest, releaseLight } from '../render/lightrig.js';
import { makeLightGizmo } from '../render/lightgizmo.js';
import { lightOf, colliderOf } from '../../../shared/components.js';
import { entities, bagOf, childrenOf, avatarMounts, findPart, editHolds } from '../world.js';
import { compKeys } from '../../../shared/protocol/view.js';
import { encName } from '../../../shared/protocol/names.js';
import { state, onWorldChange } from '../state.js';
import { schedule, cancelOwner } from '../render/scheduler.js';
import { planReconcile, bandForDistance, mountsTouching, collisionOwnedElsewhere, modelOf, offIn, readMesh, meshKeyOf } from './models_field.js';
import { prepareMaterial } from '../render/materials.js';
import { tracked, reserve, regen, untrack, release } from './lifecycle.js';

import { recordComponents } from '../../../shared/protocol/view.js';
import { R_BASE, residencyRadiusFor } from '../../../shared/lod-distance.js';   // shared with the server's LOD budget
import { worldPose, ancestors } from '../../../shared/hierarchy.js';

// Orientation (spec/PROTOCOL.md §9): the fold's q when the thing is more than turned, else its yaw. base carries q
// too, so motion composes on the real tilt instead of snapping a toppled thing upright.
function orientObj(obj, ent) {
  if (Array.isArray(ent?.q) && ent.q.length === 4) obj.quaternion.set(ent.q[0], ent.q[1], ent.q[2], ent.q[3]);
  else obj.rotation.set(0, ent?.yaw ?? 0, 0);
}
const restOf = (obj, ent) => ({
  pos: obj.position.toArray(), yaw: ent?.yaw ?? obj.rotation.y,
  ...(Array.isArray(ent?.q) && ent.q.length === 4 ? { q: [...ent.q] } : {}),
});

const _v = new THREE.Vector3();

// ---- placeholders -----------------------------------------------------------
// The world appears at fold time: a translucent box the size of the real thing (bbox from the server's geom
// side-channel) at the folded transform until the GLB lands; one shared geometry + material. Placeholders are real
// entities to the maps (place/mount/motion/panels) but invisible to camera collision, colliders and shadows.

const libGeom = new Map();   // lib -> {bbox}, fed by the 'lib-geom' message
/** A placed thing's model box in its own frame: the server's measure, or (a model added after you joined, which the
 *  join-time geom never covered) measured here from the loaded meshes. null while nothing has loaded. */
const _ib = new THREE.Matrix4(), _bx = new THREE.Box3(), _mb = new THREE.Box3();
export function boxOf(id) {
  const ent = state.st.entities?.[id]; const known = ent?.model ? libBox(ent.model) : null; if (known) return known;
  const obj = entities.get(id); if (!obj) return null;
  obj.updateWorldMatrix(true, true); _ib.copy(obj.matrixWorld).invert(); _bx.makeEmpty();
  const walk = (m) => {   // its own meshes only: an occupant (another entity mounted here) is a child in three, not part of it
    if (m !== obj && m.userData?.entityId != null && m.userData.entityId !== id) return;
    if (m.isMesh && m.geometry && !m.userData?.isGizmo) { if (!m.geometry.boundingBox) m.geometry.computeBoundingBox();
      _mb.copy(m.geometry.boundingBox).applyMatrix4(new THREE.Matrix4().multiplyMatrices(_ib, m.matrixWorld)); _bx.union(_mb); }
    for (const k of m.children) walk(k);
  };
  walk(obj);
  return _bx.isEmpty() ? null : [_bx.min.toArray(), _bx.max.toArray()];
}
function libBox(lib) { const b = libGeom.get(lib)?.bbox; if (!b?.size) return null; const c = b.center ?? [0, b.size[1] / 2, 0]; return [[0, 1, 2].map((i) => c[i] - b.size[i] / 2), [0, 1, 2].map((i) => c[i] + b.size[i] / 2)]; }
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
  // the shared stand-in material must never be swept into a weather wrap (a mid-session recompile for every placeholder)
  mesh.userData.noWet = true;
  mesh.userData.noCloudShadow = true;
  grp.add(mesh);
  grp.userData.entityId = id;
  grp.userData.placeholder = true;
  grp.userData.noCamCollide = true;
  grp.position.set(...(ent.pos ?? [0, 0, 0]));
  orientObj(grp, ent);
  if (ent.scale) applyScale(grp, entScale(ent));
  grp.userData.base = restOf(grp, ent);
  return grp;
}

/** Stand a placeholder in for a still-loading reservation, if its size is known. Safe to call again: only a bare
 *  `null` reservation upgrades. */
function maybePlaceholder(id) {
  if (entities.get(id) !== null) return;   // realized, placeholdered, or unknown
  const ent = state.st.entities[id];
  const g = ent?.model ? libGeom.get(ent.model) : null;
  if (!ent || !g?.bbox) return;
  const grp = makePlaceholder(id, ent, g);
  entities.set(id, grp);
  scene.add(grp);
  syncParts(id);     // its mesh and socket ride the stand-in too
  applyHidden(id);   // hidden survives the stand-in box (placeholder / demote)
  syncCompLight(id); // a lamp's light rides the stand-in until the model lands
  bus.emit('entity', { id, kind: 'placeholder' });
}

const isPlaceholder = (obj) => Boolean(obj?.userData?.placeholder);

/** Drop a placeholder (or a bare reservation) for an id whose load resolved some other way than realization. */
function clearReservation(id) {
  const cur = entities.get(id);
  if (cur === null || isPlaceholder(cur)) {
    if (cur) (cur.parent ?? scene).remove(cur);
    entities.delete(id);
    syncCompLight(id);   // the stand-in it rode is gone: park at the fold, or drop
  }
}

// ---- the scene-side mount index ---------------------------------------------
// The fold's edges live in world.js childrenOf. This is scene truth (parent id → children whose realized object is
// attached, userData.mountedTo), for the cargo step-out loops: a `remove` folds the children's parent records away
// before retire() runs. Maintained exactly where userData.mountedTo is written or cleared.
const sceneChildren = new Map(); // parent id -> Set(child id)   (scene truth)
const sceneParentOf = new Map();

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
  const gen = reserve(id, { kind: 'model', model: ent.model });
  entities.set(id, null);   // reservation: the contract every consumer knows
  maybePlaceholder(id);     // upgraded to a sized stand-in when geom is known
  syncCompLight(id);        // a lamp lights its folded spot before (and beyond) its load
  // Streaming: the gate works from position, stand-in or not. A far entity keeps its reservation and loads nothing
  // until the residency sweep promotes it; unknown sizes err large (DIAG_DEFAULT). Live spawns share this path.
  if (entDist(ent) > residencyRadius(ent)) return;
  scheduleLoad(id, ent, gen);
}

function scheduleLoad(id, ent, gen, tier = null) {
  const t0 = tracked.get(id);
  if (t0) t0.loading = true;   // the sweep must not re-promote a load in flight
  schedule({
    key: `entity:${id}`, owner: `entity:${id}`, lane: 'net',
    // live distance to the entity's current folded position, re-read at dequeue, so walking toward it promotes the load
    priority: () => bandForDistance(camWorld().distanceTo(
      _v.set(...(state.st.entities[id]?.pos ?? [0, 0, 0])))),
    run: async (signal) => {
      // a first load chooses its tier at dequeue, once /version has answered (assets.js lodNegotiable) and from the
      // live distance; a re-tier brings the tier the sweep chose
      await negotiationReady;
      if (signal.aborted) return;
      const want = tier ?? tierFor(ent, null);
      const obj = await loadGLB(ent.model, { tier: want });
      const cur = state.st.entities[id];
      const t = tracked.get(id);
      if (t?.gen === gen) t.loading = false;
      // the world may have moved on while the bytes flew: retired, re-spawned with a different model (its own job
      // follows), demoted-then-reset, or the realizer was reset
      if (signal.aborted || t?.gen !== gen) return;
      if (!cur || modelOf(cur) !== ent.model) {
        clearReservation(id);
        if (tracked.get(id)?.gen === gen) untrack(id);
        return;
      }
      // a tier swap re-checks at application time: while the bytes flew a body may have sat down, cargo mounted, a
      // part motion or socket arrived, or an edit hold begun. The clone is then not worn; the sweep may retry later.
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
    if (t) t.failedAt = Date.now();   // the sweep backs off
    // a failed load keeps its reservation: the id stays addressable (a later remove folds cleanly), it just doesn't
    // render until the sweep retries it (30 s after failedAt, while it is still in range)
    report(`realize spawn ${id}`, e);
  });
}

/** Everything a realized object holds that its replacement must not inherit, factored so a tier swap (real → real)
 *  and a demote (real → placeholder) release identically. The collider and the caster let go on the lifecycle's word
 *  (lifecycle.js release). */
function teardownRealized(id, obj, phase) {
  promoteTail.delete(id);   // a pending heavy tail dies — the replacement earns its own
  indexSceneMount(id, null);
  releaseGLB(obj.userData?.glbKey ?? obj.userData?.lib);
  cancelOwner(`entity:${id}`);
  release(id, phase);
}

function realizeModel(id, cur, obj) {
  const stand = entities.get(id);
  if (stand && (isPlaceholder(stand) || stand.userData?.lib)) {
    // children attach to placeholders too (execMount takes any truthy parent): step them out before the stand's
    // subtree is removed, and clear mountRel so the tail's execMount re-attaches them to the real thing. mountedTo
    // (and the scene index entry) stays, so a racing retire() still steps them off.
    const kids = sceneChildren.get(id);
    if (kids) for (const cid of [...kids]) {
      const cobj = entities.get(cid);
      if (cobj?.userData?.mountedTo === id && cobj.parent) {
        scene.attach(cobj);
        delete cobj.userData.mountRel;
      }
    }
    // the stand itself may have ridden a carrier; the fresh clone starts unattached and the tail re-mounts it
    if (stand.userData.mountedTo) indexSceneMount(id, null);
    // a real object being replaced (a tier swap) releases what it held; a placeholder held nothing
    if (!isPlaceholder(stand)) teardownRealized(id, stand, 'swap');
    (stand.parent ?? scene).remove(stand);   // the real thing takes the spot
  }
  retainGLB(obj.userData.glbKey ?? cur.model);   // the proto is worn: eviction must not undress it
  obj.userData.lib = cur.model;
  obj.userData.tier = obj.userData.tierServed ?? 'full';   // the server's word, not the request
  // tierAsked rides along from loadGLB: a lod ask answered with the original wears tier 'full' but asked 'lod'; the
  // sweep compares against the ask so it is not re-asked every cooldown
  obj.userData.entityId = id;
  const sc = entScale(cur);
  obj.position.set(...(cur.pos ?? [0, 0, 0]));
  orientObj(obj, cur);
  if (sc) applyScale(obj, sc);
  obj.userData.base = restOf(obj, cur);
  entities.set(id, obj);
  scene.add(obj);
  syncParts(id);     // its mesh and socket move onto the real thing
  applyHidden(id);   // a thing hidden before its model arrived stays hidden
  bus.emit('entity', { id, kind: 'spawn' });
  // comps that folded while the GLB was in flight (or rode the snapshot) announce now; emitters and panels attach
  // off these events
  emitCompBag(id);
  promoteTail.set(id, obj);   // the heavy tail (collider fit, caster, mounts) lands over the next frames
}

// ---- the promote tail -------------------------------------------------------
// The visible half of a promote is synchronous; the heavy tail (collider fit, caster registration, mount re-checks)
// drains ≤~4 ms per frame through the 'promote-tail' system. A query before the collider lands misses the new object.

/** id → the realized object awaiting its heavy tail. Identity is the guard: the drain runs an item only while
 *  entities.get(id) is still this object (retire and demote also cancel eagerly). */
const promoteTail = new Map();

/** Sharing the per-lib collider derivations (colliders.js) is sound only on the pristine clone: no occupant glued
 *  in (stepped-out occupants at the scene root don't count), no mesh component, no part motion. */
function shareableLib(id, cur) {
  if (!cur?.model) return null;
  const kids = sceneChildren.get(id);
  if (kids) for (const cid of kids) {
    const cobj = entities.get(cid);
    if (cobj && cobj.parent && cobj.parent !== scene && !cobj.userData.socket) return null;   // a socket is a frame, not geometry
  }
  if (meshParts.has(id)) return null;   // its own mesh component is geometry the lib's derivations don't hold
  const bag = recordComponents(cur);
  if (bag) {
    if (bag.motion?.part) return null;
    for (const k in bag) if (k.startsWith('motion:')) return null;
  }
  return cur.model;
}

function runPromoteTail(id, obj) {
  const cur = state.st.entities[id];
  if (!cur) return;   // a remove raced the drain; retire already cleaned up
  // receiveShadow came from the factory at parse time; castShadow is the rig's caster budget (lightrig.js)
  registerCaster(id, obj);
  // no collider when collision is owned elsewhere (collisionOwnedElsewhere) or at a reduced tier (fits on upgrade)
  if (obj.userData.tier !== 'lod' && !collisionOwnedElsewhere(cur, obj.userData.mountedTo)) {
    // localFrame: the spawn transform is already applied, so the box is computed root-local and bucketed live
    fitCollider(id, obj, {
      collide: colliderOf(cur), scale: cur.scale || 1,   // comp.collider, else the legacy collide (shared/components.js)
      lib: shareableLib(id, cur), localFrame: true,
    });
    // an interior verdict lands with the tail, after 'spawn': re-announce it for the grass clearing mask
    if (colliders.get(id)?.interior) bus.emit('entity', { id, kind: 'collider' });
  }
  // mounts that were waiting on this id, as child or carrier
  for (const mid of mountsTouching(state.st.entities, id, childrenOf)) execMount(mid);
}

/** Realized objects still owing their heavy tail; the governor's loading grace counts these. */
export const promoteTailPending = () => promoteTail.size;
/** What the realizer holds a thing AS ({kind, model?}): the parity probe's word against the fold's; null for an id the realizer never reserved. */
export const realizedAs = (id) => { const t = tracked.get(id); return t ? { kind: t.kind, ...(t.model ? { model: t.model } : {}) } : null; };

/** Drain within ~4 ms, at least one item per frame: the 'promote-tail' system (main.js). */
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

/** A thing with no model: a bare Group, so every entities-map consumer treats it as an entity; no load. With nothing to
 *  draw it is an Empty (pivot, group parent, target: no collider or caster); its parts (a mesh component, syncParts)
 *  draw on it and then bring their collider and caster (partsChanged). Announces as 'spawn' (what comp evaluators
 *  rebuild on); a light component brings its light (syncCompLight) and gizmo. */
function createHost(id, ent) {
  reserve(id, { kind: 'host' });
  const g = new THREE.Group();
  g.userData.entityId = id;
  g.userData.noCamCollide = true;
  g.position.set(...(ent.pos ?? [0, 0, 0]));
  orientObj(g, ent);
  if (ent.scale) applyScale(g, entScale(ent));
  g.userData.base = restOf(g, ent);
  entities.set(id, g);
  scene.add(g);
  syncParts(id);
  applyHidden(id);
  bus.emit('entity', { id, kind: 'spawn' });
  emitCompBag(id);
  // mounts that were waiting on this id (a model's promote tail does this; a frame has no tail, it exists at once)
  for (const mid of mountsTouching(state.st.entities, id, childrenOf)) execMount(mid);
}
/** A model makes a GLB frame (createModel); anything else a bare one. Every other component is realized on the frame. */
const create = (id, ent) => (modelOf(ent) ? createModel(id, ent) : createHost(id, ent));

/** A mesh component (componentspec `mesh`): a parametric body drawn as one THREE.Mesh on its thing's frame (beside
 *  its model, if it has one), whose single material is named 'surface' so hesperus/material (and its :surface slot)
 *  colours it as it colours a model's. Base-centred like a measured model: it stands on the frame's origin. */
function meshGeometry({ shape, size: [x, y, z] }) {
  const r = x / 2;
  switch (shape) {
    case 'sphere': return new THREE.SphereGeometry(r, 32, 16).translate(0, r, 0);
    case 'cylinder': return new THREE.CylinderGeometry(r, r, y, 32).translate(0, y / 2, 0);
    case 'capsule': return new THREE.CapsuleGeometry(r, Math.max(0, y - 2 * r), 8, 16).translate(0, y / 2, 0);
    case 'plane': return new THREE.PlaneGeometry(x, z).rotateX(-Math.PI / 2);
    default: return new THREE.BoxGeometry(x, y, z).translate(0, y / 2, 0);
  }
}
function meshMaterial(shape) {
  const mat = new THREE.MeshStandardNodeMaterial({ color: 0x9a9a9a, roughness: 0.8, metalness: 0, ...(shape === 'plane' ? { side: THREE.DoubleSide } : {}) });
  mat.name = 'surface';
  return mat;
}
const meshParts = new Map();   // id -> the THREE.Mesh drawing its mesh component, on whichever frame stands for it now
function dropMeshPart(id) {
  const part = meshParts.get(id); if (!part) return;
  part.parent?.remove(part); part.geometry.dispose();
  for (const mat of new Set([part.material, ...(part.userData.__matOrig ?? []), ...(part.userData.__matClones ?? [])])) mat?.dispose?.();
  meshParts.delete(id);
}
function setMeshShape(part, m) {
  part.geometry.dispose(); part.geometry = meshGeometry(m); part.userData.meshSize = m.size;
  if (part.userData.meshShape !== m.shape) { part.userData.meshShape = m.shape; for (const mat of [part.material, ...(part.userData.__matClones ?? [])]) if (mat) mat.side = m.shape === 'plane' ? THREE.DoubleSide : THREE.FrontSide; }
}
/** Realize the frame's own components, each on its own: the mesh (made, reshaped, moved onto a replaced frame, or dropped),
 *  the socket flag, and whether the frame is an Empty (nothing drawn). Idempotent. */
function syncParts(id) {
  const ent = state.st.entities[id], obj = entities.get(id); if (!ent || !obj) return;
  const m = readMesh(ent.mesh), key = meshKeyOf(ent); let part = meshParts.get(id) ?? null, changed = false;
  if (!m && part) { dropMeshPart(id); part = null; changed = true; }
  else if (m && !part) {
    part = new THREE.Mesh(meshGeometry(m), meshMaterial(m.shape));
    part.castShadow = part.receiveShadow = true;
    part.userData = { meshPart: true, meshShape: m.shape, meshSize: m.size, key };
    prepareMaterial(part.material, part);
    meshParts.set(id, part); changed = true;
  } else if (m && part.userData.key !== key) { setMeshShape(part, m); part.userData.key = key; changed = true; }
  if (part && part.parent !== obj) obj.add(part);
  if (ent.socket && typeof ent.socket === 'object' && !Array.isArray(ent.socket)) obj.userData.socket = true; else delete obj.userData.socket;
  obj.userData.empty = tracked.get(id)?.kind === 'host' && !part;
  syncMarker(id);
  if (changed) partsChanged(id, obj, ent);
}
/** A frame's drawn geometry changed: its collider and caster slot follow (a model's promote tail does both when it lands). */
function partsChanged(id, obj, ent) {
  if (isPlaceholder(obj) || obj.userData.tier === 'lod' || promoteTail.has(id)) return;
  if (obj.userData.empty) { if (colliders.has(id)) removeCollider(id); releaseCaster(id); return; }
  // collision off for bodies has no box, as runPromoteTail reads it (collisionOwnedElsewhere)
  if (!collisionOwnedElsewhere(ent, obj.userData.mountedTo)) fitCollider(id, obj, { collide: colliderOf(ent), scale: ent.scale || 1, localFrame: true });
  registerCaster(id, obj);
  bus.emit('entity', { id, kind: 'place' });
}

/** The Inspector's live preview of a mesh card scrub: the geometry as the field reads now, before release. The fold's
 *  echo (syncParts, keyed) settles it. */
export function previewMesh(id, m) {
  const part = meshParts.get(id); const r = readMesh(m); if (!part || !r) return false;
  setMeshShape(part, r); part.userData.key = null;   // null: the next fold word (or a pose-revert) rebuilds and refits
  return true;
}

// An Empty is invisible, so in edit mode it wears a small pickable wireframe marker (edit/build.js walks up to
// entityId). Attached only while editing, not hidden: three's raycaster ignores `visible`.
let editing = false;
let _emGeo = null;
let _emMat = null;
/** An Empty that is no socket wears the marker while editing (a socket's seat gizmos draw it). */
function syncMarker(id) { const g = entities.get(id); if (g && tracked.get(id)?.kind === 'host') setEmptyMarker(g, editing && g.userData.empty === true && !g.userData.socket); }
function setEmptyMarker(g, on) {
  const cur = g.children.find((c) => c.userData?.emptyMarker);
  if (on && !cur) {
    _emGeo ??= new THREE.OctahedronGeometry(0.18);
    _emMat ??= new THREE.MeshBasicNodeMaterial({ color: 0x66ccff, wireframe: true, transparent: true, opacity: 0.9, depthTest: false });
    const m = new THREE.Mesh(_emGeo, _emMat);
    m.userData = { emptyMarker: true, perfscopeIgnore: true, noCamCollide: true, noWet: true, noCloudShadow: true };
    m.castShadow = m.receiveShadow = false;
    m.renderOrder = 999;
    g.add(m);
  } else if (!on && cur) g.remove(cur);
}

// ---- light components -------------------------------------------------------
// comp.light on any entity (a lamp model, an Empty, a crate). Not a child mesh (a gizmo inside a lamp would join its
// collider) but a rig request (lightrig.js) whose `obj` is the realized object, so the cast follows motion and
// mounts; a bare reservation parks it at the folded position. An Empty carries the gizmo as a child. Keyed by id and
// released here, never by owner, which demote and tier swaps release.
const compLights = new Map();   // id -> { key, gizmo? }

function dropCompLight(id) {
  const cl = compLights.get(id);
  if (!cl) return;
  releaseLight(cl.key);
  if (cl.gizmo) { cl.gizmo.parent?.remove(cl.gizmo); cl.gizmo.geometry?.dispose?.(); cl.gizmo.material?.dispose?.(); }
  compLights.delete(id);
}


/** The rig request for a light component: on its realized host, or (no host yet) parked at the fold's world pose
 *  (a child's own pos is its parent's frame), with its q for a spot. */
export const lightSpec = (id, ent, L, host) => { const w = host ? null : worldPose(state.st.entities, id); return {
  color: L.color, intensity: L.intensity, range: L.range, decay: L.decay, keep: L.important, dayAware: L.daytime !== 'full',   // the rig's `keep` tier is light.important
  spot: L.kind === 'spot' ? { angle: L.angle, inner: L.inner } : null,
  obj: host, pos: host ? null : [...(w?.pos ?? ent.pos ?? [0, 0, 0])], q: host ? null : (w?.q ?? null),
}; };
/** Parked lights (no realized host yet) at or under `id` re-read the fold's world pose: a carrier moved or a chain changed. */
const resyncParkedUnder = (id) => { for (const lid of compLights.keys()) if (!entities.has(lid) && (lid === id || ancestors(state.st.entities, lid).includes(id))) syncCompLight(lid); };
/** A light card's drag, before release: the realized light takes the dragged brightness or range; the fold's value
 *  comes back with the commit (syncCompLight) or the card's restore. */
export function previewLight(id, patch) {
  const cl = compLights.get(id), ent = state.st.entities[id], L = ent ? lightOf(ent) : null;
  if (!cl || !L) return false;
  updateRequest(cl.key, { ...lightSpec(id, ent, L, entities.get(id) ?? null), ...patch }); return true;
}
/** Make the realized light match the fold for this id: create, update, move to the current realized object, or
 *  release. Idempotent; called whenever the comp changes or the entity's realized object is replaced. */
function syncCompLight(id) {
  const ent = state.st.entities[id];
  const L = ent ? lightOf(ent) : null;
  if (!L || offIn(state.st.entities, id)) { dropCompLight(id); return; }   // a switched-off thing casts nothing
  if (L.kind === 'directional') { dropCompLight(id); return; }   // a sun: the rig's own sun draws it (watervolumes.js, zone.js lookOf)
  const host = entities.get(id) ?? null;
  const spec = lightSpec(id, ent, L, host);
  let cl = compLights.get(id);
  if (!cl) {
    cl = { key: `complight:${id}` };
    compLights.set(id, cl);
    requestLight(cl.key, { ...spec, authored: true, owner: null });
  } else updateRequest(cl.key, spec);
  const wantGizmo = !!host?.userData?.empty;
  if (wantGizmo && cl.gizmo?.parent !== host) {
    if (!cl.gizmo) cl.gizmo = makeLightGizmo(L.color);
    host.add(cl.gizmo);
  } else if (!wantGizmo && cl.gizmo) {
    cl.gizmo.parent?.remove(cl.gizmo); cl.gizmo.geometry?.dispose?.(); cl.gizmo.material?.dispose?.();
    delete cl.gizmo;
  }
  cl.gizmo?.material?.color?.set?.(L.color);
}

/** comp.collider changed on a standing collider: re-decide it under the new preference (the promote tail reads
 *  colliderOf fresh, so an entity whose collider has not landed yet needs nothing). */
function applyColliderPref(id) {
  // collision switched off or back on (collider.enabled): the walker's collider goes, or is fitted again (a full-tier thing)
  const ent = state.st.entities[id], obj = entities.get(id);
  if (collisionOwnedElsewhere(ent, obj?.userData?.mountedTo)) { if (colliders.has(id)) removeCollider(id); return; }
  if (!colliders.has(id) && obj && !isPlaceholder(obj) && obj.userData.tier !== 'lod' && !obj.userData.empty) { fitCollider(id, obj, { collide: colliderOf(ent), scale: ent.scale || 1, localFrame: true }); bus.emit('entity', { id, kind: 'place' }); return; }
  const e = colliders.get(id);
  if (!e) return;
  e.pref = colliderOf(state.st.entities[id]);
  refitCollider(id);
}

// ---- refresh ----------------------------------------------------------------

function refreshModel(id, ent) {
  const obj = entities.get(id);
  if (!obj) return;   // loading: completion reads state
  // a mounted child's transform is parent-relative and the mount owns it; the dismount brings the fold's word back
  if (!obj.userData.mountedTo) {
    if (ent.pos) obj.position.set(...ent.pos);
    if (ent.q || ent.yaw != null) orientObj(obj, ent);
    obj.userData.base = restOf(obj, ent);
  }
  if (ent.scale != null) applyScale(obj, entScale(ent));
  if (!isPlaceholder(obj) && obj.userData.tier !== 'lod') refitCollider(id);   // placeholders and lod tiers own no collider
  bus.emit('entity', { id, kind: 'place' });
}

// ---- retirement -------------------------------------------------------------

function retire(id) {
  dropCompLight(id);
  cancelOwner(`entity:${id}`);
  promoteTail.delete(id);         // a pending heavy tail dies with the id
  const obj = entities.get(id);
  if (obj && !isPlaceholder(obj) && obj.userData?.lib) releaseGLB(obj.userData.glbKey ?? obj.userData.lib);
  dropMeshPart(id);
  const rode = obj?.userData?.mountedTo;
  // a carrier that leaves the fold with only a stand-in: its cargo steps off that, the same way (one that is only being
  // rebuilt keeps it: the rebuild re-mounts them)
  const holder = obj ?? (state.st.entities[id] ? null : standIns.get(id));
  if (holder) {
    // cargo steps off before the carrier vanishes, at the pose the fold stamped for it, so every joiner agrees
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
      if (cst?.q || cst?.yaw != null) orientObj(cobj, cst);
      applyScale(cobj, entScale(cst) ?? 1);   // the fold's scale, not the one attach() baked in
      cobj.userData.base = restOf(cobj, cst);
      // an Empty owns no collider (its only mesh may be a light gizmo), nor does a thing with collision off for bodies
      if (!cobj.userData.empty && !collisionOwnedElsewhere(cst)) fitCollider(cid, cobj, { collide: colliderOf(cst), scale: cobj.scale?.x || 1 });
    }
    (holder.parent ?? scene).remove(holder);
    if (holder !== obj) standIns.delete(id);
  }
  if (rode) pruneStandIn(rode);
  indexSceneMount(id, null);      // if the retired thing itself rode a carrier
  release(id, 'retire');          // the collider, the caster and the lamps let go
  entities.delete(id);
  untrack(id);
  bus.emit('entity', { id, kind: 'remove' });
}

// ---- components -------------------------------------------------------------

function emitCompBag(id) {
  syncCompLight(id);   // every path that re-announces the bag re-derives the light
  const bag = bagOf(id);
  if (bag) for (const type of compKeys(bag)) bus.emit('comp', { id, type, data: bag[type] });
}

/** comp {type:'hidden', data:true} = not drawn, still there (the collider, the mounts, the log all stand). */
export function applyHidden(id) {
  const obj = entities.get(id);
  if (obj) obj.visible = bagOf(id)?.hidden !== true && !isMineHidden(id) && !isolatedOut(id);   // hidden for everyone, or just in my view (myview.js: the eye, isolate)
  else if (standIns.has(id)) placeStandIn(id);   // its waiting children go and come with it
}
bus.on('myview', ({ id }) => applyHidden(id));

function onComp(id, type) {
  // switched off or back on: the thing and everything under it go (deepest first) or come back (the top first)
  if (type === 'disabled') { reconcileSubtree(id); bus.emit('disabled-changed', { id }); return; }
  const data = bagOf(id)?.[encName(type)] ?? null;   // the diff names components as the view spells them
  if (type === 'motion' && data == null) restAtBase(id);
  if (type === 'hidden') applyHidden(id);
  if (type === 'light') syncCompLight(id);
  // a mesh or a socket arriving, changing or leaving is realized on the standing frame (an Empty's gizmo follows the mesh)
  if (type === 'mesh' || type === 'socket') { syncParts(id); syncCompLight(id); }
  if (type === 'collider') applyColliderPref(id);
  // a socket that starts (or stops) riding a part re-attaches: into the part's node at rest, or back onto its host
  if (type === 'socket') execMount(id);
  bus.emit('comp', { id, type, data });
}

/** Motion ended: rest at the logged base pose (the `place` that accompanies an away-from-base stop rewrites base first). */
function restAtBase(id) {
  const obj = entities.get(id);
  const base = obj?.userData?.base;
  if (!obj || !base) return;
  obj.position.set(...base.pos);
  orientObj(obj, base);
  reindexCollider(id);
}

// ---- mounting ---------------------------------------------------------------

/** Execute (or re-execute) the scene linkage for an entity's folded parent. State is the pending list: if either
 *  end isn't realized yet, do nothing; the spawn completion calls back via mountsTouching. `mountRel` guards
 *  re-execution: re-attaching a part socket mid-motion would re-bake the phase into the offset. */
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
  if (!child) return;
  const parent = entities.get(rel.to) || standInFor(rel.to);
  if (!parent) return;
  // a socket that rides a part goes INTO the part's node, at the part's rest pose, so the scene graph carries it (and what
  // sits on it) through the part's motion. The part node and stand-in-ness are part of the linkage's identity (relKey).
  const part = typeof ent?.socket?.part === 'string' ? ent.socket.part : null;
  const partNode = part && !parent.userData.standIn ? findPart(parent, part) : null;
  const relKey = JSON.stringify([rel, part, !!partNode, !!parent.userData.standIn]);
  if (child.userData.mountRel === relKey) return;   // already exactly this
  // a loop (a log written before the authority refused them): parenting a thing under its own descendant would make
  // three.js recurse forever; leave it where it stands (shared/hierarchy.js treeOf shows both as roots)
  for (let p = parent; p; p = p.parent) if (p === child) return;
  parent.add(child);   // transform becomes parent-relative
  child.position.set(...(rel.offset ?? [0, 0, 0]));
  applyScale(child, entScale(ent) ?? 1);   // its own: attach() and a step-out bake the carrier's in
  if (Array.isArray(rel.q) && rel.q.length === 4) child.quaternion.set(rel.q[0], rel.q[1], rel.q[2], rel.q[3]);
  else child.rotation.set(0, rel.yaw ?? 0, 0);
  if (partNode) attachAtRest(parent, partNode, child);
  // its rest is this local pose (in the part's node when it rides one): motion.js and openable.js compose onto it
  child.userData.base = { pos: child.position.toArray(), yaw: child.rotation.y, q: child.quaternion.toArray() };
  child.userData.mountedTo = rel.to;
  child.userData.mountRel = relKey;
  indexSceneMount(id, rel.to);
  // the parent's collider is what the pair collides as while attached
  removeCollider(id);
  bus.emit('mount', { id, to: rel.to });
  if (!parent.userData.standIn) pruneStandIn(rel.to);
}

/** Move `child` (posed in `host`'s frame) into `node`, a moving part somewhere under `host`, so that with the part at
 *  REST it stands exactly where it stood: its local pose in the node is (the node's rest pose in the host's frame)⁻¹ ∘
 *  its pose in the host's. A node's rest is motion.js's `mbase` once it has animated it (the pose it started from), else
 *  where it stands now (a part that has never moved is at rest). */
const _arM = new THREE.Matrix4(), _arL = new THREE.Matrix4(), _arV = new THREE.Vector3(), _arQ = new THREE.Quaternion();
function attachAtRest(host, node, child) {
  const chain = [];
  for (let n = node; n && n !== host; n = n.parent) chain.push(n);
  if (!chain.length || chain[chain.length - 1].parent !== host) return;   // not under it: stays on the host
  _arM.identity();
  for (let i = chain.length - 1; i >= 0; i--) {
    const n = chain[i], b = n.userData.mbase;
    _arM.multiply(_arL.compose(b ? _arV.fromArray(b.pos) : n.position, b ? _arQ.fromArray(b.quat) : n.quaternion, n.scale));
  }
  child.updateMatrix();
  _arL.copy(_arM).invert().multiply(child.matrix);
  node.add(child);
  _arL.decompose(child.position, child.quaternion, child.scale);
}

// ---- stand-ins ----------------------------------------------------------------
// A carrier in the fold with nothing realized (far, loading, failed) still carries its children: they mount into its
// stand-in, a bare Group (no mesh, collider or entityId) at the carrier's folded world pose, so a child's pose stays
// local to its carrier and hidden/isolated reaches them as the scene graph would. The real carrier's arrival
// re-mounts them (mountsTouching) and the emptied stand-in goes. One per carrier; never in `entities`.
const standIns = new Map();   // carrier id -> Group

function standInFor(cid) {
  if (!state.st.entities[cid]) return null;   // a dangling parent: the child stands as a root, as it always did
  let g = standIns.get(cid);
  if (!g) {
    g = new THREE.Group();
    g.userData = { standIn: cid, noCamCollide: true, perfscopeIgnore: true, skyExempt: true };   // skyExempt: a sky build in flight must not adopt it (sky.js claimSkyAdditions)
    standIns.set(cid, g);
    scene.add(g);
    placeStandIn(cid);
  }
  return g;
}
function placeStandIn(cid) {
  const g = standIns.get(cid); if (!g) return;
  const w = worldPose(state.st.entities, cid); if (!w) return;
  g.position.set(...w.pos); g.quaternion.set(...w.q); applyScale(g, w.scale ?? 1);
  g.visible = bagOf(cid)?.hidden !== true && !isMineHidden(cid) && !isolatedOut(cid);
}
function pruneStandIn(cid) {
  const g = standIns.get(cid);
  if (g && !g.children.length) { g.parent?.remove(g); standIns.delete(cid); }
}
/** `id` moved or was re-parented in the fold: the stand-ins at or under it re-stand (their world pose composes its). */
function restandWaiting(id, seen = new Set()) {
  if (seen.has(id)) return;
  seen.add(id);
  placeStandIn(id);
  for (const cid of childrenOf(id)) restandWaiting(cid, seen);
}

function execDismount(id, ent) {
  const obj = entities.get(id);
  if (obj && obj.userData.mountedTo) {
    const was = obj.userData.mountedTo;
    scene.attach(obj);   // keeps the world transform it had
    delete obj.userData.mountedTo;
    delete obj.userData.mountRel;
    indexSceneMount(id, null);
    // the fold's stamp wins over wherever the mount left it
    if (ent?.pos) obj.position.set(...ent.pos);
    if (ent?.q || ent?.yaw != null) orientObj(obj, ent);
    // and so does the fold's scale: attach() baked the carrier's scale into this one, which a joiner never sees
    applyScale(obj, entScale(ent) ?? 1);
    obj.userData.base = restOf(obj, ent);
    if (!obj.userData.empty && !collisionOwnedElsewhere(ent)) fitCollider(id, obj, { collide: colliderOf(ent), scale: obj.scale?.x || 1 });
    pruneStandIn(was);
  }
  bus.emit('mount', { id, to: null });
}

// ---- residency ----------------------------------------------------------------
// Demotion is fold→state→realize read backwards: state never changes, the projection coarsens. A far entity swaps
// back to the placeholder tier, freeing its subtree, collider BVH, lamp requests and caster slot (VRAM falls when the
// proto evicts, assets.js evictIdleProtos). Promotion reruns the load pipeline.

// ---- the geometry tier -----------------------------------------------------
// Chosen before the fetch from the resident's dial, the distance against the entity's residency radius, and device
// pressure (lod_policy.js); the recipe comes from the server's /version. A lod-tier placement is visual only (no
// collider, no support surface) until it upgrades to full on approach.
let lodRecipe = null;
lodRecipeReady.then((r) => { lodRecipe = r; }).catch(() => {});
export const modelQuality = makeModelQuality(globalThis.localStorage);
function tierFor(ent, current = null) {
  // the recipe counts only where a lod ask can cross the wire (assets.js lodNegotiable); elsewhere the policy sees
  // no recipe, and nothing is asked or reported as asked
  return chooseTier({ dist: entDist(ent), radius: residencyRadius(ent), quality: modelQuality.quality,
    recipe: lodNegotiable(ent?.model) ? lodRecipe : null, pressure: gpuPressure(), shed: modelQuality.shed, current, scale: ent?.scale ?? 1 });
}
/** The models⚙ row (edit/skypanel.js binds it): set the resident's dial, and say whether a reduced tier can be asked
 *  from this browser at all. Out of the DOM so test/client/lod-client-test.ts gates it. */
export function dialModelQuality(v) {
  const q = modelQuality.setQuality(v);
  return lodNegotiable('eidoverse/assets/models/any.glb')
    ? `models: ${q} (yours only)`
    : `models: ${q} (yours only) — reduced tiers cannot be asked from this browser; everything stays full detail`;
}
/** Only a placement nothing depends on may change tier in place, the same predicate as demotion: a tier swap is a
 *  demote-and-promote with the placeholder frame skipped. */
const canRetier = (id, ent) => canDemote(id, ent);

const R_HYST = 20;     // the band that keeps a walk along the edge quiet
const DIAG_DEFAULT = 12; // assumed bbox diagonal (m) before geom lands: err large, so a big thing near the edge still loads
const resStats = { demotes: 0, promotes: 0, retiers: 0, retiersRefused: 0 };

function residencyRadius(ent) {
  const s = ent?.model ? libGeom.get(ent.model)?.bbox?.size : null;
  const diag = s ? Math.hypot(s[0] ?? 0, s[1] ?? 0, s[2] ?? 0) : DIAG_DEFAULT;
  return residencyRadiusFor(diag);
}
// distance is min(camera, avatar): in photo-mode flight the body may stand on something the camera left behind, and
// demoting its floor drops it through the world. main.js injects the avatar-position source.
let residencyFocus = null;
export function setResidencyFocus(fn) { residencyFocus = fn; }
const _f = new THREE.Vector3();
// world position: in XR the camera is a child of the rig (xr.js), so camera.position is only the head's offset inside it
const _cw = new THREE.Vector3();
const camWorld = () => camera.getWorldPosition(_cw);
/** Test seam (test/client/camera-world-probe.mjs): the residency/LOD distance for a folded entity. */
export const residencyDistance = (ent) => entDist(ent);
/** Where a folded thing stands in the world: a parented thing's pos is in its parent's frame, so its carriers'
 *  transforms are composed onto it. */
const _rq = new THREE.Quaternion(), _rs = new THREE.Vector3(), _rup = new THREE.Vector3(0, 1, 0);
function foldWorldPos(ent, out) {
  out.set(...(ent?.pos ?? [0, 0, 0]));
  const seen = new Set();
  for (let e = ent; e?.parent?.to && !seen.has(e); ) {
    seen.add(e);
    const p = state.st.entities[e.parent.to]; if (!p) break;
    const s3 = Array.isArray(p.scale3) && p.scale3.length === 3 ? p.scale3 : null, s = typeof p.scale === 'number' ? p.scale : 1;
    out.multiply(s3 ? _rs.set(s3[0], s3[1], s3[2]) : _rs.setScalar(s));
    if (Array.isArray(p.q) && p.q.length === 4) _rq.set(p.q[0], p.q[1], p.q[2], p.q[3]); else _rq.setFromAxisAngle(_rup, p.yaw ?? 0);
    out.applyQuaternion(_rq).add(_rs.set(...(p.pos ?? [0, 0, 0])));
    e = p;
  }
  return out;
}
function entDist(ent) {
  foldWorldPos(ent, _v);
  let d = camWorld().distanceTo(_v);
  const p = residencyFocus?.();
  if (p) d = Math.min(d, _f.set(p.x, p.y, p.z).distanceTo(_v));
  return d;
}

/** What may not be demoted: things whose demote has no clean undo. All cheap fold-truth predicates. */
function canDemote(id, ent) {
  if (!ent || !modelOf(ent) || ent.parent) return false;   // only a model has a stand-in (a mesh has no bytes to shed); mounted children ride carriers
  const obj = entities.get(id);
  if (!obj || isPlaceholder(obj) || editHolds.has(id)) return false;
  if (!libGeom.get(ent.model)?.bbox) return false;    // nothing honest to stand in
  // a carrier: cargo would need the step-off, which is semantically a removal (it re-stamps fold poses), so refuse.
  // Its own bare sockets don't count (demote moves them onto the stand-in) unless one rides a part or carries something.
  const kids = childrenOf(id);
  for (const k of kids) { const sk = state.st.entities[k]?.socket; if (!sk || typeof sk.part === 'string' || childrenOf(k).length) return false; }
  // a body in its seat: someone is sitting on it, wherever we are standing (avatarMounts is occupant-keyed)
  for (const rel of avatarMounts.values()) if (rel.to === id || kids.includes(rel.to)) return false;
  const bag = recordComponents(state.st.entities[id]);
  if (bag) {
    // part motions need named nodes a placeholder lacks; whole-entity motion is fine (the stand-in carries userData.base)
    if (bag.motion?.part) return false;
    for (const k in bag) if (k.startsWith('motion:')) return false;
  }
  return true;
}

function demote(id) {
  const ent = state.st.entities[id];
  const obj = entities.get(id);
  // its sockets (canDemote let only bare ones through) step off onto the scene and re-attach to the stand-in below
  const socks = [...(sceneChildren.get(id) ?? [])].filter((k) => entities.get(k)?.userData?.socket);
  for (const k of socks) { const so = entities.get(k); scene.attach(so); delete so.userData.mountRel; }
  teardownRealized(id, obj, 'demote');   // a demoted stand-in must not inherit the real model's collider/lamps
  (obj.parent ?? scene).remove(obj);
  const grp = makePlaceholder(id, ent, libGeom.get(ent.model));
  entities.set(id, grp);
  scene.add(grp);
  syncParts(id);     // its mesh and socket ride the stand-in
  applyHidden(id);   // hidden survives the stand-in box (placeholder / demote)
  syncCompLight(id); // the lamp's light follows it onto the stand-in
  resStats.demotes++;
  for (const k of socks) execMount(k);
  bus.emit('entity', { id, kind: 'demote' });   // emitters, pictures, texts retire what they built on it
}

let lastEvict = 0;
/** One residency beat (initModelsRealizer runs it at 2 Hz; exported so a headless harness can beat it
 *  deterministically, test/client/lod-client-test.ts). */
export function residencySweep() {
  // the VRAM tier: every ~5 s, if GPU memory is over budget, zero-ref protos dispose (usually a no-op number read)
  const now = Date.now();
  if (now - lastEvict > 5000) {
    lastEvict = now;
    evictIdleProtos().catch(() => {});
  }
  for (const [id, t] of tracked) {
    if (t.kind !== 'model') continue;
    const ent = state.st.entities[id];
    if (!ent) continue;
    const obj = entities.get(id);
    const R = residencyRadius(ent);
    const d = entDist(ent);
    if (obj && !isPlaceholder(obj) && d > R + R_HYST) {
      if (canDemote(id, ent)) demote(id);
    // inside the radius, a realized placement may want the other tier now (hysteresis in the policy, a cooldown
    // against stacking); the new tier loads first and replaces in place, no placeholder frame between
    } else if (obj && !isPlaceholder(obj) && !t.loading && obj.userData.lib) {
      const asked = obj.userData.tierAsked ?? obj.userData.tier ?? 'full';
      const want = tierFor(ent, asked);
      if (want !== asked && now - (t.retierAt ?? 0) > 5000 && canRetier(id, ent)) {
        t.retierAt = now;
        resStats.retiers++;
        scheduleLoad(id, ent, regen(id), want);
      }
    // both stand-in shapes promote by distance (bare reservations too, or a `place` moving one near before geom
    // arrives would never load). Within its radius an entity eventually loads; beyond it, it isn't promoted (a load
    // already queued still runs).
    } else if ((obj === null || isPlaceholder(obj)) && d < R && !t.loading
      && (!t.failedAt || now - t.failedAt > 30000)) {
      resStats.promotes++;
      scheduleLoad(id, ent, regen(id));   // stale in-flight completions no-op
    }
  }
}

export const residencyDebug = () => {
  let real = 0, standins = 0, loading = 0, waiting = 0;
  for (const [id, t] of tracked) {
    if (t.kind !== 'model') continue;
    const obj = entities.get(id);
    // a bare reservation is only "loading" while a job is in flight; the join gate leaves far entities "waiting"
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

/** A thing and everything under it, after it was switched off or on (or moved under / out from under something
 *  off): off goes deepest first, on comes top first, by real depth. */
function reconcileSubtree(id) {
  const E = state.st.entities; const depth = (k) => { let n = 0; for (let p = E[k]?.parent?.to; p && n < 33; p = E[p]?.parent?.to) n++; return n; };
  const under = Object.keys(E).filter((k) => { for (let p = E[k]?.parent?.to, n = 0; p && n < 33; p = E[p]?.parent?.to, n++) if (p === id) return true; return false; });
  const order = [id, ...under].sort((a, b) => depth(a) - depth(b)); const off = offIn(E, id); if (off) order.reverse();
  for (const k of order) reconcileId(k);
  if (!off) for (const k of order) execMount(k);   // a no-op until both ends are realized; the load's own callback finishes it
}
/** One id, after its identity may have changed: create, retire, rebuild, or refresh. The fold's current word is final. */
function reconcileId(id) {
  const ent = state.st.entities[id];
  const t = tracked.get(id);
  if (!ent || offIn(state.st.entities, id)) { if (t || entities.has(id)) retire(id); return; }
  if (!t) { create(id, ent); return; }
  if ((t.model ?? null) !== modelOf(ent)) {
    retire(id);
    create(id, ent);
    return;
  }
  syncParts(id);
  refreshModel(id, ent);
  if (t.kind !== 'model') { emitCompBag(id); execMount(id); }
}

/** Full idempotent pass (hydration, reconnect): reconcile ∘ reconcile = reconcile. */
export function reconcileModels() {
  const view = new Map([...tracked].map(([id, t]) => [id, { model: t.model }]));
  const { create: plan, retire: dead } = planReconcile(state.st.entities, view);
  for (const id of dead) retire(id);
  const created = new Set(plan.map((c) => c.id));
  for (const { id, ent } of plan) create(id, ent);
  // survivors refresh in place: a reconnect may have moved anything
  for (const [id, t] of tracked) {
    if (created.has(id) || !state.st.entities[id]) continue;
    const ent = state.st.entities[id];
    syncParts(id);
    refreshModel(id, ent);
    emitCompBag(id);
    execMount(id);
  }
}

/** One thing changed (state.js: said in the protocol's terms). The fold has already written state. */
function onChange({ id, what, comp }) {
  try {
    const ent = state.st.entities[id];
    switch (what) {
      case 'born':
      case 'gone':
        reconcileId(id);
        // a re-born thing keeps no stale bag: the light follows the new one
        if (what === 'born') syncCompLight(id);
        break;
      case 'pose':
        if (ent) refreshModel(id, ent);
        syncCompLight(id);   // a parked light (model still loading) moves with the fold
        resyncParkedUnder(id);
        if (standIns.size) restandWaiting(id);
        break;
      case 'parent':
        // moved under (or out from under) a switched-off thing: it goes or comes with its new parent
        if (offIn(state.st.entities, id) !== !(entities.has(id) || tracked.has(id))) { reconcileSubtree(id); break; }
        if (ent?.parent) execMount(id);
        else if (entities.has(id) || tracked.has(id)) execDismount(id, ent);
        resyncParkedUnder(id);
        if (standIns.size) restandWaiting(id);
        break;
      case 'comp':
        onComp(id, comp);
        break;
    }
  } catch (e) { report(`realize ${what} ${id}`, e); }
}

/** Wire the realizer to state. Called once from main.js. */
export function initModelsRealizer() {
  // the geom side-channel lands a beat after the snapshot: upgrade every still-bare reservation to a sized stand-in
  bus.on('lib-geom', (geom) => {
    for (const [lib, g] of Object.entries(geom ?? {})) libGeom.set(lib, g);
    for (const id of tracked.keys()) maybePlaceholder(id);
  });
  // thingphysics: a launched body leaves its carrier (scene.attach keeps where it is); its rest's parent record re-mounts it
  bus.on('flight-detach', ({ id }) => {
    const obj = entities.get(id); if (!obj || !obj.parent || obj.parent.isScene) return;
    scene.attach(obj); delete obj.userData.mountedTo; delete obj.userData.mountRel; indexSceneMount(id, null);
  });
  bus.on('build-mode', (on) => {
    editing = !!on;
    for (const id of tracked.keys()) syncMarker(id);
  });
  // a gesture the authority refused, or one cancelled with Esc (edit/writes.js): the preview snaps back to the fold.
  // A mounted child's pose is its mount's (parent-relative), which execMount skips when the linkage is unchanged.
  bus.on('pose-revert', ({ id }) => {
    const ent = state.st.entities[id]; const obj = entities.get(id);
    if (!ent || !obj) return;
    // a refused or cancelled mesh scrub previewed a geometry the fold never took: back to the fold's, collider too
    if (meshParts.has(id)) { meshParts.get(id).userData.key = null; syncParts(id); }
    if (obj.userData.mountedTo && ent.parent) {
      if (typeof ent?.socket?.part === 'string') { delete obj.userData.mountRel; execMount(id); bus.emit('entity', { id, kind: 'place' }); return; }   // in a part, at rest
      obj.position.set(...(ent.parent.offset ?? [0, 0, 0]));
      if (Array.isArray(ent.parent.q) && ent.parent.q.length === 4) obj.quaternion.set(...ent.parent.q);
      if (ent.scale != null) applyScale(obj, entScale(ent));
      bus.emit('entity', { id, kind: 'place' });
      return;
    }
    refreshModel(id, ent);
  });
  // the residency sweep: fold positions in, demote/promote out; a person covers ~3 m between beats at a run
  setInterval(residencySweep, 500);
  onWorldChange((ev) => {
    if (ev.type === 'hydrated') {
      reconcileModels();
    } else if (ev.type === 'reset') {
      // a real teardown, not just bookkeeping: otherwise the next hydrate re-creates every id on top of its orphaned
      // twin (a world switch without reload)
      for (const id of [...tracked.keys()]) retire(id);
      sceneChildren.clear();
      sceneParentOf.clear();
      for (const g of standIns.values()) g.parent?.remove(g);
      standIns.clear();
    } else if (ev.type === 'change') onChange(ev);
  });
  return true;
}
