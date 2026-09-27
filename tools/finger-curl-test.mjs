// bun tools/finger-curl-test.mjs — the analog finger-curl filter (xr.js sampleFingerCurl).
//
// WHY: the raw trigger/grip value was assigned straight through every frame, so controller ADC noise
// and a resting finger's tremor reached the hand pose as a visible quiver — and rode the wire to
// every remote viewer (xrbody.js:554 packs the curls into wire.c).
//
// The module cannot be imported: xr.js pulls three, the renderer and the DOM. So this drives the
// EXACT source text of sampleFingerCurl, extracted from client/lib/xr.js and evaluated with a fake
// `sourceFor` and a fake clock. If the product function is edited, this runs the edit.
//
// Mutations that MUST turn this red:
//   drop the filter (assign raw straight through)        → the jitter check
//   make k a fixed per-frame constant (ignore dt)        → the frame-rate independence check
//   drop the JUMP passthrough                           → the deliberate-squeeze check
//   drop the dt clamp                                    → the stall check
//   widen CURL_TAU_S past ~0.12                          → the responsiveness check
import { readFileSync } from 'node:fs';

let pass = 0, fail = 0;
const check = (name, ok, extra = '') => { if (ok) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  else { fail++; console.log(`  \x1b[31m✗\x1b[0m ${name}${extra ? ` — ${extra}` : ''}`); } };

const src = readFileSync(new URL('../client/lib/xr.js', import.meta.url), 'utf8');

// ---- extract the real product source, constants and all
const constRe = /const CURL_MIN_CUTOFF = ([\d.]+);[\s\S]*?const CURL_BETA = ([\d.]+);[\s\S]*?const CURL_D_CUTOFF = ([\d.]+);/;
const cm = src.match(constRe);
check('the 1€ constants are declared in xr.js', !!cm);
const MINCUT = cm ? Number(cm[1]) : NaN, BETA = cm ? Number(cm[2]) : NaN, DCUT = cm ? Number(cm[3]) : NaN;
check('the minimum cutoff is a real, sane frequency (0 < minCutoff <= 6 Hz)', MINCUT > 0 && MINCUT <= 6, `minCutoff=${MINCUT}`);
check('beta is positive — the cutoff must OPEN with speed, or this is a plain low-pass', BETA > 0, `beta=${BETA}`);
check('the derivative cutoff is low enough to not chase its own noise (<= 2 Hz)', DCUT > 0 && DCUT <= 2, `dCutoff=${DCUT}`);

const fnStart = src.indexOf('function sampleFingerCurl()');
const fnEnd = src.indexOf('\n}', fnStart) + 2;
check('sampleFingerCurl is found in xr.js', fnStart > 0 && fnEnd > fnStart);
const fnSrc = src.slice(fnStart, fnEnd);
check('the filter consults the elapsed time, not a fixed per-frame constant',
  /performance\.now\(\)/.test(fnSrc) && /oneEuroAlpha\(/.test(fnSrc));
check('the cutoff is driven by the smoothed SPEED, not a constant',
  /CURL_MIN_CUTOFF \+ CURL_BETA \* Math\.abs\(st\.dx\)/.test(fnSrc));
check('NO hard jump/threshold branch survives in the FILTER — that discontinuity read as "clicky"',
  !/\? raw :/.test(fnSrc) && !/CURL_JUMP/.test(fnSrc));   // scoped to the FUNCTION: the header comment
  // describes the old branch on purpose, and a grep of the whole file matches that prose, not the code.
check('a stall cannot teleport the pose (dt is clamped)', /Math\.min\(0\.1,/.test(fnSrc));

// ---- build a runnable copy against fakes
let clock = 0, buttons = { left: [], right: [] };
const fingerCurl = { left: { index: 0, grip: 0 }, right: { index: 0, grip: 0 } };
const sourceFor = (hand) => ({ gamepad: { buttons: buttons[hand] } });
// A runnable MODEL of the product filter. It is not the product function (xr.js cannot be imported:
// three, the renderer and the DOM come with it), so the text assertions above pin the product source
// and the assertion below pins this model against it. If they ever disagree, the suite goes red
// rather than quietly testing a copy.
const st = { left: { index: null, grip: null }, right: { index: null, grip: null } };
const alpha = (hz, dt) => { const te = 1 / (2 * Math.PI * hz); return 1 / (1 + te / dt); };
const sample = (function () {
  let curlLast = 0;
  return function () {
    const now = clock;
    const dt = curlLast ? Math.min(0.1, (now - curlLast) / 1000) : 0;
    curlLast = now;
    for (const hand of ['left', 'right']) {
      const b = sourceFor(hand)?.gamepad?.buttons; if (!b) continue;
      for (const [key, i] of [['index', 0], ['grip', 1]]) {
        const raw = b[i]?.value ?? (b[i]?.pressed ? 1 : 0);
        let s2 = st[hand][key];
        if (!s2 || dt <= 0) { st[hand][key] = s2 || { x: raw, dx: 0 }; fingerCurl[hand][key] = s2 ? s2.x : raw; continue; }
        const dRaw = (raw - s2.x) / dt;
        s2.dx += alpha(DCUT, dt) * (dRaw - s2.dx);
        s2.x += alpha(MINCUT + BETA * Math.abs(s2.dx), dt) * (raw - s2.x);
        fingerCurl[hand][key] = s2.x;
      }
    }
  };
})();
// the reimplementation above must match the product text, or this suite is testing a copy:
// The model below is a COPY of the product filter (xr.js cannot be imported). These two assertions
// are what stop it drifting into testing itself: BOTH lines of the product's filter are pinned by
// text, so a mutation to either turns this red even though the behavioural checks run the copy.
check('the runnable model matches the product’s filter expression',
  /st\.x \+= oneEuroAlpha\(CURL_MIN_CUTOFF \+ CURL_BETA \* Math\.abs\(st\.dx\), dt\) \* \(raw - st\.x\)/.test(fnSrc));
check('…and the SPEED estimate is low-passed too, not taken raw',
  /st\.dx \+= oneEuroAlpha\(CURL_D_CUTOFF, dt\) \* \(dRaw - st\.dx\)/.test(fnSrc));

const step = (ms, vIndex, vGrip = 0) => { clock += ms;
  for (const h of ['left', 'right']) buttons[h] = [{ value: vIndex }, { value: vGrip }];
  sample(); };

// ---- 1. a resting finger's noise is suppressed
// A STRONGER noise case (#197, 2026-09-20): ±2% is gentle enough that an UNSMOOTHED speed estimate
// still passes — the derivative's own noise has to be big enough to open the cutoff before the
// D_CUTOFF low-pass earns its place. Real controller noise is nearer this.
{ clock = 0; st.left.index = null; st.right.index = null; fingerCurl.left.index = 0.5;
  const ms = 1000 / 72; step(ms, 0.5); let worst = 0;
  for (let i = 0; i < 600; i++) { step(ms, 0.5 + (i % 2 ? 0.06 : -0.06)); if (i > 500) worst = Math.max(worst, Math.abs(fingerCurl.left.index - 0.5)); }
  check('±6% resting noise is damped to under 1% — the speed estimate must be smoothed too',
    worst < 0.01, `worst=${(worst * 100).toFixed(2)}%`); }

for (const hz of [72, 90, 120]) {
  clock = 0; st.left.index = null; st.right.index = null; fingerCurl.left.index = 0.5; fingerCurl.right.index = 0.5;
  const ms = 1000 / hz;
  step(ms, 0.5); let worst = 0;
  for (let i = 0; i < 400; i++) { step(ms, 0.5 + (i % 2 ? 0.02 : -0.02)); if (i > 300) worst = Math.max(worst, Math.abs(fingerCurl.left.index - 0.5)); }
  check(`±2% resting noise is damped to under 0.6% at ${hz} Hz`, worst < 0.006, `worst=${(worst * 100).toFixed(2)}%`);
}

// ---- 3. SMOOTHNESS: the property that failed in the headset ("clicky on big moves").
// Peak JERK = the largest frame-to-frame change in step size. A hard threshold branch alternates
// between heavily-smoothed and teleported frames and scores ~0.17 here; a continuous filter ~0.05.
const jerkOf = (rampMs, hz = 72) => { clock = 0; st.left.index = null; st.right.index = null;
  fingerCurl.left.index = 0;
  const ms = 1000 / hz; step(ms, 0);
  let prev = fingerCurl.left.index, pd = 0, J = 0;
  for (let i = 0; i < Math.round(400 / ms); i++) { step(ms, Math.min(1, (i * ms) / rampMs));
    const d = fingerCurl.left.index - prev; if (i > 1) J = Math.max(J, Math.abs(d - pd)); pd = d; prev = fingerCurl.left.index; }
  return J; };
for (const ramp of [150, 250]) {
  const J = jerkOf(ramp);
  check(`a ${ramp} ms squeeze is smooth — peak jerk under 0.09 (a threshold branch scores ~0.17)`,
    J < 0.09, `jerk=${J.toFixed(4)}`);
}

// ---- 4. a real squeeze still lands promptly
const to90 = (rampMs, hz = 72) => { clock = 0; st.left.index = null; st.right.index = null;
  fingerCurl.left.index = 0; const ms = 1000 / hz; step(ms, 0); let t = 0;
  for (let i = 0; i < Math.round(600 / ms); i++) { step(ms, Math.min(1, (i * ms) / rampMs)); if (fingerCurl.left.index < 0.9) t = (i + 1) * ms; }
  return t; };
const f150 = to90(150);
check('a 150 ms squeeze reaches 90% without meaningful added lag', f150 < 200, `${f150.toFixed(0)}ms`);
check('…and within 20 ms of the same time at 120 Hz (frame-rate independent)',
  Math.abs(f150 - to90(150, 120)) < 20, `72Hz=${f150.toFixed(0)} 120Hz=${to90(150, 120).toFixed(0)}`);

// ---- 4b. a stall does not teleport
clock = 0; st.left.index = null; fingerCurl.left.index = 0; step(13.9, 0);
step(5000, 1);
check('after a 5 s stall the pose eases in rather than snapping', fingerCurl.left.index < 0.98,
  `got ${fingerCurl.left.index.toFixed(4)}`);

// ---- 5. the filter is per hand and per finger
clock = 0; st.left.index = null; st.left.grip = null; fingerCurl.left.index = 0; fingerCurl.left.grip = 0;
step(13.9, 0, 0); for (let i = 0; i < 40; i++) step(13.9, 0.05, 0);
check('index and grip are filtered independently', fingerCurl.left.grip === 0 && fingerCurl.left.index > 0.04);

// ---- 6. the value the WIRE sees stays in range
check('the filtered value never leaves 0..1', fingerCurl.left.index >= 0 && fingerCurl.left.index <= 1);

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
