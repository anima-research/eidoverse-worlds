// sky_swapchain — the cloud-tier swap bookkeeping of sky.js, pure (no GPU, no three; test/client/sky-swapchain-test.mjs).
// One swap at a time, latest choice wins: each run swaps from what is shown to the tier wanted now; choices made
// mid-run queue at most one more run, and intermediate tiers are skipped.
//
// `inner(from, to)` does the swap and answers: true = `to` is on screen; false = nothing changed; 'superseded' = it
// changed the screen but stood down for a newer choice before its tier arrived. After 'superseded' no tier is on
// screen, so `shown` becomes SHOWN_UNKNOWN, which never equals a tier: the next run always acts.
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
