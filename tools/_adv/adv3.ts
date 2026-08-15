/**
 * F — is the load number honest? Both halves of every connection live in ONE
 * process, so process.cpuUsage() includes the FAKE BROWSERS' cost: N receiving
 * PeerConnections doing SRTP DECRYPT + depacketize + jitter, which in a real
 * deployment run on N separate client machines.
 *
 * Method: measure the same fanout with the listeners' receive side made
 * progressively cheaper, and diff. If the number is dominated by the
 * client-side work, the "server cost" is a large overstatement.
 */
import { RTCPeerConnection, MediaStreamTrack, RTCRtpCodecParameters, RtpPacket, RtpHeader } from "werift";
import { Sfu } from "../../server/sfu.ts";

const CODEC = new RTCRtpCodecParameters({ mimeType: "audio/opus", clockRate: 48000, channels: 2, payloadType: 111 });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const N = Number(process.argv[2] ?? 12);
const SECONDS = Number(process.argv[3] ?? 8);
const SPEAKERS = Number(process.argv[4] ?? 2);
const MODE = process.argv[5] ?? "full";     // full | nopeers
const PTIME_MS = 20, OPUS_BYTES = 80;

const negotiate = async (o: RTCPeerConnection, a: RTCPeerConnection) => {
  const off = await o.createOffer(); await o.setLocalDescription(off);
  await a.setRemoteDescription(o.localDescription!);
  const an = await a.createAnswer(); await a.setLocalDescription(an);
  await o.setRemoteDescription(a.localDescription!);
};

const sfu = new Sfu({ onNegotiationNeeded: () => {} });
const peers: { id: string; pc: RTCPeerConnection; mic: MediaStreamTrack; heard: number }[] = [];

if (MODE === "full") {
  for (let i = 0; i < N; i++) {
    const id = `p${i}`;
    const pc = new RTCPeerConnection({ codecs: { audio: [CODEC] } });
    const mic = new MediaStreamTrack({ kind: "audio" });
    pc.addTransceiver(mic, { direction: "sendonly" });
    const peer = { id, pc, mic, heard: 0 };
    pc.ontrack = (e) => e.track.onReceiveRtp.subscribe(() => { peer.heard++; });
    const leg = sfu.createLeg(id, 1);
    await negotiate(pc, leg.pc);
    peers.push(peer);
  }
  await sleep(1200);
  for (const l of peers) for (const s of peers) if (l.id !== s.id) sfu.setConsent(l.id, s.id, true);
  for (const p of peers) await negotiate(sfu.getLeg(p.id)!.pc, p.pc);
  await sleep(1500);
} else {
  // NOPEERS: the SFU's own bookkeeping + fanout ONLY. Legs exist, routes exist,
  // but outbound tracks are detached stubs -- no SRTP encrypt, no dgram send, no
  // receiving peer. This is the FLOOR of what the server alone does.
  for (let i = 0; i < N; i++) {
    const id = `p${i}`;
    const leg = sfu.createLeg(id, 1);
    (leg as any).ingress = new MediaStreamTrack({ kind: "audio" });
    peers.push({ id, pc: leg.pc, mic: (leg as any).ingress, heard: 0 });
  }
  for (const l of peers) for (const s of peers) if (l.id !== s.id) sfu.setConsent(l.id, s.id, true);
  await sleep(50);
  let n = 0;
  for (const l of peers) for (const [, t] of sfu.getLeg(l.id)!.outbound) { (t as any).writeRtp = () => { n++; }; }
}

const cpu0 = process.cpuUsage(), t0 = Date.now();
let sent = 0;
const ticks = Math.floor((SECONDS * 1000) / PTIME_MS);
for (let tick = 0; tick < ticks; tick++) {
  for (const p of peers.slice(0, SPEAKERS)) {
    const pkt = new RtpPacket(
      new RtpHeader({ payloadType: 111, sequenceNumber: tick & 0xffff, timestamp: tick * 960, ssrc: 1000 + peers.indexOf(p) }),
      Buffer.alloc(OPUS_BYTES, 0xfe));
    if (MODE === "full") p.mic.writeRtp(pkt);
    else (sfu as any).fanout(sfu.getLeg(p.id), pkt);
    sent++;
  }
  await sleep(PTIME_MS);
}
await sleep(500);
const elapsed = (Date.now() - t0) / 1000;
const cpu = process.cpuUsage(cpu0);
const cpuPct = ((cpu.user + cpu.system) / 1000 / (elapsed * 1000)) * 100;
const d = sfu.diag();
console.log(`MODE=${MODE} N=${N} spk=${SPEAKERS}  cpu=${cpuPct.toFixed(1)}%  forwarded=${d.forwarded}  sent=${sent}`);
sfu.closeAll();
process.exit(0);
