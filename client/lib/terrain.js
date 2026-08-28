// terrain — the world's ground truth for "how high is the floor here".
//
// Its own module (rather than living in world.js) purely to break a cycle:
// the controller needs ground height every frame, and world.js needs the
// controller's position to place things. Both depend on this instead.

import { scene, ground, grid, bus } from './core.js';
import { retireField } from './flora_field.js';
import { makeGrassQuality, GRASS_QUALITY, GRASS_MOTION } from './grass_quality.js';
import { autoHooks, releaseHook } from './autohooks.js';

let current = null;

export const heightAt = (x, z) => (current ? current.heightAt(x, z) : 0);
export const hasTerrain = () => current !== null;
/** §22m diag: the terrain mesh, for cost-attribution phases. */
export const getTerrainMesh = () => current?.mesh ?? null;

export function setTerrain(t) {
  if (current) {
    scene.remove(current.mesh);
    // …and FREE it (audit §13.1): three's WebGPU renderer pins every
    // geometry and texture it has uploaded in strong maps, so a replaced
    // terrain stayed GPU-resident forever. Terrain resources are per-build
    // (engine mesh + client-baked layer noiseTextures) — nothing shared,
    // safe to dispose wholesale.
    current.mesh?.traverse?.((o) => {
      o.geometry?.dispose?.();
      for (const m of Array.isArray(o.material) ? o.material : o.material ? [o.material] : []) {
        for (const v of Object.values(m)) if (v?.isTexture) v.dispose();
        m.dispose?.();
      }
    });
    // layer textures ride the colorNode, not material properties (world.js
    // stashes them at build for exactly this pass)
    for (const tex of current.layerTextures ?? []) tex?.dispose?.();
  }
  current = t;
  // ground/grid are null under the headless core stub — an agent process sets
  // terrain for its settle sim and has no stage floor to hide (issue #17)
  if (t) {
    if (t.mesh) {
      // the sky's scene-diff claim must never own the ground: a terrain
      // landing while an async sky build is in flight got CLAIMED (tel0s's
      // trace: "sky warm terrain") and the next sky rebuild would have
      // removed it (§17c)
      if (t.mesh.userData) t.mesh.userData.skyExempt = true;
      scene.add(t.mesh);
    }
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
  // sticky budget: a machine that had to thin its meadow keeps it thin
  // across re-grows, instead of re-discovering the same slow frame rate —
  // and a resident's chosen cap (persisted) survives them the same way.
  // The motion dial is sticky for the same reason and by the same route: a
  // re-grow that quietly restarted the sway would undo the choice without
  // saying so. (Both are re-applied against the NEW field — the old field's
  // frozen hooks left with it, so the freeze state is rebuilt, not carried.)
  frozenHooks = []; frozenWind = [];
  if (field && (budget.effective() < 1 || !budget.animates())) applyGrassBudget();
}
export const clearGrass = () => setGrass(null);
export const hasGrass = () => currentGrass !== null;
/** The live field object — grassdiag's toggle surface (§22). */
export const getGrassField = () => currentGrass;

// The meadow budget: the resident's persisted cap × the governor's session
// shed (grass_quality.js owns the semantics — effective is their min).
const budget = makeGrassQuality(globalThis.localStorage);

// ---- the motion dial (the 'static' half of #42's off/static/full) ----------
//
// Freezing foliage animation must touch ONLY foliage. The engine's per-frame
// hook array is shared with the sky and with every entity emitter, so the
// coarse move — emptying it, which is what the grassdiag phase does for one
// measured second — would stop the clouds and every particle system in the
// world for as long as a resident left the setting on.
//
// So: by identity, and narrowly.
//   · each stroke's own `update(t){ uT.value = t }` (vegetation.js) — the wind
//     clock. Released from the array, put back on the way out.
//   · that stroke's `base`/`gust` wind amplitudes, zeroed. Freezing the clock
//     alone leaves the blades stopped mid-gust, leaning; zeroing the amplitude
//     settles them upright, which is what "static" should look like.
//
// NOT frozen: the per-tile ticks. They re-settle LOD and visibility against
// the camera, so freezing them leaves a stale meadow behind a walking viewer —
// a still meadow is the ask, a wrong one is not. And not the pushers: a
// motionless field that still parts around your feet is honest interaction,
// not ambient animation.
//
// ⚠ This is a COMFORT setting, not established as a performance one. The
// shader still evaluates its wind term with the amplitude at zero, and no
// measurement on this hardware separates static from full (both sit on the
// vsync interval — tools/receipts-42/). Claim what is measured: 'off' is the
// lever that removes work.
let frozenHooks = [];
let frozenWind = [];   // [{ u, base, gust }] — the amplitudes we zeroed

function applyGrassMotion() {
  const want = budget.animates();
  if (!currentGrass) { frozenHooks = []; frozenWind = []; return; }
  const strokes = currentGrass._strokes ?? [];
  if (!want && !frozenHooks.length && !frozenWind.length) {
    for (const st of strokes) {
      if (typeof st.update === 'function' && releaseHook(st.update)) frozenHooks.push(st.update);
      const u = st.uniforms;
      if (u?.base && u?.gust) {
        frozenWind.push({ u, base: u.base.value, gust: u.gust.value });
        u.base.value = 0; u.gust.value = 0;
      }
    }
  } else if (want && (frozenHooks.length || frozenWind.length)) {
    // plain push, not pushHostHook: these were never marked host-owned, and
    // restoring must leave the array exactly as it was found
    if (frozenHooks.length) autoHooks().push(...frozenHooks);
    for (const f of frozenWind) { f.u.base.value = f.base; f.u.gust.value = f.gust; }
    frozenHooks = []; frozenWind = [];
  }
}

function applyGrassBudget() {
  const eff = budget.effective();
  applyGrassMotion();
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

/** Tile-level truth (§13.2's promised-and-never-landed stats, landed 8e):
 *  how each stroke is actually cut and what it draws right now — the render-
 *  object count that §16 spent a night shrinking, readable in-session. */
export function grassTiles() {
  if (!currentGrass) return { field: false, strokes: [] };
  const strokes = (currentGrass._strokes ?? []).map((f, i) => {
    const tiles = f.tiles ?? [];
    return {
      stroke: f.strokeLabel ?? `stroke ${i}`,
      // §22m: which material generation this stroke actually built —
      // 'opaque' (palette blades), 'cards-fast', 'cards-sss', or species
      // default. Answers "is the branch's grass actually on?" in one read.
      mode: f.grassMode ?? 'n/a',
      tiled: !!f.tiled,
      // tiled strokes: f.count is the LIVE summing getter (#74), so the
      // planted total lives on the tiles' fullCount
      planted: tiles.length
        ? tiles.reduce((s, t) => s + (t.userData.fullCount ?? 0), 0)
        : (f.count ?? 0),
      tiles: tiles.length,
      visible: tiles.filter((t) => t.visible).length,
      drawn: tiles.length
        ? tiles.reduce((s, t) => s + t.count, 0)
        : (f.mesh?.count ?? f.count ?? 0),
      // §17b blade LOD, observable: `lod` says the stroke carries far-index
      // twins at all; `lodTiles` counts tiles drawing the thinned tuft right
      // now. Existing fields stay put (bootjank prints them).
      lod: tiles.some((t) => t.userData.lodFar !== undefined),
      lodTiles: tiles.filter((t) => t.userData.lodFar === true).length,
    };
  });
  return { field: true, strokes };
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

/** The resident's second dial: does their meadow sway? Local, persisted,
 *  never a verb — exactly like the cap. */
export function setGrassMotion(m) {
  const applied = budget.setMotion(m);
  applyGrassBudget();
  return applied;
}
export const getGrassMotion = () => budget.motion;
/** Whether the meadow is animating right now — 'off' at cap 0, where there
 *  is nothing drawn to animate. */
export const grassAnimates = () => budget.animates();

/** #42's three names, as one call. Returns the dial pair it landed on. */
export function setFoliagePreset(name) {
  const pair = budget.setPreset(name);
  applyGrassBudget();
  return pair;
}
/** The name for the current pair, or null when the dials sit between names. */
export const getFoliagePreset = () => budget.preset();

export { GRASS_QUALITY, GRASS_MOTION };
