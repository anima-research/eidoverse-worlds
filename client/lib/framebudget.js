// framebudget — one per-frame budget for background work, shared by every producer.
//
// warmqueue (pipeline warms), loadwork (parse/compile slices) and the baked sky (band renders) each used to pace
// themselves: one item per rAF, a private 6 ms slice per work record, one band per frame. None knew what the others
// spent, so they stacked in the same frame (owner's jank lines: "sky build + xr pipelines + compile ×5 + depth ×8").
// This is the shape Unity (asyncUploadTimeSlice, backgroundLoadingPriority) and React's scheduler use:
//
//   - ONE budget per frame: a governor-set share of the measured frame period, never more than the old 6 ms slice
//     (MAX_MS); a fixed SPLASH_MS while the splash covers the screen.
//   - Measure, then predict: producers call spent(lane, ms, since, grant) with what the work took on the main thread;
//     each grant holds the lane's EWMA of that until its own measurement replaces it. The first grant of a frame may
//     overrun, even under debt (progress is guaranteed); the overrun is carried as debt into the next frame (capped
//     at one budget), so it delays the OTHER producers.
//   - Nothing starves: turn() grants a waiter that has been denied AGE_FRAMES frames in a row (per waiter, so one
//     busy work record cannot hold the others back).
//   - GPU work counts in UNITS, not ms (GPU timers answer frames late): at most one gpu unit per frame.
//
// The frame is the render loop's: frame.js calls tick() first thing, and a yield (nextFrame) is window rAF — which
// xr_frame_clock.js routes to the session's clock during a real XR session — raced with a WATCHDOG_MS timeout, so no
// waiter can outlive a stopped clock. Books roll once per frame, deduped on the frame timestamp.
//
// busy() is the loading signal the governor's grace reads: producers report how much LOADING work they hold
// (reportPending). Steady-state work (the sky's cadence re-bakes) spends from the budget but is not loading.

import { bus } from './base.js';

const SPLASH_MS = 14;        // under the splash: big bites (loadwork's pre-boot number)
const MAX_MS = 6;            // once booted, never more than the old per-record slice, however long the frame
const AGE_FRAMES = 8;        // a waiter denied this many frames in a row is granted anyway
const WATCHDOG_MS = 250;     // no waiter waits longer than this for a frame

let share = 0.36;            // ≈ 6 ms at 60 Hz
let booted = false;
let periodMs = 1000 / 60;    // EWMA of the render loop's frame period
let frameStart = 0;
let spentThis = 0;           // ms charged in the current frame
let debt = 0;                // overrun carried from the previous frame
let gpuUnits = 0;            // gpu units granted in the current frame
let grantsThis = 0;          // grants in the current frame (the free first grant goes to ONE caller)
let frameNo = 0;
let lastTickTs = -1;         // the loop's own previous timestamp (period)
let lastRollTs = -1;         // the last frame the books were rolled for (dedupe)
let lastTickWall = 0;        // performance.now() at the loop's last tick (is the loop alive?)
const lanes = new Map();     // lane → { spent, grants, denied, pending, ewma } — stats and busy()

bus.on('booted', () => { booted = true; });

const laneOf = (name) => {
  let l = lanes.get(name);
  if (!l) lanes.set(name, (l = { spent: 0, grants: 0, denied: 0, pending: 0, ewma: 0 }));
  return l;
};

/** The ms background work may use this frame, before debt. */
export const budgetMs = () => (booted ? Math.min(MAX_MS, share * periodMs) : SPLASH_MS);
const remaining = () => budgetMs() - debt - spentThis;

// Close the current frame's books and open the next. Deduped on the frame timestamp: the loop and every rAF waiter
// in one frame see the same one.
function roll(ts) {
  if (ts === lastRollTs) return;
  lastRollTs = ts;
  frameStart = performance.now();
  debt = Math.min(budgetMs(), Math.max(0, debt + spentThis - budgetMs()));
  spentThis = 0;
  gpuUnits = 0;
  grantsThis = 0;
  frameNo++;
}

/** Called once per frame by the render loop, first thing. */
export function tick(now = performance.now()) {
  lastTickWall = performance.now();
  const dt = now - lastTickTs;
  if (lastTickTs >= 0 && dt > 4 && dt < 100) periodMs += (dt - periodMs) * 0.1;
  lastTickTs = now;
  roll(now);
}

/** Resolve on the next frame: window rAF (the session's clock in a real XR session, via xr_frame_clock), a macrotask
 *  in a hidden tab, and never later than WATCHDOG_MS whatever the clock is doing. */
export function nextFrame() {
  return new Promise((res) => {
    let done = false, wd = 0;
    const once = (ts) => { if (done) return; done = true; clearTimeout(wd); roll(ts); res(); };
    // a hidden document whose render loop still ticks is a PC headset session (the desktop window occluded): its rAF is
    // the session's clock (xr_frame_clock), so it stays on rAF rather than rolling a fresh frame per timeout
    const loopLive = performance.now() - lastTickWall < WATCHDOG_MS;
    const hidden = typeof document !== 'undefined' && document.hidden && !loopLive;
    if (!hidden && typeof requestAnimationFrame === 'function') requestAnimationFrame(once);
    else setTimeout(() => once(performance.now()), hidden ? 0 : 16);
    wd = setTimeout(() => once(performance.now()), WATCHDOG_MS);
  });
}

/** May `lane` spend now? Returns a GRANT (truthy; pass it to spent()) or false. The first grant of a frame always
 *  passes, even under debt (so a producer that overruns every frame still progresses; its overrun delays the others);
 *  `waited` (frames this caller has been denied in a row, turn() keeps it) ≥ AGE_FRAMES passes; `gpu: true` asks for
 *  this frame's one gpu unit. */
export function ask(lane, { gpu = false, waited = 0 } = {}) {
  const l = laneOf(lane);
  const starved = waited >= AGE_FRAMES;
  // the free first grant is counted by GRANTS, not spend: a grant charges only after its work runs, and every caller
  // asking in between would otherwise see nothing spent and be waved through too
  const room = starved || grantsThis === 0 || remaining() > 0;
  const ok = gpu ? gpuUnits === 0 && room : room;
  if (!ok) { l.denied++; return false; }
  l.grants++;
  grantsThis++;
  if (gpu) gpuUnits++;
  // hold the lane's typical cost until THIS grant's work reports: a grant charges only after its work runs, and
  // without the hold every ask in between would see an empty frame. Per grant: several records share a lane.
  spentThis += l.ewma;
  return { held: l.ewma, frame: frameNo };
}

/** Charge measured main-thread time, releasing `grant`'s hold if it was taken this frame (a hold from an earlier
 *  frame was cleared by the roll). With `since` (when the slice began): a slice that began before this frame resumed
 *  from an await (a fetch, a worker, a queue) and its main-thread share is unknowable — it charges nothing and leaves
 *  the lane's estimate alone, rather than bill this frame for the render loop's own time. The undercount is at most
 *  one slice per resumption. */
export function spent(lane, ms, since = null, grant = null) {
  const unknown = since != null && since < frameStart;
  const v = unknown ? 0 : since == null ? Math.max(0, ms) : Math.max(0, Math.min(ms, performance.now() - since));
  const l = laneOf(lane);
  if (grant && grant.frame === frameNo) { spentThis -= grant.held; grant.held = 0; }
  spentThis += v;
  l.spent += v;
  if (!unknown) l.ewma += (v - l.ewma) * 0.2;
}

/** Ask, then wait whole frames until granted — aging per caller. Resolves with the grant. */
export async function turn(lane, opts = {}) {
  let waited = 0, g;
  while (!(g = ask(lane, { ...opts, waited }))) { waited++; await nextFrame(); }
  return g;
}

/** How much LOADING work `lane` holds (queued + running). */
export function reportPending(lane, n) { laneOf(lane).pending = Math.max(0, n | 0); }

/** Is anything loading? */
export function busy() {
  for (const l of lanes.values()) if (l.pending > 0) return true;
  return false;
}

/** The governor's knob: the share of the frame period background work may use once booted. */
export function setShare(s) { share = Math.min(0.8, Math.max(0.05, +s || 0)); }

/** Debug shape (EW.budget). */
export const budgetStats = () => ({
  frameNo, periodMs: +periodMs.toFixed(2), share, budgetMs: +budgetMs().toFixed(2), debt: +debt.toFixed(2),
  spentThis: +spentThis.toFixed(2), booted,
  lanes: Object.fromEntries([...lanes].map(([k, l]) => [k, {
    spent: Math.round(l.spent), grants: l.grants, denied: l.denied, pending: l.pending, ewma: +l.ewma.toFixed(2) }])),
});

/** Tests only: reset module state. */
export function __resetForTest() {
  share = 0.36; booted = false; periodMs = 1000 / 60; frameStart = 0; spentThis = 0; debt = 0;
  gpuUnits = 0; grantsThis = 0; frameNo = 0; lanes.clear(); lastTickTs = -1; lastRollTs = -1; lastTickWall = 0;
}
export function __setBootedForTest(b) { booted = !!b; }
