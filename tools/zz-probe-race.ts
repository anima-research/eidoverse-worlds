/**
 * Priority-1 item 1: the `negotiated` flag race.
 *
 * negotiate() does, AFTER awaiting the exchange:
 *     for (const r of leg.outbound.values()) r.negotiated = true;
 *
 * It marks EVERY route on the leg, including routes added DURING the await —
 * routes that were never in the SDP that was just exchanged. Such a route is
 * then permanently `negotiated: true` with no browser receiver: silent forever,
 * reported by diag() as `hears`, and never re-asked by ensureRoute (which only
 * re-asks when `!existing.negotiated`). That is exactly the B2 bug, one level
 * deeper.
 *
 * Realistic trigger: an SDP exchange is a network round trip (tens of ms). A
 * second participant granting consent during that window is not exotic — it is
 * the normal case in a room where people join at once.
 */
import { RTCPeerConnection, MediaStreamTrack, RTCRtpCodecParameters, RtpPacket, RtpHeader } from "werift";
import { Sfu } from "../server/sfu.ts";

const CODEC = new RTCRtpCodecParameters({ mimeType: "audio/opus", clockRate: 48000, channels: 2, payloadType: 111 });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
async function negotiate(browser: RTCPeerConnection, sfuPc: RTCPeerConnection) {
  const offer = await browser.createOffer();
  await browser.setLocalDescription(offer);
  await sfuPc.setRemoteDescription(browser.localDescription);
  const answer = await sfuPc.createAnswer();
  await sfuPc.setLocalDescription(answer);
  await browser.setRemoteDescription(sfuPc.localDescription);
}

let bad = 0;
const asks: string[] = [];
const sfu = new Sfu({ onNegotiationNeeded: (id) => asks.push(id) });

const s1 = new FakePeer(), s2 = new FakePeer(), lis = new FakePeer();
await negotiate(s1.pc, sfu.createLeg("S1", 1).pc);
await negotiate(s2.pc, sfu.createLeg("S2", 1).pc);
await negotiate(lis.pc, sfu.createLeg("L", 1).pc);

// L consents to hear S1 → route #1 created, pending.
sfu.setConsent("L", "S1", true);
await sleep(10);

// Now run the exchange for L, and DURING the await add a second route (S2).
// This models "S2's consent lands while L's offer is in flight".
// The vulnerable window is AFTER the SDP has been built/exchanged and BEFORE
// negotiate()'s post-await `for (...) r.negotiated = true` runs. Any await
// inside exchange() that resolves later than the SDP construction lands there.
// A real caller has exactly this shape: build the SDP, then await the socket
// round trip to the browser.
await sfu.negotiate("L", async (pc) => {
  await negotiate(pc, lis.pc);       // the SDP here contains ONLY the S1 track
  // …now the caller awaits its websocket ack / ICE settle. Consent for S2
  // lands during that wait — the route is added to leg.outbound AFTER the
  // offer went out, but BEFORE negotiate() marks the map.
  await new Promise<void>((res) => setTimeout(res, 30));
  sfu.setConsent("L", "S2", true);
});
await sleep(400);

const leg = sfu.getLeg("L")!;
const r1 = leg.outbound.get("S1")!, r2 = leg.outbound.get("S2")!;
console.log(`route S1 negotiated=${r1.negotiated}  (was in the SDP: correct)`);
console.log(`route S2 negotiated=${r2.negotiated}  (was NOT in the SDP)`);
if (r2.negotiated) {
  console.log("DEFECT: a route added mid-exchange was marked negotiated without ever being offered.");
  bad++;
}

const d = sfu.diag().legs.find((l) => l.id === "L")!;
console.log(`diag hears=${JSON.stringify(d.hears)} pendingRoutes=${JSON.stringify(d.pendingRoutes)}`);
if (d.hears.includes("S2")) {
  console.log("DEFECT: diag reports L hears S2 — the B2 'green while silent' shape.");
  bad++;
}

// Does anything ever re-ask? ensureRoute only re-asks when !negotiated.
const asksBefore = asks.filter((a) => a === "L").length;
sfu.setConsent("L", "S2", false);
sfu.setConsent("L", "S2", true);      // the B2 recovery path
await sleep(20);
const asksAfter = asks.filter((a) => a === "L").length;
console.log(`re-ask attempts for L: ${asksBefore} -> ${asksAfter}`);
if (asksAfter === asksBefore) {
  console.log("DEFECT: the route is never re-asked — permanently silent, exactly like B2.");
  bad++;
}

// And empirically: does L actually hear S2?
const at = lis.heard;
await s2.speak(20);
await sleep(400);
console.log(`L heard from S2: ${lis.heard - at} packets (diag claims it hears S2)`);
if (d.hears.includes("S2") && lis.heard - at === 0) {
  console.log("DEFECT CONFIRMED EMPIRICALLY: diag green, forwarded>0, heard=0.");
  bad++;
}
console.log(`forwarded=${sfu.diag().forwarded}`);

sfu.closeAll();
console.log(bad === 0 ? "\nCLEAN" : `\n${bad} defect signals`);
process.exit(bad === 0 ? 0 : 1);
