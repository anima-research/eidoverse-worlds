// terrain — the world's ground truth for "how high is the floor here".
//
// Its own module (rather than living in world.js) purely to break a cycle:
// the controller needs ground height every frame, and world.js needs the
// controller's position to place things. Both depend on this instead.

import { scene, ground, grid } from './core.js';
import { retireField } from './flora_field.js';

let current = null;

export const heightAt = (x, z) => (current ? current.heightAt(x, z) : 0);
export const hasTerrain = () => current !== null;

export function setTerrain(t) {
  if (current) scene.remove(current.mesh);
  current = t;
  // ground/grid are null under the headless core stub — an agent process sets
  // terrain for its settle sim and has no stage floor to hide (issue #17)
  if (t) {
    if (t.mesh) scene.add(t.mesh);
    // terrain replaces the stage floor
    if (ground) ground.visible = false;
    if (grid) grid.visible = false;
  } else {
    if (ground) ground.visible = true;
    if (grid) grid.visible = true;
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
  // sticky density: a machine that had to thin its meadow keeps it thin
  // across re-grows, instead of re-discovering the same slow frame rate
  if (field?.setDensity && grassDensity < 1) field.setDensity(grassDensity);
}
export const clearGrass = () => setGrass(null);
export const hasGrass = () => currentGrass !== null;

// Perf governor's handle on the meadow.
let grassDensity = 1;
export function setGrassDensity(f) {
  grassDensity = f;
  currentGrass?.setDensity?.(f);
}
export const getGrassDensity = () => grassDensity;
