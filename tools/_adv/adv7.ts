/**
 * D1 confirm: is ~1MB/leg real retention or allocator noise? Scale the round
 * count and check linearity. A leak is linear in ROUNDS; noise plateaus.
 *
 * Also isolates: is the growth attributable to the SFU's un-unsubscribed
 * onReceiveRtp closures, or to the fake browser PCs (which a real server
 * wouldn't have)? Run with --no-browser to close the browser side eagerly and
 * with --sfu-only to skip browsers entirely.
 */
import { RTCPeerConnection, MediaStreamTrack, RTCRtpCodecParameters, RtpPacket, RtpHeader } from "werift";
import { Sfu } from "../../server/sfu.ts";

const CODEC = new RTCRtpCodecParameters({ mimeType: "audio/opus", clockRate: 48000, channels: 2, payloadType: 111 });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ROUNDS = Number(process.argv[2] ?? 30);
const MODE = process.argv[3] ?? "full";
const negotiate = async (o: RTCPeerConnection, a: RTCPeerConnection) => {
  const off = await o.createOffer(); await o.setLocalDescription(off);
  await a.setRemoteDescription(o.localDescription!);
  const an = await a.createAnswer(); await a.setLocalDescription(an);
  await o.setRemoteDescription(a.localDescription!);
};

const sfu = new Sfu({ onNegotiationNeeded: () => {} });
if (global.gc) global.gc();
await sleep(400);
const rss0 = process.memoryUsage().rss;
const marks: number[] = [];

for (let r = 0; r < ROUNDS; r++) {
  if (MODE === "sfu-only") {
    // No browser at all: just create and destroy legs. Isolates the SFU's own
    // retention (RTCPeerConnection + its ICE/DTLS machinery).
    sfu.createLeg("churn", 1);
    sfu.closeLeg("churn");
  } else {
    const pc = new RTCPeerConnection({ codecs: { audio: [CODEC] } });
    const mic = new MediaStreamTrack({ kind: "audio" });
    pc.addTransceiver(mic, { direction: "sendonly" });
    const leg = sfu.createLeg("churn", 1);
    await negotiate(pc, leg.pc);
    for (let i = 0; i < 3; i++) {
      mic.writeRtp(new RtpPacket(new RtpHeader({ payloadType: 111, sequenceNumber: i, timestamp: i * 960, ssrc: 5 }), Buffer.alloc(80)));
      await sleep(4);
    }
    sfu.closeLeg("churn");
    pc.close();
  }
  if ((r + 1) % Math.max(1, Math.floor(ROUNDS / 5)) === 0) {
    if (global.gc) global.gc();
    await sleep(120);
    marks.push((process.memoryUsage().rss - rss0) / 1048576);
  }
}
if (global.gc) global.gc();
await sleep(600);
const total = (process.memoryUsage().rss - rss0) / 1048576;
console.log(`MODE=${MODE} ROUNDS=${ROUNDS}`);
console.log(`  RSS growth checkpoints (MB): ${marks.map((m) => m.toFixed(1)).join("  ")}`);
console.log(`  final +${total.toFixed(1)} MB = ${(total / ROUNDS * 1024).toFixed(0)} KB/leg`);
console.log(`  legs left: ${sfu.diag().legs.length}`);
sfu.closeAll();
process.exit(0);
