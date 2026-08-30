// loadwork — where load-time CPU goes, measured and spread.
//
// "The client freezes for seconds when things load into the world." Two causes,
// two jobs here:
//
//   MEASURE — every heavy materialization (a body, a spawned model) runs as a
//   labelled work record with phases. The browser's own long-task entries are
//   attributed to whatever work was active when they happened, so a freeze
//   names its culprit in the console instead of being a vibe.
//
//   SPREAD + SERIALIZE — heavy main-thread work yields to the frame loop on a
//   per-frame budget, and at most ONE materialization finalizes at a time.
//   Three bodies arriving together used to stack their parse/compile bursts
//   into the same frames; now they queue, and the queue wait is visible as its
//   own phase rather than masquerading as parse time.
//
// ⚠️ INVARIANT: serialize() is for LEAF operations only (one parse, one
// compile). Never call serialize() from inside a serialized function and never
// wrap a caller that itself awaits a serialized callee — that is a deadlock,
// the chain waits on itself.

import { bus } from './base.js';

// ---- yields -----------------------------------------------------------------

/** Wait for the next animation frame — or a macrotask when the tab is hidden,
 *  where rAF never fires and an avatar load must still finish. */
export const nextFrame = () => new Promise((res) => {
  if (document.hidden) setTimeout(res, 0);
  else requestAnimationFrame(() => res());
});

/** Wait for browser idle time (bounded — loading must finish even on a busy
 *  frame loop), for background work like clip hydration. */
export const idleYield = () => new Promise((res) => {
  if (typeof requestIdleCallback === 'function' && !document.hidden) {
    requestIdleCallback(() => res(), { timeout: 400 });
  } else setTimeout(res, 32);
});

// While the splash still covers the screen nobody sees a dropped frame, so
// load work may take bigger bites; once someone is walking around, 60fps means
// ~16ms frames and load work gets a slice of that, not all of it.
let budgetMs = 14;
bus.on('booted', () => { budgetMs = 6; });

// ---- work records -----------------------------------------------------------

const active = new Set(); // in-flight records, for long-task attribution
const LOG_THRESHOLD_MS = 120;
// Mirrors of the console lines, reachable from automation (Safari's console
// can't be read over WebDriver) and from a quick `__loadJank` in any console.
const loadLog = (globalThis.__loadLog = []);
const jankLog = (globalThis.__loadJank = []);

/** Start a labelled piece of load work. Returns a record:
 *    phase(name)  — enter a named phase (closes the previous one)
 *    tick()       — await this inside loops; yields a frame when the current
 *                   slice is over budget, otherwise resolves immediately
 *    yield()      — unconditional yield to the next frame
 *    end()        — close and log one summary line if the work was heavy
 *  Wall time includes awaited downloads and queue waits — give them their own
 *  phases so the summary tells the truth about where time went. */
export function beginWork(label) {
  const t0 = performance.now();
  const phases = [];
  let phaseName = null;
  let phaseStart = t0;
  let sliceStart = t0;
  let frames = 0;
  let ended = false;

  const closePhase = () => {
    if (phaseName !== null) phases.push([phaseName, performance.now() - phaseStart]);
  };

  const rec = {
    label,
    get phaseName() { return phaseName; },
    phase(name) {
      closePhase();
      phaseName = name;
      phaseStart = performance.now();
    },
    async tick() {
      if (performance.now() - sliceStart < budgetMs) return;
      frames++;
      await nextFrame();
      sliceStart = performance.now();
    },
    async yield() {
      frames++;
      await nextFrame();
      sliceStart = performance.now();
    },
    end() {
      if (ended) return;
      ended = true;
      closePhase();
      active.delete(rec);
      const total = performance.now() - t0;
      if (total < LOG_THRESHOLD_MS) return;
      const parts = phases
        .filter(([, ms]) => ms >= 1)
        .map(([n, ms]) => `${n} ${Math.round(ms)}ms`)
        .join(' · ');
      const line = `${label}: ${parts} — ${Math.round(total)}ms over ${frames + 1} frame(s)`;
      console.log(`[load] ${line}`);
      if (loadLog.length < 300) loadLog.push(line); // reachable without a console (webdriver, evals)
    },
  };
  active.add(rec);
  return rec;
}

/** Record a one-line load fact outside any work record. beginWork only logs
 *  work over 120ms — the right filter for stalls, the wrong one for wins: a
 *  VRM pool hit (§19b) finishes in ~0ms and is exactly the line that proves
 *  the cache worked. Same console tag, same automation mirror, same cap. */
export function loadNote(line) {
  console.log(`[load] ${line}`);
  if (loadLog.length < 300) loadLog.push(line);
}

// ---- serialization ----------------------------------------------------------

/** Queue heavy leaf work. LEAF OPERATIONS ONLY — see the invariant at the top
 *  of this file. Errors reach the caller; the lanes themselves never break.
 *
 *  Two lanes, because two different resources are being protected:
 *    cpu — parses and skeleton passes: genuinely synchronous main-thread work.
 *          Strictly one at a time; two of these in the same frames is the
 *          stall this module exists to prevent.
 *    gpu — pipeline compiles: internally frame-yielding codegen followed by
 *          seconds of WAITING on driver-side pipeline creation. Serializing
 *          that wall time was a mistake this trace paid for: a body queued
 *          19s behind crates whose "work" was mostly idle await. Two in
 *          flight overlaps the waits; the codegen slices still interleave
 *          through the frame loop.
 *
 *  Priority: 2 = your own body, 1 = anyone's body, 0 = objects. People
 *  materialize before furniture, always. Reorders WAITING work only. */
// cpu at 2: a parse's WALL time is dominated by draco workers and image
// decode — awaits, not main-thread work (one conjured model held the serial
// lane 18s on Safari while its webp decoded). Two in flight overlap the
// waits; the genuinely-synchronous chunks still interleave through frames.
const lanes = {
  cpu: { jobs: [], running: 0, max: 2 },
  gpu: { jobs: [], running: 0, max: 2 },
};
export function enqueue(fn, { lane = 'cpu', priority = 0 } = {}) {
  return new Promise((resolve, reject) => {
    const l = lanes[lane] ?? lanes.cpu;
    const job = { fn, priority, resolve, reject };
    const i = l.jobs.findIndex((j) => j.priority < priority);
    if (i === -1) l.jobs.push(job); else l.jobs.splice(i, 0, job);
    pumpLane(l);
  });
}
// (holdObjectCompiles lived here — object compiles paused while a sky was
// building, because the sky's wraps rewrote every graph after the fact. The
// material factory ended that: materials are born with their final shape,
// so there is no wrong moment to compile one. TEL0S_NOTES §12.7.)
function pumpLane(l) {
  while (l.running < l.max && l.jobs.length) {
    const job = l.jobs.shift();
    if (!job) break;
    l.running++;
    (async () => {
      try { job.resolve(await job.fn()); } catch (e) { job.reject(e); }
      finally { l.running--; pumpLane(l); checkIdle(); }
    })();
  }
}
/** Whether any lane holds running or queued work — the same truth checkIdle()
 *  gates on, exposed as a predicate for the governor's loading grace
 *  (§16.2.D): storm fps under live lane work is loading, not a performance
 *  regime. */
export const laneBusy = () => Boolean(
  lanes.cpu.running || lanes.gpu.running
  || lanes.cpu.jobs.length || lanes.gpu.jobs.length);
/** Queue depths per lane — the 8e debug shape (EW.lanes). */
export const laneStats = () => ({
  cpu: { running: lanes.cpu.running, queued: lanes.cpu.jobs.length, max: lanes.cpu.max },
  gpu: { running: lanes.gpu.running, queued: lanes.gpu.jobs.length, max: lanes.gpu.max },
});
// 'lanes-idle' fires when every queued load has finished. (Its one historic
// consumer — the deferred shadow drain — is gone; the event stays as the
// generic "all loadwork settled" signal.)
function checkIdle() {
  if (!lanes.cpu.jobs.length && !lanes.gpu.jobs.length
    && !lanes.cpu.running && !lanes.gpu.running) {
    bus.emit('lanes-idle');
  }
}
/** Back-compat shape used by early call sites. */
export function serialize(fn, { urgent = false, lane = 'cpu', priority } = {}) {
  return enqueue(fn, { lane, priority: priority ?? (urgent ? 2 : 0) });
}

// (holdFrames lived here — presentation paused for one bounded beat while a
// whole-scene recompile settled behind it. Nothing invalidates the whole
// scene anymore — the factory fixes graph shapes at birth, the light rig
// freezes topology at boot, the env texture is persistent — so there is
// nothing left to hold for. TEL0S_NOTES §12.7.)

// ---- long-task attribution --------------------------------------------------
// The browser already measures every main-thread stall over 50ms; all that was
// missing is knowing WHOSE stall it was. Anything unattributed logs as such —
// an honest "the freeze came from somewhere we are not measuring yet".

const activeLabels = () => [...active]
  .map((w) => w.phaseName ? `${w.label}[${w.phaseName}]` : w.label)
  .join(' + ');

try {
  new PerformanceObserver((list) => {
    for (const e of list.getEntries()) {
      if (e.duration < 90) continue;
      console.warn(`[longtask] ${Math.round(e.duration)}ms during: ${activeLabels() || '(unattributed)'}`);
    }
  }).observe({ type: 'longtask', buffered: true });
} catch { /* not supported — the frame-gap watchdog below still measures */ }

// Frame-gap watchdog — Safari has no longtask observer, so frame gaps are the
// portable truth about felt freezes. Anything that holds a frame >150ms logs
// with the same attribution.
// ---- perf beacon ------------------------------------------------------------
// Safari's console can't be read over WebDriver and most visitors never open
// one — so the profile phones home instead: one small POST per session at
// 40s (the load window) and one at 120s (the Safari compile tail), to the
// sequencer's /perflog. That is how WebKit performance gets diagnosed from
// real visits instead of asked-for console screenshots.
// Steady-state smoothness never shows in the jank lines — a constant 25fps
// has no >150ms gaps (exactly how Safari's grass cost stayed invisible). The
// watchdog's own rAF ticks double as an fps estimator; the beacon carries a
// recent-median so per-browser render cost is visible from real visits.
const fpsWindow = [];
let fpsTick = 0;
setInterval(() => {
  fpsWindow.push(fpsTick); fpsTick = 0;
  if (fpsWindow.length > 30) fpsWindow.shift();
}, 1000);
const fpsMedian = () => {
  const s = [...fpsWindow].sort((a, b) => a - b);
  return s.length ? s[(s.length / 2) | 0] : null;
};

function postPerf(mark) {
  try {
    fetch('/perflog', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        mark,
        ua: navigator.userAgent.slice(0, 160),
        boot: globalThis.__bootMarks ?? null,
        fps: fpsMedian(),
        jank: jankLog.slice(0, 100),
        load: loadLog.slice(0, 200),
      }),
    }).catch(() => {});
  } catch { /* never let telemetry hurt the world */ }
}
bus.on('booted', (m) => { globalThis.__bootMarks = m; });
setTimeout(() => postPerf('40s'), 40_000);
setTimeout(() => postPerf('120s'), 120_000);

let lastFrameAt = 0;
requestAnimationFrame(function gapWatch(t) {
  fpsTick++;
  if (lastFrameAt && t - lastFrameAt > 150 && !document.hidden) {
    const line = `${Math.round(t - lastFrameAt)}ms frame gap during: ${activeLabels() || '(unattributed)'}`;
    console.warn(`[jank] ${line}`);
    if (jankLog.length < 200) jankLog.push(line);
  }
  lastFrameAt = t;
  requestAnimationFrame(gapWatch);
});
