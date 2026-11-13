// dwell — ONE way for "the pointer has rested on this for a beat" (owner, 10-02). A mouse resting on a nameplate, a VR
// laser resting on a nameplate, on a panel control with a tooltip, on a panel's handle or resizer: each asks a dwell
// tracker keyed on what the pointer rests on. The key changes → the clock restarts; the same key for DWELL_MS → ripe.
//
// In VR the key is what the laser HOLDS (xr.js), so the pointer's stickiness carries through: a drift within the stay
// margin keeps the same key and the dwell keeps counting; a hand that moves on to the next button starts it again.
// Pure (no DOM, no THREE): tools/dwell-test.mjs runs it.

export const DWELL_MS = 300;   // the nameplate card's long-standing hover delay, now everyone's

/** A tracker. step(key, now) each frame (null: resting on nothing); ripe(now) once the same key has held DWELL_MS. */
export function makeDwell(ms = DWELL_MS) {
  const d = {
    key: null, since: 0, ms,
    step(key, now = performance.now()) { if (key !== d.key) { d.key = key ?? null; d.since = now; } return d; },
    ripe(now = performance.now()) { return d.key != null && now - d.since >= d.ms; },
    /** the key, if ripe — else null */
    ripeKey(now = performance.now()) { return d.ripe(now) ? d.key : null; },
    reset(now = performance.now()) { d.key = null; d.since = now; },
  };
  return d;
}
