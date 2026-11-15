// loadwork — where load-time CPU goes, measured and spread.
//
//   MEASURE — every heavy materialization (a body, a spawned model) runs as a labelled work record with phases;
//   the browser's long-task entries are attributed to whatever work is active when the observer runs (a record that
//   already ended reads "(unattributed)").
//
//   SPREAD + SERIALIZE — heavy main-thread work yields to the frame loop on a per-frame budget, and materializations
//   queue in lanes (the queue wait is its own phase, not masquerading as parse time).
//
// ⚠️ INVARIANT: serialize() is for LEAF operations only (one parse, one
// compile). Never call serialize() from inside a serialized function and never
// wrap a caller that itself awaits a serialized callee — that is a deadlock,
// the chain waits on itself.

import { bus } from '../base.js';
import { nextFrame as budgetFrame, ask, spent, reportPending } from './framebudget.js';

// ---- yields -----------------------------------------------------------------

/** Wait for the next frame (framebudget: window rAF, which xr_frame_clock routes to the session clock in XR; a
 *  macrotask when the tab is hidden, where an avatar load must still finish; never longer than its watchdog). */
export const nextFrame = budgetFrame;

/** Wait for browser idle time (bounded — loading must finish even on a busy
 *  frame loop), for background work like clip hydration. */
export const idleYield = () => new Promise((res) => {
  if (typeof requestIdleCallback === 'function' && !document.hidden) {
    requestIdleCallback(() => res(), { timeout: 400 });
  } else setTimeout(res, 32);
});

// The slice size is framebudget's: one budget per frame shared with the warm conductor and the sky (bigger bites
// under the splash, a governor-set share of the frame once someone is walking around).

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
  let grant = null;   // this record's current framebudget grant (its hold is released when the slice reports)

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
      const now = performance.now();
      spent('load', now - sliceStart, sliceStart, grant);
      sliceStart = now;
      if ((grant = ask('load'))) return;
      let waited = 0;   // aging is per record: one busy record cannot hold the others back
      do { frames++; waited++; await nextFrame(); } while (!(grant = ask('load', { waited })));
      sliceStart = performance.now();
    },
    async yield() {
      // a whole frame, then the same grant as tick(): the work after a yield is budgeted like any other slice
      spent('load', performance.now() - sliceStart, sliceStart, grant);
      grant = null;
      let waited = 0;
      do { frames++; waited++; await nextFrame(); } while (!(grant = ask('load', { waited })));
      sliceStart = performance.now();
    },
    end() {
      if (ended) return;
      ended = true;
      spent('load', performance.now() - sliceStart, sliceStart, grant);   // the last slice, and its hold released
      grant = null;
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

/** Record a one-line load fact outside any work record (beginWork only logs work over LOG_THRESHOLD_MS; a VRM pool
 *  hit finishes in ~0 ms and is the line that proves the cache worked). Same tag, mirror and cap. */
export function loadNote(line) {
  console.log(`[load] ${line}`);
  if (loadLog.length < 300) loadLog.push(line);
}

// ---- serialization ----------------------------------------------------------

/** Queue heavy leaf work. LEAF OPERATIONS ONLY — see the invariant at the top of this file. Errors reach the caller;
 *  the lanes never break. Two lanes, two resources:
 *    cpu — parses and skeleton passes (main-thread work).
 *    gpu — pipeline compiles: frame-yielding codegen, then seconds of WAITING on the driver. Two in flight overlap
 *          the waits; the codegen slices still interleave through the frame loop.
 *  Priority: 2 = your own body, 1 = anyone's body, 0 = objects. Reorders WAITING work only. */
// cpu at 2 as well: a parse's WALL time is mostly draco workers and image decode (awaits), so two overlap the waits.
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
    reportLanes();
  });
}
function pumpLane(l) {
  while (l.running < l.max && l.jobs.length) {
    const job = l.jobs.shift();
    if (!job) break;
    l.running++;
    (async () => {
      try { job.resolve(await job.fn()); } catch (e) { job.reject(e); }
      finally { l.running--; pumpLane(l); reportLanes(); checkIdle(); }
    })();
  }
}
/** Whether any lane holds running or queued work. */
export const laneBusy = () => Boolean(
  lanes.cpu.running || lanes.gpu.running
  || lanes.cpu.jobs.length || lanes.gpu.jobs.length);
const reportLanes = () => reportPending('lanes',
  lanes.cpu.running + lanes.gpu.running + lanes.cpu.jobs.length + lanes.gpu.jobs.length);
/** Queue depths per lane (debug shape). */
export const laneStats = () => ({
  cpu: { running: lanes.cpu.running, queued: lanes.cpu.jobs.length, max: lanes.cpu.max },
  gpu: { running: lanes.gpu.running, queued: lanes.gpu.jobs.length, max: lanes.gpu.max },
});
// 'lanes-idle' fires when every queued load has finished (the generic "all loadwork settled" signal).
function checkIdle() {
  if (!lanes.cpu.jobs.length && !lanes.gpu.jobs.length
    && !lanes.cpu.running && !lanes.gpu.running) {
    bus.emit('lanes-idle');
  }
}
/** enqueue with the older `urgent` flag (priority 2). */
export function serialize(fn, { urgent = false, lane = 'cpu', priority } = {}) {
  return enqueue(fn, { lane, priority: priority ?? (urgent ? 2 : 0) });
}


// ---- long-task attribution --------------------------------------------------
// The browser measures every main-thread stall over 50ms; this says WHOSE it was (or "(unattributed)").

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

// Frame-gap watchdog (bottom of the file): Safari has no longtask observer, so frame gaps >150ms are the portable
// truth about felt freezes, with the same attribution. Its rAF ticks double as an fps estimator.
// ---- perf beacon ------------------------------------------------------------
// Safari's console can't be read over WebDriver and most visitors never open one, so the profile phones home: one
// POST at 40s (the load window) and one at 120s (the compile tail) to the sequencer's /perflog, with a recent fps
// median (a constant 25fps has no >150ms gaps).
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
