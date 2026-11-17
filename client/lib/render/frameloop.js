// frameloop — the loop as an explicit system list (TEL0S_NOTES §6, §14.2 6b).
//
// Systems REGISTER, in order, and the loop runs the list: each tick is timed into a rolling average (EW.frame() prints
// the bill), carries an enable flag and a frame stride the governor may set (every=2 runs at half rate), and is fenced
// (one throwing system reports instead of killing requestAnimationFrame).
//
// Registration ORDER is execution order, and it carries real constraints (§14.1): motion before remotes (mounted bodies
// derive from parents' motion), sky → materials → rig (sun position), voice-mouths before the avatar update, bodydrag
// before remotes, gaze after remotes, send-pose after every myState writer, render after every scene writer (only the
// XR desktop mirror, which draws after it, and the 1 Hz pulse follow). main.js registers the list;
// this module knows nothing about any system. startFrame() is explicit: the loop starts only after identity resolves.

import { report, bus } from '../base.js';
import { renderer, XR_BOOT } from '../core.js';
import { BC } from '../debug/breadcrumbs.js';
import { perf } from './perf.js';
import { tick as budgetTick } from './framebudget.js';
globalThis.__perf = perf;   // harness: xr-lifecycle-probe reads frameNo to prove the desktop loop ticks after a session ends

const systems = [];
let frameNo = 0;
let last = 0;
let frames = 0;
let fpsAt = 0;

/** Register a system. Order of registration = order of execution. */
export function registerSystem(name, tick, { every = 1 } = {}) {
  const s = { name, tick, every, enabled: true, ms: 0 };
  systems.push(s);
  return s;
}

export function setSystemEvery(name, every) {
  const s = systems.find((x) => x.name === name);
  if (s) s.every = Math.max(1, every | 0);
}
export function getSystemEvery(name) {
  return systems.find((x) => x.name === name)?.every ?? 1;
}
export function setSystemEnabled(name, on) {
  const s = systems.find((x) => x.name === name);
  if (s) s.enabled = !!on;
}

/** The bill: per-system rolling ms, stride, enablement. */
export const frameDebug = () => systems.map((s) => ({
  name: s.name, ms: +s.ms.toFixed(3), every: s.every, enabled: s.enabled,
}));

let windowWorst = 0;
let windowDoubled = 0;
let windowSpikes = 0;
function frame(now) {
  // The first tick after an XR session ends can arrive with a non-finite `now`; a NaN dt would poison the follow
  // camera forever. A frame with no clock is a resume.
  if (!Number.isFinite(now)) now = performance.now();
  budgetTick(now);   // background work's frame opens here — this loop is the one that keeps ticking in XR
  let dtMs = now - last;
  if (!Number.isFinite(dtMs)) dtMs = 0;
  // A RESUME is not a frame: after a blurred XR session (dashboard, headset off) the first tick can carry a huge
  // negative dt. Negative or absurd deltas advance nothing.
  if (dtMs < 0 || dtMs > 2000) dtMs = 0;
  const dt = Math.min(0.1, dtMs / 1000);
  last = now;
  // A hidden tab's resume gap is a suspension, not a 5000 ms jank spike. Real frames feed the ms EWMA and window worst.
  if (dtMs < 2000) {
    perf.ms += (dtMs - perf.ms) * 0.1;
    if (dtMs > windowWorst) windowWorst = dtMs;
    // §22p: pacing vs stutter. On a 60 Hz panel a sub-60 second MUST contain ~33 ms frames (vsync doubling): not a
    // hitch. doubled = waited one extra vsync; spikes = beyond any pacing explanation (>40 ms), the real events.
    if (dtMs > 40) windowSpikes++;
    else if (dtMs > 25) windowDoubled++;
  }
  const t = now / 1000;
  globalThis._sceneTime = t;

  for (const s of systems) {
    if (!s.enabled || (s.every > 1 && frameNo % s.every)) continue;
    BC(s.name);
    const t0 = performance.now();
    try { s.tick(dt, t, now); } catch (e) { report(`frame ${s.name}`, e); }
    s.ms += (performance.now() - t0 - s.ms) * 0.05;   // rolling average
  }
  frameNo++;
  perf.frameNo = frameNo;   // lifetime tick count — the after-exit probe reads it

  frames++;
  if (now - fpsAt > 1000) {
    perf.fps = frames;
    perf.worst = windowWorst;
    perf.doubled = windowDoubled;
    perf.spikes = windowSpikes;
    windowWorst = 0;
    windowDoubled = 0;
    windowSpikes = 0;
    frames = 0;
    fpsAt = now;
  }
  if (!onXRLoop) requestAnimationFrame(frame);
}

// Who drives the loop. An ?xr=1 boot hands frame to three's Animation and it stays there: XRManager.setSession SAVES the
// app loop and wraps it in _onAnimationFrame (the ONLY place the eye framebuffer is bound) on the session clock, and
// restores it on exit. So the hand-over happens BEFORE setSession (xr:loop fires just ahead of it): after it, bare
// frame overwrites three's wrapper and the XR cameras render into the canvas. Never re-arm window.rAF on exit (it
// would run twice).
let onXRLoop = XR_BOOT;
bus.on('xr:loop', () => { if (onXRLoop) return; onXRLoop = true; renderer.setAnimationLoop(frame); });
bus.on('xr:rearm', () => renderer.setAnimationLoop(frame));   // after-exit recovery: the loop three restarted never ticked (xr.js probe)

/** Start the loop. Called once from boot, AFTER identity resolves. */
export function startFrame() {
  last = performance.now();
  fpsAt = last;
  // In an XR session only session.requestAnimationFrame ticks; setAnimationLoop routes to whichever is live.
  if (XR_BOOT) renderer.setAnimationLoop(frame);
  else requestAnimationFrame(frame);
}
