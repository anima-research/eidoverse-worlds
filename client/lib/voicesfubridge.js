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
import { bus } from './bus.js';
import { net } from './net.js';
import { sfuConnect, sfuOnOffer, sfuOnIce, sfuMic, sfuPeerLevels,
  sfuDiagClient, sfuClose, sfuActive, sfuSpeakerEntries } from './voicesfu.js';
import { myState, remotes } from './state.js';
import { isHushed, volumeFor } from './audio.js';

const send = (o) => { if (net.ws?.readyState === 1) net.ws.send(JSON.stringify(o)); };

export function initVoiceSfu(name) {
  // Ask for the media credential once we are actually joined. Same join-race
  // guard as the relay path (askOnce): check the live state NOW and also
  // listen, because a fast join can fire before we subscribed.
  let asked = false;
  const askOnce = (n) => {
    if (asked || !n?.joined) return;
    asked = true;
    send({ type: 'relay-cred', publish: true, subscribe: true });
  };
  bus.on('net', askOnce);
  askOnce(net);

  bus.on('relay-cred', async (cred) => {
    await sfuConnect(cred, send);
    // We do NOT offer. Tell the server we are ready and let it drive every
    // negotiation — see the header of voicesfu.js for why an answer cannot add
    // a receive direction the offer never proposed.
    send({ type: 'sfu-want-negotiate' });
  });

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
  addEventListener('beforeunload', sfuClose);
}

// voicesfu owns the map; sfuSpeakerEntries() hands back the live records so the
// rolloff loops can mutate volume in place, without exposing the Map itself.
// (First version of this read a `_ref` field off the DIAG output that never
// existed — rolloff would have silently never applied, and nothing would have
// thrown. Found by grepping for the field rather than by running it.)
const sfuSpeakers = sfuSpeakerEntries;
