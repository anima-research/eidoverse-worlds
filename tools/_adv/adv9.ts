/**
 * A — THE SECURITY QUESTION. Construct ANY sequence where audio reaches a
 * listener without consent, or continues after consent is revoked.
 *
 * Attack surface: consent is keyed by (listenerId, speakerId) STRINGS, and
 * closeLeg wipes consent for that id. But `outbound` tracks are keyed by
 * speakerId too -- and a TAKEOVER creates a new leg with the SAME id while the
 * OLD leg's track object may still be plumbed into a live browser.
 */
import { RTCPeerConnection, MediaStreamTrack, RTCRtpCodecParameters, RtpPacket, RtpHeader } from "werift";
import { Sfu } from "../../server/sfu.ts";

const CODEC = new RTCRtpCodecParameters({ mimeType: "audio/opus", clockRate: 48000, channels: 2, payloadType: 111 });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const P = (n: string, ok: boolean, d = "") =>
  console.log(`${ok ? "  PASS  " : "  DEFECT"} ${n}${d ? "  :: " + d : ""}`);
const negotiate = async (o: RTCPeerConnection, a: RTCPeerConnection) => {
  const off = await o.createOffer(); await o.setLocalDescription(off);
  await a.setRemoteDescription(o.localDescription!);
  const an = await a.createAnswer(); await a.setLocalDescription(an);
  await o.setRemoteDescription(a.localDescription!);
};
class FakePeer {
  pc = new RTCPeerConnection({ codecs: { audio: [CODEC] } });
  mic = new MediaStreamTrack({ kind: "audio" });
  heard = 0; seq = 0;
  constructor(publish = true) {
    if (publish) this.pc.addTransceiver(this.mic, { direction: "sendonly" });
    this.pc.ontrack = (e) => e.track.onReceiveRtp.subscribe(() => { this.heard++; });
  }
  async speak(n: number) {
    for (let i = 0; i < n; i++) {
      this.mic.writeRtp(new RtpPacket(
        new RtpHeader({ payloadType: 111, sequenceNumber: this.seq++, timestamp: this.seq * 960, ssrc: 42 }),
        Buffer.from([0xf8, 0xff, 0xfe, i & 0xff])));
      await sleep(6);
    }
  }
}

// ── ATTACK 1: consent SURVIVES a listener's own takeover? ──────────────────
// closeLeg("L") wipes consent keys starting "L " and ending " L". So a
// reconnecting listener starts consent-free. Verify -- this is the good path.
console.log("\n── ATTACK 1: listener reconnect must not inherit consent ──");
{
  const sfu = new Sfu({ onNegotiationNeeded: () => {} });
  const spk = new FakePeer(); const lis = new FakePeer();
  await negotiate(spk.pc, sfu.createLeg("S", 1).pc);
  await negotiate(lis.pc, sfu.createLeg("L", 1).pc);
  sfu.setConsent("L", "S", true);
  await sleep(20);
  await negotiate(sfu.getLeg("L")!.pc, lis.pc);
  await sleep(400);
  await spk.speak(10); await sleep(300);
  const heardWithConsent = lis.heard;
  // L reconnects (takeover). New body, no consent.
  const lis2 = new FakePeer();
  await negotiate(lis2.pc, sfu.createLeg("L", 2).pc);
  await sleep(400);
  const h0 = lis2.heard;
  await spk.speak(10); await sleep(300);
  P("A1 reconnected listener hears nothing without fresh consent",
    lis2.heard === h0, `heard ${h0}->${lis2.heard} (gen1 had heard ${heardWithConsent})`);
  sfu.closeAll();
}

// ── ATTACK 2: SPEAKER takeover — does the OLD speaker's identity keep a route?
console.log("\n── ATTACK 2: speaker reconnects; is consent re-required? ──");
{
  const sfu = new Sfu({ onNegotiationNeeded: () => {} });
  const spk = new FakePeer(); const lis = new FakePeer();
  await negotiate(spk.pc, sfu.createLeg("S", 1).pc);
  await negotiate(lis.pc, sfu.createLeg("L", 1).pc);
  sfu.setConsent("L", "S", true);
  await sleep(20);
  await negotiate(sfu.getLeg("L")!.pc, lis.pc);
  await sleep(400);
  await spk.speak(8); await sleep(300);
  const baseline = lis.heard;
  // Speaker reconnects with a NEW body under the same id.
  const spk2 = new FakePeer();
  await negotiate(spk2.pc, sfu.createLeg("S", 2).pc);
  await sleep(400);
  const consentNow = (sfu as any).consent.get("L S");
  const routeNow = sfu.getLeg("L")?.outbound.has("S");
  const h0 = lis.heard;
  await spk2.speak(10); await sleep(400);
  P("A2 new speaker body requires fresh consent",
    lis.heard === h0,
    `heard ${h0}->${lis.heard}; consent='${consentNow}' route=${routeNow} (baseline was ${baseline})`);
  sfu.closeAll();
}

// ── ATTACK 3: mute is checked on `from.id` -- a muted speaker who RECONNECTS
// under the same id stays muted (good). But does closeLeg clear `muted`?
// If a moderator mutes "S", S leaves, and a DIFFERENT person later claims id
// "S", they inherit the mute. Conversely if muted is cleared on close, a muted
// speaker can UNMUTE THEMSELVES by reconnecting.
console.log("\n── ATTACK 3: can a muted speaker unmute by reconnecting? ──");
{
  const sfu = new Sfu({ onNegotiationNeeded: () => {} });
  const spk = new FakePeer(); const lis = new FakePeer();
  await negotiate(spk.pc, sfu.createLeg("S", 1).pc);
  await negotiate(lis.pc, sfu.createLeg("L", 1).pc);
  sfu.setConsent("L", "S", true);
  await sleep(20);
  await negotiate(sfu.getLeg("L")!.pc, lis.pc);
  await sleep(400);
  sfu.setMuted("S", true);
  const h0 = lis.heard;
  await spk.speak(8); await sleep(300);
  const mutedWorks = lis.heard === h0;
  // S reconnects, and the listener re-consents (normal rejoin flow).
  const spk2 = new FakePeer();
  await negotiate(spk2.pc, sfu.createLeg("S", 2).pc);
  sfu.setConsent("L", "S", true);
  await sleep(30);
  await negotiate(sfu.getLeg("L")!.pc, lis.pc);
  await sleep(500);
  const h1 = lis.heard;
  await spk2.speak(12); await sleep(400);
  console.log(`     mute effective pre-reconnect: ${mutedWorks}; muted set now: ${JSON.stringify(sfu.diag().muted)}`);
  P("A3 mute survives the speaker's reconnect",
    lis.heard === h1, `heard ${h1}->${lis.heard} after reconnect while muted`);
  sfu.closeAll();
}
console.log("");
