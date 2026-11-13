// scheduler — the realizers' job queue (realize/models.js, models_field.js; net.js reads `pending` for world
// progress). A job has a key (dedupe identity), an owner (cancellation scope), a lane (concurrency cap) and a
// priority band re-read at dequeue.
//
// DOM-free and THREE-free (headless-tested in test/client/scheduler-test.ts): pumping rides queueMicrotask.
// Budget slicing inside a job is loadwork.js's business.
// Lane caps are measured: cpu and gpu at 2 (one stuck decode can't serialize a body behind crates; compiles don't
// trample the frame), net at 6 (assets.js's byte-fetch pool). Move them only with a new measurement.

/** Priority bands. FIFO within a band; a function priority is re-read at
 *  dequeue so "near" can follow the camera without rescheduling. */
export const P = Object.freeze({
  BODY_SELF: 100,   // your own body — nothing outranks a person's legs
  BODY: 80,         // anyone else's body
  NEAR: 60,         // in front of you
  VISIBLE: 40,      // on screen
  FAR: 20,          // the world behind you
  COSMETIC: 10,     // sky variants, prefetch, high-LOD swaps
});

const LANES = { net: { max: 6, running: 0 }, cpu: { max: 2, running: 0 }, gpu: { max: 2, running: 0 } };

const queued = new Map();     // key → job
const running = new Map();    // key → job
const idleWaiters = [];       // {fn, minPriority}
let pumping = false;

const prioOf = (job) => (typeof job.priority === 'function' ? Number(job.priority()) || 0 : job.priority ?? 0);

/** Schedule work. Returns {cancel(), done}. Re-scheduling a queued key keeps
 *  ONE job at the higher of the two priorities, with the newer run; a key
 *  currently running finishes, and the new job queues behind it. */
export function schedule({ key, owner = null, lane = 'cpu', priority = P.VISIBLE, run }) {
  if (!LANES[lane]) throw new Error(`[scheduler] unknown lane "${lane}"`);
  if (typeof run !== 'function') throw new Error('[scheduler] run must be a function');
  key ??= `anon-${Math.random().toString(36).slice(2)}`;

  const prev = queued.get(key);
  const job = {
    key, owner, lane, priority, run,
    ctrl: new AbortController(),
    seq: nextSeq++,               // FIFO tiebreak within a band
    resolve: null, reject: null,
  };
  job.done = new Promise((res, rej) => { job.resolve = res; job.reject = rej; });
  // cancellation is a normal outcome, not an unhandled rejection; callers who care await handle.done
  job.done.catch(() => {});

  if (prev) {
    // keep one: the newer run at the higher priority; the replaced job's `done` follows the newcomer's outcome
    job.priority = Math.max(prioOf(prev), prioOf(job));
    job.done.then(prev.resolve, prev.reject);
  }
  queued.set(key, job);
  pump();
  return { cancel: () => cancelJob(job, 'cancelled'), done: job.done };
}

let nextSeq = 1;

function cancelJob(job, why) {
  if (queued.get(job.key) === job) {
    queued.delete(job.key);
    job.reject(new DOMException(why, 'AbortError'));
    settleIdle();
    return;
  }
  if (running.get(job.key) === job) job.ctrl.abort(why);   // run() honours the signal
}

/** Cancel everything under an owner — entity removed, world switched. */
export function cancelOwner(owner) {
  for (const job of [...queued.values()]) if (job.owner === owner) cancelJob(job, `owner ${owner} cancelled`);
  for (const job of [...running.values()]) if (job.owner === owner) job.ctrl.abort(`owner ${owner} cancelled`);
}

/** Outstanding jobs at or above a band (queued + running). The curtain
 *  asks pending(P.BODY) === 0; the loading tray reads the rest. */
export function pending(minPriority = -Infinity) {
  let n = 0;
  for (const j of queued.values()) if (prioOf(j) >= minPriority) n++;
  for (const j of running.values()) if (prioOf(j) >= minPriority) n++;
  return n;
}

/** Resolves (once) when everything at or above the band has drained; immediately if already idle. */
export function onIdle(fn, minPriority = -Infinity) {
  if (pending(minPriority) === 0) { queueMicrotask(fn); return; }
  idleWaiters.push({ fn, minPriority });
}

function settleIdle() {
  for (let i = idleWaiters.length - 1; i >= 0; i--) {
    if (pending(idleWaiters[i].minPriority) === 0) {
      const { fn } = idleWaiters.splice(i, 1)[0];
      queueMicrotask(fn);
    }
  }
}

function pump() {
  if (pumping) return;
  pumping = true;
  queueMicrotask(() => {
    pumping = false;
    for (const lane of Object.keys(LANES)) {
      const L = LANES[lane];
      while (L.running < L.max) {
        const job = takeBest(lane);
        if (!job) break;
        start(L, job);
      }
    }
  });
}

function takeBest(lane) {
  let best = null;
  for (const job of queued.values()) {
    if (job.lane !== lane) continue;
    if (running.has(job.key)) continue;     // same key running: wait it out
    if (!best || prioOf(job) > prioOf(best) || (prioOf(job) === prioOf(best) && job.seq < best.seq)) best = job;
  }
  if (best) queued.delete(best.key);
  return best;
}

function start(L, job) {
  L.running++;
  running.set(job.key, job);
  Promise.resolve()
    .then(() => job.run(job.ctrl.signal))
    .then(job.resolve, job.reject)
    .finally(() => {
      L.running--;
      running.delete(job.key);
      settleIdle();
      pump();
    });
}

/** Test/debug introspection — counts only, never the jobs. */
export function laneStats() {
  const out = {};
  for (const [name, L] of Object.entries(LANES)) {
    let q = 0;
    for (const j of queued.values()) if (j.lane === name) q++;
    out[name] = { running: L.running, queued: q, max: L.max };
  }
  return out;
}
