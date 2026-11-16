// ONE AudioContext for the whole page. Chrome caps a document at roughly six and a refused
// context never throws, it just never sounds. Remote voices don't play through it (only their level
// analysers live here, voicesfu.js): voicesfubridge.js sets each speaker's <audio> volume.
let ctx = null;

/** The page's AudioContext. Created on first use, resumed opportunistically. */
export function audioContext() {
  if (!ctx) ctx = new (window.AudioContext ?? window.webkitAudioContext)();
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  return ctx;
}

/** TEST-ONLY: drop the cached context so a suite can swap the constructor. */
export function __resetForTest() { ctx = null; }

/** Has one been made yet? (Probes: do not CREATE one just to look at it.) */
export const audioContextState = () => ctx?.state ?? 'none';
