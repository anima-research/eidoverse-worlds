// voicesource — where a body's voice comes from. voicesfu.js asks this module for a
// MediaStream instead of calling getUserMedia; everything downstream only sees a MediaStream.
//
//   humans → getUserMedia (the browser/OS default device)
//   agents → a synth provider, registered by whatever drives the body (hands over a finished track)

import { report } from '../base.js';

// ── the synth-provider contract ──────────────────────────────────────────────
// {
//   available(): boolean            — can this provider produce a track NOW
//   start(): MediaStreamTrack       — begin producing; returns the live track
//   stop(): void                    — cease producing (track may end)
//   label?: string                  — shown in the audio panel
//   audibleAt?(): number            — performance.now() when the track last took a frame over micgate.js SYNTH_AUDIBLE
//   level?(): number                — the RMS of the last frame it wrote
// }
// The last two are the provider's own account of what it sent, read by micstate.js through the synthetic stream: the
// track reaches WebRTC without the AudioContext, so an analyser on it can hear silence while the room hears speech.
// One provider, replaceable. null = this body has no synthetic voice.
let provider = null;

export function setSynthProvider(p) {
  provider = p || null;
  return provider;
}
export const synthProvider = () => provider;

// ── track-change notification ────────────────────────────────────────────────
// A provider that rebuilds its track calls notifySynthTrackChanged(newTrack).
// A Set of hooks, each isolated: one throwing must not deny the others.
const rebuildHooks = new Set();
export const setGeneratorRebuildHook = (fn) => { rebuildHooks.add(fn); return () => rebuildHooks.delete(fn); };
export const notifySynthTrackChanged = (track) => {
  for (const fn of rebuildHooks) {
    try { fn(track); } catch (e) { report('synth track-change hook', e); }
  }
};

// ── the source ───────────────────────────────────────────────────────────────
export async function voiceSource({ micWanted = true } = {}) {
  // a live mic wins outright; micWanted:false takes the synth path directly rather than
  // opening a device the caller declined
  if (!micWanted) {
    if (provider?.available?.()) return synthStream();
    throw new Error('mic declined and no synth provider registered — nothing to publish');
  }
  try {
    const mic = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true },
    });
    return mic;
  } catch (e) {
    // no microphone or permission refused: a willing synth provider is the whole voice
    if (provider?.available?.()) return synthStream();
    throw e;
  }
}

/** The synth provider's track as a stream, marked synthetic so callers can tell it from a device. */
function synthStream() {
  const p = provider;
  const track = p.start();
  const ms = new MediaStream([track]);
  // synthetic: the caller must not wrap it in the WebAudio gate (no room noise; the gate's clock is dead in headless bodies)
  ms.synthetic = true;
  if (typeof p.audibleAt === 'function') ms.audibleAt = () => p.audibleAt();
  if (typeof p.level === 'function') ms.level = () => p.level();
  return ms;
}
