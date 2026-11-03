// sky-swapchain-test — the tier-swap bookkeeping (client/lib/sky_swapchain.js, used by sky.js swapTier), headless.
//   node tools/sky-swapchain-test.mjs      (or bun)
// The screen work (swapTierInner) is a scripted fake here: each call waits for the test to answer it with what the real
// one would return. What's bound is the SHOWN bookkeeping — which tier the next run swaps FROM, and whether it acts.
import { makeSwapChain, SHOWN_UNKNOWN } from '../client/lib/sky_swapchain.js';
let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) { pass++; console.log(`  ok    ${n}`); } else { fail++; console.log(`  FAIL  ${n}  ${d}`); } };
const tick = () => new Promise((r) => setTimeout(r, 0));

function rig(start) {
  const st = { q: start, api: 1, calls: [] };
  const chain = makeSwapChain({
    inner: (from, to) => new Promise((answer) => st.calls.push({ from, to, answer })),
    want: () => st.q, api: () => st.api,
  });
  // setCloudQuality's shape: remember the tier being left, then set the new one, then swap
  const pick = (t) => { const from = st.q; st.q = t; return chain.swap(from); };
  return { st, chain, pick };
}

// H1 (review 10b): A→B→C→B, C's run stands down. medium → low (baked→baked: detach, gradient up) → high mid-bake (low's
// run returns 'superseded') → low again while high's live domes compile (high's run returns false: stood down before
// touching the screen). Nothing is on screen but the gradient, so the last run MUST act.
{
  const { st, chain, pick } = rig('medium');
  pick('low'); await tick();
  ok('run 1 swaps medium → low', st.calls.length === 1 && st.calls[0].from === 'medium' && st.calls[0].to === 'low', JSON.stringify(st.calls));
  pick('high');
  st.calls[0].answer('superseded'); await tick(); await tick();
  ok("after 'superseded' nothing is recorded as shown", chain.shown() === SHOWN_UNKNOWN, chain.shown());
  ok('run 2 swaps FROM the unknown state to high', st.calls.length === 2 && st.calls[1].from === SHOWN_UNKNOWN && st.calls[1].to === 'high', JSON.stringify(st.calls.map(({ from, to }) => [from, to])));
  pick('low');
  st.calls[1].answer(false); await tick(); await tick();
  ok('run 3 (back to low) ACTS: it is not mistaken for "already there"', st.calls.length === 3 && st.calls[2].to === 'low' && st.calls[2].from === SHOWN_UNKNOWN, JSON.stringify(st.calls.map(({ from, to }) => [from, to])));
  st.calls[2]?.answer(true); await tick(); await tick();
  ok('…and once it arrives, low is shown', chain.shown() === 'low', chain.shown());
}

// A→B→A (final review H1's case, still closed): medium → low superseded by medium
{
  const { st, chain, pick } = rig('medium');
  pick('low'); await tick();
  pick('medium');
  st.calls[0].answer('superseded'); await tick(); await tick();
  ok('A→B→A: the return to medium acts (from the unknown state)', st.calls.length === 2 && st.calls[1].from === SHOWN_UNKNOWN && st.calls[1].to === 'medium', JSON.stringify(st.calls.map(({ from, to }) => [from, to])));
  st.calls[1].answer(true); await tick(); await tick();
  ok('A→B→A: medium shown at the end', chain.shown() === 'medium', chain.shown());
}

// a run that stood down WITHOUT touching the screen (false) leaves the old tier shown: returning to it is a no-op
// (control: the sentinel is only for 'superseded'; the dome that stayed up is still the truth)
{
  const { st, chain, pick } = rig('medium');
  pick('high'); await tick();
  pick('medium');
  st.calls[0].answer(false); await tick(); await tick();
  ok('control: medium → high stood down (false) → medium: no swap (the medium dome never left)', st.calls.length === 1 && chain.shown() === 'medium', JSON.stringify({ calls: st.calls.length, shown: chain.shown() }));
}

// latest choice wins: intermediate tiers are skipped
{
  const { st, pick } = rig('medium');
  pick('low'); await tick();
  pick('high'); pick('off'); pick('low');
  st.calls[0].answer(true); await tick(); await tick();
  ok('queued choices collapse to the latest (low already shown: nothing more runs)', st.calls.length === 1, JSON.stringify(st.calls.map(({ from, to }) => [from, to])));
}

// a sky torn down (api changed) while a run was queued: the run does nothing; reset() forgets what was shown
{
  const { st, chain, pick } = rig('medium');
  pick('low'); await tick();
  pick('high'); st.api = 2;
  st.calls[0].answer(true); await tick(); await tick();
  ok('a run queued for a torn-down sky does nothing', st.calls.length === 1, st.calls.length);
  chain.reset();
  ok('reset() forgets the shown tier', chain.shown() === null);
}

console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
