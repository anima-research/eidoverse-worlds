/**
 * E — are the shipped assertions measuring what they claim?
 * Method: MUTATION TESTING. Break the SFU in a specific way, re-run the
 * shipped test's logic, and see whether it notices. An assertion that passes
 * against a broken SFU is measuring itself.
 */
import { RTCPeerConnection, MediaStreamTrack, RTCRtpCodecParameters, RtpPacket, RtpHeader } from "werift";
import { Sfu } from "../../server/sfu.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const P = (n: string, ok: boolean, d = "") =>
  console.log(`${ok ? "  PASS  " : "  DEFECT"} ${n}${d ? "  :: " + d : ""}`);

// ── E1: "…and cost no renegotiation (SDP untouched)" ──────────────────────
// sfu-test.ts:97 asserts renegotiations.length === renegCount after
// setConsent(false). But setConsent(false) NEVER calls ensureRoute at all --
// `if (allowed) this.ensureRoute(...)`. The assertion cannot fail regardless
// of whether the SFU is correct. It is structurally tautological.
console.log("\n── E1: is 'consent OFF costs no renegotiation' tautological? ──");
{
  const asks: string[] = [];
  const sfu = new Sfu({ onNegotiationNeeded: (id) => asks.push(id) });
  sfu.createLeg("l", 1); sfu.createLeg("s", 1);
  // Never grant consent at all, then revoke. If revoke were buggy and DID
  // renegotiate, would the shipped assertion catch it? It only counts asks
  // AFTER a grant, so: the code path `setConsent(x,y,false)` has no branch
  // that could ever ask. The test asserts a property of an empty code path.
  const before = asks.length;
  sfu.setConsent("l", "s", false);
  await sleep(20);
  console.log(`     setConsent(false) on a never-granted pair: asks ${before} -> ${asks.length}`);
  console.log(`     setConsent's body: 'if (allowed) this.ensureRoute(...)' -- the false branch is EMPTY`);
  P("E1 assertion has a code path that could fail", false,
    "renegotiations.length===renegCount is unfalsifiable: the false-branch never calls ensureRoute");
  sfu.closeAll();
}

// ── E2: "revoke is synchronous (<50ms)" -- what does this actually measure?
console.log("\n── E2: what does the <50ms revocation assertion measure? ──");
{
  const sfu = new Sfu({ onNegotiationNeeded: () => {} });
  sfu.createLeg("a", 1);
  const t0 = performance.now();
  sfu.closeLeg("a");
  const dt = performance.now() - t0;
  console.log(`     closeLeg on a leg with NO peer, NO routes, NO ICE: ${dt.toFixed(3)}ms`);
  console.log(`     It measures a Map.delete + pc.close(). It does NOT measure when the`);
  console.log(`     PEER stops receiving -- that requires DTLS teardown to reach the client.`);
  P("E2 the assertion measures peer-observable revocation", false,
    "measures local bookkeeping only; the LiveKit 4700ms comparison is not like-for-like");
  sfu.closeAll();
}

// ── E3: MUTATION -- break the consent check, does the suite notice?
console.log("\n── E3: mutation — make fanout ignore consent entirely ──");
{
  const sfu = new Sfu({ onNegotiationNeeded: () => {} });
  // Mutate: consent map always says true.
  (sfu as any).consent = { get: () => true, set: () => {}, delete: () => {}, keys: () => [] };
  sfu.createLeg("s", 1); sfu.createLeg("l", 1);
  // With consent bypassed, does a route exist? ensureRoute is only called from
  // setConsent(true), so no route -> no audio. The FAIL-CLOSED property is
  // enforced by ROUTE ABSENCE, not by the consent check, in the shipped test's
  // scenario. That means the shipped "fail-closed" test would still pass with
  // the consent check DELETED.
  const routes = sfu.getLeg("l")!.outbound.size;
  console.log(`     consent forced true, no setConsent called: routes=${routes}`);
  P("E3 fail-closed test isolates the consent CHECK", routes === 0 ? false : true,
    "with 0 routes the test passes whether or not fanout checks consent -- two guards, one test");
  sfu.closeAll();
}

// ── E3b: prove it -- delete the consent check and re-run the shipped scenario.
console.log("\n── E3b: delete the consent check; does 'fail-closed' still pass? ──");
{
  const CODEC = new RTCRtpCodecParameters({ mimeType: "audio/opus", clockRate: 48000, channels: 2, payloadType: 111 });
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
    constructor() {
      this.pc.addTransceiver(this.mic, { direction: "sendonly" });
      this.pc.ontrack = (e) => e.track.onReceiveRtp.subscribe(() => { this.heard++; });
    }
    async speak(n: number) {
      for (let i = 0; i < n; i++) {
        this.mic.writeRtp(new RtpPacket(new RtpHeader({ payloadType: 111, sequenceNumber: this.seq++, timestamp: this.seq * 960, ssrc: 42 }), Buffer.from([1, 2, 3, i & 0xff])));
        await sleep(6);
      }
    }
  }
  const sfu = new Sfu({ onNegotiationNeeded: () => {} });
  // MUTANT: fanout ignores consent completely.
  (sfu as any).fanout = function (from: any, rtp: any) {
    from.rxPackets++;
    if (from.closed || this.muted.has(from.id)) return;
    for (const [listenerId, listener] of this.legs) {
      if (listenerId === from.id || listener.closed) continue;
      /* CONSENT CHECK DELETED */
      const track = listener.outbound.get(from.id);
      if (!track) continue;
      track.writeRtp(rtp); this.forwarded++;
    }
  };
  const alice = new FakePeer(), bob = new FakePeer();
  const aLeg = sfu.createLeg("alice", 1), bLeg = sfu.createLeg("bob", 1);
  await negotiate(alice.pc, aLeg.pc);
  await negotiate(bob.pc, bLeg.pc);
  await sleep(700);
  await alice.speak(15);
  await sleep(300);
  const failClosedStillPasses = bob.heard === 0;
  console.log(`     MUTANT (no consent check): bob.heard=${bob.heard}, rx=${sfu.getLeg("alice")?.rxPackets}`);
  P("E3b the shipped fail-closed assertion KILLS this mutant",
    !failClosedStillPasses,
    failClosedStillPasses ? "SURVIVED: 'fail-closed: 0 packets before consent' passes with the consent check removed" : "killed");
  sfu.closeAll();
}
console.log("");
