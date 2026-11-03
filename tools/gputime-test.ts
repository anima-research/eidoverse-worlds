// gputime's shadow A/B gives the shadow maps back however it ends (client/lib/gputime.js). `bun tools/gputime-test.ts`
import { plugin } from 'bun';
const STUB = new URL('./gputime-core-stub.mjs', import.meta.url).pathname;
const RIG = new URL('./gputime-lightrig-stub.mjs', import.meta.url).pathname;
plugin({ name: 'gputime-stubs', setup(b) { b.onResolve({ filter: /^\.\/core\.js$/ }, () => ({ path: STUB })); b.onResolve({ filter: /^\.\/lightrig\.js$/ }, () => ({ path: RIG })); } });
const { pref } = await import(RIG);
const { lights } = await import(STUB);
const G = await import('../client/lib/gputime.js');
let pass = 0, fail = 0;
const ok = (n: string, c: boolean, d = '') => { if (c) pass++; else { fail++; console.log(`  FAIL ${n} ${d}`); } };
const sun = { isLight: true, castShadow: true, shadow: { autoUpdate: true } };
lights.push(sun);
const p = G.measureShadowPass(4);
G.gpuBegin(); G.gpuEnd(); G.gpuBegin(); G.gpuEnd();       // 'drawn', then 'held'
ok('(setup) mid-A/B the map is held', sun.shadow.autoUpdate === false, String(sun.shadow.autoUpdate));
G.setGpuTimer(false);
ok('turning the timer off mid-A/B gives the shadow map back', sun.shadow.autoUpdate === true, String(sun.shadow.autoUpdate));
const r: any = await Promise.race([p, new Promise((res) => setTimeout(() => res('pending'), 200))]);
ok('…and the measurement answers (cancelled), never hangs', r !== 'pending' && /cancel/.test(r?.error ?? ''), JSON.stringify(r));
ok('a new measurement can start after', G.gpuTimerState().measuring === false);
// a measurement's 500 ms settle must not clobber a newer one started inside it (review 5)
{ const q = G.measureShadowPass(1);
  G.gpuBegin(); G.gpuEnd(); G.gpuBegin(); G.gpuEnd();     // 'drawn', 'held'
  G.gpuBegin(); G.gpuEnd();                                // the next frame finishes: closing, settle timer armed
  G.setGpuTimer(false);                                    // off during the settle
  const q2 = G.measureShadowPass(2);                       // a new A/B inside the window
  await new Promise((r) => setTimeout(r, 650));
  ok('a new A/B started during an old one\'s settle survives it', G.gpuTimerState().measuring === true);
  void q; void q2; }
// the LAST tagged frame is 'held': it must render with the map held, i.e. the restore waits for the frame after it
// (Greptile #206: the restore ran inside that frame's own step, so its shadow maps were drawn and the sample was wrong)
{ G.setGpuTimer(false); await new Promise((r) => setTimeout(r, 650));
  sun.shadow.autoUpdate = true; pref.on = true;
  const q = G.measureShadowPass(1);
  G.gpuBegin(); G.gpuEnd();                                // 'drawn'
  G.gpuBegin();                                            // 'held' — the frame renders now
  ok('the final "held" frame renders with its shadow map held', sun.shadow.autoUpdate === false, String(sun.shadow.autoUpdate));
  G.gpuEnd(); G.gpuBegin(); G.gpuEnd();                    // the next frame ends the A/B
  ok('…and the frame after it gets the map back', sun.shadow.autoUpdate === true, String(sun.shadow.autoUpdate));
  G.setGpuTimer(false); void q; }
// shadows switched OFF during an A/B: the A/B's restore must not resurrect the value it saved at its start (review 7, L5)
{ G.setGpuTimer(false); await new Promise((r) => setTimeout(r, 650));
  sun.shadow.autoUpdate = true; pref.on = true;
  const q = G.measureShadowPass(4);
  G.gpuBegin(); G.gpuEnd();
  pref.on = false; sun.shadow.autoUpdate = false;          // the person turns shadows off mid-A/B
  G.setGpuTimer(false);
  ok('shadows turned off mid-A/B stay off after it ends (the preference wins over the saved value)', sun.shadow.autoUpdate === false, String(sun.shadow.autoUpdate));
  pref.on = true; void q; }
console.log(`${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
