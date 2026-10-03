// bun tools/governor-xr-test.ts — in a headset the frame governor never moves the pixel ratio (#32 split vision: in XR
// the ratio scales each EYE'S VIEWPORT, not the resolution). Three guards in governor.js: the 'pixels' lever's shed and
// restore, and the dead-band 'cruise' step. The REAL governor.js runs over tools/lod-client-stub.mjs (its renderer is a
// plain object, so presenting is a flag here). Each case drives the governor's own 1 Hz input (governPerformance) and
// reads its own history + the pixel ratio it set. Controls: the same drive on the desktop DOES move pixels.
import { plugin } from 'bun';
import { fileURLToPath } from 'node:url';
const STUB = fileURLToPath(new URL('./lod-client-stub.mjs', import.meta.url));
plugin({ name: 'governor-xr-stub', setup(b) {
  // the same cone lod-client-test stubs: governor.js and the REAL realize/models.js it imports stay real
  for (const f of ['^\\./core\\.js$', '^\\./warmqueue\\.js$', '^\\./loadwork\\.js$', '^\\./lightrig\\.js$', '^\\./emitters\\.js$',
    '^\\./terrain\\.js$', '^\\./remotes\\.js$', '^\\./frame\\.js$', '^\\./ui\\.js$', '^\\./statuschips\\.js$',
    '^\\.\\./core\\.js$', '^\\.\\./assets\\.js$', '^\\.\\./colliders\\.js$', '^\\.\\./lightrig\\.js$', '^\\.\\./lights\\.js$', '^\\.\\./world\\.js$'])
    b.onResolve({ filter: new RegExp(f) }, () => ({ path: STUB }));
} });
const mem = new Map<string, string>();
(globalThis as any).localStorage = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => mem.set(k, String(v)), removeItem: (k: string) => mem.delete(k) };
let pass = 0, fail = 0;
const check = (n: string, ok: boolean, d: unknown = '') => { ok ? pass++ : fail++; console.log(`  ${ok ? '✓' : '✗'} ${n}${ok ? '' : `  ${JSON.stringify(d)}`}`); };

const stub: any = await import(STUB);
const ratios: number[] = [];
stub.renderer.setPixelRatio = (r: number) => { ratios.push(r); };
stub.renderer.xr = { isPresenting: false };
const G: any = await import('../client/lib/governor.js');
const hist = () => (G.governorDebug().history as string[]);
const pixelMoves = () => hist().filter((h) => /pixels/.test(h)).length;
// one frame as main.js runs it: the pulse decides, the NEXT frame's 'pixel-ratio' system applies before 'render'
const tick = (fps: number) => { G.governPerformance(fps); G.applyPendingPixelRatio(); };

// 1. SLOW seconds in a headset: the ladder must skip 'pixels' (shed returns false) and never touch the ratio
stub.renderer.xr.isPresenting = true;
const r0 = ratios.length, p0 = pixelMoves();
for (let i = 0; i < 40; i++) tick(12);
check('headset, slow: no pixel-ratio write and no "pixels" rung', ratios.length === r0 && pixelMoves() === p0, { writes: ratios.slice(r0), hist: hist().slice(-4) });
check('…but the ladder still acts on something else (it moved on, not stalled)', hist().some((h) => h.startsWith('−') && !/pixels/.test(h)), hist().slice(-4));

// 2. MID (dead-band) seconds in a headset: the cruise step must not fire either
const r1 = ratios.length, p1 = pixelMoves();
for (let i = 0; i < 40; i++) tick(40);
check('headset, sustained mid fps (cruise regime): no pixel-ratio write', ratios.length === r1 && pixelMoves() === p1, { writes: ratios.slice(r1), hist: hist().slice(-4) });

// 3. FAST seconds in a headset, starting BELOW base (shed on the desktop first — otherwise restore has nothing to raise
//    and the check could never fail): restore must not raise the ratio while presenting
stub.renderer.xr.isPresenting = false;
for (let i = 0; i < 60 && G.governorDebug().pixelRatio >= 1; i++) tick(12);
const shedTo = G.governorDebug().pixelRatio;
stub.renderer.xr.isPresenting = true;
const r2 = ratios.length;
for (let i = 0; i < 60; i++) tick(72);
check('headset, fast, ratio below base: restore does NOT raise it', shedTo < 1 && ratios.length === r2 && G.governorDebug().pixelRatio === shedTo, { shedTo, writes: ratios.slice(r2), now: G.governorDebug().pixelRatio });
stub.renderer.xr.isPresenting = false;
for (let i = 0; i < 80; i++) tick(72);
check('control — desktop, fast: the SAME state DOES restore the ratio', G.governorDebug().pixelRatio > shedTo, { shedTo, now: G.governorDebug().pixelRatio });

// CONTROL: the same slow drive on the desktop DOES shed pixels (the measurement has a subject)
stub.renderer.xr.isPresenting = false;
const r3 = ratios.length;
for (let i = 0; i < 60; i++) tick(12);
check('control — desktop, slow: the governor DOES move the pixel ratio', ratios.length > r3 && hist().some((h) => /− pixels/.test(h)), { writes: ratios.slice(r3), hist: hist().slice(-4) });

// a decision made on the desktop and still pending at VR entry must wait for exit (#32)
{ stub.renderer.xr.isPresenting = false;
  const pr0 = G.governorDebug().pixelRatio; let decided = false;
  for (let i = 0; i < 80 && !decided; i++) { G.governPerformance(i < 40 ? 72 : 12); decided = G.governorDebug().pixelRatio !== pr0; }
  const w0 = ratios.length; stub.renderer.xr.isPresenting = true; G.applyPendingPixelRatio();
  check('a change still pending at VR entry is NOT applied mid-session', !decided || ratios.length === w0, { decided, writes: ratios.slice(w0) });
  stub.renderer.xr.isPresenting = false; G.applyPendingPixelRatio();
  check('…it lands after exit', !decided || ratios.length === w0 + 1, { decided, writes: ratios.slice(w0) }); }
// VR exit resizes outside the governor (xr.js emits 'xr:exit-resized'): the governor's own ratio comes back next frame
{ stub.renderer.xr.isPresenting = false;
  const { bus } = await import('../client/lib/base.js');
  const mine = G.governorDebug().pixelRatio, w0 = ratios.length;
  bus.emit('xr:exit-resized'); G.applyPendingPixelRatio();
  check('after VR exit the governor re-asserts its own pixel ratio (a pinned scale survives VR)', ratios.length === w0 + 1 && ratios.at(-1) === mine, { mine, writes: ratios.slice(w0) }); }
// THE BLACK FRAMES (09-28): a pixel-ratio change resizes (and so clears) the canvas; decided after the draw, it must
// not reach the renderer until the next frame's apply step, which runs BEFORE render
{ stub.renderer.xr.isPresenting = false;
  for (let i = 0; i < 80; i++) tick(72);                          // back to base
  const before = ratios.length, pr0 = G.governorDebug().pixelRatio;
  let decided = false;
  for (let i = 0; i < 60 && !decided; i++) { G.governPerformance(12); decided = G.governorDebug().pixelRatio !== pr0; }
  check('(setup) the governor decided a pixel-ratio change', decided, { pr0, now: G.governorDebug().pixelRatio });
  check('its decision does NOT touch the renderer after the frame (no canvas resize, no cleared frame)', ratios.length === before, ratios.slice(before));
  G.applyPendingPixelRatio();
  check('…the next frame start applies it, once', ratios.length === before + 1 && ratios.at(-1) === G.governorDebug().pixelRatio, ratios.slice(before));
  G.applyPendingPixelRatio();
  check('…and only once', ratios.length === before + 1, ratios.slice(before)); }
// review 10a M3: the headset's cap on loading's share holds WHILE loading too (entering VR mid-load, the usual cold entry)
{ const FB: any = await import('../client/lib/framebudget.js');
  stub.renderer.xr.isPresenting = false;
  for (let i = 0; i < 10; i++) tick(72);                               // smooth desktop: the share is the desktop 0.36
  const desk = FB.budgetStats().share;
  FB.reportPending('governor-xr-test', 1);                             // loading is busy from here
  tick(72);
  check('control — desktop, loading: the share is frozen (loading must not shrink its own slice)', FB.budgetStats().share === desk && desk > 0.25, { desk, now: FB.budgetStats().share });
  stub.renderer.xr.isPresenting = true;                                // enter VR mid-load
  tick(72);
  check('headset entered mid-load: the share drops to the 0.25 cap at once', FB.budgetStats().share <= 0.25, { desk, now: FB.budgetStats().share });
  FB.setShare(0.2); tick(72);
  check('…and the cap only lowers: a smaller share stays', FB.budgetStats().share === 0.2, FB.budgetStats().share);
  FB.reportPending('governor-xr-test', 0); stub.renderer.xr.isPresenting = false; }
console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
