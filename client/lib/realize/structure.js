// structure — the griddled-building realizer (docs/history/TEL0S_NOTES.md §11.4): every entity carrying a
// `structure` component becomes merged geometry through the material factory plus declared boxes in the collider
// hash. The pure half is shared/structure.js; this hosted half executes its plan.
//
// - Wholesale rebuild on any component change: buildings are edited rarely, a rebuild is a few hundred boxes, and it
//   cannot drift from the fold.
// - Merged, not instanced: one draw call per material per building. Instancing pays off with dozens of buildings
//   sharing a kit (flora.js is the precedent); nothing outside this file addresses a wall as an Object3D.
// - Topology is born at init: the palette is created once at module load and style is an index and a uniform, never
//   a new node graph (three's WebGPU renderer keys its pipeline cache on graph identity; a fresh graph hitches).

import { THREE, TSL, scene } from '../core.js';
import { bus, report } from '../base.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { state, onWorldChange } from '../state.js';
import { prepareObject } from '../render/materials.js';
import { fitStructureBoxes, removeStructureBoxes, removeCollider, fitCollider } from '../colliders.js';
import { entities } from '../world.js';
import { planStructure, makeShader } from '../../../shared/structure.js';
import { colliderOf } from '../../../shared/components.js';
import { solidOff } from '../../../shared/protocol/simlayer.js';
import { defsRegistry } from '../defs.js';
import { applyHidden } from './models.js';
import { collisionOwnedElsewhere, offIn } from './models_field.js';
import { transformOf } from './structuretf.js';
import { worldPose, ancestors } from '../../../shared/hierarchy.js';
import { scale3 } from '../../../shared/scale3.js';

// Procedural, not textured: surface detail comes from grid-local position in the shader (zero texture bytes, tiling
// that never visibly repeats). Every graph is built once, here; the palette is a fixed set of slots.
const {
  positionLocal, attribute, vec3, float, floor: tslFloor, fract, abs: tslAbs,
  smoothstep, mx_noise_float, mx_fractal_noise_float,
} = TSL;

/** The baked AO/daylight term. Setting colorNode replaces the default colour path, vertex colours included, so it
 *  is multiplied back in by hand. */
const baked = () => attribute('color', 'vec3');

const fbm = (p, oct = 3) => mx_fractal_noise_float(p, oct, 2.0, 0.5).mul(0.5).add(0.5);

/** Plaster: broad patchiness plus a fine tooth, so a 4 m wall isn't one flat value. */
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

/** `vec3(0xe4ded1)` is not a colour (a vec3 of the integer renders blown-out white): decode through THREE.Color,
 *  which also lands it in the renderer's working colour space. */
const lit = (hex, roughness, node) => {
  const c = new THREE.Color(hex);
  const m = new THREE.MeshStandardNodeMaterial({ color: hex, roughness, metalness: 0 });
  m.colorNode = node(vec3(c.r, c.g, c.b));
  return m;
};

// The palette values are style data: defs/structure/_palette.json overlays these built-in defaults (defs.js). Slots
// and finish nodes stay engine; applyPaletteStyle mutates the live shared materials, so a def edit restyles standing
// buildings on the defs-updated push.
const FINISHES = { plaster, boards, painted };
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

function applyPaletteStyle(style) {
  for (const [slot, s] of Object.entries(style ?? {})) {
    const m = PALETTE[slot];
    if (!m || !s || typeof s !== 'object') continue;   // unknown slots: future members, skipped
    if (s.color != null) m.color.set(s.color);
    if (s.roughness != null) m.roughness = s.roughness;
    if (s.opacity != null && m.transparent) m.opacity = s.opacity;
    if (slot !== 'glass') {
      // the visible colour rides colorNode (see baked()): rebuild it through the chosen finish and recompile
      const c = new THREE.Color(s.color ?? m.color);
      const finish = FINISHES[s.finish]
        ?? (slot === 'floor' ? boards : slot === 'trim' ? painted : plaster);
      m.colorNode = finish(vec3(c.r, c.g, c.b));
      m.needsUpdate = true;
    }
  }
}

/** Which palette slot a part wears: the author's `mat` where it names a real slot, else the structural `kind`. */
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

/** Bake the analytic AO/daylight term into a geometry's vertex colours. A pure function of position and normal, so
 *  boxes meeting at a face shade continuously with no welding. */
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

/** Hide every roof while building. Idempotent; buildGroup applies it to buildings that appear during the mode. */
export function setCutaway(on) {
  cutaway = !!on;
  for (const t of tracked.values()) {
    t.group.traverse((o) => { if (o.userData?.structRoof) o.visible = !cutaway; });
  }
  return cutaway;
}

/** The structure component, or null for entities that aren't buildings. */
const structOf = (ent) => (ent && typeof ent === 'object' ? ent.structure ?? null : null);

function poseGroup(group, tf) {
  group.position.set(...tf.position);
  if (tf.q) group.quaternion.set(...tf.q); else group.rotation.set(0, tf.yaw, 0);
  if (tf.scale3) group.scale.set(...tf.scale3); else group.scale.setScalar(tf.scale);
}

/** Build the scene object for one plan. Geometry only (no scene insertion, no collider registration), so a throw
 *  in here leaks nothing. */
function buildGroup(plan) {
  const bySlot = new Map();
  for (const lv of plan.levels) {
    const shade = makeShader(lv.level, plan.grid, lv.y);
    // swept walls, mitred at every turn: non-indexed before normals so each profile facet gets a flat normal
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
      // non-indexed like the sweeps: mergeGeometries refuses a mix, and flat normals are wanted anyway
      const g = boxed.toNonIndexed();
      boxed.dispose();
      // nothing here samples a texture, and mergeGeometries refuses a mix of attribute sets
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
    // mergeGeometries refuses any disagreement (a stray index, an extra attribute) and drops the whole slot:
    // normalise to one shape, and report a piece that arrives wearing another
    const want = slot === 'glass' ? ['position', 'normal'] : ['position', 'normal', 'color'];
    for (const e of entries) {
      let g2 = e.g;
      if (g2.index) g2 = g2.toNonIndexed();
      for (const name of Object.keys(g2.attributes)) {
        if (!want.includes(name)) g2.deleteAttribute(name);
      }
      const missing = want.filter((n) => !g2.attributes[n]);
      if (missing.length) {
        report(`structure geometry (${slot})`,
          new Error(`piece missing ${missing.join(', ')} — dropped from the merge`));
        e.g = null; continue;
      }
      e.g = g2;
    }
    const usable = entries.filter((e) => e.g);
    const merged = mergeGeometries(usable.map((e) => e.g), false);
    for (const { g } of usable) g.dispose();    // the merge copied them
    if (!merged) continue;
    const mesh = new THREE.Mesh(merged, PALETTE[slot] ?? PALETTE.wall);
    mesh.castShadow = false;   // the baked term does the work real shadows would
    mesh.receiveShadow = true;
    // the cutaway: the roof comes off while building, so you can see the floor you are laying
    if (slot === 'roof') { mesh.userData.structRoof = true; mesh.visible = !cutaway; }
    group.add(mesh);
    geoms.push(merged);
  }
  // through the factory before the first compile (materials.js)
  prepareObject(group, { kind: 'model' });
  return { group, geoms };
}

/** Hide the anchor object: a building rides an ordinary thing, and the models realizer makes an object for it too.
 *  Re-applied on every entity event, not once: that object is created asynchronously and can appear after the
 *  building realizes. */
function hideAnchor(id) {
  const anchor = entities.get(id);
  if (!anchor) return;
  anchor.visible = false;
  // and take its collider: the models realizer fitted a box at spawn, an invisible obstacle at the building's origin.
  // The building's own boxes are keyed <id>#sN; this one is the bare id.
  removeCollider(id);
}

function retire(id) {
  // only a building we realized has an anchor to give back (realize() retires every thing born without a structure)
  const t = tracked.get(id);
  if (!t) return;
  // give the anchor back, mesh and collider, so removing just the `structure` comp leaves an ordinary thing, drawn
  // and solid as the models realizer reads it
  const anchor = entities.get(id);
  if (anchor) {
    applyHidden(id);
    const ent = state.st.entities[id];
    if (!collisionOwnedElsewhere(ent, anchor.userData?.mountedTo)) {
      try { fitCollider(id, anchor, { collide: colliderOf(ent), localFrame: true, scale: anchor.scale?.x || 1 }); }
      catch (e) { report(`structure anchor restore ${id}`, e); }
    }
  }
  scene.remove(t.group);
  for (const g of t.geoms) g.dispose();     // palette materials are shared: never disposed
  removeStructureBoxes(id);
  tracked.delete(id);
  bus.emit('entity', { id, kind: 'collider' });   // the grass mask loses a clearing
}

/** Create or rebuild one building. Idempotent: same state in, same scene out. */
function realize(id, ent) {
  const data = structOf(ent);
  // switched off, itself or up its chain: not drawn, no boxes (models_field offIn)
  if (!data || offIn(state.st.entities ?? {}, id)) { retire(id); return; }
  // under a carrier the fold's pos is the carrier's frame: the group and its boxes take the composed world pose
  const w = ent.parent?.to ? worldPose(state.st.entities, id) : null;
  // collision off for bodies (collider.enabled false, or blocks without bodies): no box a walker meets
  const tf = { ...transformOf(w ? { ...ent, pos: w.pos, q: w.q, scale3: scale3(w.scale) } : ent), solid: !solidOff(ent, 'bodies') };
  const sig = JSON.stringify(data);
  const prev = tracked.get(id);

  if (prev && prev.sig === sig) {
    // geometry is still right; only the pose can have moved. Colliders are re-declared: world-space bucketing.
    poseGroup(prev.group, tf);
    fitStructureBoxes(id, prev.plan.boxes, tf);
    bus.emit('entity', { id, kind: 'collider' });
    return;
  }

  const plan = planStructure(data);
  const { group, geoms } = buildGroup(plan);
  poseGroup(group, tf);

  if (prev) { scene.remove(prev.group); for (const g of prev.geoms) g.dispose(); }
  scene.add(group);
  tracked.set(id, { group, geoms, sig, plan });
  fitStructureBoxes(id, plan.boxes, tf);

  hideAnchor(id);
  bus.emit('entity', { id, kind: 'collider' });
}

export const structureIds = () => [...tracked.keys()];

/** Full idempotent pass: hydration, world switch, late enable. */
function reconcileStructures() {
  const seen = new Set();
  for (const [id, ent] of Object.entries(state.st.entities ?? {})) {
    if (!structOf(ent)) continue;
    seen.add(id);
    try { realize(id, ent); } catch (e) { report(`realize structure ${id}`, e); }
  }
  // tracked but no longer a building (component removed, entity removed)
  for (const id of [...tracked.keys()]) if (!seen.has(id)) retire(id);
}

const carries = (id) => [...tracked.keys()].some((t) => ancestors(state.st.entities, t).includes(id));
function onChange({ id, what, comp }) {
  try {
    switch (what) {
      // a `structure` comp arriving on a thing we don't track yet is exactly how a building is born
      case 'comp': if (comp === 'structure' || (comp === 'collider' && tracked.has(id))) realize(id, state.st.entities[id]);
        else if (comp === 'disabled') reconcileStructures();   // a switch reaches the buildings below it
        break;
      case 'parent': reconcileStructures(); break;   // a move under one reaches the buildings below it (viewdiff.js: its own event)
      // re-derive from state rather than assume (a re-born thing may have dropped its structure)
      case 'born': realize(id, state.st.entities[id]); break;
      case 'pose': if (tracked.has(id)) realize(id, state.st.entities[id]);
        else if (carries(id)) reconcileStructures();   // a carrier moved: the buildings under it move with it
        break;
      case 'gone': retire(id); break;
    }
  } catch (e) { report(`realize structure ${what}`, e); }
}



/** Wire the realizer to state. Called once from main.js, beside the others. */
export function initStructureRealizer() {
  // the style overlay (defs.js), applied when the registry lands or a defs-updated push invalidates it; a failed
  // fetch keeps the built-in style
  const restyle = () => defsRegistry()
    .then((reg) => applyPaletteStyle(reg.structurePalette))
    .catch((e) => report('structure palette', e));
  restyle();
  bus.on('defs-updated', restyle);
  // the anchor can arrive any time after we realize; the models realizer announces every object it creates or moves
  // on this bus. hideAnchor emits nothing, so there is no loop.
  bus.on('entity', (ev) => { if (ev?.id && tracked.has(ev.id)) hideAnchor(ev.id); });
  onWorldChange((ev) => {
    if (ev.type === 'hydrated') reconcileStructures();
    else if (ev.type === 'reset') { for (const id of [...tracked.keys()]) retire(id); }
    else if (ev.type === 'change') onChange(ev);
  });
  return true;
}
