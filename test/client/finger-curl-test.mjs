// bun test/client/finger-curl-test.mjs: the analog finger-curl filter (xr-fingercurl.js sampleFingerCurl). Raw trigger/grip values put
// ADC noise and finger tremor on the hand pose and the wire (xrbody.js packs the curls into wire.c).
// The product file is read as text: its constants and its two filter lines are pinned by regex, and a runnable MODEL of
// sampleFingerCurl (below) is what the behaviour rows drive, with a fake `sourceFor` and clock. The function's shape (elapsed
// time, no jump branch, the dt clamp) is test/client/wiring-check.ts's. Product mutations that turn this red:
//   drop the filter, or the low-passed speed (either pinned line)  → the model-matches rows
//   change a 1€ constant                                           → the constant rows, or the behaviour rows (the model reads them)
import { readFileSync } from 'node:fs';
import { suite } from "../gate/suite.ts";

const S = suite("finger-curl");
const check = (name, ok, extra) => S.check(name, ok, extra);

const src = readFileSync(new URL('../../client/lib/xr/xr-fingercurl.js', import.meta.url), 'utf8');

// ---- extract the real product source, constants and all
const constRe = /const CURL_MIN_CUTOFF = ([\d.]+);[\s\S]*?const CURL_BETA = ([\d.]+);[\s\S]*?const CURL_D_CUTOFF = ([\d.]+);/;
const cm = src.match(constRe);
check('the 1€ constants are declared in xr-fingercurl.js', !!cm);
const MINCUT = cm ? Number(cm[1]) : NaN, BETA = cm ? Number(cm[2]) : NaN, DCUT = cm ? Number(cm[3]) : NaN;
check('the minimum cutoff is a real, sane frequency (0 < minCutoff <= 6 Hz)', MINCUT > 0 && MINCUT <= 6, `minCutoff=${MINCUT}`);
check('beta is positive — the cutoff must OPEN with speed, or this is a plain low-pass', BETA > 0, `beta=${BETA}`);
check('the derivative cutoff is low enough to not chase its own noise (<= 2 Hz)', DCUT > 0 && DCUT <= 2, `dCutoff=${DCUT}`);

const fnStart = src.indexOf('function sampleFingerCurl()');
const fnEnd = src.indexOf('\n}', fnStart) + 2;
check('sampleFingerCurl is found in xr-fingercurl.js', fnStart > 0 && fnEnd > fnStart);
const fnSrc = src.slice(fnStart, fnEnd);
// the filter's shape (elapsed time, speed-driven cutoff, no jump branch, dt clamp): test/client/wiring-check.ts

// ---- build a runnable copy against fakes
let clock = 0, buttons = { left: [], right: [] };
const fingerCurl = { left: { index: 0, grip: 0 }, right: { index: 0, grip: 0 } };
const sourceFor = (hand) => ({ gamepad: { buttons: buttons[hand] } });
// a runnable MODEL of the product filter: the text assertions pin the product source, the check below pins this model to it
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
// the model is a COPY: both product lines are pinned by text, so mutating either turns this red
check('the runnable model matches the product’s filter expression',
  /st\.x \+= oneEuroAlpha\(CURL_MIN_CUTOFF \+ CURL_BETA \* Math\.abs\(st\.dx\), dt\) \* \(raw - st\.x\)/.test(fnSrc));
check('…and the SPEED estimate is low-passed too, not taken raw',
  /st\.dx \+= oneEuroAlpha\(CURL_D_CUTOFF, dt\) \* \(dRaw - st\.dx\)/.test(fnSrc));

let lo = Infinity, hi = -Infinity;   // every filtered value any row below produced
const step = (ms, vIndex, vGrip = 0) => { clock += ms;
  for (const h of ['left', 'right']) buttons[h] = [{ value: vIndex }, { value: vGrip }];
  sample();
  for (const h of ['left', 'right']) for (const k of ['index', 'grip']) { lo = Math.min(lo, fingerCurl[h][k]); hi = Math.max(hi, fingerCurl[h][k]); } };

// ---- 1. a resting finger's noise is suppressed
// a STRONGER noise case (#197): ±2% passes an unsmoothed speed estimate; this much opens the cutoff unless the D_CUTOFF
// low-pass works (real controller noise is nearer this)
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

// ---- 3. SMOOTHNESS ("clicky on big moves"): peak JERK = the largest frame-to-frame change in step size. A hard
// threshold branch alternates smoothed and teleported frames (~0.17 here); a continuous filter ~0.05.
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
check('the filtered value never leaves 0..1 (every step of every ramp above)', lo >= 0 && hi <= 1, `min ${lo} max ${hi}`);

S.done();
