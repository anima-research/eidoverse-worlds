// voicesource — WHERE YOUR VOICE COMES FROM.
//
// A participant's voice is a property of that participant, not a second client
// in the room. Before this, an agent spoke by running a WHOLE SEPARATE WebRTC
// client (voicebox/page.html) that joined under the agent's own name — which
// meant two sockets holding one identity, and the server's one-body-per-id rule
// evicting each in turn: 543 identity takeovers in a single session on
// 2026-08-08. Renaming that client is not the fix; not being a client is.
//
// So: voice.js asks THIS module for a MediaStream instead of calling
// getUserMedia directly. Everything downstream — the sender, replaceTrack,
// distance falloff, volumeFor(), consent, mute — takes a MediaStream and does
// not care where it came from. One seam, and an agent's synthesized speech gets
// spatialization and consent for free rather than needing a parallel path.
//
//   humans → getUserMedia (unchanged; the browser/OS default device)
//   agents → a SYNTH PROVIDER, registered by whatever is driving the body
//
// This module deliberately contains NO synthesizer (#90 review, 2026-08-11):
// it is the seam, not the mouth. A provider hands over a finished
// MediaStreamTrack — how the samples are made (generator, pacer, TTS engine,
// test stub) is entirely the provider's business, and lives in its own module.

import { report } from './core.js';

// ── the synth-provider contract ──────────────────────────────────────────────
// {
//   available(): boolean            — can this provider produce a track NOW
//   start(): MediaStreamTrack       — begin producing; returns the live track
//   stop(): void                    — cease producing (track may end)
//   label?: string                  — shown in the audio panel
// }
// One provider, replaceable. null = this body has no synthetic voice.
let provider = null;

export function setSynthProvider(p) {
  provider = p || null;
  return provider;
}
export const synthProvider = () => provider;

// ── track-change notification ────────────────────────────────────────────────
// If a provider must rebuild its track (its generator died, its engine
// restarted), it calls notifySynthTrackChanged(newTrack); voice.js re-binds
// every sender. The hook survives from the pre-split module under its old
// name so the call site's diff stays honest.
// 🔴 A LIST, NOT A SLOT (2026-08-16). This was `onRebuild = fn`, a single
// assignment — and once the SFU needed the hook too, TWO modules registered:
// voice.js:1204 for the mesh and voicesfubridge for the SFU. Whichever module
// evaluated last silently won and the other's hook never fired again, with no
// error and no way to see it. That is a transport-dependent, load-order-
// dependent failure in the one path that gives a synthesized voice its lane.
//
// Both transports coexist by design on this branch (mesh is #104's rollback
// path), so the hook has to be broadcast. Handlers are independent: one
// throwing must not deny the others their notification.
const rebuildHooks = new Set();
export const setGeneratorRebuildHook = (fn) => { rebuildHooks.add(fn); return () => rebuildHooks.delete(fn); };
export const notifySynthTrackChanged = (track) => {
  for (const fn of rebuildHooks) {
    try { fn(track); } catch (e) { report('synth track-change hook', e); }
  }
};

// ── the source ───────────────────────────────────────────────────────────────
export async function voiceSource({ micWanted = true } = {}) {
  // A body has ONE mic, and a LIVE MIC WINS OUTRIGHT (R, 2026-08-09): mic on
  // means your own voice, full stop; mic off drops back to the synth provider
  // with nothing to re-enable, because the provider's enablement is left
  // STANDING rather than cleared — a priority, not a toggle.
  //
  // 🔴 "MIC OFF" AND "NO MIC" ARE DIFFERENT STATES (R, 2026-08-16: "I just want
  // to verify that TTS can ship over the voice lane even if mic is toggled
  // off"). This function only ever reached the synth provider when
  // getUserMedia THREW — no device, or permission refused. Someone with a
  // working microphone who has simply switched it off still got the
  // microphone back, so their TTS had no route to a sender and nobody heard
  // their typed lines. The doctrine above is right and was only half
  // implemented: a live mic wins, but a mic the user turned OFF is not a live
  // mic.
  //
  // micWanted:false is that state, and it takes the synth path directly rather
  // than opening a device the caller has already declined. Default true keeps
  // every existing call site behaving exactly as before.
  if (!micWanted && provider?.available?.()) return synthStream();
  try {
    const mic = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true },
    });
    return mic;
  } catch (e) {
    // No microphone, or permission refused. If a synth provider is registered
    // and willing, that is the whole voice — the agent path, and the path a
    // human with no mic takes to still be heard.
    if (provider?.available?.()) return synthStream();
    throw e;
  }
}

/** The synth provider's track as a stream, marked so callers can tell it from a
 *  device. Extracted so the two paths that reach it — no mic, and mic
 *  deliberately off — cannot drift apart. */
function synthStream() {
  const track = provider.start();
  const ms = new MediaStream([track]);
  // Mark it: this is a SYNTHETIC source, not a device. The caller must not
  // wrap it in the WebAudio gate — a synth has no room noise to gate, and
  // the gate graph hangs off an AudioContext whose clock is DEAD in every
  // headless body (field-measured 2026-08-10: 'running', +0.000s/2s).
  ms.synthetic = true;
  return ms;
}

/** True when the current source's track has died and needs re-making. The
 *  liveness check nothing was doing — an `audio:ended` sender transmits
 *  silence forever while ICE and direction both look perfectly healthy. */
export function sourceIsDead(stream) {
  const t = stream?.getAudioTracks?.()[0];
  return !!t && t.readyState === 'ended';
}
