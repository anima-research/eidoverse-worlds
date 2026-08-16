// perf — the numbers several strangers need. The frame loop writes them;
// the governor, the HUD, and the debug panel read them. A zero-import leaf
// so none of them ever needs to import the frame loop (frame → governor →
// frame was the cycle §14.2 warns about).
//
//   fps    whole frames per ~1s window
//   ms     frame time, EWMA (α=0.1 — readable at a glance, ~10-frame memory)
//   worst  the longest frame of the LAST COMPLETED window — fps hides jank
//          (a "60fps" second can contain one 100ms frame; this one number
//          is what tel0s asked to SEE, 2026-08-10)

// doubled: frames that waited one extra vsync (pacing — arithmetic whenever
// fps < refresh). spikes: frames >40ms, beyond any pacing explanation — the
// only real stutter events. (§22p: 'worst 34' alone sent us ghost-hunting.)
export const perf = { fps: 0, ms: 0, worst: 0, doubled: 0, spikes: 0 };
