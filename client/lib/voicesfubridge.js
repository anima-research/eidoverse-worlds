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
import { bus, CONFIG } from './core.js';
import { net, sendRelayCredRequest, sendVoiceConsent } from './net.js';
import { sfuConnect, sfuOnOffer, sfuOnIce, sfuMic, sfuPeerLevels, sfuMyLevel,
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
  // 🔴 RE-ASK AFTER A RECONNECT (found 2026-08-15 by reading this file end to
  // end, after R: "you HAVE to re-read after trims").
  //
  // `asked` used to be a ONE-WAY LATCH: set true on the first join and never
  // cleared. So when the socket dropped and net.js reconnected (net.js:381), the
  // world log recovered — snapshot replays verbQueue — but VOICE never did. No
  // new credential was requested, so `pc` was never rebuilt, and the SFU stayed
  // dead until a full page reload. Chat working while voice is silently gone is
  // exactly the shape that reads as "the voice feature is broken".
  //
  // Every send() in this file is fire-and-forget (line 21: no queue, no retry,
  // silent no-op when readyState !== 1), so a reconnect loses consent and
  // position too — hence re-arming here re-establishes ALL of it.
  let asked = false;
  const askOnce = (n) => {
    if (asked || !n?.joined) return;
    asked = true;
    sendRelayCredRequest();          // the same ask the relay path uses
  };
  bus.on('net', (n) => {
    // joined→false means the socket died: disarm so the NEXT join re-asks.
    if (!n?.joined) { asked = false; return; }
    if (!asked) {
      askOnce(n);
      // consent is listener-authored state the server holds per-connection; a
      // new connection has none, so restate it rather than assume it survived
      sendVoiceConsent(receivingVoice());
    }
  });
  askOnce(net);

  // 🔴 A SPEAKER'S VOICE LEG CAN BE REPLACED WHILE YOU LISTEN (2026-08-15).
  //
  // Found live: I restarted my sidecar, which retires my voice leg and mints a
  // new generation. R's client had subscribed to the OLD gen and simply went
  // deaf to me — permanently, with no error. The server was already correct
  // (`applyStandingConsent` re-applies her standing consent to the new leg, so
  // `hears: ['hesperus']` stayed true) and it BROADCASTS `surface-transition`
  // for exactly this reason. Nothing on the SFU client listened: the event fed
  // only causes.js's hold-then-fallback bookkeeping, never the media path.
  //
  // Net effect without this: any speaker whose voice leg restarts is silent to
  // everyone already in the room until THEY reload. For an agent whose mouth is
  // a separate process — which is the whole topology-B design — that is not an
  // edge case, it is every deploy.
  //
  // We do not offer (the server owns every offer — see voicesfu.js's header);
  // we ASK for a renegotiation, and the server's next offer carries the route
  // to the new leg. Skip our own transitions: we are not our own listener.
  bus.on('surface-transition', ({ actor, surface, gen }) => {
    if (surface !== 'voice' || gen == null) return;      // gen null = leg died
    if (actor === CONFIG.name) return;                    // our own leg
    if (!sfuActive()) return;                             // nothing to renegotiate yet
    console.info(`[sfu] ${actor} has a new voice leg (gen ${gen}) — asking to re-negotiate`);
    send({ type: 'sfu-want-negotiate' });
  });

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
  // The actual <audio> elements, for /audio's playback probe. They are
  // `new Audio()` and never appended to the DOM, so querySelectorAll cannot
  // find them — a probe that looked there reported "no elements" while two
  // speakers were audibly playing (2026-08-16).
  window.__voiceSpeakerEls = () =>
    sfuSpeakerEntries().map(([id, s]) => ({ id, audio: s.audio }));
  window.relayMic = () => sfuMic(true);
  window.relayPeerLevels = sfuPeerLevels;
  // Cheap mic-state read for the 8Hz HUD poll — sfuDiagClient() allocates an
  // object and spreads the speaker map every call (review F4).
  window.__sfuMicOn = sfuMicOn;
  // My own mic level, for my own mouth flap + the 🎙 glyph (voicemouths.js).
  // The mesh reads voice.js's analyser; on this transport that is always 0.
  window.__sfuMyLevel = sfuMyLevel;
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
