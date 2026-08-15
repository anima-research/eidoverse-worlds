/**
 * The number that decides the design: pure-JS SRTP cost at room scale.
 *
 * werift encrypts in JavaScript. #104's acceptance table wants N=2/6/12 load,
 * and my own spec pre-registered this as gotcha 3 — "the number that decides
 * whether the design survives". Everyone talks at once (worst case; real rooms
 * have one or two speakers), so this is a ceiling, not an average.
 *
 * Run: bun tools/sfu-load.ts [N] [seconds]
 */
import { RTCPeerConnection, MediaStreamTrack, RTCRtpCodecParameters, RtpPacket, RtpHeader } from "werift";
import { Sfu } from "../server/sfu.ts";

const N = Number(process.argv[2] ?? 12);
const SECONDS = Number(process.argv[3] ?? 10);
/** How many of the N are actually talking. Everyone-at-once is the ceiling;
 *  a real room has 1-2. Pass as arg 4 to measure the realistic case. */
const SPEAKERS = Number(process.argv[4] ?? N);
const CODEC = new RTCRtpCodecParameters({ mimeType: "audio/opus", clockRate: 48000, channels: 2, payloadType: 111 });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const PTIME_MS = 20;                     // Opus default framing = 50 pkt/s
const OPUS_BYTES = 80;                   // ~32kbps mono, Basis's setting

const sfu = new Sfu({ onNegotiationNeeded: () => {} });
const negotiate = async (offerer: RTCPeerConnection, answerer: RTCPeerConnection) => {
  const o = await offerer.createOffer(); await offerer.setLocalDescription(o);
  await answerer.setRemoteDescription(offerer.localDescription!);
  const a = await answerer.createAnswer(); await answerer.setLocalDescription(a);
  await offerer.setRemoteDescription(answerer.localDescription!);
};

console.log(`\nSFU load — N=${N}, ${SPEAKERS} speaking, ${SECONDS}s\n`);
const peers: { id: string; pc: RTCPeerConnection; mic: MediaStreamTrack; heard: number }[] = [];

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
console.log(`  ${N} legs up`);

// full mesh of consent: everyone hears everyone (N*(N-1) routes)
for (const l of peers) for (const s of peers) if (l.id !== s.id) sfu.setConsent(l.id, s.id, true);
// the SFU offers (see sfu.ts: server offers, never answers)
for (const p of peers) await negotiate(sfu.getLeg(p.id)!.pc, p.pc);
await sleep(1500);
const routes = peers.reduce((n, p) => n + (sfu.getLeg(p.id)?.outbound.size ?? 0), 0);
console.log(`  ${routes} routes negotiated (expect ${N * (N - 1)})\n`);

const cpu0 = process.cpuUsage(), mem0 = process.memoryUsage().rss, t0 = Date.now();
let sent = 0;
const ticks = Math.floor((SECONDS * 1000) / PTIME_MS);
for (let tick = 0; tick < ticks; tick++) {
  for (const p of peers.slice(0, SPEAKERS)) {
    p.mic.writeRtp(new RtpPacket(
      new RtpHeader({ payloadType: 111, sequenceNumber: tick & 0xffff, timestamp: tick * 960, ssrc: 1000 + peers.indexOf(p) }),
      Buffer.alloc(OPUS_BYTES, 0xfe),
    ));
    sent++;
  }
  await sleep(PTIME_MS);
}
await sleep(1000);

const elapsed = (Date.now() - t0) / 1000;
const cpu = process.cpuUsage(cpu0);
const cpuPct = ((cpu.user + cpu.system) / 1000 / (elapsed * 1000)) * 100;
const memMB = (process.memoryUsage().rss - mem0) / 1048576;
const d = sfu.diag();
const heard = peers.reduce((n, p) => n + p.heard, 0);
// `sent` already sums EVERY peer's packets, so the fanout multiplier is
// (N-1) per packet — not per peer. (First run read 200%: the formula was
// wrong, not the SFU. forwarded == sent*(N-1) exactly, which is the proof.)
const expected = sent * (N - 1);
const egressBps = (d.forwarded / elapsed) * (OPUS_BYTES + 12) * 8;

console.log(`  packets in       ${sent}  (${Math.round(sent / elapsed)}/s)`);
console.log(`  forwarded        ${d.forwarded}  (${Math.round(d.forwarded / elapsed)}/s)`);
console.log(`  heard by peers   ${heard} / ${expected} expected  (${((heard / expected) * 100).toFixed(1)}% delivery)`);
console.log(`  CPU              ${cpuPct.toFixed(1)}% of one core`);
console.log(`  RSS delta        ${memMB.toFixed(0)} MB`);
console.log(`  egress           ${(egressBps / 1e6).toFixed(2)} Mbps\n`);
console.log(cpuPct < 80 && heard / expected > 0.95
  ? `  \x1b[32m✅ N=${N} is comfortable\x1b[0m\n`
  : `  \x1b[31m⚠ N=${N} is at or past the limit\x1b[0m\n`);
sfu.closeAll();
process.exit(0);
