/**
 * SFU unit proof — the acceptance rows that are checkable without a browser.
 * Loopback werift peers stand in for browsers: same RTP, same negotiation,
 * no Chromium. The browser smoke is a separate (and mandatory) step; passing
 * here proves the POLICY, not the interop.
 */
import { RTCPeerConnection, MediaStreamTrack, RTCRtpCodecParameters, RtpPacket, RtpHeader } from "werift";
import { Sfu } from "../server/sfu.ts";

const CODEC = new RTCRtpCodecParameters({ mimeType: "audio/opus", clockRate: 48000, channels: 2, payloadType: 111 });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) { console.log(`  \x1b[32m✓\x1b[0m ${name}`); pass++; }
  else { console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? "  " + detail : ""}`); fail++; }
};

/** A stand-in browser: publishes a mic, counts what it hears. */
class FakePeer {
  pc = new RTCPeerConnection({ codecs: { audio: [CODEC] } });
  mic = new MediaStreamTrack({ kind: "audio" });
  heard = 0;
  seq = 0;
  constructor(publish = true) {
    if (publish) this.pc.addTransceiver(this.mic, { direction: "sendonly" });
    this.pc.ontrack = (e) => e.track.onReceiveRtp.subscribe(() => { this.heard++; });
  }
  /** speak N packets of (fake) encoded Opus */
  async speak(n: number) {
    for (let i = 0; i < n; i++) {
      this.mic.writeRtp(new RtpPacket(
        new RtpHeader({ payloadType: 111, sequenceNumber: this.seq++, timestamp: this.seq * 960, ssrc: 42 }),
        Buffer.from([0xf8, 0xff, 0xfe, i & 0xff]),
      ));
      await sleep(6);
    }
  }
}

/** Full offer/answer both directions — the SFU always answers. */
async function negotiate(browser: RTCPeerConnection, sfuPc: RTCPeerConnection) {
  const offer = await browser.createOffer();
  await browser.setLocalDescription(offer);
  await sfuPc.setRemoteDescription(browser.localDescription);
  const answer = await sfuPc.createAnswer();
  await sfuPc.setLocalDescription(answer);
  await browser.setRemoteDescription(sfuPc.localDescription);
}

console.log("\nSFU — policy proof (loopback peers)\n");
const renegotiations: string[] = [];
const sfu = new Sfu({ onNegotiationNeeded: (id) => renegotiations.push(id) });

// ── two participants join ──────────────────────────────────────────────────
const alice = new FakePeer(), bob = new FakePeer();
const aLeg = sfu.createLeg("alice", 1), bLeg = sfu.createLeg("bob", 1);
await negotiate(alice.pc, aLeg.pc);
await negotiate(bob.pc, bLeg.pc);
await sleep(900);
check("both legs negotiated", !!sfu.getLeg("alice") && !!sfu.getLeg("bob"));

// ── FAIL-CLOSED: no consent means no audio, even with a live mic ───────────
await alice.speak(15);
await sleep(300);
check("fail-closed: 0 packets to bob before consent", bob.heard === 0, `heard=${bob.heard}`);
check("…but the SFU DID receive alice's mic", (sfu.getLeg("alice")?.rxPackets ?? 0) > 0,
  `rx=${sfu.getLeg("alice")?.rxPackets}`);

// ── consent ON → route created, renegotiation requested, audio flows ───────
sfu.setConsent("bob", "alice", true);
check("consent created a route", (sfu.getLeg("bob")?.outbound.has("alice")) === true);
check("consent asked the caller to renegotiate", renegotiations.includes("bob"));
// The SFU OFFERS here, it does not answer: bob's browser offered sendonly (his
// mic), and an answer cannot add a receive direction the offer never proposed.
// Adding a track server-side therefore makes the SERVER the offerer — which is
// why createLeg's caller gets onNegotiationNeeded rather than a re-answer.
await negotiate(sfu.getLeg("bob")!.pc, bob.pc);
await sleep(600);
const before = bob.heard;
await alice.speak(20);
await sleep(400);
check("consent ON → bob hears alice", bob.heard > before, `heard=${bob.heard}`);

// ── consent OFF → audio stops, WITHOUT renegotiating ───────────────────────
const renegCount = renegotiations.length;
sfu.setConsent("bob", "alice", false);
const atRevoke = bob.heard;
await alice.speak(20);
await sleep(400);
check("consent OFF → audio stops", bob.heard === atRevoke, `heard ${atRevoke}→${bob.heard}`);
check("…and cost no renegotiation (SDP untouched)", renegotiations.length === renegCount);

// ── moderator mute is enforced at INGRESS: nobody hears, no route survives ─
sfu.setConsent("bob", "alice", true);
await sleep(200);
sfu.setMuted("alice", true);
const atMute = bob.heard;
await alice.speak(20);
await sleep(400);
check("moderator mute silences alice for everyone", bob.heard === atMute, `heard ${atMute}→${bob.heard}`);
sfu.setMuted("alice", false);

// ── revocation is LOCAL and immediate (no webhook, no TTL) ─────────────────
const t0 = Date.now();
sfu.closeLeg("alice");
const revokeMs = Date.now() - t0;
check("revoke is synchronous (<50ms, vs LiveKit's ~4700ms webhook path)", revokeMs < 50, `${revokeMs}ms`);
check("revoked leg is gone", sfu.getLeg("alice") === undefined);
check("…and nobody holds a route to it", sfu.getLeg("bob")?.outbound.has("alice") === false);

// ── takeover: same id re-joining retires the predecessor (#57 one body) ────
const bob2 = new FakePeer();
const bLeg2 = sfu.createLeg("bob", 2);
await negotiate(bob2.pc, bLeg2.pc);
await sleep(500);
check("takeover replaced the leg", sfu.getLeg("bob")?.gen === 2);
check("…and the old PC was closed", bLeg.pc.connectionState === "closed" || bLeg.closed);

const d = sfu.diag();
check("diag reports live legs", Array.isArray(d.legs) && typeof d.forwarded === "number");

sfu.closeAll();
console.log(`\n${fail === 0 ? "\x1b[32m" : "\x1b[31m"}${pass} passed, ${fail} failed\x1b[0m\n`);
process.exit(fail === 0 ? 0 : 1);
