// colliders — the physical reading of placed geometry.
//
// Every spawned object gets a box fit from its own geometry: an OBB (local AABB + the entity's yaw). Boxy things
// block movement and their tops are walkable ground. Tall SMALL-footprint things (streetlights, signs) collide as a
// slim centre pillar, so you can walk under what they carry. Anything room-sized collides against its real triangles,
// so you can walk into it. Why the rules are what they are: docs/research/collider-heuristics.md.
//
// This is also where Layer-0 affordances come from: a fitted box's walkable top is, by the same data, sittable (findSeat;
// exact and heightfield surfaces aren't) and placeable-on. Nobody authors that.

import { THREE } from './core.js';
import { MOVER } from '../../shared/mover.js';
import { bus } from './base.js';
import { MeshBVH, estimateMemoryInBytes } from 'three-mesh-bvh';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { gridAccumulator, decideSupportClass, validTopGrid, LIE_GRID } from '../../shared/supportclass.js';

const UP = new THREE.Vector3(0, 1, 0);
export const colliders = new Map(); // entity id -> { obj, box, pillar, exact?, interior, cells }

// ---- exact (trimesh) colliders ----------------------------------------------
// Room-scale things (shared/supportclass.js decides; the collider component can force "exact" | "box") collide
// against their actual triangles via a BVH, since the avatar is inside them: floor = downward raycast (step-up
// capped), walls = closest-point at hip height. The body's size is the mover's (shared/mover.js MOVER.body), the one
// set the agent and the authority read too; only the wall-probe height is this file's.
const HIP = 0.95;    // wall-probe height: floors stay > r away, walls don't

// a model whose every mesh opts out of collision (glTF extras collision:false) is not solid, distinct from "no exact
// collider available", which falls back to a box/pillar
const NON_SOLID = Object.freeze({ nonSolid: true });
function buildExact(obj) {
  obj.updateMatrixWorld(true);
  const inv = new THREE.Matrix4().copy(obj.matrixWorld).invert();
  const geoms = [];
  let meshes = 0;
  obj.traverse((o) => {
    if (!o.isMesh || !o.geometry?.attributes?.position) return;
    meshes++;
    // glTF extras mark non-solid panes, pool surfaces and decorative parts
    for(let parent=o;parent&&parent!==obj.parent;parent=parent.parent)
      if(parent.userData?.collision===false)return;
    const relative = new THREE.Matrix4().multiplyMatrices(inv,o.matrixWorld);
    const instance = new THREE.Matrix4(), transform = new THREE.Matrix4();
    for(let i=0;i<(o.isInstancedMesh?o.count:1);i++){
      transform.copy(relative);
      if(o.isInstancedMesh){o.getMatrixAt(i,instance);transform.multiply(instance);}
      const g = o.geometry.index ? o.geometry.toNonIndexed() : o.geometry.clone();
      g.applyMatrix4(transform);
      const clean = new THREE.BufferGeometry();
      clean.setAttribute('position',g.getAttribute('position'));
      geoms.push(clean);
    }
  });
  if (!geoms.length) return meshes ? NON_SOLID : null;
  return { bvh: new MeshBVH(mergeGeometries(geoms, false)) };
}

// ---- per-lib shared derivations ----------------------------------------------
// buildExact and topLie work in the entity's root-local frame (every query transforms into it), so the merged
// geometry, BVH, lie scalar and hasFloor verdict are identical for every clone of a lib at any uniform scale, keyed
// by lib path alone. Sharing is only sound for a pristine clone: models.js passes `lib` only for the untouched clone
// at promote time; every other fit keeps a per-entity build. Cache writes come only from pristine fits; refit-time
// reads are safe. CPU heap only, refcounted by the entries wearing it, dropped at zero refs.
const libCache = new Map(); // lib -> { refs, lie?, exact?: {bvh, interior} }

/** CPU bytes and refcounts per cached lib (the debug surface). */
export const colliderCacheStats = () => {
  const libs = [];
  let bytes = 0;
  for (const [lib, c] of libCache) {
    let b = 0;
    if (c.exact) { try { b = estimateMemoryInBytes(c.exact.bvh); } catch { /* debug util, best-effort */ } }
    bytes += b;
    libs.push({ lib, refs: c.refs, exact: !!c.exact, lie: c.lie ?? null, bytes: b });
  }
  return { libs, bytes };
};

const _lbInv = new THREE.Matrix4();
const _lbRel = new THREE.Matrix4();
const _lbBox = new THREE.Box3();
/** The entity-root-local bounding box at ANY current transform (inv(root) folds the pose out): every consumer treats
 *  `box` as root-local, and the promote tail fits after the spawn transform lands. */
function localBox(obj) {
  obj.updateMatrixWorld(true);
  _lbInv.copy(obj.matrixWorld).invert();
  const box = new THREE.Box3();
  obj.traverse((o) => {
    const g = o.geometry;
    if (!g) return;
    if (g.boundingBox === null) g.computeBoundingBox();
    if (!g.boundingBox || g.boundingBox.isEmpty()) return;
    _lbRel.multiplyMatrices(_lbInv,o.matrixWorld);
    const instance=new THREE.Matrix4(),transform=new THREE.Matrix4();
    for(let i=0;i<(o.isInstancedMesh?o.count:1);i++){
      transform.copy(_lbRel);
      if(o.isInstancedMesh){o.getMatrixAt(i,instance);transform.multiply(instance);}
      _lbBox.copy(g.boundingBox).applyMatrix4(transform);box.union(_lbBox);
    }
  });
  return box;
}

// ---- spatial hash -----------------------------------------------------------
// Objects are bucketed by world-space cell; a point query tests the 3×3 neighbourhood around it, nearColliders and
// raySegment every cell their radius or segment spans.
const CELL = 8; // metres
const buckets = new Map();
const cellKey = (x, z) => `${Math.floor(x / CELL)},${Math.floor(z / CELL)}`;

function bucketAdd(id, entry) {
  // an OBB can straddle cells — register in every cell its footprint touches
  const { obj } = entry; const { box } = frameOf(entry);   // a thing lying down is filed by its true footprint
  const s = obj.scale?.x || 1; // imports land wrong-sized and get resized in-world
  const r = Math.max(
    Math.abs(box.min.x), Math.abs(box.max.x),
    Math.abs(box.min.z), Math.abs(box.max.z),
  ) * s;
  entry.cells = [];
  const x0 = Math.floor((obj.position.x - r) / CELL), x1 = Math.floor((obj.position.x + r) / CELL);
  const z0 = Math.floor((obj.position.z - r) / CELL), z1 = Math.floor((obj.position.z + r) / CELL);
  // a box whose cell span is absurd (misread scale, corrupt bbox) would fill memory with cells: refuse the box,
  // keep the process. Same bucketRemove contract as a normal entry (no cells).
  const spanX = x1 - x0 + 1, spanZ = z1 - z0 + 1;
  if (spanX * spanZ > 4096) {
    console.error(`[colliders] bucketAdd ${id} abstained — footprint ${spanX}x${spanZ} cells (r=${r.toFixed(1)}m s=${s})`);
    return false;
  }
  for (let cx = x0; cx <= x1; cx++) {
    for (let cz = z0; cz <= z1; cz++) {
      const k = `${cx},${cz}`;
      if (!buckets.has(k)) buckets.set(k, new Set());
      buckets.get(k).add(id);
      entry.cells.push(k);
    }
  }
  return true;
}
function bucketRemove(id, entry) {
  for (const k of entry?.cells ?? []) {
    const s = buckets.get(k);
    if (s) { s.delete(id); if (!s.size) buckets.delete(k); }
  }
}

const _fray = new THREE.Ray();
// Does this thing contain its OWN floor? Rays down from mid-height: a pavilion hits its deck, a tree hits air. Not a
// walkability test (size decides that, see decide): it answers the grass mask's "should the meadow not grow here?"
function hasFloor(bvh, box, s) {
  const midY = (box.min.y + box.max.y) / 2;
  const w = box.max.x - box.min.x, d = box.max.z - box.min.z;
  let hits = 0, n = 0;
  for (let i = 0; i < 4; i++) {
    for (let j = 0; j < 4; j++) {
      // inset to 20%..80% of the footprint: samples hugging the walls would count the walls themselves
      _fray.origin.set(box.min.x + w * (0.2 + 0.2 * i), midY, box.min.z + d * (0.2 + 0.2 * j));
      _fray.direction.set(0, -1, 0);
      n++;
      const hit = bvh.raycastFirst(_fray, THREE.DoubleSide);
      if (!hit) continue;
      // horizontal-ish surfaces only (sign ignored: back-faces of a deck point down)
      const ny = hit.face?.normal?.y;
      if (ny == null || Math.abs(ny) > 0.5) hits++;
    }
  }
  return hits / n >= 0.35;
}

// ---- the uneven-top probe ---------------------------------------------------
// A box's top face is the only ground it can report, so a box is as honest as the thing's top is flat: a blanket with
// cushions reads ground at its tallest cushion. The probe buckets every vertex into a 24×24 grid, keeps the highest y
// per cell, and calls the lie the gap between the bbox top and the median cell top (no BVH: the BVH is what decide()
// is pricing). The grid math lives in shared/supportclass.js so the headless pipeline classifies the same; this
// adapter only walks loaded THREE meshes. Survey: docs/research/collider-heuristics.md.
export function topLie(obj, box) {
  const w = box.max.x - box.min.x, d = box.max.z - box.min.z;
  const acc = gridAccumulator(box.min.x, box.min.z, w, d);
  if (!acc) return 0;
  obj.updateMatrixWorld(true);
  const inv = new THREE.Matrix4().copy(obj.matrixWorld).invert();
  const rel = new THREE.Matrix4();
  const v = new THREE.Vector3();
  obj.traverse((o) => {
    if (!o.isMesh || !o.geometry?.attributes?.position) return;
    const pos = o.geometry.attributes.position;
    rel.multiplyMatrices(inv, o.matrixWorld);
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(rel);
      acc.add(v.x, v.y, v.z);
    }
  });
  return acc.finish(box.max.y).lie;
}

/** `fresh` marks a pristine-clone fit (see the lib-cache header): only those may write the shared derivations;
 *  refits and step-out re-fits read only. */
function decide(entry, s, fresh = false) {
  const { box, pref } = entry;
  // Size decides walkability, with one exception below; a per-object `collide` override wins over all of it (why
  // there is no "hollow" probe: docs/research/collider-heuristics.md). The gates and their numbers are the shared
  // classifier's (shared/supportclass.js).
  const w = (box.max.x - box.min.x) * s, d = (box.max.z - box.min.z) * s;
  const h = (box.max.y - box.min.y) * s;
  const { roomScale } = decideSupportClass({ w, d, h });
  // the exception: floor-shaped things whose box top is a lie (a blanket, a rug) collide exact. The lie probe is
  // local-space and scale-free (the gate applies `s`), so it shares per lib; nothing pays for it unless the shape
  // gate consults it.
  const { floorShaped } = decideSupportClass({ w, d, h });
  const shared = entry.cacheKey ? libCache.get(entry.cacheKey) : null;
  if (floorShaped && entry.lie == null) {
    if (shared && shared.lie != null) entry.lie = shared.lie;
    else {
      entry.lie = topLie(entry.obj, box);
      if (shared && fresh) shared.lie = entry.lie;
    }
  }
  const uneven = floorShaped
    && decideSupportClass({ w, d, h, lie: (entry.lie ?? 0) * s }).uneven;
  const exact = pref === 'exact' ? true : pref === 'box' ? false : (roomScale || uneven);
  if (exact && !entry.exact) {
    if (shared?.exact) entry.exact = shared.exact;
    else {
      const built = buildExact(entry.obj);
      if (built === NON_SOLID) { if (shared && fresh) shared.exact = built; }
      else if (built) {
        // hasFloor reads only the local bvh + box, so the verdict rides the shared product
        built.interior = hasFloor(built.bvh, box, s);
        if (shared && fresh) shared.exact = built;
      }
      entry.exact = built;
    }
  }
  entry.nonSolid = exact && entry.exact === NON_SOLID;   // every mesh opted out: nothing to stand on or bump
  if (!exact || entry.nonSolid) entry.exact = null;         // small/solid: use pillar/box, no trimesh
  entry.pillar = !entry.exact && (box.max.y - box.min.y) * s > 2.4;
  // clearing is a separate question from collision: a palm is exact (walk under the fronds, bump the trunk), but
  // its canopy must not bald the grass; only things with a real floor suppress the meadow
  entry.interior = entry.exact ? entry.exact.interior : false;
}

/** `lib` opts in to the per-lib shared derivations, only for a pristine clone (see the lib-cache header; models.js's
 *  promote tail is the one caller). `localFrame` computes the box root-local at any current transform (required
 *  after the spawn transform landed); other callers fit at identity with setFromObject. */
export function fitCollider(id, obj, { collide, scale = 1, lib = null, localFrame = false } = {}) {
  const box = localFrame ? localBox(obj) : new THREE.Box3().setFromObject(obj);
  if (box.isEmpty()) return;
  removeCollider(id);   // a re-fit replaces: drop the old entry's bucket cells + lib ref
  // camGhost hoisted from userData so the camera query never touches the object graph
  const entry = { obj, box, pref: collide, pillar: false, exact: null, cells: [],
    camGhost: !!obj.userData?.noCamCollide, cacheKey: lib };   // the libCache key (the model's path), not a record field
  if (lib) {
    const c = libCache.get(lib) ?? { refs: 0 };
    c.refs++;
    libCache.set(lib, c);
  }
  decide(entry, scale, Boolean(lib));
  if (entry.nonSolid) {   // decorative throughout: register nothing (and give back the lib ref taken above)
    if (lib) { const c = libCache.get(lib); if (c && --c.refs <= 0) libCache.delete(lib); }
    return;
  }
  colliders.set(id, entry);
  bucketAdd(id, entry);
}

/** Register a support collider from data rather than a loaded mesh: the headless door for a model an agent process
 *  could not decode (mcpl/physics.ts registerMeshSupport). Turns one of the server's /geom bboxes or floor decks into
 *  the entry shape resolveColliders walks. Not decide(): its probes raycast real meshes; a data box is always pref
 *  'box'. `min`/`max` are the entity's local frame, like fitCollider's box. */
export function fitSupportBox(id, min, max, { position, yaw = 0, scale = 1 } = {}) {
  const box = new THREE.Box3(
    new THREE.Vector3(min[0], min[1], min[2]),
    new THREE.Vector3(max[0], max[1], max[2]),
  );
  if (box.isEmpty()) return;
  const obj = {
    position: new THREE.Vector3(position[0], position[1], position[2]),
    rotation: { y: yaw },
    scale: new THREE.Vector3(scale, scale, scale),
  };
  const entry = { obj, box, pref: 'box', exact: null, interior: false, cells: [] };
  // the same rule decide() applies to non-exact entries: tall small-footprint things collide as a slim centre pillar
  entry.pillar = (box.max.y - box.min.y) * scale > 2.4;
  bucketRemove(id, colliders.get(id));   // a re-fit releases the old entry's cells first
  colliders.set(id, entry);
  bucketAdd(id, entry);
}

/** Register heightfield support from a served topGrid: the headless door for floor-shaped assets whose box top is a
 *  known lie (sibling of fitSupportBox). The grid is the same 24×24 max-y probe decide() uses to detect the lie, so
 *  here it is the floor. Cells are model-local; support only (a blanket has no walls). Returns false (registering
 *  nothing) for any payload validTopGrid refuses. */
export function fitSupportGrid(id, topGrid, { position, yaw = 0, scale = 1 } = {}) {
  if (!validTopGrid(topGrid)) return false;
  if (![position].every((v) => Array.isArray(v) && v.length === 3 && v.every(Number.isFinite))
      || !Number.isFinite(yaw) || !Number.isFinite(scale) || !(scale > 0)) return false;
  const [minX, minZ] = topGrid.minXZ, [w, d] = topGrid.sizeXZ;
  let lo = Infinity, hi = -Infinity;
  for (const c of topGrid.cells) if (c !== null) { if (c < lo) lo = c; if (c > hi) hi = c; }
  const box = new THREE.Box3(
    new THREE.Vector3(minX, lo, minZ),
    new THREE.Vector3(minX + w, hi, minZ + d),
  );
  const obj = {
    position: new THREE.Vector3(position[0], position[1], position[2]),
    rotation: { y: yaw },
    scale: new THREE.Vector3(scale, scale, scale),
  };
  const entry = { obj, box, pref: 'box', exact: null, interior: false, pillar: false, cells: [],
    grid: { n: topGrid.n, minX, minZ, w, d, tops: topGrid.cells } };
  bucketRemove(id, colliders.get(id));   // re-fit releases the old cells (same rule as fitSupportBox)
  colliders.set(id, entry);
  bucketAdd(id, entry);   // radial footprint: the world bounds follow yaw and scale
  return true;
}

// ---- declared structure boxes -----------------------------------------------
// A griddled building (shared/structure.js plans it, realize/structure.js declares its boxes) has its collider
// declared, not inferred: decide() never runs. Not fitSupportBox: the pillar rule (a 2.8 m wall is not a post) and
// `interior` (the ragdoll engines skip interior entries, so bodies would fall through) don't apply. The grass mask
// gets its own footprint entry carrying `mask`, which every query path skips and only flora consumes.
const structureIds = new Map(); // owner entity id -> synthetic collider ids

/** Register a building's boxes. `boxes` are grid-local metres (the entity's own frame, like every other collider's
 *  box); the entity transform composes at query time. Each box is its own entry so the spatial hash keeps doing real
 *  work. `solid: false` (collision off for bodies) registers the grass mask alone. */
export function fitStructureBoxes(ownerId, boxes, { position, yaw = 0, scale = 1, q = null, scale3 = null, solid = true } = {}) {
  removeStructureBoxes(ownerId);
  if (!Array.isArray(boxes) || !boxes.length) return 0;
  if (!Array.isArray(position) || position.length !== 3 || !position.every(Number.isFinite)) return 0;
  if (!Number.isFinite(yaw) || !Number.isFinite(scale) || scale === 0) return 0;
  // per-axis scale (a negative one mirrors, as structuretf.js draws it) is folded into the boxes; a whole rotation
  // rides as a quaternion that frameOf reads as one yaw per building, so a tilt collides as the yaw-framed bounding
  // box, not the drawn TRS
  const s3 = Array.isArray(scale3) && scale3.length === 3 && scale3.every((x) => Number.isFinite(x) && x !== 0) ? scale3 : [scale, scale, scale];
  const quat = Array.isArray(q) && q.length === 4 && q.every(Number.isFinite) && Math.hypot(...q) > 1e-6 ? new THREE.Quaternion(...q).normalize() : null;
  const obj = {
    position: new THREE.Vector3(position[0], position[1], position[2]),
    rotation: quat ? new THREE.Euler().setFromQuaternion(quat) : { y: yaw },
    ...(quat ? { quaternion: quat } : {}),
    scale: new THREE.Vector3(1, 1, 1),
  };
  const ids = [];
  let lo = null, hi = null;
  for (const b of boxes) {
    if (![b?.x0, b?.y0, b?.z0, b?.x1, b?.y1, b?.z1].every(Number.isFinite)) continue;
    const [x0, x1, y0, y1, z0, z1] = [b.x0 * s3[0], b.x1 * s3[0], b.y0 * s3[1], b.y1 * s3[1], b.z0 * s3[2], b.z1 * s3[2]];
    const box = new THREE.Box3(
      new THREE.Vector3(Math.min(x0, x1), Math.min(y0, y1), Math.min(z0, z1)),
      new THREE.Vector3(Math.max(x0, x1), Math.max(y0, y1), Math.max(z0, z1)),
    );
    if (box.isEmpty()) continue;
    lo = lo ? lo.min(box.min) : box.min.clone();
    hi = hi ? hi.max(box.max) : box.max.clone();
    if (!solid) continue;
    const id = `${ownerId}#s${ids.length}`;
    // `structOwner` keeps the entity recoverable from a synthetic id without parsing the key
    const kind = b.kind ?? 'wall';
    const entry = { obj, box, pref: 'box', exact: null, interior: false, pillar: false,
      // floors hold you up; they never push you sideways (see resolveColliders)
      support: kind === 'floor', cells: [], structOwner: ownerId, structKind: kind };
    colliders.set(id, entry);
    bucketAdd(id, entry);
    ids.push(id);
  }
  // the grass mask: one rectangular, non-colliding footprint entry (an L-shaped building clears a little extra meadow)
  if (lo && hi) {
    const id = `${ownerId}#mask`;
    const entry = { obj, box: new THREE.Box3(lo, hi), pref: 'box', exact: null,
      interior: true, mask: true, pillar: false, cells: [], structOwner: ownerId };
    colliders.set(id, entry);
    bucketAdd(id, entry);
    ids.push(id);
  }
  structureIds.set(ownerId, ids);
  return ids.length;
}

/** Drop every box a building registered. Idempotent: the realizer calls it on retire and at the head of every re-fit. */
export function removeStructureBoxes(ownerId) {
  const ids = structureIds.get(ownerId);
  if (!ids) return;
  for (const id of ids) removeCollider(id);
  structureIds.delete(ownerId);
}

/** The synthetic ids a building currently owns. */
export const structureBoxIds = (ownerId) => structureIds.get(ownerId) ?? [];

/** Call after an in-world rescale: re-decides exact-vs-box against the new size (a dollhouse scaled to a building
 *  becomes walkable-inside) and re-buckets with the scaled footprint. */
export function refitCollider(id) {
  const e = colliders.get(id);
  if (!e) return;
  bucketRemove(id, e);
  decide(e, e.obj.scale?.x || 1);
  if (!suspended.has(id)) bucketAdd(id, e);
}
// the realizer's word that a realized object is going (realize/lifecycle.js): its collider goes with it
bus.on('realized', ({ id }) => removeCollider(id));
export function removeCollider(id) {
  suspended.delete(id);
  const e = colliders.get(id);
  if (e) {
    bucketRemove(id, e);
    if (e.cacheKey) {
      const c = libCache.get(e.cacheKey);
      // zero refs: no resident entity wears this lib's derivations; drop the geometry + BVH for GC
      if (c && --c.refs <= 0) libCache.delete(e.cacheKey);
    }
  }
  colliders.delete(id);
}
/** A thing in a hand or in the air (thingphysics.js) isn't where its collider was: take it out of the walking world's grid
 *  while it is (on = true), and put it back where it is now (on = false). The entry itself is kept. */
const suspended = new Set();
export function suspendCollider(id, on) {
  const e = colliders.get(id);
  if (on) { if (!e || suspended.has(id)) return; bucketRemove(id, e); e.cells = []; suspended.add(id); return; }
  if (!suspended.delete(id) || !e) return;
  bucketAdd(id, e);
}
export const isSuspended = (id) => suspended.has(id);
/** Call after moving an entity so its bucket registration follows it. */
export function reindexCollider(id) {
  const e = colliders.get(id);
  if (!e || suspended.has(id)) return;
  bucketRemove(id, e);
  bucketAdd(id, e);
}

/** Where a thing visibly is: the collider box's world-space centre (an entity's origin is wherever its GLB author
 *  left it). Same composition as the walking/camera queries. Null with no collider. */
const _ecV = new THREE.Vector3();
export function entityWorldCenter(id, out = new THREE.Vector3()) {
  const c = colliders.get(id);
  const obj = c?.obj;
  if (!c?.box || !obj) return null;
  const sc = obj.scale ?? _ecV.set(1, 1, 1); const F = frameOf(c);
  out.copy(F.box.min).add(F.box.max).multiplyScalar(0.5)
    .multiply(_ecV.set(sc.x || 1, sc.y || 1, sc.z || 1))
    .applyAxisAngle(UP, F.yaw)
    .add(obj.position);
  return out;
}

// ---- scope: whose world a query is about -----------------------------------
// A browser holds one world's colliders; an agent process can hold several, so its entries carry `entry.scope`
// (mcpl/physics.ts) and while a scope is active queries see only that world's entries and unscoped ones.
let activeScope = null;
export function setColliderScope(s) { activeScope = s ?? null; }
export const colliderScope = () => activeScope;
const inScope = (e) => activeScope === null || e.scope == null || e.scope === activeScope;

function* cellsNear(x, z) {
  const cx = Math.floor(x / CELL), cz = Math.floor(z / CELL);
  for (let i = -1; i <= 1; i++) {
    for (let j = -1; j <= 1; j++) {
      const s = buckets.get(`${cx + i},${cz + j}`);
      if (!s) continue;
      for (const id of s) {
        const e = colliders.get(id);
        if (e && inScope(e)) yield e;
      }
    }
  }
}

/** Variable-radius neighbourhood, [id, entry] pairs; the 3×3 cellsNear caps at ~8 m. Dedupes straddlers.
 *  Not reentrant: the dedupe Set is shared, so never start a second nearColliders iteration inside a loop over one. */
const _seen = new Set();
export function* nearColliders(x, z, r = CELL) {
  const x0 = Math.floor((x - r) / CELL), x1 = Math.floor((x + r) / CELL);
  const z0 = Math.floor((z - r) / CELL), z1 = Math.floor((z + r) / CELL);
  _seen.clear();
  for (let cx = x0; cx <= x1; cx++) {
    for (let cz = z0; cz <= z1; cz++) {
      const s = buckets.get(`${cx},${cz}`);
      if (!s) continue;
      for (const id of s) {
        if (_seen.has(id)) continue;
        _seen.add(id);
        const e = colliders.get(id);
        if (e && inScope(e)) yield [id, e];
      }
    }
  }
}

// ---- camera segment query ---------------------------------------------------
// How far back may the follow camera sit, answered from the grid: candidate ids from the cells the segment overlaps,
// then a slab test against each OBB, except exact entries, which raycast their BVH (the camera slides through a
// doorway), and pillars, which test the walking post (a tree's canopy box doesn't yank the camera).

const _rsO = new THREE.Vector3();
const _rsD = new THREE.Vector3();
const _rsRay = new THREE.Ray();
const _rsPost = new THREE.Box3();
const _rsSeen = new Set();

function slabT(o, d, box, far) {
  let t0 = 0, t1 = far;
  for (const ax of ['x', 'y', 'z']) {
    const dv = d[ax];
    if (Math.abs(dv) < 1e-9) {
      if (o[ax] < box.min[ax] || o[ax] > box.max[ax]) return null;
      continue;
    }
    let a = (box.min[ax] - o[ax]) / dv;
    let b = (box.max[ax] - o[ax]) / dv;
    if (a > b) { const t = a; a = b; b = t; }
    if (a > t0) t0 = a;
    if (b < t1) t1 = b;
    if (t0 > t1) return null;
  }
  return t0;   // 0 when the origin starts inside: a solid box is solid
}

/** Nearest blocking distance along origin+dir, within `far`; null = clear.
 *  camGhost entries (gizmos, placeholders) never block. */
export function raySegment(origin, dir, far, ignoreId = null) {
  let bestT = Infinity;
  const ex = origin.x + dir.x * far, ez = origin.z + dir.z * far;
  const x0 = Math.floor(Math.min(origin.x, ex) / CELL) - 1;
  const x1 = Math.floor(Math.max(origin.x, ex) / CELL) + 1;
  const z0 = Math.floor(Math.min(origin.z, ez) / CELL) - 1;
  const z1 = Math.floor(Math.max(origin.z, ez) / CELL) + 1;
  _rsSeen.clear();
  for (let cx = x0; cx <= x1; cx++) {
    for (let cz = z0; cz <= z1; cz++) {
      const set = buckets.get(`${cx},${cz}`);
      if (!set) continue;
      for (const id of set) {
        if (id === ignoreId || _rsSeen.has(id)) continue;
        _rsSeen.add(id);
        const e = colliders.get(id);
        if (!e || e.camGhost || e.mask || !e.box || !inScope(e)) continue;
        const o = e.obj;
        const s = o.scale?.x || 1;
        const F = frameOf(e); const yaw = F.yaw;
        _rsO.copy(origin).sub(o.position);
        _rsD.copy(dir);
        if (yaw) { _rsO.applyAxisAngle(UP, -yaw); _rsD.applyAxisAngle(UP, -yaw); }
        _rsO.divideScalar(s);
        const lfar = Math.min(far, bestT) / s;
        if (F.exact?.bvh) {
          _rsRay.origin.copy(_rsO);
          _rsRay.direction.copy(_rsD);
          const hit = F.exact.bvh.raycastFirst(_rsRay, THREE.DoubleSide);
          if (hit && hit.distance <= lfar) bestT = hit.distance * s;
          continue;
        }
        let box = F.box;
        if (F.pillar) {
          const mx = (F.box.min.x + F.box.max.x) / 2, mz = (F.box.min.z + F.box.max.z) / 2;
          _rsPost.min.set(mx - 0.25, F.box.min.y, mz - 0.25);
          _rsPost.max.set(mx + 0.25, F.box.max.y, mz + 0.25);
          box = _rsPost;
        }
        const t = slabT(_rsO, _rsD, box, lfar);
        if (t !== null) bestT = t * s;
      }
    }
  }
  return bestT === Infinity ? null : bestT;
}

// ---- resolution -------------------------------------------------------------

let blockedTop = null;
export const lastBlockedTop = () => blockedTop;
const touched = new Set();
/** The collider entries the last resolveColliders call pushed against or stood on (read right after the call). */
export const lastContacts = () => touched;

const _local = new THREE.Vector3();
const _push = new THREE.Vector3();
const _exits = [
  { d: 0, x: 1, z: 0 }, { d: 0, x: -1, z: 0 },
  { d: 0, x: 0, z: 1 }, { d: 0, x: 0, z: -1 },
];

const _ray = new THREE.Ray();
const _hip = new THREE.Vector3();
const _cp = {};

// ---- a thing's frame for the yaw-only readers below ----------------------------
// Every reader here works "root-local, yaw only", exact while a thing stands. A tumbled thing can't be read through
// rotation.y (three's XYZ Euler flips past 90°), so its frame is the true yaw of its horizontal axes plus its box
// turned into that frame: exact lying on a face, the bounding box on an edge. Tumbled, it collides as that box.
const UPRIGHT = Math.cos(10 * Math.PI / 180);
const _fm = new THREE.Matrix4(), _fy = new THREE.Matrix4();
export function frameOf(e) {
  const o = e.obj, r = o.rotation, f = (e._f ??= { yaw: 0, box: e.box, exact: e.exact, pillar: e.pillar, grid: e.grid, qx: NaN, qy: NaN, qz: NaN, qw: NaN });
  if (!r || (!r.x && !r.z) || !o.quaternion) { f.yaw = r?.y ?? 0; f.box = e.box; f.exact = e.exact; f.pillar = e.pillar; f.grid = e.grid; f.qx = NaN; return f; }
  const q = o.quaternion;
  // keyed on everything a refit (decide) may change in place: the box, its exactness, its pillar and grid readings
  if (q.x === f.qx && q.y === f.qy && q.z === f.qz && q.w === f.qw && f.src === e.box && f.ex === e.exact && f.pi === e.pillar && f.gr === e.grid) return f;
  const te = _fm.makeRotationFromQuaternion(q).elements;   // column k (a local axis in the world) = te[4k..4k+2]
  const ups = [te[1], te[5], te[9]].map(Math.abs); const k = ups.indexOf(Math.max(...ups)); const j = k === 0 ? 1 : 0;
  f.yaw = Math.atan2(-te[4 * j + 2], te[4 * j]);
  const standing = k === 1 && te[5] > UPRIGHT;
  // lying, it is its box: no trimesh, no slim post (a fallen tree is a log), no heightfield (measured upright)
  if (standing) { f.box = e.box; f.exact = e.exact; f.pillar = e.pillar; f.grid = e.grid; }
  else { f.box = e.box.clone().applyMatrix4(_fy.makeRotationY(-f.yaw).multiply(_fm)); f.exact = null; f.pillar = false; f.grid = null; }
  f.qx = q.x; f.qy = q.y; f.qz = q.z; f.qw = q.w; f.src = e.box; f.ex = e.exact; f.pi = e.pillar; f.gr = e.grid;
  return f;
}

/** Push `pos` out of anything solid and return the ground height under it. Mutates pos.x/pos.z, never pos.y. `r` is
 *  a horizontal radius (a vertical cylinder). `terrainAt` supplies the base ground. `tall` is how far the body extends
 *  above pos.y (1.9 for a standing avatar, ~cm for a ragdoll joint): it decides what you pass under and scales the
 *  step-up and wall-probe heights. `climbs`: may this body mantle what blocks it (sets lastBlockedTop)? Defaults to
 *  a full-height body; the walking avatar passes true explicitly, so a smaller chosen size keeps its mantle while a
 *  ragdoll joint never climbs. */
export function resolveColliders(pos, terrainAt, r = MOVER.body.radius, tall = MOVER.body.height, climbs = tall >= MOVER.body.height) {
  blockedTop = null; touched.clear();
  let ground = terrainAt(pos.x, pos.z);
  // one routine serves a 1.9 m avatar and a 3 cm ragdoll bead, so the vertical numbers scale with `tall`; a climbing
  // body's step is the mover's, in proportion to its size, and a ragdoll joint does not climb stairs
  const step = climbs ? MOVER.body.step * (tall / MOVER.body.height) : Math.min(MOVER.body.step, tall * 0.3);
  const probeY = Math.min(HIP, tall * 0.5);  // mid-body, not "hip"
  const spanY = Math.max(r, tall * 0.26);    // how far up/down a wall hit counts
  for (const e0 of cellsNear(pos.x, pos.z)) {
    const { obj, mask, support } = e0; const { yaw, box, exact, pillar, grid } = frameOf(e0);
    if (mask) continue;   // a grass-mask footprint is not a solid (see fitStructureBoxes)
    if (support) {
      // a declared floor is support, never an obstacle (as the heightfield branch below): the generic box path counts
      // a box as floor only within 8 cm of its top, which would make a 10 cm foundation slab a wall
      const ss = obj.scale?.x || 1;
      _local.set(pos.x - obj.position.x, 0, pos.z - obj.position.z)
        .applyAxisAngle(UP, -yaw).divideScalar(ss);
      if (_local.x > box.min.x && _local.x < box.max.x
          && _local.z > box.min.z && _local.z < box.max.z) {
        const topY = obj.position.y + box.max.y * ss;
        if (topY <= pos.y + step && topY > ground) { ground = topY; touched.add(e0); }
      }
      continue;
    }
    if (grid) {
      // heightfield support: the containing cell's max-y is the ground, piecewise-constant. An empty cell offers
      // nothing (interpolation would manufacture floors over air).
      const gs = obj.scale?.x || 1;
      _local.set(pos.x - obj.position.x, 0, pos.z - obj.position.z)
        .applyAxisAngle(UP, -yaw).divideScalar(gs);
      const gx = Math.floor(((_local.x - grid.minX) / grid.w) * grid.n);
      const gz = Math.floor(((_local.z - grid.minZ) / grid.d) * grid.n);
      if (gx >= 0 && gx < grid.n && gz >= 0 && gz < grid.n) {
        const top = grid.tops[gz * grid.n + gx];
        if (top !== null) {
          const gy = obj.position.y + top * gs;
          if (gy <= pos.y + step && gy > ground) { ground = gy; touched.add(e0); }
        }
      }
      continue; // support only: never box-test a grid entry (no false walls)
    }
    if (exact) {
      // work in entity-local space (yaw-only rotation, uniform scale)
      const s = obj.scale.x || 1;
      _local.set(pos.x - obj.position.x, 0, pos.z - obj.position.z)
        .applyAxisAngle(UP, -yaw).divideScalar(s);
      const localY = (pos.y - obj.position.y) / s;
      // floor: nearest surface below the feet (+step allowance) IS the ground
      _ray.origin.set(_local.x, localY + step / s, _local.z);
      _ray.direction.set(0, -1, 0);
      const hit = exact.bvh.raycastFirst(_ray, THREE.DoubleSide);
      if (hit) {
        const gy = obj.position.y + hit.point.y * s;
        if (gy <= pos.y + step && gy > ground) { ground = gy; touched.add(e0); }
      }
      // walls: closest triangle to a mid-body probe pushes the capsule out
      _hip.set(_local.x, localY + probeY / s, _local.z);
      const res = exact.bvh.closestPointToPoint(_hip, _cp);
      if (res) {
        const dx = (_hip.x - res.point.x) * s, dz = (_hip.z - res.point.z) * s;
        const dy = Math.abs(_hip.y - res.point.y) * s;
        const dh = Math.hypot(dx, dz);
        if (dh < r && dy < spanY && dh > 1e-6) {
          _push.set(dx / dh, 0, dz / dh).applyAxisAngle(UP, yaw)
            .multiplyScalar(r - dh);
          pos.x += _push.x; pos.z += _push.z; touched.add(e0);
        }
      }
      continue; // never box-test an exact entity: that would seal interiors
    }
    const bs = obj.scale?.x || 1;
    _local.set(pos.x - obj.position.x, 0, pos.z - obj.position.z)
      .applyAxisAngle(UP, -yaw).divideScalar(bs);
    const br = r / bs;
    let minX = box.min.x, maxX = box.max.x, minZ = box.min.z, maxZ = box.max.z;
    if (pillar) {
      const cx = (minX + maxX) / 2, cz = (minZ + maxZ) / 2;
      minX = cx - 0.25; maxX = cx + 0.25; minZ = cz - 0.25; maxZ = cz + 0.25;
    }
    if (_local.x < minX - br || _local.x > maxX + br || _local.z < minZ - br || _local.z > maxZ + br) continue;
    const topY = obj.position.y + box.max.y * bs;
    // are we under it? Without box.min.y every box is an infinite column (docs/research/collider-heuristics.md)
    const bottomY = obj.position.y + box.min.y * bs;
    if (pos.y + tall <= bottomY) continue;
    if (pos.y >= topY - 0.08) {
      // at/above the top: the box is floor, not wall
      if (_local.x > minX && _local.x < maxX && _local.z > minZ && _local.z < maxZ) {
        ground = Math.max(ground, topY); touched.add(e0);
      }
      continue;
    }
    // inside the (radius-expanded) footprint below the top: push out the nearest face
    _exits[0].d = (maxX + br) - _local.x;
    _exits[1].d = _local.x - (minX - br);
    _exits[2].d = (maxZ + br) - _local.z;
    _exits[3].d = _local.z - (minZ - br);
    let best = _exits[0];
    for (let i = 1; i < 4; i++) if (_exits[i].d < best.d) best = _exits[i];
    // grazing the underside of an overhang is not walking into its side: decline the push only if there is a gap
    // below (a crate on the floor still pushes) and the overlap is a graze, not "I don't fit" (a waist-high counter
    // must not phase through). docs/research/collider-heuristics.md.
    if (bottomY > ground + 0.05
        && (pos.y + tall) - bottomY <= Math.max(0.05, tall * 0.08)) continue;
    _push.set(best.x, 0, best.z).applyAxisAngle(UP, yaw).multiplyScalar(best.d * bs);
    pos.x += _push.x; pos.z += _push.z; touched.add(e0);
    // pillars aren't mantleable, and nothing is to a body that can't climb (the ragdoll runs this per joint and must
    // not leave the controller's mantle probe holding whichever wrist last brushed a crate)
    if (!pillar && climbs) blockedTop = topY;
  }
  return ground;
}

// ---- Layer-0 affordances ----------------------------------------------------

/** Nearest sittable surface to a point: a horizontal top at chair-ish height within `range`. DESIGN.md's geometry affordances:
 *  no authoring, the geometry is the affordance. Returns {y, x, z, yaw, id} or null. */
export function findSeat(pos, range = 1.2, skip = null) {   // skip(entry): a surface the caller won't offer
  let best = null;
  // grid-bounded: a chair within `range` has its footprint cells inside the query disc
  for (const [id, e0] of nearColliders(pos.x, pos.z, range)) {
    const { obj, mask } = e0; const { yaw, box, exact, pillar, grid } = frameOf(e0);
    if (mask || skip?.(e0)) continue;
    if (pillar || exact) continue; // interiors aren't chairs; furniture inside them is
    if (grid) continue; // a heightfield's box top is a lie: no phantom seat offers
    const sc = obj.scale?.x || 1;
    const topY = obj.position.y + box.max.y * sc;
    const rise = topY - pos.y;
    if (rise < 0.25 || rise > 0.85) continue;            // not seat height
    // centre of the top face, in world space
    _local.set((box.min.x + box.max.x) / 2 * sc, 0, (box.min.z + box.max.z) / 2 * sc)
      .applyAxisAngle(UP, yaw);
    const cx = obj.position.x + _local.x, cz = obj.position.z + _local.z;
    const d = Math.hypot(cx - pos.x, cz - pos.z);
    if (d > range) continue;
    if (!best || d < best.d) best = { d, id, x: cx, z: cz, y: topY, yaw: yaw };
  }
  return best;
}

/** Highest surface directly under a point: what a dropped object lands on ("put the mug on the table"). */
export function surfaceUnder(x, z, terrainAt, maxY = Infinity, skipId = null) {
  let y = terrainAt(x, z);
  let onto = null;
  // a surface under the point has its footprint over the point: the point's own cell holds every such entry
  for (const [id, e0] of nearColliders(x, z, 0.5)) {
    const { obj, mask } = e0; const { yaw, box, exact, pillar } = frameOf(e0);
    if (pillar || mask || id === skipId) continue;
    if (exact) {
      // dropped things land on the actual surface (stair tread, mezzanine)
      const s = obj.scale.x || 1;
      _local.set(x - obj.position.x, 0, z - obj.position.z)
        .applyAxisAngle(UP, -yaw).divideScalar(s);
      const fromY = (Math.min(maxY, obj.position.y + box.max.y * s) - obj.position.y) / s;
      _ray.origin.set(_local.x, fromY + 0.01, _local.z);
      _ray.direction.set(0, -1, 0);
      const hit = exact.bvh.raycastFirst(_ray, THREE.DoubleSide);
      if (hit) {
        const topY = obj.position.y + hit.point.y * s;
        if (topY > y && topY <= maxY) { y = topY; onto = id; }
      }
      continue;
    }
    const sc2 = obj.scale?.x || 1;
    _local.set(x - obj.position.x, 0, z - obj.position.z).applyAxisAngle(UP, -yaw).divideScalar(sc2);
    if (_local.x < box.min.x || _local.x > box.max.x || _local.z < box.min.z || _local.z > box.max.z) continue;
    const topY = obj.position.y + box.max.y * sc2;
    if (topY > y && topY <= maxY) { y = topY; onto = id; }
  }
  return { y, onto };
}

export function clearColliders() {
  colliders.clear();
  buckets.clear();
  libCache.clear();
}
