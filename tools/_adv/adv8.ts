/**
 * D2 — the leak that MATTERS: does the never-unsubscribed onReceiveRtp closure
 * keep the SFU (and its `legs` map, and every leg's PC) alive, and does it keep
 * FIRING after closeLeg? A retained-and-firing closure is worse than RSS: it is
 * CPU burned on a corpse, and `this.fanout` on a closed leg.
 *
 * The closure is `(rtp) => this.fanout(leg, rtp)` -- it captures BOTH the Sfu
 * instance AND the leg object, and is never unsubscribed.
 */
import { RTCPeerConnection, MediaStreamTrack, RTCRtpCodecParameters, RtpPacket, RtpHeader } from "werift";
import { Sfu } from "../../server/sfu.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const P = (n: string, ok: boolean, d = "") =>
  console.log(`${ok ? "  PASS  " : "  DEFECT"} ${n}${d ? "  :: " + d : ""}`);

console.log("\n── D2: does the ingress subscription survive closeLeg and keep firing? ──");
{
  const sfu = new Sfu({ onNegotiationNeeded: () => {} });
  const leg = sfu.createLeg("spk", 1);
  // Simulate what ontrack does, with a track we control.
  const track = new MediaStreamTrack({ kind: "audio" });
  (leg as any).ingress = track;
  let fanoutCalls = 0;
  const origFanout = (sfu as any).fanout.bind(sfu);
  (sfu as any).fanout = (l: any, rtp: any) => { fanoutCalls++; return origFanout(l, rtp); };
  track.onReceiveRtp.subscribe((rtp) => (sfu as any).fanout(leg, rtp));

  const pkt = () => new RtpPacket(new RtpHeader({ payloadType: 111, sequenceNumber: 1, timestamp: 960, ssrc: 9 }), Buffer.from([1]));
  track.onReceiveRtp.execute(pkt());
  const before = fanoutCalls;

  sfu.closeLeg("spk");
  // The browser's socket may still deliver a few in-flight packets after close.
  for (let i = 0; i < 5; i++) track.onReceiveRtp.execute(pkt());
  const after = fanoutCalls;

  P("D2 subscription stops firing after closeLeg",
    after === before,
    `fanout invoked ${after - before}x AFTER the leg was closed (subscription never unsubscribed)`);
  console.log(`     leg.rxPackets kept incrementing: ${leg.rxPackets} (a closed leg still counts)`);
  console.log(`     note: fanout's first line increments rxPackets BEFORE the closed check`);
  sfu.closeAll();
}

// ── D3: is the retained closure enough to keep a whole Sfu alive?
console.log("\n── D3: WeakRef — is the Sfu collectable after closeAll? ──");
{
  const CODEC = new RTCRtpCodecParameters({ mimeType: "audio/opus", clockRate: 48000, channels: 2, payloadType: 111 });
  let ref: WeakRef<any>;
  let trackHolder: MediaStreamTrack;
  {
    const sfu = new Sfu({ onNegotiationNeeded: () => {} });
    const leg = sfu.createLeg("x", 1);
    const track = new MediaStreamTrack({ kind: "audio" });
    (leg as any).ingress = track;
    track.onReceiveRtp.subscribe((rtp) => (sfu as any).fanout(leg, rtp));
    trackHolder = track;               // the TRACK outlives (as a browser's would)
    sfu.closeAll();
    ref = new WeakRef(sfu);
  }
  if (global.gc) { global.gc(); await sleep(200); global.gc(); }
  await sleep(300);
  const alive = ref.deref() !== undefined;
  P("D3 Sfu is collectable after closeAll",
    !alive,
    alive ? "Sfu RETAINED by the un-unsubscribed onReceiveRtp closure held on a live track" : "collected");
  console.log(`     (track still referenced: ${!!trackHolder})`);
}
console.log("");
