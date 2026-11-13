// gputime's shadow A/B gives the shadow maps back however it ends (client/lib/gputime.js). `bun test/client/gputime-test.ts`
import { fileURLToPath } from "node:url";
import { plugin } from 'bun';
import { stubResolve } from '../harness/stub.ts';
import { pause } from "../gate/wait.ts";
import { suite } from "../gate/suite.ts";
const STUB = fileURLToPath(new URL('../stubs/gputime-core-stub.mjs', import.meta.url));
const RIG = fileURLToPath(new URL('../stubs/gputime-lightrig-stub.mjs', import.meta.url));
plugin({ name: 'gputime-stubs', setup(b) { stubResolve(b, /^(\.\.?\/)+core\.js$/, () => ({ path: STUB })); stubResolve(b, /^(\.\.?\/)+lightrig\.js$/, () => ({ path: RIG })); } });
const { pref } = await import(RIG);
const { lights, em } = await import(STUB);
const G = await import('../../client/lib/gputime.js');
const S = suite("gputime");
const ok = (n: string, c: unknown, d?: unknown) => S.check(n, c, d);
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
  await pause("the GPU timer's settle window", 650);
  ok('a new A/B started during an old one\'s settle survives it', G.gpuTimerState().measuring === true);
  void q; void q2; }
// the LAST tagged frame is 'held': it must render with the map held, i.e. the restore waits for the frame after it
// (Greptile #206: the restore ran inside that frame's own step, so its shadow maps were drawn and the sample was wrong)
{ G.setGpuTimer(false); await pause("the GPU timer's settle window", 650);
  sun.shadow.autoUpdate = true; pref.on = true;
  const q = G.measureShadowPass(1);
  G.gpuBegin(); G.gpuEnd();                                // 'drawn'
  G.gpuBegin();                                            // 'held' — the frame renders now
  ok('the final "held" frame renders with its shadow map held', sun.shadow.autoUpdate === false, String(sun.shadow.autoUpdate));
  G.gpuEnd(); G.gpuBegin(); G.gpuEnd();                    // the next frame ends the A/B
  ok('…and the frame after it gets the map back', sun.shadow.autoUpdate === true, String(sun.shadow.autoUpdate));
  G.setGpuTimer(false); void q; }
// shadows switched OFF during an A/B: the A/B's restore must not resurrect the value it saved at its start (review 7, L5)
{ G.setGpuTimer(false); await pause("the GPU timer's settle window", 650);
  sun.shadow.autoUpdate = true; pref.on = true;
  const q = G.measureShadowPass(4);
  G.gpuBegin(); G.gpuEnd();
  pref.on = false; sun.shadow.autoUpdate = false;          // the person turns shadows off mid-A/B
  G.setGpuTimer(false);
  ok('shadows turned off mid-A/B stay off after it ends (the preference wins over the saved value)', sun.shadow.autoUpdate === false, String(sun.shadow.autoUpdate));
  pref.on = true; void q; }
// the readback, over the stub's timer extension: plumbing only, never GPU truth (the headset's number is the truth)
{ G.setGpuTimer(false); await pause("the GPU timer's settle window", 650);
  const frames = (n: number) => { for (let i = 0; i < n; i++) { G.gpuBegin(); G.gpuEnd(); } };
  em.answer = true; em.ns = 3e6; em.disjoint = false;
  G.setGpuTimer(true); frames(13);
  const on = G.gpuTimerState();
  ok('timer on: frames accumulate with the elapsed time as their average', on.on && on.frames >= 12 && on.avgMs === 3, JSON.stringify(on));
  em.disjoint = true; const n0 = on.frames, b0 = em.begins; frames(10);
  ok('a DISJOINT frame is discarded: queries still run, samples do not grow', em.begins - b0 >= 8 && G.gpuTimerState().frames === n0, JSON.stringify({ begins: em.begins - b0, frames: G.gpuTimerState().frames }));
  em.disjoint = false; em.answer = false; frames(20);
  ok('results that lag past the ring skip frames rather than grow it', em.begins - b0 - 10 <= 8, String(em.begins - b0 - 10));
  G.setGpuTimer(false); const b1 = em.begins; frames(5);
  ok('timer off: no queries issued', em.begins === b1, `${em.begins - b1} begins`);
  ok('…and the line says it is off', G.gpuLine() === 'gpu: timer off', G.gpuLine()); }
S.done();
