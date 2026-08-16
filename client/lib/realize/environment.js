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

function onEntry(entry) {
  const st = state.st;
  switch (entry.verb) {
    case 'terrain': applyTerrainState(st.terrain); break;
    case 'grass':
      // clear folds to null — the mow is the ARGS' clear flag, so pass the
      // entry's own args when the fold has nothing to show for them
      applyGrassState(st.grass ?? entry.args); break;
    case 'sky':
    case 'weather':
      // the fold merged this entry into st.sky already (same math as the
      // sequencer); the entry's ts anchors live transition timing
      applySkyFolded(st.sky, entry.ts); break;
    case 'asset': applyAssetState(entry.args); break;
  }
}

const VERBS = new Set(['terrain', 'grass', 'sky', 'weather', 'asset']);

export function initEnvironmentRealizer() {
  onWorldChange((ev) => {
    if (ev.type === 'hydrated') reconcileEnvironment();
    else if (ev.type === 'entry' && VERBS.has(ev.entry.verb)) onEntry(ev.entry);
  });
  return true;
}
