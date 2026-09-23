// sound-clock-test substitutes this for the seams sounds.js imports that the
// guard-label stub (main's) does not cover. Unlike sound-guard-stub, this one
// BUILDS a graph: the playhead test needs a real applyFrom → seekTo pass, so
// the audio context is a connectable fake, and the clock is a dial the test
// turns — `serverNow` here stands in for remotes.js's smoothed server clock.
export const editors = [];
export const registerEditor = (fn) => { editors.push(fn); };
export const toast = () => {};
export const flashHint = () => {};
export const playWhenAllowed = () => {};
export const volumeFor = () => 1;
export const audioContextState = () => 'running';

const node = () => ({ connect() { return this; }, disconnect() {}, gain: { value: 1 } });
export const audioContext = () => ({
  createMediaElementSource: () => node(),
  createGain: () => node(),
  createPanner: () => ({ ...node(), positionX: { value: 0 }, positionY: { value: 0 }, positionZ: { value: 0 } }),
  destination: node(),
});

/** The dial. The test sets `clock.server` to whatever the smoothed server
 *  clock should read; Date.now() stays the machine's own, deliberately
 *  skewed from it. */
export const clock = { server: 0 };
export const serverNow = () => clock.server;
