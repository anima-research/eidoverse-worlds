// terrain — the world's ground truth for "how high is the floor here".
//
// Its own module (rather than living in world.js) purely to break a cycle:
// the controller needs ground height every frame, and world.js needs the
// controller's position to place things. Both depend on this instead.

import { scene, ground, grid, bus } from './core.js';
import { retireField } from './flora_field.js';
import { makeGrassQuality, GRASS_QUALITY } from './grass_quality.js';

let current = null;

export const heightAt = (x, z) => (current ? current.heightAt(x, z) : 0);
export const hasTerrain = () => current !== null;

export function setTerrain(t) {
  if (current) scene.remove(current.mesh);
  current = t;
  if (t) {
    scene.add(t.mesh);
    // terrain replaces the stage floor
    ground.visible = false;
    grid.visible = false;
  } else {
    ground.visible = true;
    grid.visible = true;
  }
}

// ---- grass -----------------------------------------------------------------
// A flora field adds its mesh to the scene AND pushes per-frame hooks (wind
// per stroke, plus the avatar pushers) into globalThis._autoParticleSystems.
// Replacing or clearing has to undo BOTH — otherwise a new field stacks on
// the old, and the old field's hooks keep ticking against disposed GPU
// resources. setGrass owns that; retireField does the work.
//
// ⚠️ A field's mesh is a GROUP (one child InstancedMesh per stroke, plus
// shrub-wood stem meshes), and its textures are the species' map sets. Only
// the field itself knows all of that, so retirement prefers the field's own
// dispose() — walking `mesh.geometry`/`mesh.material` on a Group frees
// NOTHING and silently leaked a whole meadow's VRAM per re-grow.
let currentGrass = null;

export function setGrass(field) {
  retireField(currentGrass, globalThis._autoParticleSystems, scene);
  currentGrass = field ?? null;
  // sticky budget: a machine that had to thin its meadow keeps it thin
  // across re-grows, instead of re-discovering the same slow frame rate —
  // and a resident's chosen cap (persisted) survives them the same way
  if (field && budget.effective() < 1) applyGrassBudget();
}
export const clearGrass = () => setGrass(null);
export const hasGrass = () => currentGrass !== null;

// The meadow budget: the resident's persisted cap × the governor's session
// shed (grass_quality.js owns the semantics — effective is their min).
const budget = makeGrassQuality(globalThis.localStorage);

function applyGrassBudget() {
  const eff = budget.effective();
  if (currentGrass) {
    // `off` retires the draw entirely: count 0 stops the fill, and hiding the
    // group spares raycasts/shadows too. The field object stays whole — shared
    // state untouched, and any cap raise restores it in place.
    if (currentGrass.mesh) currentGrass.mesh.visible = eff > 0;
    currentGrass.setDensity?.(eff);
  }
  // whoever renders the dials (the grass⚙ row) hears every budget change —
  // including the governor's, which otherwise went stale until the next
  // panel open
  bus.emit('grass-budget');
}

// Perf governor's handle on the meadow — may thin below the resident's cap,
// never raises above it (the cap wins in effective()).
export function setGrassDensity(f) {
  budget.shedTo(f);
  applyGrassBudget();
}
/** effective REQUESTED density — what the two dials agreed to ask for.
 *  Whether the renderer actually applied it is getGrassApplied()'s answer:
 *  a stroke without a working count dial draws denser than this number. */
export const getGrassDensity = () => budget.effective();

/** The full budget→draw chain, honestly (#74): the resident's chosen level,
 *  the governor's shed, the requested effective factor, and what the
 *  renderer verifiably APPLIED — read from live instance counts, never from
 *  policy arithmetic. status: 'applied' | 'partial' | 'unavailable' |
 *  'not-applied' | 'unknown' (field predates draw-state reporting) |
 *  'no-field'. Strokes carry per-stroke truth so partial failure names the
 *  affected stroke(s). Shared authored grass state is never touched. */
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

// The resident's own dial (#60): full | medium | low | off, persisted per
// browser. Never a verb — the shared field is world state, the draw cost is
// not.
export function setGrassQuality(q) {
  const applied = budget.setQuality(q);
  applyGrassBudget();
  return applied;
}
export const getGrassQuality = () => budget.quality;
/** the governor's uncapped session dial, for inspection */
export const getGrassShed = () => budget.shed;
export { GRASS_QUALITY };
