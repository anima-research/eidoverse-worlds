// Does a server-set streamId/id on a werift MediaStreamTrack survive into the
// browser's ontrack event? If yes, speaker identity can ride WITH the track
// (Basis's ServerAudioSegmentMessage{playerId, audioData} principle) instead of
// being inferred from arrival order across a sideband queue.
import { RTCPeerConnection, MediaStreamTrack, MediaStream, RTCRtpCodecParameters } from "werift";
import { chromium } from "playwright";

const CODEC = new RTCRtpCodecParameters({ mimeType: "audio/opus", clockRate: 48000, channels: 2, payloadType: 111 });
const SPEAKER_ID = "speaker-abc123";

const pc = new RTCPeerConnection({ codecs: { audio: [CODEC] }, bundlePolicy: "max-bundle", iceUseIpv6: false });
const track = new MediaStreamTrack({ kind: "audio" });
// werift derives msid from the SENDER's streamIds, which come from `streams`
// in the transceiver options (rtpSender.js:443) — NOT from fields on the track.
const stream = new MediaStream({ id: SPEAKER_ID, tracks: [track] });
pc.addTransceiver(track, { direction: "sendonly", streams: [stream] } as any);
const offer = await pc.createOffer();
await pc.setLocalDescription(offer);
const sdp = pc.localDescription!.sdp;
console.log("  msid in SDP:", /a=msid:/.test(sdp) ? sdp.match(/a=msid:.*/)?.[0] : "(ABSENT)");

const b = await chromium.launch({ executablePath: process.env.CHROME ?? "/home/claude/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome" });
const pg = await b.newPage();
const seen = await pg.evaluate(async (remoteSdp) => {
  const p = new RTCPeerConnection({ iceServers: [] });
  const got: any = await new Promise((res) => {
    p.ontrack = (e) => res({ streamIds: e.streams.map((s: any) => s.id), trackId: e.track.id });
    setTimeout(() => res({ timeout: true }), 4000);
    p.setRemoteDescription({ type: "offer", sdp: remoteSdp }).then(() => p.createAnswer()).then((a) => p.setLocalDescription(a));
  });
  return got;
}, sdp);
console.log("  browser ontrack sees:", JSON.stringify(seen));
console.log(seen.streamIds?.includes(SPEAKER_ID) ? "  ✅ IDENTITY SURVIVES — msid carries the speaker id" : "  ❌ does not survive");
await b.close(); pc.close();
