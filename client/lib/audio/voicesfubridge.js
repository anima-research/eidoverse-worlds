// voicesfubridge — joins voicesfu.js (pure WebRTC) to the world websocket: the part that knows
// about `net`, the bus and the verb names, so voicesfu.js stays transport-only.
//
// It exposes window.relayDiag / window.relayMic, which the browser smokes assert against
// (historical names; test/server/sfu-browser-probe.mjs and the mic probes use them).
import { bus, CONFIG } from '../base.js';
import { net, sendRelayCredRequest, sendVoiceConsent, sendJoined } from '../net.js';
import { sfuConnect, sfuOnOffer, sfuOnIce, sfuMic, sfuPeerLevels, sfuMyLevel,
  sfuDiagClient, sfuClose, sfuActive, sfuSpeakerEntries, sfuInboundStats, sfuMicOn,
  sfuMicWanted, sfuDropSpeaker } from './voicesfu.js';
import { remotes } from '../player/remotes.js';
import { myState } from '../player/controller.js';
import { isHushed, volumeFor, receivingVoice, VOICE_FULL_M, VOICE_SILENT_M } from './voiceconsent.js';
import { setGeneratorRebuildHook, synthProvider } from './voicesource.js';
import { setModeratorMute } from './micstate.js';

const send = (o) => { sendJoined(o); };

// A moderator's voice mute is enforced at the SFU's ingress (server.ts sanctionSweep), so the room hears nothing from us
// while it stands: micstate.js roomHears() and the mic glyph must say so. The same test the server applies.
const voiceMuted = (r) => !!r?.muted?.channels?.includes('voice');
setModeratorMute(voiceMuted(net.myRights));
bus.on('your-rights', (r) => setModeratorMute(voiceMuted(r)));

// A synth track arriving while no mic is published becomes the lane, via sfuMic(false) → sfuPublish
// (a replaceTrack alone only repairs senders that exist). A live mic wins outright, as in voicesource.js; so does a
// synth that voiceSource fell back to under a wanted mic (sfuMicOn() counts it), whose rebuilt track isn't republished.
setGeneratorRebuildHook(() => {
  if (sfuMicOn()) return;
  if (!synthProvider()?.available?.()) return;
  void sfuMic(false);   // re-enters the swap path, which now finds the provider
});

export function initVoiceSfu(name) {
  // Ask for the media credential once joined: check now AND listen (a fast join can beat the
  // subscription). Sends are fire-and-forget, so re-arm on every disconnect.
  let asked = false;
  const askOnce = (n) => {
    if (asked || !n?.joined) return;
    asked = true;
    sendRelayCredRequest();          // the same ask the relay path uses
  };
  bus.on('net', (n) => {
    // joined→false: the socket died; disarm so the next join re-asks
    if (!n?.joined) { asked = false; return; }
    if (!asked) {
      askOnce(n);
      // the server holds consent per-connection, so restate it on a new one
      sendVoiceConsent(receivingVoice());
    }
  });
  askOnce(net);

  // A speaker's voice leg can be replaced while we listen (a new gen): ask the server to
  // renegotiate, or we stay on the dead gen. The server owns every offer (voicesfu.js header).
  bus.on('surface-transition', ({ actor, surface, gen }) => {
    if (surface !== 'voice' && surface !== 'voice-relay') return;
    if (actor === CONFIG.name) return;                    // our own leg
    if (gen == null) {
      // the leg died: drop its playback now, or the <audio> + analyser leak
      sfuDropSpeaker(actor);
      return;
    }
    if (!sfuActive()) return;                             // nothing to renegotiate yet
    console.info(`[sfu] ${actor} has a new voice leg (gen ${gen}) — asking to re-negotiate`);
    send({ type: 'sfu-want-negotiate' });
  });

  // Media-path recovery: a media leg that dies while the world socket is healthy re-joins
  // voice with the same ask a fresh join makes; 3 attempts, growing delay, reset when ICE connects.
  let recoveryAttempts = 0, recoveryTimer = null;
  bus.on('sfu-media-live', () => { recoveryAttempts = 0; if (recoveryTimer) { clearTimeout(recoveryTimer); recoveryTimer = null; } });
  bus.on('sfu-media-dead', ({ reason }) => {
    if (recoveryTimer) return;                 // one pending recovery at a time
    if (!net.joined) return;                   // the world socket owns THAT reconnect
    if (recoveryAttempts >= 3) {
      console.error(`[sfu] media path dead (${reason}) — giving up after 3 recovery attempts; reload to retry`);
      return;
    }
    const delay = [2000, 8000, 20000][recoveryAttempts++];
    console.warn(`[sfu] media path dead (${reason}) — re-joining voice in ${delay / 1000}s (attempt ${recoveryAttempts}/3)`);
    recoveryTimer = setTimeout(() => {
      recoveryTimer = null;
      if (!net.joined) return;
      sendRelayCredRequest();                  // fresh credential → fresh leg → fresh ICE
      sendVoiceConsent(receivingVoice());      // fire-and-forget lane: restate consent too
    }, delay);
  });

  bus.on('relay-cred', async (cred) => {
    await sfuConnect(cred, send);
    // honour a mic pressed before the credential arrived (sfuMic only recorded wantMic then)
    if (sfuMicWanted()) { await sfuMic(true); bus.emit('audio:mic', sfuMicOn()); }
    // we never offer; the server drives every negotiation (voicesfu.js header)
    send({ type: 'sfu-want-negotiate' });
  });

  // consent: send the current state now, and every change after
  sendVoiceConsent(receivingVoice());
  bus.on('audio:receive', (on) => sendVoiceConsent(on));

  bus.on('sfu-offer', (m) => sfuOnOffer(m.sdp, send));
  bus.on('sfu-ice', (m) => sfuOnIce(m.candidate));
  bus.on('sfu-want-negotiate', () => send({ type: 'sfu-want-negotiate' }));

  // Distance rolloff + hush: slow target, fast approach. The client half of the server's
  // proximity gate; the server only ever subtracts, this is what makes distance audible.
  const FULL_M = VOICE_FULL_M, SILENT_M = VOICE_SILENT_M;   // one number (voiceconsent.js)
  setInterval(() => {
    for (const [id, s] of sfuSpeakers()) {
      const r = remotes.get(id);
      if (!r?.avatar?.root || !s.audio?.srcObject) continue;
      const d = r.avatar.root.position.distanceTo(myState.pos);
      const roll = Math.min(1, Math.max(0, 1 - (d - FULL_M) / (SILENT_M - FULL_M)));
      s.wantVolume = isHushed() ? 0 : roll * volumeFor('voices');
    }
  }, 300);
  const STEP = 60 / 700;
  setInterval(() => {
    for (const [, s] of sfuSpeakers()) {
      if (!s.audio?.srcObject || s.wantVolume == null) continue;
      const d = s.wantVolume - s.audio.volume;
      s.audio.volume = Math.abs(d) <= STEP ? s.wantVolume : s.audio.volume + Math.sign(d) * STEP;
    }
  }, 60);

  // position feed for the server's proximity gate; optional (the gate fails open on unknown positions)
  setInterval(() => {
    if (!sfuActive()) return;
    const p = myState.pos;
    send({ type: 'sfu-pos', x: +p.x.toFixed(2), y: +p.y.toFixed(2), z: +p.z.toFixed(2) });
  }, 500);

  window.relayDiag = sfuDiagClient;
  // the <audio> elements for /audio's playback probe (never in the DOM, so not queryable)
  window.__voiceSpeakerEls = () =>
    sfuSpeakerEntries().map(([id, s]) => ({ id, audio: s.audio }));
  window.relayMic = () => sfuMic(true);
  window.relayPeerLevels = sfuPeerLevels;
  window.__sfuMicOn = sfuMicOn;             // cheap read for the HUD poll (sfuDiagClient() allocates)
  window.__sfuMyLevel = sfuMyLevel;         // my mouth flap + 🎙 glyph (voicemouths.js)
  window.sfuStats = sfuInboundStats;      // NetEq evidence for the spike report
  // the mic badge (mictoggle.js → micstate.js toggleMic) hands over to this. Set last, so it is
  // never visible before the bridge can honour it; returns the state read after the await.
  window.__sfuMic = async () => {
    await sfuMic(!sfuMicOn());
    const on = sfuMicOn();
    bus.emit('audio:mic', on);
    return on;
  };
  addEventListener('beforeunload', sfuClose);
}

// live records, so the rolloff loops can mutate volume in place
const sfuSpeakers = sfuSpeakerEntries;
