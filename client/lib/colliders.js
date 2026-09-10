// colliders — the physical reading of placed geometry.
//
// Every spawned object gets a box fit from its own geometry: an OBB (local
// AABB + the entity's yaw). Boxy things (desks, crates, barrels) block movement
// and their tops are walkable ground. Tall SMALL-footprint things (streetlights,
// signs) would wall you off with their canopy extents, so they collide as a slim
// centre pillar instead — you can't walk through the post, but you can walk
// under whatever it carries. Anything room-sized collides against its real
// triangles, so you can walk into it.
//
// This is also where Layer-0 affordances come from: a surface that is walkable
// is, by the same data, sittable and placeable-on. Nobody authors that.

import { THREE } from './core.js';
import { MeshBVH, estimateMemoryInBytes } from 'three-mesh-bvh';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { gridAccumulator, decideSupportClass, validTopGrid, LIE_GRID } from './supportclass.js';

const UP = new THREE.Vector3(0, 1, 0);
export const colliders = new Map(); // entity id -> { obj, box, pillar, exact?, interior, cell }

// ---- exact (trimesh) colliders ----------------------------------------------
// Boxes read the OUTSIDE of things. Generated interiors are the opposite: the
// avatar is INSIDE the concave shape — one box seals the room shut, and the
// floor must be real geometry (stairs, thresholds, uneven ground). Room-scale
// spawns therefore collide against their actual triangles via a BVH:
//   floor = downward raycast (step-up capped), walls = closest-point at hip
//   height. Auto-applied when footprint ≥ 16 m² AND height ≥ 2.2 m; the spawn
//   verb can force either way with collide: "exact" | "box".
const STEP = 0.55;   // max mantle-less step-up, metres — one comfortable stair
const HIP = 0.95;    // wall-probe height: floors stay > r away, walls don't
const TALL = 1.9;    // default body height above `pos` — an avatar on its feet

function buildExact(obj) {
  obj.updateMatrixWorld(true);
  const inv = new THREE.Matrix4().copy(obj.matrixWorld).invert();
  const geoms = [];
  obj.traverse((o) => {
    if (!o.isMesh || !o.geometry?.attributes?.position) return;
    const g = (o.geometry.index ? o.geometry.toNonIndexed() : o.geometry.clone());
    g.applyMatrix4(new THREE.Matrix4().multiplyMatrices(inv, o.matrixWorld));
    const clean = new THREE.BufferGeometry(); // position-only: BVH wants no skinning/uv baggage
    clean.setAttribute('position', g.getAttribute('position'));
    geoms.push(clean);
  });
  if (!geoms.length) return null;
  return { bvh: new MeshBVH(mergeGeometries(geoms, false)) };
}

// ---- per-lib shared derivations (§16.2.C) ------------------------------------
// buildExact and topLie already work in the entity's ROOT-LOCAL frame: every
// mesh is transformed by inv(root.matrixWorld) · mesh.matrixWorld, which folds
// the root's position/yaw/scale OUT of the product, and every query path
// (raySegment, resolveColliders, surfaceUnder, hasFloor) transforms INTO that
// frame per entity (subtract position, un-rotate yaw, divide by live scale).
// So the merged geometry, the BVH, the lie scalar and the hasFloor verdict are
// IDENTICAL for every clone of a lib at ANY uniform scale — 20 blankets used
// to pay 20 per-vertex topLie walks and 20 BVH builds for one answer. The key
// is the lib path alone; scale needs no place in it because the product is
// scale-free (per-entity decisions apply `s` at use, as they always did).
//
// Sharing is only SOUND for a pristine clone. models.js passes `lib` exactly
// when the subtree is the untouched lib clone (promote time, before mounts
// execute, no part motion having bent a named node); every other path — the
// dismount/step-out re-fits, refit flips on already-lived objects, conjured
// meshes with no lib — keeps the per-entity build. Cache WRITES happen only
// from those pristine fits; refit-time cache READS are safe (the product is
// rest-pose lib geometry, which is what promote-time fits always baked).
//
// Everything here is CPU heap (geometry arrays + BVH nodes, nothing ever
// uploaded) — refcounted by the collider entries wearing it, dropped for GC
// at zero refs (demote/delete releases). Sizes: colliderCacheStats (8e).
const libCache = new Map(); // lib -> { refs, lie?, exact?: {bvh, interior} }

/** CPU bytes and refcounts per cached lib — the 8e observability hook. */
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
/** The entity-root-local bounding box — setFromObject's answer at identity,
 *  computable at ANY current transform (inv(root) folds the pose back out).
 *  The promote tail fits colliders AFTER the spawn transform lands, and every
 *  consumer treats `box` as root-local (subtract position, un-rotate, divide
 *  by scale per query), so the box must not inherit the world pose. */
function localBox(obj) {
  obj.updateMatrixWorld(true);
  _lbInv.copy(obj.matrixWorld).invert();
  const box = new THREE.Box3();
  obj.traverse((o) => {
    const g = o.geometry;
    if (!g) return;
    if (g.boundingBox === null) g.computeBoundingBox();
    if (!g.boundingBox || g.boundingBox.isEmpty()) return;
    _lbBox.copy(g.boundingBox).applyMatrix4(_lbRel.multiplyMatrices(_lbInv, o.matrixWorld));
    box.union(_lbBox);
  });
  return box;
}

// ---- spatial hash -----------------------------------------------------------
// resolveColliders used to walk EVERY entity every frame, allocating as it
// went. Free at 20 objects; the frame budget at 500. Objects are bucketed by
// world-space cell and only the 3×3 neighbourhood around the query is tested.
const CELL = 8; // metres
const buckets = new Map();
const cellKey = (x, z) => `${Math.floor(x / CELL)},${Math.floor(z / CELL)}`;

function bucketAdd(id, entry) {
  // an OBB can straddle cells — register in every cell its footprint touches
  const { obj, box } = entry;
  const s = obj.scale?.x || 1; // imports land wrong-sized and get resized in-world
  const r = Math.max(
    Math.abs(box.min.x), Math.abs(box.max.x),
    Math.abs(box.min.z), Math.abs(box.max.z),
  ) * s;
  entry.cells = [];
  const x0 = Math.floor((obj.position.x - r) / CELL), x1 = Math.floor((obj.position.x + r) / CELL);
  const z0 = Math.floor((obj.position.z - r) / CELL), z1 = Math.floor((obj.position.z + r) / CELL);
  for (let cx = x0; cx <= x1; cx++) {
    for (let cz = z0; cz <= z1; cz++) {
      const k = `${cx},${cz}`;
      if (!buckets.has(k)) buckets.set(k, new Set());
      buckets.get(k).add(id);
      entry.cells.push(k);
    }
  }
}
function bucketRemove(id, entry) {
  for (const k of entry?.cells ?? []) {
    const s = buckets.get(k);
    if (s) { s.delete(id); if (!s.size) buckets.delete(k); }
  }
}

const _fray = new THREE.Ray();
// Does this thing contain its OWN floor — a surface you could stand on inside
// it? Rays down from mid-height: a pavilion, a house, a tower all hit their own
// deck; a tree hits nothing but air between its trunk and its canopy.
//
// This is NOT a walkability test (size decides that, see decide). It exists for
// the grass clearing mask, whose question is narrower and answerable: "is there
// a floor here that the meadow should not grow through?"
function hasFloor(bvh, box, s) {
  const midY = (box.min.y + box.max.y) / 2;
  const w = box.max.x - box.min.x, d = box.max.z - box.min.z;
  let hits = 0, n = 0;
  for (let i = 0; i < 4; i++) {
    for (let j = 0; j < 4; j++) {
      // inset to 20%..80% of the footprint: samples hugging the walls would
      // count the walls themselves, and every hollow box would read as floored
      _fray.origin.set(box.min.x + w * (0.2 + 0.2 * i), midY, box.min.z + d * (0.2 + 0.2 * j));
      _fray.direction.set(0, -1, 0);
      n++;
      const hit = bvh.raycastFirst(_fray, THREE.DoubleSide);
      if (!hit) continue;
      // horizontal-ish surfaces only — a wall passing under the ray is not a
      // floor (sign ignored: back-faces of a deck point down)
      const ny = hit.face?.normal?.y;
      if (ny == null || Math.abs(ny) > 0.5) hits++;
    }
  }
  return hits / n >= 0.35;
}

// ---- the uneven-top probe ---------------------------------------------------
// A box collider's top face is the only ground it can ever report, so a box is
// exactly as honest as the top of the thing is flat. For most props that is
// honest enough — a crate lies by 5cm. For a blanket with cushions on it the
// bbox top sits at the tallest cushion, and the whole footprint reads as
// ground at that height: a body walking the bare cloth stands 27cm up in the
// air. Issue #11's three observables — the shove at the rim, the phantom
// mantle offer, the invisible full-footprint ceiling — are all this one lie.
//
// The probe: bucket every vertex into a 24×24 grid over the footprint, keep
// the highest y per cell, and call the LIE the gap between the bbox top and
// the median cell top. One linear pass, no BVH — the BVH is the thing
// decide() is pricing, so the probe must not need one to answer. Surveyed
// against a raycast ground truth across the 58-model library plus 8 conjured
// store meshes (tools/collider-survey.ts): inside the floor-shaped population
// the gate below admits, the vertex version tracks raycast to 1.8cm worst
// case and never disagrees about the threshold. (Library-wide it drifts up to
// 2.5m on tall structured things — a watchtower, a perimeter wall — which is
// exactly why the shape gate runs before the probe is consulted.)
// The grid/median math and its constants live in supportclass.js now (#84):
// the headless support pipeline classifies with the SAME module, so the two
// runtimes cannot drift about which box tops lie. This adapter's own job is
// only what a renderer can do — walking loaded THREE meshes for vertices.
export function topLie(obj, box) {   // exported for the classifier-parity fixture (#94 B2)
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

/** `fresh` marks a pristine-clone fit (see the lib-cache header): only those
 *  may WRITE the shared derivations; refits and step-out re-fits read only. */
function decide(entry, s, fresh = false) {
  const { box, pref } = entry;
  // SIZE decides walkability — with one exception below.
  //
  // This used to also require the thing be "hollow" — nothing within 0.9m of
  // its bounding-box centre — to keep a tree's canopy from becoming a walkable
  // room. But that probe cannot tell a trunk from anything else standing in the
  // middle of an open structure, so it failed every bell tower, pavilion,
  // gazebo and colonnade we have: bell2 is a 214m² pavilion with its bell
  // hanging 0.20m from the centre, and it read as solid rock. A rule that
  // excludes real buildings to exclude trees is the wrong rule; trees are
  // handled where they actually cause harm (the grass mask below), and a
  // per-object `collide` override still wins over any of it.
  const w = (box.max.x - box.min.x) * s, d = (box.max.z - box.min.z) * s;
  const h = (box.max.y - box.min.y) * s;
  // shape gates come from the shared classifier (supportclass.js) — the
  // numbers below in the comments are ITS constants, kept in one place
  const { roomScale } = decideSupportClass({ w, d, h });
  // The exception: FLOOR-SHAPED things whose box top is a lie. Wide enough to
  // stand on, low enough that standing on it is the only thing a body would
  // ever do with it — a blanket, a rug, a pillow pile — and with a real gap
  // between the box top and where the surface actually is. Those collide
  // exact, because the box's one flat top is the bug (issue #11).
  //
  // The numbers come from the survey, not taste. Footprint ≥ 2m²: smaller and
  // nobody walks on it. Lie > 0.10m: below that the box is honest enough (a
  // crate reads 0.05). Height ≤ 1.0m: every gate from 0.6 to 1.0 reclassifies
  // exactly ONE object across 66 surveyed (the blanket); 1.2 pulls in nine
  // more — both rubble piles (which float you 0.73m and 0.44m, worse than the
  // blanket), five hovercars, a shark. If those should firm up too, this is
  // the one line to move.
  // shape gates from the shared classifier (upstream supportclass.js — the
  // same thresholds the headless side mirrors); the lie probe keeps the
  // fork's per-LIB sharing: it is local-space and scale-free (the gate
  // applies `s` below), so one per-vertex walk per LIB answers for every
  // clone, and nothing pays for the probe unless the shape gate consults it
  const { floorShaped } = decideSupportClass({ w, d, h });
  const shared = entry.lib ? libCache.get(entry.lib) : null;
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
      if (built) {
        // hasFloor reads only the local bvh + local box (its `s` is unused):
        // the verdict rides the shared product instead of re-raycasting 16
        // times per clone — same inputs, same boolean, computed once
        built.interior = hasFloor(built.bvh, box, s);
        if (shared && fresh) shared.exact = built;
      }
      entry.exact = built;
    }
  }
  if (!exact) entry.exact = null;         // small/solid: use pillar/box, no trimesh
  entry.pillar = !entry.exact && (box.max.y - box.min.y) * s > 2.4;
  // Clearing is a SEPARATE question from collision: a palm is now exact (you
  // walk under the fronds and bump the trunk, which is right), but stamping its
  // canopy footprint into the grass mask would leave a bald ring under every
  // tree. Only things with a real floor suppress the meadow.
  entry.interior = entry.exact ? entry.exact.interior : false;
}

/** `lib` opts in to the per-lib shared derivations — pass it ONLY for a
 *  pristine clone (see the lib-cache header; models.js's promote tail is the
 *  one caller). `localFrame` computes the box in the root-local frame at any
 *  current transform — required when fitting after the spawn transform landed
 *  (the promote tail); legacy callers fit at identity and keep setFromObject. */
export function fitCollider(id, obj, { collide, scale = 1, lib = null, localFrame = false } = {}) {
  const box = localFrame ? localBox(obj) : new THREE.Box3().setFromObject(obj);
  if (box.isEmpty()) return;
  removeCollider(id);   // a re-fit REPLACES: drop the old entry's bucket cells + lib ref
  // camGhost hoisted from userData so the camera query never touches the
  // object graph (the flag lives on roots: gizmos, placeholders)
  const entry = { obj, box, pref: collide, pillar: false, exact: null, cells: [],
    camGhost: !!obj.userData?.noCamCollide, lib };
  if (lib) {
    const c = libCache.get(lib) ?? { refs: 0 };
    c.refs++;
    libCache.set(lib, c);
  }
  decide(entry, scale, Boolean(lib));
  colliders.set(id, entry);
  bucketAdd(id, entry);
}

/** Register a support collider from DATA rather than a loaded mesh — the
 *  headless door (issue #17). An agent process has no geometry to fit, but the
 *  server's /geom summary gives it bboxes and floor decks; this turns one of
 *  those into the same entry shape resolveColliders already walks, minus
 *  everything that needs triangles. Deliberately NOT decide(): the exact and
 *  uneven-top probes raycast real meshes. A data box is always pref 'box' —
 *  honest boxes only. Walls of room-scale interiors stay a browser-side
 *  concern; headless registers their floor decks as thin slabs instead, so a
 *  settling body finds support without the pavilion sealing into a block.
 *  `min`/`max` are the entity's LOCAL frame, like fitCollider's box. */
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
  // same rule decide() applies to non-exact entries: tall small-footprint
  // things collide as a slim centre pillar, not their canopy extents
  entry.pillar = (box.max.y - box.min.y) * scale > 2.4;
  colliders.set(id, entry);
  bucketAdd(id, entry);
}

/** Register HEIGHTFIELD support from a served topGrid — the headless door
 *  for floor-shaped assets whose box top is a known lie (#84; the data-tier
 *  sibling of fitSupportBox, #17's door). The grid is the same 24×24
 *  max-y-per-cell probe decide() trusts to DETECT the lie, surveyed to
 *  1.8cm against raycast inside this population — so here it IS the floor.
 *  Cells are model-local; the entry composes with the entity transform like
 *  every other collider. Support only: a blanket has no walls.
 *  Returns false (registering nothing) for any payload validTopGrid
 *  refuses — the caller's duty on refusal is to abstain, never box-top. */
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
  colliders.set(id, entry);
  bucketAdd(id, entry);   // radial footprint: the world bounds follow yaw and scale
  return true;
}

// ---- declared structure boxes -----------------------------------------------
// A griddled building (client/lib/structure_field.js) is the one case where the
// collider does not have to be INFERRED: the generator knows exactly what it
// built, so it declares its boxes and decide() never runs. That matters more
// than it saves. decide()'s comment above records that its earlier "hollow"
// probe "failed every bell tower, pavilion, gazebo and colonnade we have" —
// architecture is precisely the population where guessing a shape back out of a
// bounding box has already lost once. Declaring sidesteps the whole question,
// and takes the sync BVH build out of the spawn path with it.
//
// Two things are deliberately NOT inherited from fitSupportBox:
//  - the pillar rule (`h > 2.4` → a 0.5m centre post so you can walk under a
//    canopy). A 2.8m wall is exactly that tall and is emphatically not a post;
//    applied here it would make every building walk-through-able.
//  - `interior`. That flag is overloaded: flora reads it to clear grass, while
//    physobj and both ragdoll engines read it to SKIP the entry (its box being
//    a known lie for room-scale meshes). A declared slab's box is not a lie, so
//    wearing `interior` would make bodies fall through the floor. The grass
//    mask instead gets its own footprint-shaped entry carrying `mask`, which
//    every query path skips and only flora consumes.
const structureIds = new Map(); // owner entity id -> synthetic collider ids

/** Register a building's boxes. `boxes` are grid-LOCAL metres (the entity's own
 *  frame, like every other collider's box); the entity transform composes at
 *  query time exactly as it does for a fitted mesh. Each box becomes its own
 *  entry so the spatial hash keeps doing real work — a query at one corner of a
 *  house tests the few boxes in its 3×3 neighbourhood, not all of them. */
export function fitStructureBoxes(ownerId, boxes, { position, yaw = 0, scale = 1 } = {}) {
  removeStructureBoxes(ownerId);
  if (!Array.isArray(boxes) || !boxes.length) return 0;
  if (!Array.isArray(position) || position.length !== 3 || !position.every(Number.isFinite)) return 0;
  if (!Number.isFinite(yaw) || !Number.isFinite(scale) || !(scale > 0)) return 0;
  const obj = {
    position: new THREE.Vector3(position[0], position[1], position[2]),
    rotation: { y: yaw },
    scale: new THREE.Vector3(scale, scale, scale),
  };
  const ids = [];
  let lo = null, hi = null;
  for (const b of boxes) {
    if (![b?.x0, b?.y0, b?.z0, b?.x1, b?.y1, b?.z1].every(Number.isFinite)) continue;
    const box = new THREE.Box3(
      new THREE.Vector3(Math.min(b.x0, b.x1), Math.min(b.y0, b.y1), Math.min(b.z0, b.z1)),
      new THREE.Vector3(Math.max(b.x0, b.x1), Math.max(b.y0, b.y1), Math.max(b.z0, b.z1)),
    );
    if (box.isEmpty()) continue;
    const id = `${ownerId}#s${ids.length}`;
    // `structOwner` keeps the entity recoverable from a synthetic id — anything
    // that needs to know WHOSE wall it hit can ask, without parsing the key.
    const kind = b.kind ?? 'wall';
    const entry = { obj, box, pref: 'box', exact: null, interior: false, pillar: false,
      // floors hold you up; they never push you sideways (see resolveColliders)
      support: kind === 'floor', cells: [], structOwner: ownerId, structKind: kind };
    colliders.set(id, entry);
    bucketAdd(id, entry);
    ids.push(id);
    lo = lo ? lo.min(box.min) : box.min.clone();
    hi = hi ? hi.max(box.max) : box.max.clone();
  }
  // The grass mask: one footprint-shaped, non-colliding entry. Rectangular
  // (flora paints a rect from the bbox), so an L-shaped building clears a
  // little more meadow than it covers — visible only as tidiness, and cheaper
  // than teaching the mask about cells.
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

/** Drop every box a building registered. Idempotent — the realizer calls it on
 *  retire and again at the head of every re-fit. */
export function removeStructureBoxes(ownerId) {
  const ids = structureIds.get(ownerId);
  if (!ids) return;
  for (const id of ids) removeCollider(id);
  structureIds.delete(ownerId);
}

/** The synthetic ids a building currently owns — the realizer's ownership
 *  check, and the debug overlay's way to colour a building's boxes together. */
export const structureBoxIds = (ownerId) => structureIds.get(ownerId) ?? [];

/** Call after an in-world rescale: re-decides exact-vs-box against the NEW
 *  size (a dollhouse import scaled to a building becomes walkable-inside)
 *  and re-buckets with the scaled footprint. */
export function refitCollider(id) {
  const e = colliders.get(id);
  if (!e) return;
  bucketRemove(id, e);
  decide(e, e.obj.scale?.x || 1);
  bucketAdd(id, e);
}
export function removeCollider(id) {
  const e = colliders.get(id);
  if (e) {
    bucketRemove(id, e);
    if (e.lib) {
      const c = libCache.get(e.lib);
      // zero refs: no resident entity wears this lib's derivations — drop
      // the CPU-side geometry + BVH for GC (demote/delete land here)
      if (c && --c.refs <= 0) libCache.delete(e.lib);
    }
  }
  colliders.delete(id);
}
/** Call after moving an entity so its bucket registration follows it. */
export function reindexCollider(id) {
  const e = colliders.get(id);
  if (!e) return;
  bucketRemove(id, e);
  bucketAdd(id, e);
}

/** Where a thing VISIBLY is: the collider box's world-space center. An
 *  entity's origin is wherever its GLB author left it — the barrels group
 *  ships its cluster 1.95m off origin (§24t-4), so anything that measures
 *  "where the thing is" by obj.position aims at empty air two metres from
 *  the mesh. Same composition as the walking/camera queries and the debug
 *  overlay: local box center × per-axis scale, rotated by yaw, + position.
 *  Returns null when the id has no collider. */
const _ecV = new THREE.Vector3();
export function entityWorldCenter(id, out = new THREE.Vector3()) {
  const c = colliders.get(id);
  const obj = c?.obj;
  if (!c?.box || !obj) return null;
  const sc = obj.scale ?? _ecV.set(1, 1, 1);
  out.copy(c.box.min).add(c.box.max).multiplyScalar(0.5)
    .multiply(_ecV.set(sc.x || 1, sc.y || 1, sc.z || 1))
    .applyAxisAngle(UP, obj.rotation?.y ?? 0)
    .add(obj.position);
  return out;
}

function* near(x, z) {
  const cx = Math.floor(x / CELL), cz = Math.floor(z / CELL);
  for (let i = -1; i <= 1; i++) {
    for (let j = -1; j <= 1; j++) {
      const s = buckets.get(`${cx + i},${cz + j}`);
      if (!s) continue;
      for (const id of s) {
        const e = colliders.get(id);
        if (e) yield e;
      }
    }
  }
}

/** Variable-radius neighbourhood, [id, entry] pairs — the promoted service
 *  query (§14.2 6a). The 3×3 `near` above caps at ~8m; seat search reaches
 *  30 and physics wants its own radius. Dedupes ids that straddle cells.
 *  ⚠️ NOT REENTRANT: the dedupe Set is shared (zero-alloc per query), so a
 *  loop body iterating this generator must never start a second
 *  nearColliders iteration — take a different scratch or collect first. */
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
        if (e) yield [id, e];
      }
    }
  }
}

// ---- camera segment query (§14.2 6a — hot-path offender #1) -----------------
// The follow camera used to raycast recursively into EVERY MESH of EVERY
// entity, three allocations per frame, to learn one number: how far back it
// may sit. This answers the same question from the grid: candidate ids from
// the cells the ≤6m segment overlaps, then per entry a slab test against the
// OBB (world→local is sub(pos), rotY(−yaw), ÷scale — the same transform
// surfaceUnder uses) — except exact entries, which raycast their BVH so the
// camera still slides through a doorway instead of bumping the pavilion's
// bounding box, and pillars, which test the walking post so a tree's canopy
// box doesn't yank the camera the way its sparse meshes never did.

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
  return t0;   // 0 when the origin starts inside — a solid box is solid
}

/** Nearest blocking distance along origin+dir, within `far`; null = clear.
 *  camGhost entries (gizmos, placeholders) never block. */
export function raySegment(origin, dir, far, excludeId = null) {
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
        if (id === excludeId || _rsSeen.has(id)) continue;
        _rsSeen.add(id);
        const e = colliders.get(id);
        if (!e || (excludeId != null && e.structOwner === excludeId) || e.camGhost || e.mask || !e.box) continue;
        const o = e.obj;
        const s = o.scale?.x || 1;
        const yaw = o.rotation?.y ?? 0;
        _rsO.copy(origin).sub(o.position);
        _rsD.copy(dir);
        if (yaw) { _rsO.applyAxisAngle(UP, -yaw); _rsD.applyAxisAngle(UP, -yaw); }
        _rsO.divideScalar(s);
        const lfar = Math.min(far, bestT) / s;
        if (e.exact?.bvh) {
          _rsRay.origin.copy(_rsO);
          _rsRay.direction.copy(_rsD);
          const hit = e.exact.bvh.raycastFirst(_rsRay, THREE.DoubleSide);
          if (hit && hit.distance <= lfar) bestT = hit.distance * s;
          continue;
        }
        let box = e.box;
        if (e.pillar) {
          const mx = (e.box.min.x + e.box.max.x) / 2, mz = (e.box.min.z + e.box.max.z) / 2;
          _rsPost.min.set(mx - 0.25, e.box.min.y, mz - 0.25);
          _rsPost.max.set(mx + 0.25, e.box.max.y, mz + 0.25);
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

const _local = new THREE.Vector3();
const _push = new THREE.Vector3();
const _exits = [
  { d: 0, x: 1, z: 0 }, { d: 0, x: -1, z: 0 },
  { d: 0, x: 0, z: 1 }, { d: 0, x: 0, z: -1 },
];

/** Push `pos` out of anything solid and return the ground height under it.
 *  Mutates pos.x/pos.z — never pos.y; placing the body vertically is the
 *  caller's job, and `r` is a HORIZONTAL radius (a vertical cylinder, not a
 *  sphere). `terrainAt` supplies the base ground. `tall` is how far the body
 *  extends ABOVE pos.y: 1.9 for an avatar standing on its feet, a couple of
 *  centimetres for a single ragdoll joint. It decides what you can pass
 *  underneath, and it scales the step-up and wall-probe heights, which were
 *  constants tuned for a standing human and wildly wrong for a wrist. */
const _ray = new THREE.Ray();
const _hip = new THREE.Vector3();
const _cp = {};

export function resolveColliders(pos, terrainAt, r = 0.32, tall = TALL) {
  blockedTop = null;
  let ground = terrainAt(pos.x, pos.z);
  // Everything below is written for a body of SOME height standing at `pos`.
  // The avatar is a 1.9m capsule on its feet; a ragdoll joint is a 3cm bead.
  // Sharing one routine between them means the vertical numbers cannot be
  // constants — a 55cm step-up allowance applied to a hand teleports it onto
  // the nearest crate, and a hip-height wall probe applied to a wrist lying on
  // the floor measures the wall a metre above the wrist.
  const step = Math.min(STEP, tall * 0.3);   // a ragdoll does not climb stairs
  const probeY = Math.min(HIP, tall * 0.5);  // mid-body, not "hip"
  const spanY = Math.max(r, tall * 0.26);    // how far up/down a wall hit counts
  for (const { obj, box, pillar, exact, grid, mask, support } of near(pos.x, pos.z)) {
    if (mask) continue;   // a grass-mask footprint is not a solid (see fitStructureBoxes)
    if (support) {
      // A DECLARED FLOOR IS SUPPORT, NEVER AN OBSTACLE — the same contract the
      // heightfield branch below keeps, for the same reason.
      //
      // The generic box path treats a box as floor only within 8cm of its top
      // (`pos.y >= topY - 0.08`), because for an INFERRED collider that
      // tolerance is the only thing separating a doorstep from a crate. A
      // 10cm foundation slab misses it by 2cm and becomes a wall: the body
      // standing on it gets ejected horizontally out of its own building.
      // Shrinking the slab under the tolerance would "work" while making the
      // floor's thickness hostage to a constant in another file. A declared
      // floor doesn't need the heuristic — it knows what it is.
      const ss = obj.scale?.x || 1;
      _local.set(pos.x - obj.position.x, 0, pos.z - obj.position.z)
        .applyAxisAngle(UP, -obj.rotation.y).divideScalar(ss);
      if (_local.x > box.min.x && _local.x < box.max.x
          && _local.z > box.min.z && _local.z < box.max.z) {
        const topY = obj.position.y + box.max.y * ss;
        if (topY <= pos.y + step && topY > ground) ground = topY;
      }
      continue;
    }
    if (grid) {
      // Heightfield support (#84): the CONTAINING cell's max-y is the ground
      // — nearest occupied cell, piecewise-constant, no interpolation. An
      // empty cell offers NOTHING: bilinear smoothing would bridge air and
      // manufacture floors, so stepping off the cloth's edge finds terrain,
      // exactly as the browser's exact triangles would have it.
      const gs = obj.scale?.x || 1;
      _local.set(pos.x - obj.position.x, 0, pos.z - obj.position.z)
        .applyAxisAngle(UP, -obj.rotation.y).divideScalar(gs);
      const gx = Math.floor(((_local.x - grid.minX) / grid.w) * grid.n);
      const gz = Math.floor(((_local.z - grid.minZ) / grid.d) * grid.n);
      if (gx >= 0 && gx < grid.n && gz >= 0 && gz < grid.n) {
        const top = grid.tops[gz * grid.n + gx];
        if (top !== null) {
          const gy = obj.position.y + top * gs;
          if (gy <= pos.y + step && gy > ground) ground = gy;
        }
      }
      continue; // support only — never box-test a grid entry (no false walls)
    }
    if (exact) {
      // work in entity-local space (yaw-only rotation, uniform scale)
      const s = obj.scale.x || 1;
      _local.set(pos.x - obj.position.x, 0, pos.z - obj.position.z)
        .applyAxisAngle(UP, -obj.rotation.y).divideScalar(s);
      const localY = (pos.y - obj.position.y) / s;
      // floor: nearest surface below the feet (+step allowance) IS the ground
      _ray.origin.set(_local.x, localY + step / s, _local.z);
      _ray.direction.set(0, -1, 0);
      const hit = exact.bvh.raycastFirst(_ray, THREE.DoubleSide);
      if (hit) {
        const gy = obj.position.y + hit.point.y * s;
        if (gy <= pos.y + step && gy > ground) ground = gy;
      }
      // walls: closest triangle to a mid-body probe pushes the capsule out
      _hip.set(_local.x, localY + probeY / s, _local.z);
      const res = exact.bvh.closestPointToPoint(_hip, _cp);
      if (res) {
        const dx = (_hip.x - res.point.x) * s, dz = (_hip.z - res.point.z) * s;
        const dy = Math.abs(_hip.y - res.point.y) * s;
        const dh = Math.hypot(dx, dz);
        if (dh < r && dy < spanY && dh > 1e-6) {
          _push.set(dx / dh, 0, dz / dh).applyAxisAngle(UP, obj.rotation.y)
            .multiplyScalar(r - dh);
          pos.x += _push.x; pos.z += _push.z;
        }
      }
      continue; // never box-test an exact entity — that would seal interiors
    }
    const bs = obj.scale?.x || 1;
    _local.set(pos.x - obj.position.x, 0, pos.z - obj.position.z)
      .applyAxisAngle(UP, -obj.rotation.y).divideScalar(bs);
    const br = r / bs;
    let minX = box.min.x, maxX = box.max.x, minZ = box.min.z, maxZ = box.max.z;
    if (pillar) {
      const cx = (minX + maxX) / 2, cz = (minZ + maxZ) / 2;
      minX = cx - 0.25; maxX = cx + 0.25; minZ = cz - 0.25; maxZ = cz + 0.25;
    }
    if (_local.x < minX - br || _local.x > maxX + br || _local.z < minZ - br || _local.z > maxZ + br) continue;
    const topY = obj.position.y + box.max.y * bs;
    // Are we UNDER it? Nothing here ever read box.min.y, so every box was an
    // infinite column reaching down to the world floor: a mezzanine slab
    // modelled at y 2.4-2.7 shoved a walking avatar 2.3m sideways at ground
    // level, and a tabletop ejected anything that tried to lie beneath it.
    // The `pillar` heuristic was the only way anything was ever passable
    // underneath, which is why trees worked and archways did not.
    const bottomY = obj.position.y + box.min.y * bs;
    if (pos.y + tall <= bottomY) continue;
    if (pos.y >= topY - 0.08) {
      // at/above the top: the box is floor, not wall
      if (_local.x > minX && _local.x < maxX && _local.z > minZ && _local.z < maxZ) {
        ground = Math.max(ground, topY);
      }
      continue;
    }
    // inside the (radius-expanded) footprint below the top: push out the
    // nearest face
    _exits[0].d = (maxX + br) - _local.x;
    _exits[1].d = _local.x - (minX - br);
    _exits[2].d = (maxZ + br) - _local.z;
    _exits[3].d = _local.z - (minZ - br);
    let best = _exits[0];
    for (let i = 1; i < 4; i++) if (_exits[i].d < best.d) best = _exits[i];
    // Grazing the UNDERSIDE of an overhang is not walking into its side, and
    // exiting through the nearest vertical face regardless is how a head
    // brushing a mezzanine by 1.3cm got flung 1.6m sideways, clear of a 3m
    // slab's whole footprint — on a room-sized one it is tens of metres.
    //
    // Two things must hold before we decline the push. There must BE a down:
    // a crate sitting on the floor has its underside at ground level, so no
    // amount of "you could go under it" is true and it must still push you
    // sideways. And the overlap must be a GRAZE rather than "I do not fit" —
    // a waist-high counter overlaps a standing body by most of a metre, and
    // waving that through would let the avatar phase through it at chest
    // height. Note that "the shortest way out is down" is NOT the test: for
    // any large slab the sideways exit is metres away, so down always wins and
    // everything becomes passable.
    if (bottomY > ground + 0.05
        && (pos.y + tall) - bottomY <= Math.max(0.05, tall * 0.08)) continue;
    _push.set(best.x, 0, best.z).applyAxisAngle(UP, obj.rotation.y).multiplyScalar(best.d * bs);
    pos.x += _push.x; pos.z += _push.z;
    // pillars aren't mantleable — and neither is anything, to a body that
    // cannot climb. The ragdoll runs this routine once per JOINT per frame;
    // without the height test it would leave the controller's mantle probe
    // holding whichever wrist last brushed a crate. That is harmless only
    // because updateMe does not run while you are down, which is not a
    // guarantee worth resting on.
    if (!pillar && tall >= TALL) blockedTop = topY;
  }
  return ground;
}

// ---- Layer-0 affordances ----------------------------------------------------

/** Nearest sittable surface to a point: a horizontal top at chair-ish height
 *  within `range`. This is DESIGN.md's `seatOn` — no authoring, no metadata,
 *  the geometry IS the affordance. Returns {y, x, z, yaw, id} or null. */
export function findSeat(pos, range = 1.2) {
  let best = null;
  // grid-bounded (§14.2 6a): a chair within `range` has its footprint cells
  // inside the query disc — the old full-map scan ran on every X press and
  // the 0.45s seat-hint beat
  for (const [id, { obj, box, pillar, exact, grid, mask }] of nearColliders(pos.x, pos.z, range)) {
    if (mask) continue;
    if (pillar || exact) continue; // interiors aren't chairs; furniture inside them is
    if (grid) continue; // a heightfield's box top is the lie we exist to avoid — no phantom seat offers (#11)
    const sc = obj.scale?.x || 1;
    const topY = obj.position.y + box.max.y * sc;
    const rise = topY - pos.y;
    if (rise < 0.25 || rise > 0.85) continue;            // not seat height
    // centre of the top face, in world space
    _local.set((box.min.x + box.max.x) / 2 * sc, 0, (box.min.z + box.max.z) / 2 * sc)
      .applyAxisAngle(UP, obj.rotation.y);
    const cx = obj.position.x + _local.x, cz = obj.position.z + _local.z;
    const d = Math.hypot(cx - pos.x, cz - pos.z);
    if (d > range) continue;
    if (!best || d < best.d) best = { d, id, x: cx, z: cz, y: topY, yaw: obj.rotation.y };
  }
  return best;
}

/** Highest surface directly under a point — what a dropped object lands on.
 *  This is what makes "put the mug ON the table" work instead of the mug
 *  sinking to y=0 beside it. */
export function surfaceUnder(x, z, terrainAt, maxY = Infinity, skipId = null) {
  let y = terrainAt(x, z);
  let onto = null;
  // a surface UNDER the point must have its footprint over the point — the
  // point's own cell holds every such entry (grid-bounded, §14.2 6a)
  for (const [id, { obj, box, pillar, exact, mask }] of nearColliders(x, z, 0.5)) {
    if (pillar || mask || id === skipId) continue;
    if (exact) {
      // dropped things land on the actual surface (stair tread, mezzanine)
      const s = obj.scale.x || 1;
      _local.set(x - obj.position.x, 0, z - obj.position.z)
        .applyAxisAngle(UP, -obj.rotation.y).divideScalar(s);
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
    _local.set(x - obj.position.x, 0, z - obj.position.z).applyAxisAngle(UP, -obj.rotation.y).divideScalar(sc2);
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
