// frame — the loop as an explicit system list (TEL0S_NOTES §6, §14.2 6b).
//
// The frame used to be a 60-line function body in main.js: every call
// hand-ordered, every cost invisible, and the governor pulling levers with
// no idea which system was eating the frame. Now systems REGISTER, in
// order, and the loop runs the list: each tick is timed into a rolling
// average (EW.frame() prints the bill), each carries an enable flag and a
// frame stride the governor may set (a cosmetic system at every=2 runs at
// half rate), and each is fenced — one throwing system reports (throttled)
// instead of killing requestAnimationFrame and freezing the world.
//
// Registration ORDER is the execution order, and the order carries real
// constraints (§14.1): motion before remotes (mounted bodies derive from
// parents motion already ticked), sky → materials → rig (sun position),
// voice-mouths before the avatar update that consumes them, bodydrag
// before remotes, gaze after remotes, send-pose after every myState
// writer, render last. main.js registers the list; this module knows
// nothing about any system.
//
// startFrame() is explicit: today the loop deliberately starts only after
// the identity RTT resolves — a module that self-started on import would
// change boot ordering silently (§14.1).

import { report, bus } from './base.js';
import { renderer, XR_BOOT } from './core.js';
import { BC } from './bc.js';
import { perf } from './perf.js';

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
  // The first tick after an XR session ends arrives with a non-finite `now` (three re-arms the loop; 09-07 00:20,
  // emulated headset): dtMs went NaN straight through the guard below, the follow camera lerped by NaN once and
  // stayed NaN forever — R's BLACK DESKTOP AFTER LEAVING VR (09-06 12:46 → 23:43). A frame with no clock is a resume.
  if (!Number.isFinite(now)) now = performance.now();
  let dtMs = now - last;
  if (!Number.isFinite(dtMs)) dtMs = 0;
  // A RESUME is not a frame. Under an XR session the loop ticks on the
  // session's clock and stops while the session is blurred (SteamVR
  // dashboard, headset off); the first tick back arrived with dtMs = -72464
  // (R's recorder, 09-04 23:41) and a negative dt went straight into the
  // body physics. Negative or absurd deltas advance nothing.
  if (dtMs < 0 || dtMs > 2000) dtMs = 0;
  const dt = Math.min(0.1, dtMs / 1000);
  last = now;
  // A hidden tab suspends rAF; the resume gap is a suspension, not a frame —
  // it must not read as a 5000ms jank spike. Real frames feed the ms EWMA
  // and the window's worst.
  if (dtMs < 2000) {
    perf.ms += (dtMs - perf.ms) * 0.1;
    if (dtMs > windowWorst) windowWorst = dtMs;
    // §22p: pacing vs stutter. On a 60Hz panel every sub-60 second MUST
    // contain ~33ms frames (vsync doubling) — that is arithmetic, not a
    // hitch, and reading it as "worst 34ms" sent us hunting a ghost.
    // doubled = frames that waited one extra vsync; spikes = frames beyond
    // ANY pacing explanation (>40ms) — only those are real events.
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
  perf.frameNo = frameNo;   // lifetime tick count — the after-exit probe reads it (perf.frames never existed; that field teed 0 since 09-06)

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

// Who drives the loop. An ?xr=1 boot hands frame to three's Animation at boot and it stays there: three's
// XRManager.setSession SAVES the current app loop, wraps it in _onAnimationFrame (the ONLY place the eye
// framebuffer is bound — backend.setXRTarget(glBaseLayer.framebuffer) — before the app loop runs), moves it
// to the session clock, and restores it to window.rAF on exit. The visor enters in place since 09-07, so the
// hand-over must happen the same way: BEFORE setSession (xr:loop fires just ahead of it). Handing over AFTER
// setSession (684c716, one afternoon) overwrote three's wrapper with bare frame — session clock at 90 fps,
// the XR cameras rendered into the CANVAS, setXRTarget never called (loop-identity probe: liveLoop='frame',
// savedAppLoop=null, 0 binds/s) — and R saw the WebXR construct all day. Once handed over the loop stays on
// three's Animation; re-arming window.rAF ourselves on exit would run it twice.
let onXRLoop = XR_BOOT;
bus.on('xr:loop', () => { if (onXRLoop) return; onXRLoop = true; renderer.setAnimationLoop(frame); });
bus.on('xr:rearm', () => renderer.setAnimationLoop(frame));   // after-exit recovery: the loop three restarted never ticked (xr.js probe)

/** Start the loop. Called once from boot, AFTER identity resolves. */
export function startFrame() {
  last = performance.now();
  fpsAt = last;
  // Inside an XR session the window's rAF stops (or detaches from the
  // headset's cadence) and only session.requestAnimationFrame ticks —
  // renderer.setAnimationLoop routes to whichever is live. Desktop boot
  // keeps the plain rAF loop byte-for-byte.
  if (XR_BOOT) renderer.setAnimationLoop(frame);
  else requestAnimationFrame(frame);
}
