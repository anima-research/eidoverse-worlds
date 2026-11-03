// gputime — how many milliseconds of GPU the world's frame costs, measured by the GPU itself (Debug › gpu timer).
//
// A VR frame here is GPU-bound (CPU 3–5 ms of 25–100), and a headless browser cannot time a real GPU, so every
// "is shadow quality / MSAA / X worth it" question needs this number from the headset. One EXT_disjoint_timer_query
// TIME_ELAPSED query brackets renderWorld's world pass (shadow maps + both eyes + post), read back a few frames later
// from a small ring; a frame the driver flags DISJOINT (context switch, clock change) is thrown away, not averaged.
// Our own top-level query: three's per-context timestamps cannot nest (its pool refuses a second active query), so
// the shadow pass inside the main render would fold into the main number and read as nothing on its own.
//
// measureShadowPass(): alternates frames with the shadow maps RE-RENDERED and HELD (shadow.autoUpdate — uniform-
// level, no recompile; a held map is the same map, so the image does not change) and reports the difference: what
// drawing the shadow maps costs per frame. Sampling them on every lit pixel is not in that number (turning that off
// recompiles) — for it, and for MSAA (reload-time), flip the Video setting and read the live number before/after.
//
// Not measured: renders outside renderWorld (sky bakes, the desktop mirror). WebGPU backend: unavailable (needs the
// timestamp-query device feature, requested at boot) — the row says so.
import { renderer, scene } from './core.js';
import { reassertShadowPref } from './lightrig.js';

const S = { on: false, supported: null, reason: null, gl: null, ext: null, active: null, pending: [], free: [],
  samples: [], ab: null, abResult: null };
const WINDOW = 120, MAX_PENDING = 8;

function probe() {
  if (S.supported !== null) return;
  const gl = renderer.backend?.gl ?? null;
  if (!gl) { S.supported = false; S.reason = 'WebGPU backend — the GPU timer needs WebGL 2 here'; return; }
  const ext = gl.getExtension('EXT_disjoint_timer_query_webgl2');
  if (!ext) { S.supported = false; S.reason = 'this browser does not expose EXT_disjoint_timer_query_webgl2'; return; }
  S.gl = gl; S.ext = ext; S.supported = true;
}

export function setGpuTimer(on) {
  probe();
  S.on = !!on && S.supported;
  if (!S.on) {
    S.samples.length = 0;
    // an A/B still stepping holds some shadow maps (autoUpdate off): give them back, and answer the caller
    if (S.ab && !S.ab.closing) { for (const [l, a] of S.ab.saved) l.shadow.autoUpdate = a; reassertShadowPref(); S.ab.resolve({ error: 'cancelled (gpu timer turned off)' }); }
    S.ab = null;
  }
  return gpuTimerState();
}
export const gpuTimerOn = () => S.on;

function poll() {
  const { gl, ext } = S;
  const disjoint = gl.getParameter(ext.GPU_DISJOINT_EXT);
  while (S.pending.length) {
    const p = S.pending[0];
    if (!gl.getQueryParameter(p.q, gl.QUERY_RESULT_AVAILABLE)) break;
    S.pending.shift();
    const ns = gl.getQueryParameter(p.q, gl.QUERY_RESULT);
    S.free.push(p.q);
    if (disjoint) continue;
    const ms = ns / 1e6;
    if (p.tag) { if (S.ab) S.ab[p.tag].push(ms); }
    else { S.samples.push(ms); if (S.samples.length > WINDOW) S.samples.shift(); }
  }
}

/** renderWorld calls these around the world pass. */
export function gpuBegin() {
  if (!S.on || S.active) return;
  poll();
  if (S.pending.length >= MAX_PENDING) return;     // results lagging: skip a frame rather than grow
  const tag = S.ab && !S.ab.closing ? abStep() : null;
  const q = S.free.pop() ?? S.gl.createQuery();
  S.gl.beginQuery(S.ext.TIME_ELAPSED_EXT, q);
  S.active = { q, tag };
}
export function gpuEnd() {
  if (!S.active) return;
  S.gl.endQuery(S.ext.TIME_ELAPSED_EXT);
  S.pending.push(S.active);
  S.active = null;
}

const casters = () => { const out = []; scene.traverse((o) => { if (o.isLight && o.castShadow && o.shadow) out.push(o); }); return out; };

function abStep() {
  const ab = S.ab;
  // finish BEFORE tagging: restoring autoUpdate in the same step as the last tag let that 'held' frame draw its shadow
  // maps (Greptile #206), so the final sample measured the wrong thing. The frame that finishes is simply untagged.
  if (ab.i >= ab.frames * 2) { finishAB(); return null; }
  const tag = ab.i++ % 2 ? 'held' : 'drawn';
  for (const [l] of ab.saved) l.shadow.autoUpdate = tag === 'drawn';
  return tag;
}
function finishAB() {
  const ab = S.ab;
  for (const [l, a] of ab.saved) l.shadow.autoUpdate = a;
  reassertShadowPref();   // a shadows toggle during the A/B wins over the value saved at its start (review 7, L5)
  // results for the last few frames are still in flight: settle, then summarise
  S.ab = { ...ab, closing: true };
  setTimeout(() => {
    const mean = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : NaN);
    const d = mean(ab.drawn), h = mean(ab.held);
    S.abResult = { drawnMs: +d.toFixed(2), heldMs: +h.toFixed(2), shadowPassMs: +(d - h).toFixed(2),
      frames: `${ab.drawn.length}/${ab.held.length}`, casters: ab.saved.length };
    ab.resolve(S.abResult);
    if (S.ab?.resolve === ab.resolve) S.ab = null;   // not a newer measurement started meanwhile
  }, 500);
}

/** A/B the shadow-map draw: `frames` frames re-rendering the maps, interleaved with `frames` holding them. */
export function measureShadowPass(frames = 60) {
  probe();
  if (!S.supported) return Promise.resolve({ error: S.reason });
  if (S.ab) return Promise.resolve({ error: 'a measurement is already running' });
  if (!S.on) setGpuTimer(true);
  const saved = casters().map((l) => [l, l.shadow.autoUpdate]);
  if (!saved.length) return Promise.resolve({ error: 'no shadow-casting light (shadows off?)' });
  return new Promise((resolve) => { S.ab = { frames, i: 0, saved, drawn: [], held: [], resolve }; });
}

export function gpuTimerState() {
  probe();
  const s = [...S.samples].sort((a, b) => a - b);
  const avg = s.length ? s.reduce((a, v) => a + v, 0) / s.length : null;
  const p95 = s.length ? s[Math.min(s.length - 1, Math.floor(s.length * 0.95))] : null;
  return { supported: S.supported, reason: S.reason, on: S.on, frames: s.length,
    avgMs: avg == null ? null : +avg.toFixed(2), p95Ms: p95 == null ? null : +p95.toFixed(2),
    measuring: !!S.ab, abStepping: !!S.ab && !S.ab.closing, shadowPass: S.abResult };
}

/** One line for the panels. */
export function gpuLine() {
  const st = gpuTimerState();
  if (!st.supported) return `gpu: unavailable — ${st.reason}`;
  if (!st.on) return 'gpu: timer off';
  if (!st.frames) return 'gpu: measuring…';
  return `gpu ${st.avgMs.toFixed(1)} ms avg · ${st.p95Ms.toFixed(1)} p95 (${st.frames} frames)`;
}
export function shadowPassLine() {
  const r = S.abResult;
  if (S.ab) return 'shadow pass: measuring…';
  if (!r) return 'shadow pass: not measured';
  return `shadow pass ${r.shadowPassMs.toFixed(2)} ms/frame (drawn ${r.drawnMs} vs held ${r.heldMs}; ${r.casters} caster light${r.casters === 1 ? '' : 's'})`;
}
