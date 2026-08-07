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
import { MeshBVH } from 'three-mesh-bvh';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

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
const LIE_GRID = 24;
function topLie(obj, box) {
  const w = box.max.x - box.min.x, d = box.max.z - box.min.z;
  if (!(w > 0) || !(d > 0)) return 0;
  obj.updateMatrixWorld(true);
  const inv = new THREE.Matrix4().copy(obj.matrixWorld).invert();
  const rel = new THREE.Matrix4();
  const v = new THREE.Vector3();
  const cells = new Float64Array(LIE_GRID * LIE_GRID).fill(-Infinity);
  obj.traverse((o) => {
    if (!o.isMesh || !o.geometry?.attributes?.position) return;
    const pos = o.geometry.attributes.position;
    rel.multiplyMatrices(inv, o.matrixWorld);
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(rel);
      const cx = Math.min(LIE_GRID - 1, Math.max(0, Math.floor(((v.x - box.min.x) / w) * LIE_GRID)));
      const cz = Math.min(LIE_GRID - 1, Math.max(0, Math.floor(((v.z - box.min.z) / d) * LIE_GRID)));
      const k = cz * LIE_GRID + cx;
      if (v.y > cells[k]) cells[k] = v.y;
    }
  });
  const tops = [];
  for (let i = 0; i < cells.length; i++) if (cells[i] !== -Infinity) tops.push(cells[i]);
  if (tops.length < 8) return 0;   // a 4-corner quad covers 4 cells: too sparse to accuse
  tops.sort((a, b) => a - b);
  const h = tops.length >> 1;
  return box.max.y - (tops.length % 2 ? tops[h] : (tops[h - 1] + tops[h]) / 2);
}

function decide(entry, s) {
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
  const roomScale = w * d >= 16 && h >= 2.2;
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
  const floorShaped = !roomScale && w * d >= 2 && h <= 1.0;
  const uneven = floorShaped && (entry.lie ??= topLie(entry.obj, box)) * s > 0.10;
  const exact = pref === 'exact' ? true : pref === 'box' ? false : (roomScale || uneven);
  if (exact && !entry.exact) entry.exact = buildExact(entry.obj);
  if (!exact) entry.exact = null;         // small/solid: use pillar/box, no trimesh
  entry.pillar = !entry.exact && (box.max.y - box.min.y) * s > 2.4;
  // Clearing is a SEPARATE question from collision: a palm is now exact (you
  // walk under the fronds and bump the trunk, which is right), but stamping its
  // canopy footprint into the grass mask would leave a bald ring under every
  // tree. Only things with a real floor suppress the meadow.
  entry.interior = entry.exact ? hasFloor(entry.exact.bvh, box, s) : false;
}

export function fitCollider(id, obj, { collide, scale = 1 } = {}) {
  const box = new THREE.Box3().setFromObject(obj); // obj still at identity here
  if (box.isEmpty()) return;
  const entry = { obj, box, pref: collide, pillar: false, exact: null, cells: [] };
  decide(entry, scale);
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
  if (e) bucketRemove(id, e);
  colliders.delete(id);
}
/** Call after moving an entity so its bucket registration follows it. */
export function reindexCollider(id) {
  const e = colliders.get(id);
  if (!e) return;
  bucketRemove(id, e);
  bucketAdd(id, e);
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
  for (const { obj, box, pillar, exact } of near(pos.x, pos.z)) {
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
  for (const [id, { obj, box, pillar, exact }] of colliders) {
    if (pillar || exact) continue; // interiors aren't chairs; furniture inside them is
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
  for (const [id, { obj, box, pillar, exact }] of colliders) {
    if (pillar || id === skipId) continue;
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
}
