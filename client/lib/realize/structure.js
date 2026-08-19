// structure — the griddled-building realizer (TEL0S_NOTES §11.4).
//
// Projects every entity carrying a `structure` component into the scene: merged
// geometry through the material factory, declared boxes into the collider hash,
// and nothing else. The thinking half is shared/structure.js, which is
// pure and headless-tested; this file is the hosted half that executes its plan.
//
// WHOLESALE REBUILD, ON PURPOSE. A building's geometry is rebuilt from scratch
// whenever its component changes — no incremental patching of walls. Buildings
// are edited rarely and rendered constantly, a rebuild is a few hundred boxes,
// and a full rebuild cannot drift from the folded state the way an incremental
// patch can. That is the same trade `reconcile ∘ reconcile = reconcile` asks for
// one level up, taken one level down.
//
// MERGED, NOT INSTANCED — for now. One merged BufferGeometry per palette
// material gives one draw call per material per building, which is the win that
// matters at this scale, and it is markedly simpler than InstancedMesh (whose
// per-instance transforms buy nothing for geometry that never moves relative to
// its building). Instancing becomes worth it when a world holds dozens of
// buildings sharing one kit; client/lib/flora.js is the in-tree precedent for
// that day. Nothing outside this file addresses a wall as an Object3D, which is
// exactly what keeps that swap a private matter.
//
// TOPOLOGY IS BORN AT INIT. The palette below is created once, at module load,
// and every building indexes into it. This is the lightrig.js/materials.js
// doctrine restated: r184 keys its pipeline cache on material graph identity,
// upstream's rewrap-after-the-fact measured 44 rewraps at 2–6s each on one
// Safari join, and a runtime light-topology flip measured 388–1523ms frames. A
// building that minted a fresh node graph per style would hitch the whole scene
// every time somebody painted a wall. Style is an INDEX and a uniform, never a
// new graph.

import { THREE, TSL, scene, bus, report } from '../core.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { state, onWorldChange } from '../state.js';
import { prepareObject } from '../materials.js';
import { fitStructureBoxes, removeStructureBoxes } from '../colliders.js';
import { entities } from '../world.js';
import { planStructure, makeShader } from '../../shared/structure.js';

// PROCEDURAL, NOT TEXTURED. Surface detail is computed in the shader from
// grid-local position, which buys three things this stack specifically needs:
// zero texture bytes (there is no KTX2 encoder on either box, and texture
// memory is the profiled frame-budget eater at 1.19GB), tiling that never
// visibly repeats at any scale, and a style that costs a few uniforms in an
// 8KB component instead of megabytes in the store.
//
// Every graph below is built ONCE, here, at module load. Style must never mint
// a new graph at runtime — that is the same hazard class as a light-topology
// flip, and it is why the palette is a fixed set of slots.
const {
  positionLocal, attribute, vec3, float, floor: tslFloor, fract, abs: tslAbs,
  smoothstep, mx_noise_float, mx_fractal_noise_float,
} = TSL;

/** The baked AO/daylight term. Setting colorNode REPLACES the default colour
 *  path, vertex colours included, so it has to be multiplied back in by hand —
 *  forgetting this silently throws away every bit of the shading bake. */
const baked = () => attribute('color', 'vec3');

const fbm = (p, oct = 3) => mx_fractal_noise_float(p, oct, 2.0, 0.5).mul(0.5).add(0.5);

/** Plaster: broad patchiness plus a fine tooth. Nothing dramatic — the job is
 *  to stop a 4m wall being one flat value, not to look like a photograph. */
function plaster(base) {
  const p = positionLocal;
  return base
    .mul(float(0.93).add(fbm(p.mul(0.55)).mul(0.10)).add(fbm(p.mul(6.5), 2).mul(0.05)))
    .mul(baked());
}

/** Boards: planks along X, each with its own tone, darkening into the seams. */
function boards(base) {
  const p = positionLocal;
  const u = p.x.div(0.185);
  const seam = tslAbs(fract(u).sub(0.5)).mul(2.0);
  const groove = smoothstep(0.80, 1.0, seam).mul(0.30);
  const tone = mx_noise_float(vec3(tslFloor(u).mul(0.37), 0.0, 0.0)).mul(0.5).add(0.5);
  const grain = fbm(vec3(p.x.mul(2.0), p.y, p.z.mul(20.0)), 2);
  return base
    .mul(float(0.86).add(tone.mul(0.20)).add(grain.mul(0.06)).sub(groove))
    .mul(baked());
}

/** Painted woodwork: almost flat, a whisper of unevenness so it isn't plastic. */
function painted(base) {
  return base.mul(float(0.96).add(fbm(positionLocal.mul(3.0), 2).mul(0.06))).mul(baked());
}

/** ⚠️ `vec3(0xe4ded1)` is NOT a colour — it is a vec3 of the integer 14999249,
 *  and every surface in the building renders blown-out white. The hex has to be
 *  decoded through THREE.Color first, which also lands it in the renderer's
 *  working colour space rather than raw sRGB bytes. */
const lit = (hex, roughness, node) => {
  const c = new THREE.Color(hex);
  const m = new THREE.MeshStandardNodeMaterial({ color: hex, roughness, metalness: 0 });
  m.colorNode = node(vec3(c.r, c.g, c.b));
  return m;
};

const PALETTE = {
  wall: lit(0xe4ded1, 0.94, plaster),    // warm plaster
  floor: lit(0xa8814f, 0.80, boards),    // boards
  trim: lit(0xf2efe8, 0.62, painted),    // painted woodwork, lighter than the wall
  roof: lit(0x6d6257, 0.90, plaster),
  glass: new THREE.MeshPhysicalNodeMaterial({
    color: 0xcfe2e8, roughness: 0.06, metalness: 0,
    transparent: true, opacity: 0.22, side: THREE.DoubleSide,
  }),
};

/** Which palette slot a part wears. The plan names a structural `kind` and an
 *  author `mat`; author intent wins where it names a real slot, role decides
 *  otherwise — which is the seam a style catalog plugs into without adding
 *  palette members, since adding members is the part that costs a recompile. */
function slotFor(part) {
  if (PALETTE[part.mat]) return part.mat;
  if (part.kind === 'floor') return 'floor';
  if (part.kind === 'roof') return 'roof';
  if (part.kind === 'glass') return 'glass';
  if (part.kind === 'corner') return 'wall';
  if (part.kind === 'base' || part.kind === 'case' || part.kind === 'sill'
    || part.kind === 'lintel') return 'trim';
  return 'wall';
}

/** Bake the analytic AO/daylight term into a merged geometry's vertex colours.
 *
 *  Pure function of position and normal, so adjacent boxes that meet at a face
 *  agree exactly and the shading is continuous across them without any welding
 *  or shared vertices. BoxGeometry keeps four vertices per face with true
 *  per-face normals, which is precisely what lets one wall's inside read dark
 *  while its outside reads sunlit. */
function paintGeometry(geo, shade) {
  const pos = geo.getAttribute('position'), nor = geo.getAttribute('normal');
  const col = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    const c = shade(pos.getX(i), pos.getY(i), pos.getZ(i),
      nor.getX(i), nor.getY(i), nor.getZ(i));
    col[i * 3] = c[0]; col[i * 3 + 1] = c[1]; col[i * 3 + 2] = c[2];
  }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
}

const tracked = new Map(); // entity id -> { group, sig, geoms: BufferGeometry[] }
let cutaway = false;

/** Hide every roof while building. Idempotent, and applied to buildings that
 *  appear DURING the mode as well as those already standing. */
export function setCutaway(on) {
  cutaway = !!on;
  for (const t of tracked.values()) {
    t.group.traverse((o) => { if (o.userData?.structRoof) o.visible = !cutaway; });
  }
  return cutaway;
}
export const isCutaway = () => cutaway;

/** The structure component, or null for entities that aren't buildings. */
const structOf = (ent) => (ent?.comp && typeof ent.comp === 'object' ? ent.comp.structure ?? null : null);

const transformOf = (ent) => ({
  position: Array.isArray(ent?.pos) && ent.pos.length === 3 && ent.pos.every(Number.isFinite)
    ? ent.pos : [0, 0, 0],
  yaw: Number.isFinite(ent?.yaw) ? ent.yaw : 0,
  scale: Number.isFinite(ent?.scale) && ent.scale > 0 ? ent.scale : 1,
});

/** Build the scene object for one plan. Geometry only — no scene insertion, no
 *  collider registration, so a throw anywhere in here leaks nothing. */
function buildGroup(plan) {
  const bySlot = new Map();
  for (const lv of plan.levels) {
    const shade = makeShader(lv.level, plan.grid, lv.y);
    // Swept walls: geometry built from the wall's own direction, mitred at
    // every turn. Made NON-INDEXED before normals so each profile facet gets a
    // flat normal — shared ring vertices would average the chamfer into a soft
    // roll, and a chamfer that does not catch a hard highlight line is a
    // chamfer nobody can see.
    for (const sw of lv.sweeps ?? []) {
      if (!sw.positions.length) continue;
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(sw.positions, 3));
      geo.setIndex(sw.indices);
      const flat = geo.toNonIndexed();
      geo.dispose();
      flat.computeVertexNormals();
      const slot = PALETTE[sw.mat] ? sw.mat : 'wall';
      if (!bySlot.has(slot)) bySlot.set(slot, []);
      bySlot.get(slot).push({ g: flat, shade });
    }
    for (const b of lv.parts) {
      const w = Math.abs(b.x1 - b.x0), h = Math.abs(b.y1 - b.y0), d = Math.abs(b.z1 - b.z0);
      if (!(w > 0 && h > 0 && d > 0)) continue;
      const boxed = new THREE.BoxGeometry(w, h, d);
      boxed.translate((b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2, (b.z0 + b.z1) / 2);
      // non-indexed like the sweeps: mergeGeometries refuses a mix, and flat
      // normals are what we want on every one of these anyway
      const g = boxed.toNonIndexed();
      boxed.dispose();
      // nothing here samples a texture — the materials are procedural from
      // position — and mergeGeometries refuses a mix of attribute sets
      g.deleteAttribute('uv');
      const slot = slotFor(b);
      if (!bySlot.has(slot)) bySlot.set(slot, []);
      bySlot.get(slot).push({ g, shade });
    }
  }
  const group = new THREE.Group();
  const geoms = [];
  for (const [slot, entries] of bySlot) {
    // paint BEFORE the merge, so every part is shaded by its own level's field
    if (slot !== 'glass') for (const { g, shade } of entries) paintGeometry(g, shade);
    const merged = mergeGeometries(entries.map((e) => e.g), false);
    for (const { g } of entries) g.dispose();   // the merge copied them
    if (!merged) continue;
    const mesh = new THREE.Mesh(merged, PALETTE[slot] ?? PALETTE.wall);
    mesh.castShadow = false;   // still one pipeline at a time — the baked term
    mesh.receiveShadow = true; // is doing the work real shadows would
    // THE CUTAWAY. You cannot lay a floor you cannot see, and a roof is opaque
    // from every angle a builder wants. Sims solves this with walls-down; the
    // cheap and honest version here is to take the lid off while building.
    if (slot === 'roof') { mesh.userData.structRoof = true; mesh.visible = !cutaway; }
    group.add(mesh);
    geoms.push(merged);
  }
  // Through the factory BEFORE the first compile — the whole point of
  // materials.js is that nothing gets wrapped after it has been seen.
  prepareObject(group, { kind: 'model' });
  return { group, geoms };
}

/** Hide the anchor object.
 *
 *  Until a `structure` entity can be spawned without a `lib` (PROTOCOL.md §10 —
 *  the amendment this slice defers on purpose), a building rides an ordinary
 *  spawn, so the models realizer independently makes whatever that lib loads
 *  into. The building's geometry is ours; two objects for one entity is a lie
 *  the inspector would faithfully report.
 *
 *  This must be RE-APPLIED rather than done once. The models realizer creates
 *  its object asynchronously (fetch + parse + compile), so a structure that
 *  realizes first finds no anchor to hide — and the crate then pops into
 *  existence seconds later, inside the house. Found live, not reasoned out. */
function hideAnchor(id) {
  const anchor = entities.get(id);
  if (anchor) anchor.visible = false;
}

function retire(id) {
  // give the anchor back before we stop owning the id
  const anchor = entities.get(id);
  if (anchor) anchor.visible = true;
  const t = tracked.get(id);
  if (!t) return;
  scene.remove(t.group);
  for (const g of t.geoms) g.dispose();     // palette materials are shared: never disposed
  removeStructureBoxes(id);
  tracked.delete(id);
  bus.emit('entity', { id, kind: 'collider' });   // the grass mask loses a clearing
}

/** Create or rebuild one building. Idempotent: same state in, same scene out. */
function realize(id, ent) {
  const data = structOf(ent);
  if (!data) { retire(id); return; }
  const tf = transformOf(ent);
  const sig = JSON.stringify(data);
  const prev = tracked.get(id);

  if (prev && prev.sig === sig) {
    // Geometry is still right; only the pose can have moved. Colliders must be
    // re-declared even so — their boxes are entity-local but their bucket
    // registration is world-space.
    prev.group.position.set(...tf.position);
    prev.group.rotation.y = tf.yaw;
    prev.group.scale.setScalar(tf.scale);
    fitStructureBoxes(id, prev.plan.boxes, tf);
    bus.emit('entity', { id, kind: 'collider' });
    return;
  }

  const plan = planStructure(data);
  const { group, geoms } = buildGroup(plan);
  group.position.set(...tf.position);
  group.rotation.y = tf.yaw;
  group.scale.setScalar(tf.scale);

  if (prev) { scene.remove(prev.group); for (const g of prev.geoms) g.dispose(); }
  scene.add(group);
  tracked.set(id, { group, geoms, sig, plan });
  fitStructureBoxes(id, plan.boxes, tf);

  hideAnchor(id);
  bus.emit('entity', { id, kind: 'collider' });
}

/** The plan a building is currently realized from — the describer's door, and
 *  the reason look() can answer "which room" without touching the scene. */
export const structurePlan = (id) => tracked.get(id)?.plan ?? null;
export const structureIds = () => [...tracked.keys()];

/** Full idempotent pass: hydration, world switch, late enable. */
export function reconcileStructures() {
  const seen = new Set();
  for (const [id, ent] of Object.entries(state.st.entities ?? {})) {
    if (!structOf(ent)) continue;
    seen.add(id);
    try { realize(id, ent); } catch (e) { report(`realize structure ${id}`, e); }
  }
  // tracked but no longer a building (component removed, entity removed)
  for (const id of [...tracked.keys()]) if (!seen.has(id)) retire(id);
}

function onEntry(entry) {
  const { verb, args = {} } = entry;
  const id = args.id;
  if (!id) return;
  try {
    switch (verb) {
      case 'comp':
        // Only our own type matters — but a `structure` comp arriving on an
        // entity we don't track yet is exactly how a building is born.
        if (args.type === 'structure') realize(id, state.st.entities[id]);
        break;
      case 'spawn':
        // A same-id spawn REPLACES the entity wholesale (the fold's documented
        // behaviour), which drops the comp bag with it. Re-deriving from state
        // rather than assuming keeps us honest either way.
        realize(id, state.st.entities[id]);
        break;
      case 'place':
        if (tracked.has(id)) realize(id, state.st.entities[id]);
        break;
      case 'remove':
        retire(id);
        break;
    }
  } catch (e) { report(`realize structure ${verb}`, e); }
}

const PORTED = new Set(['spawn', 'place', 'remove', 'comp']);

/** Wire the realizer to state. Called once from main.js, beside the others. */
export function initStructureRealizer() {
  // The anchor can arrive at any time after we realize — the models realizer
  // announces every object it creates or moves on this bus, which is the only
  // moment we can be sure there is something to hide.
  bus.on('entity', (ev) => {
    if (ev?.id && ev.kind !== 'collider' && tracked.has(ev.id)) hideAnchor(ev.id);
  });
  onWorldChange((ev) => {
    if (ev.type === 'hydrated') reconcileStructures();
    else if (ev.type === 'reset') { for (const id of [...tracked.keys()]) retire(id); }
    else if (ev.type === 'entry' && PORTED.has(ev.entry.verb)) onEntry(ev.entry);
  });
  return true;
}

/** Test/teardown door. */
export function disposeStructures() {
  for (const id of [...tracked.keys()]) retire(id);
}
