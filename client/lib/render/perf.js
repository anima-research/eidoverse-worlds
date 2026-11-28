// perf — frame-loop numbers the governor, the HUD and the debug panel read. A zero-import leaf so none of them
// imports the frame loop.
//   fps      whole frames per ~1 s window
//   ms       frame time, EWMA (α=0.1, ~10-frame memory)
//   worst    the longest frame of the last completed window (fps hides a single 100 ms frame)
//   doubled  frames of 25–40 ms: one extra vsync at 60 Hz (fixed thresholds, so at 30 Hz every frame counts here)
//   spikes   frames > 40 ms: beyond pacing at 60 Hz (at 72 Hz a three-vsync frame lands here too)
export const perf = { fps: 0, ms: 0, worst: 0, doubled: 0, spikes: 0 };
