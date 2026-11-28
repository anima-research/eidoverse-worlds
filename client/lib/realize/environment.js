// environment — the world-scope realizer (docs/history/TEL0S_NOTES.md §11.4): terrain, grass, sky/weather and the
// asset palette as projections of the folded singletons in state.st. Thin: the apply logic lives in world.js
// (applyTerrainState etc.). The 'hydrated' handler runs synchronously, so the terrain build (which gates arrival) is
// queued before the ready check can see an empty build queue.

import { state, onWorldChange } from '../state.js';
import { applyTerrainState, applyGrassState, applySkyFolded, applyAssetState } from '../world.js';
import { withShaping } from '../../../shared/terrainshape.js';

// no sky authored (never, or removed): a plain clear sky, not the sky defaults' cumulus
const NO_SKY = Object.freeze({ clouds: 'clear' });

// the ground's builder fills water on the ground it builds: the world's water component rides on its args, and in a world
// with no terrain on the stage floor ({stageFloor, water})
// …and so do the ground's named features and sculpted tiles (shared/terrainshape.js withShaping), which shape a terrain that isn't level
const groundArgs = (st) => { const t = withShaping(st.terrain, st.terrainFeatures, st.terrainTiles);
  return t ? (st.water ? { ...t, water: st.water } : t) : st.water ? { stageFloor: true, water: st.water } : null; };

// every join hands over what the fold says, absence included: a rejoin into a world whose terrain or grass went while we
// were away clears them, instead of keeping the last session's
function reconcileEnvironment() {
  const st = state.st;
  applyTerrainState(groundArgs(st));
  applyGrassState(st.grass ?? { clear: true });
  applySkyFolded(st.sky ?? NO_SKY, st.sky?.ts);
  for (const a of st.assets ?? []) applyAssetState(a);
}

function onWorld({ key, ts }) {
  const st = state.st;
  switch (key) {
    case 'terrain': case 'water': case 'terrainFeatures': case 'terrainTiles': applyTerrainState(groundArgs(st)); break;   // removed: the default flat ground
    // a mown lawn folds to null; the realizer is told to clear
    case 'grass': applyGrassState(st.grass ?? { clear: true }); break;
    // the fold merged this change into st.sky already; its ts anchors live transition timing
    case 'sky': applySkyFolded(st.sky ?? NO_SKY, ts ?? st.sky?.ts); break;   // removed: a plain clear sky
    case 'assets': for (const a of st.assets ?? []) applyAssetState(a); break;
  }
}



export function initEnvironmentRealizer() {
  onWorldChange((ev) => {
    if (ev.type === 'hydrated') reconcileEnvironment();
    else if (ev.type === 'world') onWorld(ev);
  });
  return true;
}
