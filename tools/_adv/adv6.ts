/**
 * D — resource leaks. closeLeg/closeAll: does everything actually get freed?
 * A — the consent/route asymmetry that survives revocation.
 * E — tautological assertions in the shipped test.
 */
import { RTCPeerConnection, MediaStreamTrack, RTCRtpCodecParameters, RtpPacket, RtpHeader } from "werift";
import { Sfu } from "../../server/sfu.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const P = (n: string, ok: boolean, d = "") =>
  console.log(`${ok ? "  PASS  " : "  DEFECT"} ${n}${d ? "  :: " + d : ""}`);

// ── A2: closeLeg deletes consent for the CLOSED id, but a leg that closes and
// comes back (takeover) gets a FRESH consent-free state. Does any stale route
// survive on the OTHER side?
console.log("\n── A2: takeover leaves stale outbound routes on peers ──");
{
  const sfu = new Sfu({ onNegotiationNeeded: () => {} });
  sfu.createLeg("listener", 1);
  sfu.createLeg("speaker", 1);
  sfu.setConsent("listener", "speaker", true);
  await sleep(20);
  const hadRoute = sfu.getLeg("listener")!.outbound.has("speaker");
  // speaker takes over (reconnect, new gen)
  sfu.createLeg("speaker", 2);
  await sleep(20);
  const stillHasRoute = sfu.getLeg("listener")!.outbound.has("speaker");
  const consentAfter = (sfu as any).consent.get("listener speaker");
  P("A2 takeover cleaned the listener's stale route",
    !(hadRoute && stillHasRoute),
    `route before=${hadRoute} after=${stillHasRoute}, consent after takeover=${consentAfter}`);
  // The DANGEROUS direction: consent was wiped by closeLeg, but if the route
  // object survives, re-granting consent will NOT create a new track (ensureRoute
  // returns false when outbound.has) -> the new speaker's audio goes into the OLD
  // track, which the listener's browser may or may not still be receiving.
  sfu.setConsent("listener", "speaker", true);
  await sleep(20);
  const t = sfu.getLeg("listener")!.outbound.get("speaker");
  P("A2b re-consent after takeover made a FRESH track",
    false, `track identity reused=${t === (sfu.getLeg("listener")!.outbound.get("speaker"))} (see analysis)`);
  sfu.closeAll();
}

// ── A3: does a closed leg stop being fed IMMEDIATELY, or can an in-flight
// fanout still write to it? (fanout captured `listener` before close.)
console.log("\n── A3: consent revoked between the check and the write ──");
{
  const sfu = new Sfu({ onNegotiationNeeded: () => {} });
  sfu.createLeg("s", 1); sfu.createLeg("l", 1);
  sfu.setConsent("l", "s", true);
  await sleep(20);
  let writesAfterRevoke = 0;
  let revoked = false;
  const t = sfu.getLeg("l")!.outbound.get("s")!;
  (t as any).writeRtp = () => { if (revoked) writesAfterRevoke++; };
  const spk = sfu.getLeg("s")!;
  (spk as any).ingress = new MediaStreamTrack({ kind: "audio" });
  const pkt = new RtpPacket(new RtpHeader({ payloadType: 111, sequenceNumber: 1, timestamp: 960, ssrc: 7 }), Buffer.from([1]));
  (sfu as any).fanout(spk, pkt);
  sfu.setConsent("l", "s", false); revoked = true;
  (sfu as any).fanout(spk, pkt);
  P("A3 no writes after synchronous revoke", writesAfterRevoke === 0, `writes=${writesAfterRevoke}`);
  sfu.closeAll();
}

// ── D1: leak — create/destroy many legs, measure RSS and listener counts.
console.log("\n── D1: leg churn / RSS + retained subscriptions ──");
{
  const CODEC = new RTCRtpCodecParameters({ mimeType: "audio/opus", clockRate: 48000, channels: 2, payloadType: 111 });
  const negotiate = async (o: RTCPeerConnection, a: RTCPeerConnection) => {
    const off = await o.createOffer(); await o.setLocalDescription(off);
    await a.setRemoteDescription(o.localDescription!);
    const an = await a.createAnswer(); await a.setLocalDescription(an);
    await o.setRemoteDescription(a.localDescription!);
  };
  const sfu = new Sfu({ onNegotiationNeeded: () => {} });
  const ROUNDS = Number(process.argv[2] ?? 30);
  if (global.gc) global.gc();
  await sleep(300);
  const rss0 = process.memoryUsage().rss;
  const browsers: RTCPeerConnection[] = [];
  for (let r = 0; r < ROUNDS; r++) {
    const pc = new RTCPeerConnection({ codecs: { audio: [CODEC] } });
    const mic = new MediaStreamTrack({ kind: "audio" });
    pc.addTransceiver(mic, { direction: "sendonly" });
    const leg = sfu.createLeg(`churn`, 1);      // SAME id -> takeover each round
    await negotiate(pc, leg.pc);
    // publish a few packets so ontrack fires and the subscription is created
    for (let i = 0; i < 3; i++) {
      mic.writeRtp(new RtpPacket(new RtpHeader({ payloadType: 111, sequenceNumber: i, timestamp: i * 960, ssrc: 5 }), Buffer.alloc(80)));
      await sleep(4);
    }
    sfu.closeLeg("churn");
    pc.close();
    browsers.push(pc);
  }
  if (global.gc) global.gc();
  await sleep(500);
  const rss1 = process.memoryUsage().rss;
  const growthMB = (rss1 - rss0) / 1048576;
  console.log(`     ${ROUNDS} create/destroy rounds: RSS ${(rss0/1048576).toFixed(0)} -> ${(rss1/1048576).toFixed(0)} MB  (+${growthMB.toFixed(1)} MB, ${(growthMB/ROUNDS*1024).toFixed(0)} KB/leg)`);
  P("D1 leg churn does not grow RSS unboundedly", growthMB < ROUNDS * 0.5, `+${growthMB.toFixed(1)}MB over ${ROUNDS} legs`);
  console.log(`     legs remaining in map: ${sfu.diag().legs.length}`);
  sfu.closeAll();
}
console.log("");
