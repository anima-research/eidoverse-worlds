// voicesfubridge — joins voicesfu.js (pure WebRTC) to the world websocket.
//
// Kept separate from voicesfu.js so that file stays transport-only and testable
// without a socket: this is the part that knows about `net`, the bus, and the
// verb names. voicerelay.js fuses these two jobs; splitting them is the one
// structural improvement this port makes over the file it is modelled on.
//
// 🔴 It exposes window.relayDiag / window.relayMic with the SAME shape the
// LiveKit path does — deliberately, so ONE browser smoke can drive either
// transport and the acceptance-table row is measured the same way for both
// hypotheses. A row proved by a different yardstick proves nothing comparable.
import { bus } from './core.js';
import { net, sendRelayCredRequest, sendVoiceConsent } from './net.js';
import { sfuConnect, sfuOnOffer, sfuOnIce, sfuMic, sfuPeerLevels,
  sfuDiagClient, sfuClose, sfuActive, sfuSpeakerEntries, sfuInboundStats, sfuMicOn,
  sfuMicWanted } from './voicesfu.js';
import { remotes } from './remotes.js';
import { myState } from './controller.js';
import { isHushed, volumeFor, receivingVoice } from './voiceconsent.js';

const send = (o) => { if (net.ws?.readyState === 1) net.ws.send(JSON.stringify(o)); };

export function initVoiceSfu(name) {
  // Ask for the media credential once we are actually joined. Same join-race
  // guard as the relay path (askOnce): check the live state NOW and also
  // listen, because a fast join can fire before we subscribed.
  let asked = false;
  const askOnce = (n) => {
    if (asked || !n?.joined) return;
    asked = true;
    sendRelayCredRequest();          // the same ask the relay path uses
  };
  bus.on('net', askOnce);
  askOnce(net);

  bus.on('relay-cred', async (cred) => {
    await sfuConnect(cred, send);
    // 🔴 HONOUR A MIC PRESSED BEFORE THE CREDENTIAL ARRIVED. window.__sfuMic is
    // installed at init, but `pc` does not exist until this message lands a
    // server round-trip later — so a press in that window hits sfuMic's
    // `if (!pc) return`, sets wantMic and publishes NOTHING. The badge then
    // reports false honestly, which is worse than a lie: the user sees the mic
    // refuse to turn on with no error anywhere. Nothing re-read wantMic once
    // the connection existed, so it stayed dead until the next manual toggle.
    // Found by reading voicesfu.js and this file end-to-end, NOT by grepping —
    // it only exists in the seam between the two.
    if (sfuMicWanted()) { await sfuMic(true); bus.emit('audio:mic', sfuMicOn()); }
    // We do NOT offer. Tell the server we are ready and let it drive every
    // negotiation — see the header of voicesfu.js for why an answer cannot add
    // a receive direction the offer never proposed.
    send({ type: 'sfu-want-negotiate' });
  });

  // 🔴 CONSENT MUST BE WIRED. The first version never subscribed to
  // 'audio:receive', so setReceiveVoice(true) fired into a void: the browser
  // showed consent ON, the server never heard about it, and the listener's
  // `hears` array stayed empty while the speaker happily pushed 1858 packets
  // into the SFU. Same two halves the relay path uses — the current state NOW
  // (a session that joined already-consenting must not wait for a toggle), and
  // every change after.
  sendVoiceConsent(receivingVoice());
  bus.on('audio:receive', (on) => sendVoiceConsent(on));

  bus.on('sfu-offer', (m) => sfuOnOffer(m.sdp, send));
  bus.on('sfu-ice', (m) => sfuOnIce(m.candidate));
  bus.on('sfu-want-negotiate', () => send({ type: 'sfu-want-negotiate' }));

  // Distance rolloff + hush — the same two-clock shape as the mesh and the
  // relay (slow target, fast approach), lifted verbatim because it is generic.
  // NOTE: this is the CLIENT half of the same rolloff the server's proximity
  // gate uses (FULL_M=3, SILENT_M=20). The server gate is an efficiency hint
  // that only ever subtracts; this is what actually makes distance audible.
  const FULL_M = 3, SILENT_M = 20;
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

  // Position feed for the SERVER's proximity gate. Cheap (a few floats every
  // 500ms) and OPTIONAL by design — the gate fails open on unknown or stale
  // positions, so a client that never sends these is simply never gated.
  setInterval(() => {
    if (!sfuActive()) return;
    const p = myState.pos;
    send({ type: 'sfu-pos', x: +p.x.toFixed(2), y: +p.y.toFixed(2), z: +p.z.toFixed(2) });
  }, 500);

  window.relayDiag = sfuDiagClient;
  window.relayMic = () => sfuMic(true);
  window.relayPeerLevels = sfuPeerLevels;
  // Cheap mic-state read for the 8Hz HUD poll — sfuDiagClient() allocates an
  // object and spreads the speaker map every call (review F4).
  window.__sfuMicOn = sfuMicOn;
  window.sfuStats = sfuInboundStats;      // NetEq evidence for the spike report
  // The mic badge (mictoggle.js → voice.js toggleMic) checks for this and hands
  // over when the SFU transport owns playback. Set LAST, so it is never visible
  // before the bridge can honour it.
  // Returns the RESULTING state so toggleMic can hand it back to the panel, and
  // reads it from sfuMicOn() AFTER the await — a publish that fails then reports
  // honestly instead of optimistically. (An earlier edit of mine matched nothing
  // and silently did NOTHING because I wrote 'audio:mic' where the file says
  // 'mic'; assert-before-replace is why this one cannot repeat that.)
  window.__sfuMic = async () => {
    await sfuMic(!sfuMicOn());
    const on = sfuMicOn();
    bus.emit('audio:mic', on);
    return on;
  };
  addEventListener('beforeunload', sfuClose);
}

// voicesfu owns the map; sfuSpeakerEntries() hands back the live records so the
// rolloff loops can mutate volume in place, without exposing the Map itself.
// (First version of this read a `_ref` field off the DIAG output that never
// existed — rolloff would have silently never applied, and nothing would have
// thrown. Found by grepping for the field rather than by running it.)
const sfuSpeakers = sfuSpeakerEntries;
