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

function reconcileEnvironment() {
  const st = state.st;
  if (st.terrain) applyTerrainState(st.terrain);
  if (st.grass) applyGrassState(st.grass);
  if (st.sky) applySkyFolded(st.sky, st.sky.ts);
  for (const a of st.assets ?? []) applyAssetState(a);
}

function onWorld({ key, ts }) {
  const st = state.st;
  switch (key) {
    case 'terrain': applyTerrainState(st.terrain ?? null); break;   // removed: the default flat ground
    // a mown lawn folds to null; the realizer is told to clear
    case 'grass': applyGrassState(st.grass ?? { clear: true }); break;
    // the fold merged this change into st.sky already; its ts anchors live transition timing
    case 'sky': applySkyFolded(st.sky ?? {}, ts ?? st.sky?.ts); break;   // removed: the default sky
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
