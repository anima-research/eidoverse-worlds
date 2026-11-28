// xr-fingercurl — the analog finger curl from the triggers and grips, through a 1€ filter (test/client/finger-curl-test.mjs).
import { CONFIG } from '../base.js';

// finger curl surrogate: trigger value → index, grip value → the other three
const fingerCurl = { left: { index: 0, grip: 0 }, right: { index: 0, grip: 0 } };
export const xrFingerCurl = () => fingerCurl;
// curls go through a 1€ filter (Casiez, Roussel & Vogel, CHI 2012): the cutoff rises with the finger's speed, so
// rest is smooth and a squeeze doesn't lag. test/client/finger-curl-test.mjs.
const CURL_MIN_CUTOFF = 2.0;   // Hz: lower = quieter at rest
const CURL_BETA = 3.0;         // how hard the cutoff opens with speed: higher = less lag, more noise
const CURL_D_CUTOFF = 1.0;     // Hz, for the speed estimate itself
export const CURL_PROBE = CONFIG.params.has('curlprobe');
const curlProbe = { left: { index: { last: null, peak: 0, sum: 0, n: 0 }, grip: { last: null, peak: 0, sum: 0, n: 0 } },
                    right: { index: { last: null, peak: 0, sum: 0, n: 0 }, grip: { last: null, peak: 0, sum: 0, n: 0 } } };
export function curlProbeTake() { const out = {};
  for (const h of ['left', 'right']) for (const k of ['index', 'grip']) { const p = curlProbe[h][k];
    if (p.n) out[`${h[0]}${k[0]}`] = [+p.peak.toFixed(4), +(p.sum / p.n).toFixed(4), p.n];
    p.peak = 0; p.sum = 0; p.n = 0; }
  return out; }
let curlLast = 0;
const curlState = { left: { index: null, grip: null }, right: { index: null, grip: null } };
const oneEuroAlpha = (cutoffHz, dt) => { const te = 1 / (2 * Math.PI * cutoffHz); return 1 / (1 + te / dt); };
export function sampleFingerCurl() {
  const now = performance.now();
  const dt = curlLast ? Math.min(0.1, (now - curlLast) / 1000) : 0;   // clamp: a stall must not teleport the pose
  curlLast = now;
  for (const hand of ['left', 'right']) {
    const gp = sourceFor(hand)?.gamepad; const b = gp?.buttons;
    if (!b) continue;
    for (const [key, i] of [['index', 0], ['grip', 1]]) {
      const raw = b[i]?.value ?? (b[i]?.pressed ? 1 : 0);
      if (CURL_PROBE) { const p = curlProbe[hand][key];   // RAW jitter, so tuning is measured not felt
        if (p.last !== null) { const d = Math.abs(raw - p.last); if (d > 0 && d < 0.12) { p.peak = Math.max(p.peak, d); p.sum += d; p.n++; } }
        p.last = raw; }
      let st = curlState[hand][key];
      if (!st || dt <= 0) { curlState[hand][key] = st || { x: raw, dx: 0 }; fingerCurl[hand][key] = st ? st.x : raw; continue; }
      const dRaw = (raw - st.x) / dt;                                  // speed, from the FILTERED previous value
      st.dx += oneEuroAlpha(CURL_D_CUTOFF, dt) * (dRaw - st.dx);       // smooth the speed estimate too
      st.x += oneEuroAlpha(CURL_MIN_CUTOFF + CURL_BETA * Math.abs(st.dx), dt) * (raw - st.x);
      fingerCurl[hand][key] = st.x;
    }
  }

}

// the hands' gamepad source (xr.js sourceFor), bound once at load
let sourceFor = () => null;
export function bindCurlSource(fn) { sourceFor = fn; }
