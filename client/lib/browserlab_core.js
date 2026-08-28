// browserlab_core — the arithmetic and the refusals, with no browser in them.
//
// Everything in browserlab.js that decides whether a number may be PUBLISHED
// lives here instead: which renderer counter is a per-frame cost, whether a
// frame-time distribution is a renderer or a throttle, and whether two receipts
// are describing the same scene. Those are the claims a reviewer has to trust,
// so they are DOM-free, THREE-free, dependency-free, and unit-tested with
// mutations in tools/browserlab-core-test.ts.
//
// The rule the whole file serves: a measurement harness that cannot tell a
// number from a non-number will publish the non-number. Every function here
// returns 'unknown' rather than guessing.

// ---- renderer counters ------------------------------------------------------
//
// three's WebGPU info object carries BOTH kinds and does not say which is
// which at the call site (r180 field docs):
//
//   render.calls       "since the app has been started"   — LIFETIME
//   render.drawCalls   "of the current frame"             — PER FRAME
//   render.triangles   "of the current frame"             — PER FRAME
//
// This harness read `render.calls` and labelled it per-frame. Measured on the
// live client: `calls` advances by exactly 3 per frame (three render passes),
// while `drawCalls` sits at 92 and `triangles` at 2,456,705 across six
// consecutive frames. So the committed receipts reported ~6,186 "draws" for a
// scene that draws 92 — a lifetime total presented as a frame cost, growing
// arm over arm because time passed, not because the arm changed anything.
//
// The old heuristic (`delta > start * 0.5`) could not have caught it: once a
// lifetime total is large, one frame's growth is never half of it. Magnitude
// was the wrong question. The right one is SHAPE, observed over consecutive
// frames, and it is answered here rather than assumed.

/**
 * Classify a counter from consecutive per-frame samples.
 *
 * per-frame  → every sample identical (the renderer zeroed it each frame)
 * cumulative → strictly increasing by a consistent step (a running total)
 * unknown    → anything else: a counter that both grows and shrinks, or grows
 *              unevenly, is not something to quote a frame cost from.
 *
 * `tolerance` is the fraction two steps may differ by and still count as the
 * same step; scene load genuinely varies a little frame to frame.
 */
export function classifyCounter(samples, { tolerance = 0.25 } = {}) {
  const s = (samples ?? []).filter((n) => Number.isFinite(n));
  if (s.length < 3) return { kind: 'unknown', why: 'need at least 3 consecutive samples', value: null, samples: s };

  const steps = s.slice(1).map((v, i) => v - s[i]);
  if (steps.every((d) => d === 0)) {
    return { kind: 'per-frame', value: s[s.length - 1], why: 'identical across frames — the renderer resets it', samples: s };
  }
  if (steps.every((d) => d > 0)) {
    const min = Math.min(...steps), max = Math.max(...steps);
    // an uneven running total still has a per-frame meaning, but a WILDLY
    // uneven one is measuring something other than a steady scene
    if (max - min <= max * tolerance) {
      const mean = steps.reduce((a, b) => a + b, 0) / steps.length;
      return { kind: 'cumulative', value: Math.round(mean), why: `running total, +${Math.round(mean)}/frame`, samples: s };
    }
    return { kind: 'unknown', why: `growing unevenly (steps ${min}..${max})`, value: null, samples: s };
  }
  return { kind: 'unknown', why: 'neither flat nor monotonically increasing', value: null, samples: s };
}

// ---- frame-time distributions ----------------------------------------------

export function percentile(sorted, p) {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
}

/** Percentiles and tail counts over raw frame deltas. */
export function summarize(deltas) {
  const d = (deltas ?? []).filter((n) => Number.isFinite(n) && n > 0);
  const sorted = [...d].sort((a, b) => a - b);
  const r2 = (n) => +Number(n).toFixed(2);
  return {
    frames: d.length,
    p50: r2(percentile(sorted, 0.50)), p95: r2(percentile(sorted, 0.95)), p99: r2(percentile(sorted, 0.99)),
    min: r2(sorted[0] ?? 0), max: r2(sorted[sorted.length - 1] ?? 0),
    mean: r2(d.reduce((a, b) => a + b, 0) / (d.length || 1)),
    fpsFromP50: r2(1000 / (percentile(sorted, 0.50) || 1)),
    over40ms: d.filter((x) => x > 40).length,
    over100ms: d.filter((x) => x > 100).length,
  };
}

/**
 * Is this distribution a renderer, or a metronome?
 *
 * A renderer under load SPREADS: p50 below p95 below p99, because real work
 * varies frame to frame. A backgrounded or fully-occluded tab does not render
 * at all — rAF arrives on a fixed timer and every percentile lands on the same
 * number, classically 1000ms. The first Chrome run of this harness returned
 * `off: p50 1000.06, p95 1000.11, p99 1000.11` with document.hidden FALSE the
 * whole time, and would have been published as "hiding foliage made it 60x
 * slower". Visibility is not the only way a tab stops being drawn, so the
 * distribution has to be what gives it away.
 */
export function throttleVerdict(m) {
  if (!m || !Number.isFinite(m.p50) || m.p50 < 200) return null;
  const spread = m.p50 > 0 ? (m.p99 - m.p50) / m.p50 : 1;
  if (spread >= 0.02) return null;
  return `cadence lock at ${m.p50}ms — p50, p95 and p99 within ${(spread * 100).toFixed(2)}% of each other. `
    + 'That is a background/occlusion throttle handing out timer ticks, not a frame time.';
}

// ---- comparability ----------------------------------------------------------
//
// Two receipts are a BROWSER comparison only if they were looking at the same
// thing. Camera pose, people count and a global triangle total do not
// establish that: two runs can agree on all three while a body moved, an
// entity was hidden, an asset finished streaming, or the world advanced a few
// log entries between them. So the gate hashes the scene itself.

/** Order-independent, formatting-stable digest input. Numbers are quantised so
 *  that float noise in a pose does not read as a different world, while a real
 *  move (>1mm, >0.001rad) does. */
export function sceneDigest(scene) {
  if (!scene) return null;
  const q = (n, step = 1000) => (Number.isFinite(n) ? Math.round(n * step) / step : null);
  const ents = (scene.entities ?? []).map((e) => [
    e.id, e.lib ?? '', (e.pos ?? []).map((n) => q(n)).join(','), q(e.yaw), q(e.scale), e.visible ? 1 : 0,
  ].join('|')).sort();
  const people = (scene.people ?? []).map((p) => [
    p.id, (p.pos ?? []).map((n) => q(n, 100)).join(','), p.avatar ?? '',
  ].join('|')).sort();
  return {
    worldSeq: scene.worldSeq ?? null,
    entities: ents.length, peopleCount: people.length,
    hash: fnv1a(JSON.stringify({ ents, people, seq: scene.worldSeq ?? null })),
  };
}

/** A small, dependency-free 32-bit hash. Not a security digest — a stable
 *  fingerprint two receipts can be compared on. */
export function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/** The gate rows. Each names what it protects; `ok` false means no delta may
 *  be claimed. Returns rows plus an overall verdict. */
export function gateChecks(labs) {
  const val = (l, f) => { try { return f(l); } catch { return undefined; } };
  const CHECKS = [
    ['camera pose', (l) => l.camera && [l.camera.pos, l.camera.yaw, l.camera.pitch, l.camera.fov],
      'a few metres of dolly changes tile count, frustum and draw calls together'],
    ['drawing buffer', (l) => l.env?.drawingBuffer, 'fewer pixels is a rendering advantage nobody granted'],
    ['scene digest', (l) => l.scene?.digest?.hash ?? null,
      'same camera and same triangle total can still be a different arrangement of bodies and entities'],
    ['world log seq', (l) => l.scene?.digest?.worldSeq ?? null,
      'the world advanced between the two runs — they folded different histories'],
    ['people present', (l) => l.scene?.people ?? null, 'skinned bodies dominate frame cost at commons scale'],
    ['triangles', (l) => l.scene?.triangles ?? null, 'a different scene is a different question'],
    ['blades planted', (l) => l.scene?.grassDrawn ?? null, 'the foliage arms need the same meadow'],
    ['seconds per arm', (l) => l.secsPerArm, 'a shorter run has a shorter tail'],
    ['code under test', (l) => l.build?.digest ?? null,
      'receipts that cannot name the build they came from cannot be bound to a review'],
  ];
  const rows = CHECKS.map(([name, get, why]) => {
    const values = labs.map((l) => val(l, get));
    const known = values.every((v) => v !== undefined && v !== null);
    const equal = values.every((v) => JSON.stringify(v) === JSON.stringify(values[0]));
    return { name, values, ok: known && equal, known, why };
  });
  const tainted = labs.filter((l) => l.tainted).map((l) => ({ label: l.label ?? null, why: l.tainted }));
  return { rows, tainted, comparable: rows.every((r) => r.ok) && tainted.length === 0 };
}

/** Foliage cost, or an honest refusal. Subtracting a metronome from a renderer
 *  produces a number that means nothing, and so does subtracting across a scene
 *  whose meadow never built. */
export function foliageCost(full, off, { foliage } = {}) {
  if (!full || !off) return { ok: false, why: 'both a full and an off arm are needed' };
  if (foliage === 'absent') return { ok: false, why: 'no grass field in this world — the arms changed nothing' };
  if (full.suspect || off.suspect) return { ok: false, why: 'one of the two arms is a throttle, not a renderer' };
  const r2 = (n) => +Number(n).toFixed(2);
  return { ok: true, p50: r2(full.p50 - off.p50), p95: r2(full.p95 - off.p95) };
}

/** When every arm sits on the refresh interval the comparison has a FLOOR and
 *  cannot see a difference smaller than the monitor. Saying "tie" there would
 *  be a finding this data cannot support. */
export function vsyncFloor(labs) {
  const all = labs.flatMap((l) => (l.arms ?? []).map((a) => a.p50)).filter(Number.isFinite);
  if (!all.length) return null;
  const floor = Math.min(...all);
  const pinned = all.every((p) => Math.abs(p - floor) < 0.5) && floor < 20;
  return pinned ? { floor: +floor.toFixed(2), hz: Math.round(1000 / floor) } : null;
}
