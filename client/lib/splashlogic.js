// splashlogic — when a body in the water makes ripples and splashes. Pure (no three.js, no scene): it is handed
// each body's parts this frame and the water surface, and says what to emit. client/lib/splashes.js draws it.
//
// What disturbs the surface:
//   · a PART CROSSING it downward — hips, hands, feet. Any crossing rings the water; a fast one splashes, as
//     hard as it was moving. One rule covers a jump, a fall, a ragdoll thrown in, a swimmer's stroke, and feet
//     slapping through the shallows at a run.
//   · a body MOVING through the water — a wake from a swimmer's chest, rings shed at a wader's legs, closer
//     together the faster it goes.
//   · a body STANDING in the water — now and then a faint ring, as a body never holds quite still.
// A part deep under the surface (a diver) troubles nothing up top; a body on dry ground, nothing at all.
//
// Visual only: every viewer draws the bodies it sees, from where it sees them. Nothing here is on the wire.

/** Tunables, in metres and seconds. */
export const SPLASH = {
  SPLASH_SPEED: 1.6,     // m/s down through the surface before a crossing throws water
  FULL_SPLASH: 7,        // m/s for a full-strength splash
  SPLASH_GAP: 0.25,      // s between splashes from one part
  WAKE_SPEED: 0.25,      // m/s of travel before a body leaves a wake
  WAKE_STEP: 0.45,       // m travelled between wake rings…
  WAKE_MIN_GAP: 0.12,    // …but never more often than this
  IDLE_GAP: 1.8,         // s between a still body's faint rings
  DEEP: 0.6,             // m under the surface past which a part disturbs nothing
  JUMP: 1.5,             // m a part may move in one frame and still have MOVED (more is a teleport, a respawn,
                         // a body snapping to where it loaded — none of them a fall)
};

/** One tracker per viewer. `surfaceAt(x, z)` is the water surface there this instant, or null on dry ground.
 *  `emit.ripple(x, z, strength)` rings the water; `emit.splash(x, y, z, power, vx, vz)` throws it. */
export function makeSplashTracker(surfaceAt, emit) {
  const state = new Map();   // body key -> { parts: {name: {h, t}}, wake: {x, z, d, t}, idleT }
  let clock = 0;

  /** Advance by `dt`. `bodies`: [{ key, root: [x, y, z], height, parts: { name: [x, y, z] }, swimming? }]. */
  function update(bodies, dt) {
    clock += dt;
    const seen = new Set();
    for (const b of bodies) {
      seen.add(b.key);
      let s = state.get(b.key);
      if (!s) { s = { parts: {}, wake: null, idleT: clock + Math.random() * SPLASH.IDLE_GAP }; state.set(b.key, s); }
      const [rx, ry, rz] = b.root;
      const surf = surfaceAt(rx, rz);
      // ---- parts crossing the surface
      for (const name in b.parts) {
        const p = b.parts[name], ps = surfaceAt(p[0], p[2]);
        const prev = s.parts[name];
        const h = ps == null ? null : p[1] - ps;   // height of the part above the surface (null: no water there)
        const jumped = prev && prev.y != null && Math.hypot(p[0] - prev.x, p[1] - prev.y, p[2] - prev.z) > SPLASH.JUMP;
        if (prev && !jumped && prev.h != null && h != null && dt > 0 && prev.h > 0 && h <= 0 && h > -SPLASH.DEEP) {
          const vy = (h - prev.h) / dt;            // the surface moves too, so this is the speed THROUGH it
          const down = -vy;
          emit.ripple(p[0], p[2], Math.min(1, 0.25 + down / SPLASH.FULL_SPLASH));
          if (down >= SPLASH.SPLASH_SPEED && clock - (prev.splashT ?? -1e9) >= SPLASH.SPLASH_GAP) {
            const vx = prev.x == null ? 0 : (p[0] - prev.x) / dt, vz = prev.z == null ? 0 : (p[2] - prev.z) / dt;
            emit.splash(p[0], ps, p[2], Math.min(1, (down - SPLASH.SPLASH_SPEED * 0.5) / SPLASH.FULL_SPLASH), vx, vz, { part: name, down, from: prev.h, to: h });
            s.parts[name] = { h, x: p[0], y: p[1], z: p[2], splashT: clock };
            continue;
          }
        }
        s.parts[name] = { h, x: p[0], y: p[1], z: p[2], splashT: prev?.splashT };
      }
      // ---- moving through, or standing in, the water
      if (surf == null || ry > surf || surf - ry > b.height + SPLASH.DEEP) { s.wake = null; continue; }   // dry, or wholly under
      const w = s.wake;
      // just in the water (walked in, or arrived): its first idle ring waits — it has only now begun to stand there
      const settle = () => { s.idleT = clock + SPLASH.IDLE_GAP * (0.5 + 0.5 * Math.random()); };
      if (!w) { s.wake = { x: rx, z: rz, d: 0, t: clock }; settle(); continue; }
      const step = Math.hypot(rx - w.x, rz - w.z), speed = dt > 0 ? step / dt : 0;
      w.x = rx; w.z = rz;
      if (step > SPLASH.JUMP) { w.d = 0; settle(); continue; }   // a teleport leaves no wake behind it
      if (speed >= SPLASH.WAKE_SPEED) {
        w.d += step;
        const gap = Math.max(SPLASH.WAKE_MIN_GAP, SPLASH.WAKE_STEP / Math.max(speed, 0.01));
        if ((w.d >= SPLASH.WAKE_STEP || clock - w.t >= gap * 2) && clock - w.t >= SPLASH.WAKE_MIN_GAP) {
          w.d = 0; w.t = clock;
          const strength = Math.min(1, 0.3 + speed / 4);
          if (b.swimming) emit.ripple(rx, rz, strength);   // a swimmer's chest pushes the wake
          else {
            // a wader sheds rings at whichever legs are in the water
            let any = false;
            for (const leg of ['leftFoot', 'rightFoot']) {
              const f = b.parts[leg];
              if (f && surf - f[1] > 0.05) { emit.ripple(f[0], f[2], strength * 0.8); any = true; }
            }
            if (!any) emit.ripple(rx, rz, strength * 0.7);
          }
        }
        s.idleT = clock + SPLASH.IDLE_GAP;
      } else if (clock >= s.idleT) {
        s.idleT = clock + SPLASH.IDLE_GAP * (0.7 + 0.6 * Math.random());
        emit.ripple(rx, rz, 0.18);
      }
    }
    for (const k of state.keys()) if (!seen.has(k)) state.delete(k);   // a body gone: forget it
  }
  return { update, get size() { return state.size; } };
}
