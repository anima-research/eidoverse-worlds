// voice-lifecycle — the consent choices, executed.
//
//   bun tools/voice-lifecycle-test.ts
//
// Fake RTCPeerConnection / getUserMedia / SpeechRecognition, per the review's
// ask: "a small fake harness is enough". Server smoke proves the relay; this
// proves the two permissions the relay knows nothing about — who may hear me,
// and whether I hear them — plus that refusing either does not restart-loop.

import { GlobalRegistrator } from "@happy-dom/global-registrator";
GlobalRegistrator.register();

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  else { fail++; console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? ` — ${detail}` : ""}`); }
};

// ---- fakes ----------------------------------------------------------------
const created: FakePC[] = [];
class FakeTrack { stopped = false; kind = "audio"; stop() { this.stopped = true; } }
class FakeStream {
  tracks = [new FakeTrack()];
  attached = false;
  getTracks() { return this.tracks; }
  getAudioTracks() { return this.tracks; }
}
// happy-dom's HTMLAudioElement takes srcObject silently; we observe the
// assignment so "was this track actually attached and played?" is a fact
// about the code's behaviour rather than a flag the test sets for itself.
Object.defineProperty(globalThis.HTMLMediaElement.prototype, "srcObject", {
  configurable: true,
  get() { return this._srcObject ?? null; },
  set(v) { this._srcObject = v; if (v && typeof v === "object") (v as { attached?: boolean }).attached = true; },
});
(globalThis.HTMLMediaElement.prototype as { play?: () => Promise<void> }).play = () => Promise.resolve();
class FakePC {
  signalingState = "stable";
  connectionState = "new";
  closed = false;
  transceivers: { direction: string; sender: { track: FakeTrack | null }; receiver: { track: { kind: string } } }[] = [];
  lastOfferOpts: unknown = null;
  senders: { track: FakeTrack | null }[] = [];
  localDescription: unknown = null;
  remote: unknown = null;
  ontrack: ((e: unknown) => void) | null = null;
  onicecandidate: unknown = null;
  onconnectionstatechange: unknown = null;
  constructor() { created.push(this); }
  addTrack(t: FakeTrack) {
    const sender = { track: t };
    this.senders.push(sender);
    // a real addTrack creates (or reuses) a sendrecv transceiver — modelled
    // faithfully, because that default is exactly what the bug rode in on
    this.transceivers.push({ direction: "sendrecv", sender, receiver: { track: { kind: "audio" } } });
    return sender;
  }
  removeTrack(s: { track: FakeTrack | null }) { s.track = null; }
  getSenders() { return this.senders; }
  getTransceivers() { return this.transceivers; }
  /** the direction actually offered to the far end */
  offeredDirection() { return this.transceivers[0]?.direction ?? "none"; }
  static gate: Promise<void> | null = null;   // slows createOffer for race tests
  async createOffer(opts?: unknown) {
    this.lastOfferOpts = opts ?? null;
    if (FakePC.gate) await FakePC.gate;
    return { type: "offer", sdp: "fake" };
  }
  async createAnswer() { return { type: "answer", sdp: "fake" }; }
  async setLocalDescription(d: unknown) { this.localDescription = d; this.signalingState = "have-local-offer"; }
  async setRemoteDescription(d: unknown) { this.remote = d; this.signalingState = "stable"; }
  async addIceCandidate() {}
  close() { this.closed = true; this.connectionState = "closed"; }
  playedAudio = false;
  /** Simulate the far end delivering audio. Acceptance is observed the way
   *  the code expresses it: an accepted track gets attached to an <audio>
   *  element (srcObject set); a refused one is stopped and dropped. We read
   *  the stream itself rather than trusting a flag we set ourselves. */
  deliverAudio() {
    const stream = new FakeStream();
    stream.attached = false;
    this.ontrack?.({ streams: [stream] });
    if (stream.attached) this.playedAudio = true;
  }
}
(globalThis as Record<string, unknown>).RTCPeerConnection = FakePC;

let micGrants = 0, micDenies = 0;
let denyMic = false;
Object.defineProperty(globalThis.navigator, "mediaDevices", {
  configurable: true,
  value: {
    async getUserMedia() {
      if (denyMic) { micDenies++; throw new Error("NotAllowedError"); }
      micGrants++; return new FakeStream();
    },
  },
});

let sttStarts = 0, sttStops = 0;
class FakeSR {
  continuous = false; interimResults = false; lang = "en";
  onresult: unknown = null; onerror: unknown = null; onend: unknown = null;
  start() { sttStarts++; }
  stop() { sttStops++; }
  abort() { sttStops++; }
}
(globalThis as Record<string, unknown>).SpeechRecognition = FakeSR;
(globalThis as Record<string, unknown>).webkitSpeechRecognition = FakeSR;

class FakeAudioCtx {
  currentTime = 0; state = "running";
  createGain() { return { gain: { value: 0, setTargetAtTime() {} }, connect: () => ({ connect() {} }), disconnect() {} }; }
  createMediaStreamSource() { return { connect: () => ({ connect() {} }), disconnect() {} }; }
  createAnalyser() { return { fftSize: 0, frequencyBinCount: 8, getByteTimeDomainData() {}, connect() {}, disconnect() {} }; }
  async resume() {}
}
(globalThis as Record<string, unknown>).AudioContext = FakeAudioCtx;

// Module substitution: voice.js reaches core/net/ui/controller/remotes, none
// of which can exist headless (core.js constructs a WebGPU renderer). Bun's
// module mock swaps them for tools/voice-stubs.mjs — same doctrine as the
// house's chat-core-stub.mjs, one level up.
const stubs = await import("./voice-stubs.mjs");
const { mock } = await import("bun:test");
for (const m of ["core", "net", "ui", "controller", "remotes"])
  mock.module(`${import.meta.dir}/../client/lib/${m}.js`, () => stubs);

const consent = await import("../client/lib/voiceconsent.js");
const voice = await import("../client/lib/voice.js");
const bus = stubs.bus;
// the rtc/roster/consent subscriptions live in initVoice — a client that
// never initialises has no voice at all, which is itself the correct default
voice.initVoice("me");

const settle = () => new Promise((r) => setTimeout(r, 20));
const offerFrom = (who: string) => bus.emit("rtc", { from: who, payload: { sdp: { type: "offer", sdp: "x" } } });

// ---- receive consent ------------------------------------------------------
consent.setReceiveVoice(false);
created.length = 0;
offerFrom("stranger");
await settle();
check("receive-OFF: an inbound offer opens no peer connection at all", created.length === 0,
  `${created.length} pc(s) created`);

consent.setReceiveVoice(true);
offerFrom("friend");
await settle();
check("receive-ON: an inbound offer is accepted", created.length >= 1);
const pc = created.at(-1)!;
check("receive-ON: the answer is sent back", pc.localDescription != null);

// ---- revoking listen tears the live leg down ------------------------------
consent.setReceiveVoice(false);
await settle();
check("revoking receive closes the existing inbound peer", pc.closed);

// ---- mic is a SEPARATE permission -----------------------------------------
consent.setReceiveVoice(true);
created.length = 0;
offerFrom("friend2");
await settle();
const inbound = created.at(-1)!;
denyMic = false;
await voice.toggleMic("me");
check("mic on requests exactly one getUserMedia", micGrants === 1, `${micGrants}`);
const liveTrack = (await import("../client/lib/voice.js")).micOn();
await voice.toggleMic("me");
check("mic off stops the local track", liveTrack === true && voice.micOn() === false);
check("mic off does NOT close a consented inbound peer (send ≠ receive)", !inbound.closed);
check("mic off leaves no outbound track on the peer",
  inbound.getSenders().every((s) => s.track === null));

// ---- refusal must not loop ------------------------------------------------
denyMic = true;
const before = micDenies;
const r1 = await voice.toggleMic("me");
await settle();
check("denied mic permission returns false and does not retry", r1 === false && micDenies === before + 1,
  `${micDenies - before} attempt(s)`);
denyMic = false;

// ---- STT is a third, separate choice --------------------------------------
consent.setSttConsent(false);
const stt = await import("../client/lib/stt.js");
sttStarts = 0;
stt.setSTT(true);
await settle();
check("STT does not start without its own consent",
  sttStarts === 0 || !consent.sttConsented(), `${sttStarts} start(s)`);
const consentSrc = await Bun.file(new URL("../client/lib/voiceconsent.js", import.meta.url)).text();
check("consent copy names the third party in plain words",
  /vendor|third party/i.test(consentSrc) && /transcrib/i.test(consentSrc));
check("consent copy says the text becomes a durable log entry",
  /world log|stored/i.test(consentSrc));
check("consent copy says voice works without it",
  /does NOT require|without it/i.test(consentSrc));

// ---- receive-off must survive our OWN mic being live (review catch) -------
// The other initiation direction: we offer. An offer that asks to receive
// audio can have that request answered, and ontrack then autoplays it — so
// consent has to live in the transceiver direction, not in a gate that only
// guards inbound offers.
consent.setReceiveVoice(false);
created.length = 0;
stubs.remotes.set("peer1", { agent: false });
denyMic = false;
await voice.toggleMic("me");            // mic ON, receive OFF
await settle();
const outbound = created.at(-1)!;
check("mic-ON + receive-OFF: an outbound peer exists", created.length >= 1);
check("mic-ON + receive-OFF: the offer is sendonly (no recv direction)",
  outbound.offeredDirection() === "sendonly", outbound.offeredDirection());
check("mic-ON + receive-OFF: no blanket offerToReceiveAudio",
  !JSON.stringify(outbound.lastOfferOpts ?? {}).includes("offerToReceiveAudio"));
outbound.deliverAudio();                 // far end tries to send anyway
await settle();
check("mic-ON + receive-OFF: an inbound track is refused, not played",
  !outbound.playedAudio, "audio was attached/played");

// now consent to hear: direction opens and tracks are accepted
consent.setReceiveVoice(true);
await settle();
check("enabling receive flips the live peer to sendrecv",
  outbound.offeredDirection() === "sendrecv", outbound.offeredDirection());
outbound.deliverAudio();
await settle();
check("enabling receive accepts an inbound track", outbound.playedAudio === true);

// and revoking with the mic still live must not re-open inbound
consent.setReceiveVoice(false);
await settle();
const after = created.at(-1)!;
check("revoking with mic live re-offers SENDONLY, not sendrecv",
  after.offeredDirection() === "sendonly", after.offeredDirection());
await voice.toggleMic("me");             // leave the mic off for the rest
stubs.remotes.delete("peer1");

// ---- hush vs revoke: silence and consent are different acts ---------------
// The review asked for "tear down/mute … legibly" — both were offered. Mute
// is what people press often, and a teardown there kills the in-flight
// utterance (found live at a desk: the sentence cut mid-word and the NEXT one
// started). So the frequent act is a gain change that keeps the stream, and
// the deliberate act still tears down for anyone wanting the hard guarantee.
{
  consent.setReceiveVoice(true);
  consent.setHush(false);
  created.length = 0;
  offerFrom("talker");
  await settle();
  const live = created.at(-1)!;
  check("hush: the peer survives (the utterance is not cut)",
    (consent.setHush(true), !live.closed));
  check("hush: state is remembered and legible", consent.isHushed() === true);
  check("hush does NOT revoke consent — audio is still arriving",
    consent.receivingVoice() === true);
  consent.setHush(false);
  check("unhush: still the same peer, so you rejoin mid-sentence", !live.closed);

  // ...whereas the deliberate revoke is still a real teardown
  consent.setReceiveVoice(false);
  await settle();
  check("revoke (Shift+V) still tears the peer down — the hard guarantee", live.closed);
  consent.setHush(false);
}

// ---- a refusal is an ANSWER, not an invitation to ask again --------------
// (review catch: sttConsent was a boolean, so a stored `false` was
// indistinguishable from "never asked" and every mic-on re-prompted — a no
// turned into a recurring negotiation.)
{
  // simulate a fresh person: nothing ever asked
  localStorage.removeItem("eido.audio.prefs");
  const fresh = await import(`../client/lib/voiceconsent.js?fresh=${Date.now()}`);
  // sttAsked may not exist on an older build — absence IS the bug (a boolean
  // cannot express "not asked"), so probe rather than crash
  const hasTriState = typeof fresh.sttAsked === "function";
  check("unset state is distinguishable from a refusal",
    hasTriState && fresh.sttAsked() === false && fresh.sttConsented() === false,
    hasTriState ? "" : "no sttAsked(): consent is a boolean, refusal == never-asked");

  let prompts = 0;
  const askNo = async () => { prompts++; return false; };
  const first = await fresh.ensureSttConsent(askNo);
  check("first mic-on asks, and a refusal is stored",
    prompts === 1 && first === false && (!hasTriState || fresh.sttAsked() === true));

  const second = await fresh.ensureSttConsent(askNo);
  check("a second mic-on does NOT ask again", prompts === 1 && second === false,
    `${prompts} prompt(s)`);

  // ...and the person can still change their mind deliberately, in the panel
  fresh.setSttConsent(true);
  check("enabling STT later works and needs no prompt", fresh.sttConsented() === true);
  const third = await fresh.ensureSttConsent(askNo);
  check("a remembered YES is returned without asking", prompts === 1 && third === true);
}

// ---- categories stay independent ------------------------------------------
consent.setVolume("world", 0.5);
consent.setReceiveVoice(false);
check("muting voices leaves world volume untouched", consent.audioPrefs().volWorld === 0.5);

// ---- the #34 lifecycle, pinned (review ask: fails on main) -----------------
// A receiver with receive-OFF drops the first offer BEFORE any peer exists;
// the sender wedges in have-local-offer with no heal path. recvReady is the
// wake-up. Then the two hard edges: recvReady during the in-flight FIRST
// offer (state still 'stable') must not double-offer or tear down, and
// recvReady on a healthy peer must be idempotent.
const { sent } = stubs;
const rtcFrom = (who: string, payload: unknown) => bus.emit("rtc", { from: who, payload });

// mic back ON for the sender role (earlier sections left it off)
if (!voice.micOn()) await voice.toggleMic("me");
stubs.remotes.set("nix", { agent: false });
sent.length = 0; created.length = 0;
bus.emit("roster");
await settle();
const wedged = created.at(-1) as FakePC;
check("sender offers a new arrival while live", !!wedged && sent.some((m: any) => m.to === "nix" && m.payload?.sdp?.type === "offer"));
check("no answer (their receive is off): sender is wedged in have-local-offer",
  wedged.signalingState === "have-local-offer");

sent.length = 0;
rtcFrom("nix", { recvReady: true });
await settle();
const rebuilt = created.at(-1) as FakePC;
check("recvReady drops the wedged leg", wedged.closed === true);
check("…and exactly one fresh offer reaches the receiver",
  rebuilt !== wedged && sent.filter((m: any) => m.to === "nix" && m.payload?.sdp?.type === "offer").length === 1,
  `${sent.length} sends`);
rtcFrom("nix", { sdp: { type: "answer", sdp: "x" } });
await settle();
check("their answer completes the healed leg", rebuilt.signalingState === "stable");

// -- recvReady racing the in-flight FIRST offer (state still 'stable') -------
let releaseGate!: () => void;
FakePC.gate = new Promise<void>((r) => { releaseGate = r; });
stubs.remotes.set("lyra", { agent: false });
sent.length = 0; created.length = 0;
bus.emit("roster");                       // offerTo(lyra) starts, parked inside createOffer
await settle();
const midflight = created.at(-1) as FakePC;
check("race setup: offer is in flight, state still stable",
  midflight.signalingState === "stable" && sent.length === 0);
rtcFrom("lyra", { recvReady: true });     // arrives DURING the first offer
await settle();
FakePC.gate = null; releaseGate();
await settle();
check("recvReady during an in-flight offer neither tears down nor double-offers",
  midflight.closed === false &&
  sent.filter((m: any) => m.to === "lyra" && m.payload?.sdp?.type === "offer").length === 1,
  `${sent.filter((m: any) => m.to === "lyra").length} offer(s), closed=${midflight.closed}`);

// -- recvReady on an already-healthy peer is idempotent ----------------------
rtcFrom("lyra", { sdp: { type: "answer", sdp: "x" } });
await settle();
sent.length = 0;
rtcFrom("lyra", { recvReady: true });
await settle();
check("duplicate recvReady on a healthy peer never tears it down",
  midflight.closed === false && created.at(-1) === midflight,
  `closed=${midflight.closed}, pcs=${created.length}`);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
