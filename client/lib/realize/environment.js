// environment — the world-scope realizer (docs/history/TEL0S_NOTES.md §11.4): terrain, grass, sky/weather and the
// asset palette as projections of the folded singletons in state.st. Thin: the apply logic lives in world.js
// (applyTerrainState etc.). The 'hydrated' handler runs synchronously, so the terrain build (which gates arrival) is
// queued before the ready check can see an empty build queue.

import { state, onWorldChange } from '../state.js';
import { applyTerrainState, applyGrassState, applySkyFolded, applyAssetState } from '../world.js';

// no sky authored (never, or removed): a plain clear sky, not the sky defaults' cumulus
const NO_SKY = Object.freeze({ clouds: 'clear' });

// the ground's builder fills water on the ground it builds: the world's water component rides on its args, and in a world
// with no terrain on the stage floor ({stageFloor, water})
const groundArgs = (st) => (st.terrain ? (st.water ? { ...st.terrain, water: st.water } : st.terrain) : st.water ? { stageFloor: true, water: st.water } : null);

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
    case 'terrain': case 'water': applyTerrainState(groundArgs(st)); break;   // removed: the default flat ground
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
