// relay-e2e — the phase-1 acceptance smoke against a REAL sequencer+LiveKit
// pair (start both first; see notes/relay-spike). Proves, with two live
// participants and actual audio frames:
//   1. mint → join → publish through the sequencer's credential (A1)
//   2. fail-closed receive: no frames before listener consent (amendment 3)
//   3. consent ON → frames flow (server-enforced subscription), latency measured
//   4. consent OFF → frames stop (revocation latency, acceptance row)
//   5. forged/stale credential → admission kicks it (amendment 1, ≤2s target)
// Env: SEQ=ws://127.0.0.1:8941  RELAY assumed per staging config.
import { Room, AudioSource, AudioFrame, AudioStream, LocalAudioTrack,
  TrackPublishOptions, TrackSource, RoomEvent } from "@livekit/rtc-node";
import { AccessToken } from "livekit-server-sdk";

const SEQ = process.env.SEQ ?? "ws://127.0.0.1:8941";
const results: string[] = [];
const say = (s: string) => { results.push(s); console.log(`  ${s}`); };

// ── tiny ws world client ────────────────────────────────────────────────────
interface SeqClient { ws: WebSocket; send: (o: object) => void; waitFor: (type: string, ms?: number) => Promise<any>; msgs: any[] }
function joinWorld(id: string): Promise<SeqClient> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(SEQ + "/ws");
    const c: SeqClient = { ws, send: (o) => ws.send(JSON.stringify(o)), msgs: [],
      waitFor: (type, ms = 8000) => new Promise((res, rej) => {
        const hit = c.msgs.find((m) => m.type === type);
        if (hit) return res(hit);
        const t0 = Date.now();
        const iv = setInterval(() => {
          const m = c.msgs.find((x) => x.type === type);
          if (m) { clearInterval(iv); res(m); }
          else if (Date.now() - t0 > ms) { clearInterval(iv); rej(new Error(`timeout waiting ${type}`)); }
        }, 25);
      }) };
    ws.onopen = () => c.send({ type: "join", world: "staging", id, avatar: null });
    ws.onmessage = (e) => { try { c.msgs.push(JSON.parse(String(e.data))); } catch {} };
    ws.onerror = (e) => reject(e);
    const iv = setInterval(() => {
      if (c.msgs.some((m) => m.type === "snapshot")) { clearInterval(iv); resolve(c); }
    }, 25);
    setTimeout(() => { clearInterval(iv); reject(new Error("join timeout")); }, 8000);
  });
}

// ── speaker: world join → relay-cred → publish a tone ───────────────────────
const speakerSeq = await joinWorld("e2e-speaker");
speakerSeq.send({ type: "relay-cred" });
const spkCred = await speakerSeq.waitFor("relay-cred");
say(`✅ mint: speaker got credential gen=${spkCred.gen} incarnation=${spkCred.incarnation}`);

const spkRoom = new Room();
await spkRoom.connect(spkCred.url.replace("0.0.0.0", "127.0.0.1"), spkCred.token, { autoSubscribe: false });
const src = new AudioSource(48000, 1);
const track = LocalAudioTrack.createAudioTrack("mic", src);
await spkRoom.localParticipant!.publishTrack(track,
  new TrackPublishOptions({ source: TrackSource.SOURCE_MICROPHONE, dtx: false, red: true }));
let publishing = true;
(async () => {   // continuous tone pacer
  const FRAME = 480; const buf = new Int16Array(FRAME); let t = 0;
  while (publishing) {
    for (let j = 0; j < FRAME; j++) buf[j] = Math.round(Math.sin(2 * Math.PI * 330 * (t++ / 48000)) * 9000);
    await src.captureFrame(new AudioFrame(buf, 48000, 1, FRAME));
  }
})();
say(`✅ publish: speaker live on the relay as ${spkCred.identity}`);
await new Promise((r) => setTimeout(r, 1500));   // webhook admission runs; must NOT kick us
say(spkRoom.connectionState !== "disconnected"
  ? "✅ admission: valid credential survived the webhook check"
  : "❌ admission kicked a VALID credential");

// ── listener: join → cred → count frames across the consent flips ───────────
const listenSeq = await joinWorld("e2e-listener");
listenSeq.send({ type: "relay-cred" });
const lisCred = await listenSeq.waitFor("relay-cred");
const lisRoom = new Room();
let frames = 0;
lisRoom.on(RoomEvent.TrackSubscribed, (rtrack) => {
  if (rtrack.kind !== 1 /* AUDIO */ && String(rtrack.kind) !== "audio") { /* fallthrough anyway */ }
  (async () => { for await (const _f of new AudioStream(rtrack)) frames++; })().catch(() => {});
});
await lisRoom.connect(lisCred.url.replace("0.0.0.0", "127.0.0.1"), lisCred.token, { autoSubscribe: false });

await new Promise((r) => setTimeout(r, 2500));
const framesBeforeConsent = frames;
say(framesBeforeConsent === 0
  ? "✅ fail-closed: 0 frames before listener consent"
  : `❌ fail-open: ${framesBeforeConsent} frames arrived without consent`);

const consentAt = Date.now();
listenSeq.send({ type: "voice-consent", recv: true });
await listenSeq.waitFor("voice-consent");
let consentLatencyMs = -1;
for (let i = 0; i < 200; i++) {
  if (frames > 0) { consentLatencyMs = Date.now() - consentAt; break; }
  await new Promise((r) => setTimeout(r, 50));
}
say(consentLatencyMs >= 0
  ? `✅ consent ON → audio in ${consentLatencyMs}ms (server-enforced subscribe)`
  : "❌ consent ON produced no frames in 10s");

const framesAtRevoke = frames;
const revokeAt = Date.now();
listenSeq.send({ type: "voice-consent", recv: false });
let revokeLatencyMs = -1;
{ let last = frames; let stableSince = Date.now();
  for (let i = 0; i < 240; i++) {
    await new Promise((r) => setTimeout(r, 50));
    if (frames !== last) { last = frames; stableSince = Date.now(); }
    else if (Date.now() - stableSince > 1200) { revokeLatencyMs = stableSince - revokeAt; break; }
  } }
say(revokeLatencyMs >= 0
  ? `✅ consent OFF → audio stopped ~${Math.max(0, revokeLatencyMs)}ms after the flip (${frames - framesAtRevoke} frames in flight)`
  : "❌ frames still flowing 12s after consent revoked");

// ── forged credential: valid signature, STALE generation claims ─────────────
// (The test holds the API secret only because it plays the attacker who stole
// one; in production the secret never leaves the adapter.)
const at = new AccessToken("devkey", "secret", { identity: "e2e-speaker#g1", ttl: "2m",
  metadata: JSON.stringify({ world: "staging", id: "e2e-speaker", primaryGen: 1, mediaGen: 1,
    incarnation: spkCred.incarnation, nonce: crypto.randomUUID() }) });
at.addGrant({ room: "staging", roomJoin: true, canPublish: true, canSubscribe: true });
const forged = new Room();
let forgedKickedMs = -1;
const forgedAt = Date.now();
try {
  await forged.connect(spkCred.url.replace("0.0.0.0", "127.0.0.1"), await at.toJwt(), { autoSubscribe: false });
  forged.on(RoomEvent.Disconnected, () => { if (forgedKickedMs < 0) forgedKickedMs = Date.now() - forgedAt; });
  for (let i = 0; i < 100 && forgedKickedMs < 0; i++) await new Promise((r) => setTimeout(r, 50));
} catch { forgedKickedMs = Date.now() - forgedAt; }
say(forgedKickedMs >= 0
  ? `✅ stale-gen forgery kicked in ${forgedKickedMs}ms (≤2000ms target: ${forgedKickedMs <= 2000 ? "MET" : "MISSED"})`
  : "❌ forged stale-generation credential is still in the room after 5s");

// ── teardown ────────────────────────────────────────────────────────────────
publishing = false;
await new Promise((r) => setTimeout(r, 200));
for (const r of [spkRoom, lisRoom, forged]) { try { await r.disconnect(); } catch {} }
speakerSeq.ws.close(); listenSeq.ws.close();
const failed = results.filter((r) => r.startsWith("❌"));
console.log(`\n${failed.length ? "❌" : "✅"} relay-e2e: ${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
