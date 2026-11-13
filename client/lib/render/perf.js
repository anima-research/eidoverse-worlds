// perf — frame-loop numbers the governor, the HUD and the debug panel read. A zero-import leaf so none of them
// imports the frame loop.
//   fps      whole frames per ~1 s window
//   ms       frame time, EWMA (α=0.1, ~10-frame memory)
//   worst    the longest frame of the last completed window (fps hides a single 100 ms frame)
//   doubled  frames that waited one extra vsync (pacing, whenever fps < refresh)
//   spikes   frames > 40 ms, beyond any pacing explanation: the real stutter events
export const perf = { fps: 0, ms: 0, worst: 0, doubled: 0, spikes: 0 };
