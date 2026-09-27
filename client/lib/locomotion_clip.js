// Which clip the body plays, and how it blends in, as a pure function. controller.js calls it once per tick
// with the real motion state; tools/locomotion-clip-test.mjs calls it with every combination. No imports on purpose.
//
// The policy (owner, 09-19):
//   climb   — a mantle owns the body outright.
//   jump    — a deliberate press is immediate (`jumped`); a walk-off is airborne past a 2-frame guard
//             (AIRBORNE_GRACE) so stair-stepping does not flicker into a jump.
//             How it blends is the tell: a PRESS is snappy (FADE_PRESS), a walk-off EASES (FADE_WALKOFF,
//             ease:true) — the same clip arriving two different ways.
//   walk/run — while the KEY is down (or the stick deflected). `wantMove` is INTENT, and it is the whole
//             point: on release the speed coasts down over ~0.3 s, but the clip must leave for idle NOW and
//             let the crossfade cover the coast (owner: 'blends very late… start as soon as the key is
//             released'). Selecting on speed alone was ~0.34 s late.
//   sit/sitchair/lie — a held posture, once nothing above claims the body.
//   idle    — the floor.
//
// Returns the clip AND the options setClip should receive, so the caller has no policy left to get wrong.
export const AIRBORNE_GRACE = 0.04;   // s: stair-step tolerance before a fall reads as a jump
export const RUN_SPEED = 2.6;         // m/s: walk → run
export const MOVE_EPS = 0.05;         // m/s: below this the body is not travelling
export const FADE_PRESS = 0.1;        // s: a deliberate jump is snappy
export const FADE_WALKOFF = 0.5;      // s: walking off an edge eases

export function selectClip({ mantle = false, jumped = false, airborneFor = 0, wantMove = false, speed = 0, posture = null, seat = null } = {}) {
  const seatedClip = seat?.chair ? 'sitchair' : 'sit';
  const clip = mantle ? 'climb'
    : (jumped || airborneFor > AIRBORNE_GRACE) ? 'jump'
      : (wantMove && speed >= MOVE_EPS) ? (speed < RUN_SPEED ? 'walk' : 'run')
        : posture === 'sit' ? seatedClip
          : posture === 'lie' ? 'lie'
            : 'idle';
  // Only jump carries options; everything else takes setClip's defaults.
  const opts = clip === 'jump' ? (jumped ? { fade: FADE_PRESS } : { fade: FADE_WALKOFF, ease: true }) : undefined;
  return { clip, opts };
}
