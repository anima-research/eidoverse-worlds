// environment — the world-scope realizer (TEL0S_NOTES §11.4, slice 3c):
// terrain, grass, sky/weather, and the asset palette as projections of the
// folded singletons in state.st.
//
// Deliberately thin: the actual application logic lives in world.js
// (applyTerrainState / applyGrassState / applySkyFolded / applyAssetState),
// shared with the legacy applyEntry switch so the migration window has one
// implementation under two drivers. The fold already did the hard part —
// st.sky IS the folded bag (weather merged, forecast provenance stamped,
// hours rebased), so applying it is a straight read.
//
// Ordering note that keeps boot honest: the 'hydrated' handler runs
// synchronously inside shadowHydrate, which net.js calls BEFORE any legacy
// replay await — so the terrain build (which GATES arrival) is enqueued
// before checkReady can ever observe an empty build queue.

import { state, onWorldChange } from '../state.js';
import { applyTerrainState, applyGrassState, applySkyFolded, applyAssetState } from '../world.js';

// a world with no sky authored (never, or removed) shows a plain clear sky: the sky's defaults bring cumulus, and R removed
// the sky and still had clouds (10-11 14:05). The same at join, so a removal looks the same after a reload.
const NO_SKY = Object.freeze({ clouds: 'clear' });

// the ground's builder fills water on the ground it builds: the world's water component (shape audit 10-16) rides on its args,
// and in a world with no terrain on the stage floor ({stageFloor, water}: house review I8)
const groundArgs = (st) => (st.terrain ? (st.water ? { ...st.terrain, water: st.water } : st.terrain) : st.water ? { stageFloor: true, water: st.water } : null);

// every join hands over what the fold says, absence included: a rejoin into a world whose terrain or grass went while we
// were away clears them, instead of keeping the last session's (house review I55)
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
