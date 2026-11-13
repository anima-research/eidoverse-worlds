// terrain — the world's ground truth for "how high is the floor here", and the meadow's draw budget.
// Its own module to break a cycle: the controller needs ground height every frame, and world.js needs the
// controller's position to place things.

import { scene, ground, grid, axisLines } from './core.js';
import { bus } from './base.js';
import { retireField } from './vegetation/flora_field.js';
import { makeGrassQuality, GRASS_QUALITY } from './vegetation/grass_quality.js';

let current = null;
// with no terrain mesh the stage floor is the ground: at 0, or at a flat terrain's height (terrain {kind: 'flat'})
let floorY = 0;
export function setFlatGround(y) {
  floorY = Number.isFinite(y) ? y : 0;
  for (const [o, lift] of [[ground, 0], [grid, 0.02], [axisLines, 0.04]]) if (o) o.position.y = floorY + lift;
  bus.emit('ground-changed');
}

export const heightAt = (x, z) => (current ? current.heightAt(x, z) : floorY);
// The water, for whatever floats in it (ammodoll.js): {level, sample(x, z) → shared/waterkind.js sample | null,
// time() → wave seconds}, or null. Browser (water.js) and headless agents each hand in their own.
let water = null;
export const waterField = () => water;
export function setWaterField(f) { water = f ?? null; bus.emit('ground-changed'); }
export const hasTerrain = () => current !== null;

/** Where the rain lands (sky.js groundHeightAt): the terrain or the water over it, whichever is higher; null past
 *  the terrain's edge (no splash). Baked into a heightfield on 'ground-changed', not called per frame. */
export function rainSurfaceAt(x, z) {
  if (!current) return heightAt(x, z);
  const box = extentOf(current);
  if (box && (x < box.minX || x > box.maxX || z < box.minZ || z > box.maxZ)) return null;
  const h = current.heightAt(x, z);
  const level = water?.level;
  return typeof level === 'number' && level > h ? level : h;
}
// The terrain's horizontal footprint in world space, from its mesh. Agents' terrains have no mesh: no edge.
const extents = new WeakMap();
function extentOf(t) {
  if (!t.mesh?.geometry) return null;
  let e = extents.get(t);
  if (!e) {
    const g = t.mesh.geometry;
    if (!g.boundingBox) g.computeBoundingBox();
    const p = t.mesh.position ?? { x: 0, z: 0 };
    e = { minX: g.boundingBox.min.x + p.x, maxX: g.boundingBox.max.x + p.x, minZ: g.boundingBox.min.z + p.z, maxZ: g.boundingBox.max.z + p.z };
    extents.set(t, e);
  }
  return e;
}
/** The terrain mesh, for the perf diagnostics' cost attribution. */
export const getTerrainMesh = () => current?.mesh ?? null;

export function setTerrain(t) {
  if (current) {
    scene.remove(current.mesh);
    // and free it: three pins uploaded geometry/textures; terrain resources are per-build, nothing shared
    current.mesh?.traverse?.((o) => {
      o.geometry?.dispose?.();
      for (const m of Array.isArray(o.material) ? o.material : o.material ? [o.material] : []) {
        for (const v of Object.values(m)) if (v?.isTexture) v.dispose();
        m.dispose?.();
      }
    });
    // layer textures ride the colorNode, not material properties; world.js stashes them at build for this
    for (const tex of current.layerTextures ?? []) tex?.dispose?.();
  }
  current = t;
  // ground/grid are null under the headless core stub (an agent's settle sim has no stage floor)
  if (t) {
    if (t.mesh) {
      // the sky's scene-diff claim must never own the ground, or a sky rebuild would remove it (sky.js skyExempt)
      if (t.mesh.userData) { t.mesh.userData.skyExempt = true; t.mesh.userData.odTag = 'terrain'; }
      scene.add(t.mesh);
    }
    // terrain replaces the stage floor
    if (ground) ground.visible = false;
    if (grid) grid.visible = false;
    if (axisLines) axisLines.visible = false;
  } else {
    if (ground) ground.visible = true;
    if (grid) grid.visible = true;
    if (axisLines) axisLines.visible = true;
  }
  bus.emit('ground-changed');
}

// ---- grass -----------------------------------------------------------------
// A flora field adds its mesh to the scene and pushes per-frame hooks into globalThis._autoParticleSystems;
// retireField undoes both through the field's own dispose().
let currentGrass = null;

export function setGrass(field) {
  retireField(currentGrass, globalThis._autoParticleSystems, scene);
  currentGrass = field ?? null;
  // sticky budget: a thinned meadow (governor or resident's cap) stays thin across re-grows
  if (field && budget.effective() < 1) applyGrassBudget();
}
export const clearGrass = () => setGrass(null);
export const hasGrass = () => currentGrass !== null;
/** The live field object (grassdiag.js). */
export const getGrassField = () => currentGrass;

// The meadow budget: the resident's persisted cap and the governor's session shed; effective() is their min (grass_quality.js).
const budget = makeGrassQuality(globalThis.localStorage);

function applyGrassBudget() {
  const eff = budget.effective();
  if (currentGrass) {
    // `off` hides the group too (spares raycasts/shadows); the field stays whole for a later raise
    if (currentGrass.mesh) currentGrass.mesh.visible = eff > 0;
    currentGrass.setDensity?.(eff);
  }
  bus.emit('grass-budget');   // the dials hear every budget change, the governor's included
}

// The perf governor's handle: may thin below the resident's cap, never raises above it.
export function setGrassDensity(f) {
  budget.shedTo(f);
  applyGrassBudget();
}
/** The requested density; whether the renderer applied it is getGrassApplied()'s answer. */
export const getGrassDensity = () => budget.effective();

/** The budget→draw chain: the resident's level, the governor's shed, the requested factor, and what the renderer
 *  verifiably applied (read from live instance counts). status: 'applied' | 'partial' | 'unavailable' | 'not-applied'
 *  | 'unknown' (the field predates draw-state reporting) | 'no-field'; strokes name any partial failure. */
export function getGrassApplied() {
  const base = {
    quality: budget.quality, cap: budget.cap,
    shed: budget.shed, requested: budget.effective(),
  };
  if (!currentGrass) return { ...base, field: false, status: 'no-field', strokes: [] };
  const rep = currentGrass.applied?.(base.requested);
  // a field that cannot report draw state must not read as success
  if (!rep) return { ...base, field: true, status: 'unknown', strokes: [] };
  return { ...base, field: true, ...rep };
}

/** How each stroke is tiled and what it draws right now (docs/research/meadow-grass-rendering.md). */
export function grassTiles() {
  if (!currentGrass) return { field: false, strokes: [] };
  const strokes = (currentGrass._strokes ?? []).map((f, i) => {
    const tiles = f.tiles ?? [];
    return {
      stroke: f.strokeLabel ?? `stroke ${i}`,
      mode: f.grassMode ?? 'n/a',   // the material it built: 'opaque', 'cards-fast', 'cards-sss', or species default
      tiled: !!f.tiled,
      // tiled strokes: f.count is the live summing getter, so the planted total lives on the tiles' fullCount
      planted: tiles.length
        ? tiles.reduce((s, t) => s + (t.userData.fullCount ?? 0), 0)
        : (f.count ?? 0),
      tiles: tiles.length,
      visible: tiles.filter((t) => t.visible).length,
      drawn: tiles.length
        ? tiles.reduce((s, t) => s + t.count, 0)
        : (f.mesh?.count ?? f.count ?? 0),
      // blade LOD: `lod` = the stroke carries far-index twins; `lodTiles` = tiles drawing the thinned tuft now
      lod: tiles.some((t) => t.userData.lodFar !== undefined),
      lodTiles: tiles.filter((t) => t.userData.lodFar === true).length,
    };
  });
  return { field: true, strokes };
}

// The resident's own dial: full | medium | low | off, persisted per browser (the draw cost is not world state).
export function setGrassQuality(q) {
  const applied = budget.setQuality(q);
  applyGrassBudget();
  return applied;
}
export const getGrassQuality = () => budget.quality;
/** the governor's uncapped session dial, for inspection */
export const getGrassShed = () => budget.shed;
export { GRASS_QUALITY };
