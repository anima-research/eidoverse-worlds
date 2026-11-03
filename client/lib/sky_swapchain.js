// sky_swapchain — the tier-swap bookkeeping of sky.js, pure (no GPU, no three), so a node test can drive it.
//
// ONE SWAP AT A TIME, LATEST CHOICE WINS (review 7 / owner's rig 09-27 23:12: switches made while one was compiling piled
// up behind the bake lock, and a tier already left still baked). Each run swaps from what's actually SHOWN to the tier
// chosen NOW; choices made while a run is in flight only queue one more run, and intermediate tiers are skipped.
//
// `inner(from, to)` does the swap and answers: true = `to` is on screen; false = nothing changed (a torn-down sky, or a
// newer choice it stood down for before touching the screen); 'superseded' = it changed the screen (dome detached,
// domes held, gradient up) but stood down for a newer choice before its own tier arrived. After 'superseded' NO tier is
// on screen, so `shown` becomes SHOWN_UNKNOWN, which never equals a tier: the next run always acts (review 10b H1: it
// used to record `to`, and A→B→C→B with C's run aborting left B "shown" with only the gradient up, sky-busy stuck).
export const SHOWN_UNKNOWN = '?';

export function makeSwapChain({ inner, want, api, log = () => {} }) {
  let chain = Promise.resolve(), shown = null;
  function swap(from) {
    if (shown == null) shown = from;
    const a = api();
    const run = chain.then(async () => {
      if (api() !== a) return;
      const w = want();
      if (w === shown) return;
      const r = await inner(shown, w);
      if (r === 'superseded') { shown = SHOWN_UNKNOWN; log(`[sky] clouds →${w} superseded by →${want()} mid-bake; the next swap takes over`); }
      else if (r) shown = w;
    });
    chain = run.catch(() => {});
    return run;
  }
  return { swap, reset: () => { shown = null; }, shown: () => shown };
}
