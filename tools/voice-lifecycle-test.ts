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
class FakeTrack {
  stopped = false;
  enabled = true;              // the consent gate silences via enabled, never stop()
  readyState = "live";
  kind = "audio";
  stop() { this.stopped = true; this.readyState = "ended"; }
}
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
// A real RTCRtpSender can be re-pointed at a different track without
// renegotiating. Modelled because the repair for the mic-after-peer races uses
// it: an existing sender whose track is null is exactly the state a peer is
// left in when it was built before the mic opened.
type FakeSender = { track: FakeTrack | null; replaceTrack(t: FakeTrack | null): Promise<void> };
const mkSender = (t: FakeTrack | null): FakeSender => ({
  track: t,
  replaceTrack(next) { this.track = next; return Promise.resolve(); },
});

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
    const sender = mkSender(t);
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
  static gate: Promise<void> | null = null;
  static answerGate: Promise<void> | null = null;   // parks setRemoteDescription
  offers = 0;                 // how many offers this peer has actually produced —
                              // the fourth-class tests assert on EXACTLY ONE
                              // follow-up, which needs a real count rather than
                              // a field that silently reads undefined.
  async createOffer(opts?: unknown) {
    this.offers++;
    this.lastOfferOpts = opts ?? null;
    if (FakePC.gate) await FakePC.gate;
    return { type: "offer", sdp: "fake" };
  }
  async setLocalDescription(d: unknown) {
    await new Promise((r) => setTimeout(r, 1));           // yield: lets a rival handler interleave
    const t = (d as { type?: string })?.type;
    if (t === "answer" && this.signalingState !== "have-remote-offer") {
      const e = new Error(`Failed to set local answer sdp: Called in wrong state: ${this.signalingState}`);
      e.name = "InvalidStateError"; throw e;
    }
    this.localDescription = d;
    this.signalingState = t === "answer" ? "stable" : t === "rollback" ? "stable" : "have-local-offer";
  }
  async setRemoteDescription(d: unknown) {
    await new Promise((r) => setTimeout(r, 1));           // yield: interleave window
    // Separate gate from FakePC.gate (which parks createOffer). The
    // cross-generation seam needs an ANSWER handler held mid-await while its
    // peer is dropped and rebuilt underneath it — that is the only way to make
    // an old handler resume against a replacement (Mica, #62).
    if (FakePC.answerGate) await FakePC.answerGate;
    this.remote = d;
    const t = (d as { type?: string })?.type;
    this.signalingState = t === "offer" ? "have-remote-offer" : "stable";
  }
  async createAnswer() {
    await new Promise((r) => setTimeout(r, 1));           // yield: interleave window
    if (this.signalingState !== "have-remote-offer") {
      const e = new Error("PeerConnection cannot create an answer in a state other than have-remote-offer");
      e.name = "InvalidStateError"; throw e;
    }
    this.answersCreated++;
    return { type: "answer", sdp: "fake" };
  }
  get remoteDescription() { return this.remote; }
  addedCandidates: unknown[] = [];
  answersCreated = 0;
  async addIceCandidate(c: unknown) {
    if (!this.remote) { const e = new Error("The remote description was null"); e.name = "InvalidStateError"; throw e; }
    this.addedCandidates.push(c);
  }
  close() {
    this.closed = true;
    this.connectionState = "closed";
    // A real pc.close() ends every receiver's track and detaches the element.
    // The fake used to only set a flag, so a test could observe audio still
    // "playing" from a closed connection — which is how a revoke-path privacy
    // assertion could fail for a reason that did not exist in the browser.
    for (const r of this._receivers) r.track.readyState = "ended";
    if (this._lastStream) this._lastStream.attached = false;
  }
  playedAudio = false;
  /** Simulate the far end delivering audio. Acceptance is observed the way
   *  the code expresses it: an accepted track gets attached to an <audio>
   *  element (srcObject set); a refused one is stopped and dropped. We read
   *  the stream itself rather than trusting a flag we set ourselves. */
  deliverAudio() {
    const stream = new FakeStream();
    stream.attached = false;
    // The receiver and the stream expose the SAME track object, as a real
    // browser does. An earlier version of this fake built two, so code that
    // disabled the stream's track left the receiver's looking untouched — a
    // consent test could pass while consent did nothing. (Mica, #34.)
    this._receivers = [{ track: stream.tracks[0] }];
    this._lastStream = stream;
    this.ontrack?.({ streams: [stream] });
    if (stream.attached) this.playedAudio = true;
  }
  _receivers: { track: FakeTrack }[] = [];
  _lastStream: FakeStream | null = null;
  getReceivers() { return this._receivers; }
  /** Audible = attached to an element AND not silenced AND not destroyed. */
  inboundAudible() {
    const t = this._receivers[0]?.track;
    return !!(t && t.enabled && t.readyState === "live" && this._lastStream?.attached);
  }
  inboundStopped() { return this._receivers[0]?.track.readyState === "ended"; }
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
  static level = 0;   // amplitude the fake mic "hears" — RMS of a filled buffer equals it
  createAnalyser() { return { fftSize: 512, frequencyBinCount: 8,
    getByteTimeDomainData() {},
    getFloatTimeDomainData(buf: Float32Array) { buf.fill(FakeAudioCtx.level); },
    connect() {}, disconnect() {} }; }
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
// #95's roster rule: RTC never builds a peer for an id the world hasn't
// announced. Sections announce their speakers lazily, at the moment of
// speaking (seed-if-absent, so a section's richer seed — an avatar with
// distance, say — is never clobbered), which keeps mic-on from courting
// the whole future cast at once.
const announce = (who: string) => { if (!stubs.remotes.has(who)) stubs.remotes.set(who, { id: who, agent: false }); };
const offerFrom = (who: string) => { announce(who); bus.emit("rtc", { from: who, payload: { sdp: { type: "offer", sdp: "x" } } }); };

// ---- #95: the unannounced are refused --------------------------------------
{
  offerFrom("unannounced-ghost");
  await settle();
  check("an SDP offer from an id the world never announced builds no peer",
    !created.some((pc: any) => pc._for === "unannounced-ghost") && created.length === 0);
  bus.emit("rtc", { from: "unannounced-ghost", payload: { recvReady: true } });
  await settle();
  check("recvReady from an unannounced id courts nobody", stubs.sent.length === 0);
}

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
// What must be true is that nothing is AUDIBLE — not that nothing is attached.
// Those two come apart exactly where the one-way bug lived: stop() made the
// track unattached AND unrecoverable, and the old assertion could not tell the
// difference between a refusal and a destruction.
check("mic-ON + receive-OFF: an inbound track is silenced, not audible",
  outbound.inboundAudible() === false, "audio was audible with receive off");
check("mic-ON + receive-OFF: ...and NOT destroyed (revocable, not fatal)",
  outbound.inboundStopped() === false, "the gate stopped a remote track — one-way door");

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
// ---- #26 review: the new behavior, pinned where it travels ----------------
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const { typed } = stubs as { typed: { to: unknown; state: string }[] };

// -- mic floor clamps and persists ------------------------------------------
check("mic floor clamps its ceiling", consent.setMicFloor(9) === 0.2);
check("mic floor clamps its floor", consent.setMicFloor(-3) === 0);
consent.setMicFloor(0.04);
{
  const fresh = await import(`../client/lib/voiceconsent.js?fresh-floor=${performance.now()}`);
  check("mic floor persists across a fresh module load", fresh.micFloor() === 0.04,
    `${fresh.micFloor()}`);
}

// -- speech onset: local analyser, no vendor STT anywhere in the loop -------
if (!voice.micOn()) await voice.toggleMic("me");
const sttStartsBefore = sttStarts;
typed.length = 0;
FakeAudioCtx.level = 0;
await sleep(300);
check("below the floor: no onset ever", typed.length === 0, `${typed.length}`);
FakeAudioCtx.level = 0.1;
await sleep(300);
check("crossing the floor emits exactly one 'mic' presence",
  typed.length === 1 && typed[0].state === "mic", JSON.stringify(typed));
await sleep(300);
check("sustained speech does not re-emit", typed.length === 1, `${typed.length}`);
FakeAudioCtx.level = 0.01;   // below hysteresis (0.6 × floor)
await sleep(300);
FakeAudioCtx.level = 0.1;    // re-cross inside the 1.5s refractory
await sleep(300);
check("a re-cross inside the refractory window stays quiet", typed.length === 1,
  `${typed.length}`);
check("no SpeechRecognition was consulted for any of it (STT-off contract)",
  sttStarts === sttStartsBefore, `${sttStarts - sttStartsBefore} start(s)`);
FakeAudioCtx.level = 0;

// -- hush is a gain that ARRIVES, and never a teardown ----------------------
consent.setReceiveVoice(true);
consent.setHush(false);
created.length = 0;
stubs.remotes.set("neighbor", { agent: false, avatar: { root: { position: { distanceTo: () => 0 } } } });
offerFrom("neighbor");
await settle();
const hushPc = created.at(-1) as FakePC;
hushPc.deliverAudio();
await sleep(1300);
const preHush = voice.peerVolume?.("neighbor");
check("audible before hush", (preHush ?? 0) > 0.9, `${preHush}`);
consent.setHush(true);
await sleep(1300);   // 300ms want-pass + 700ms linear fade + margin
check("hush reaches EXACT zero (no lingering whisper)",
  voice.peerVolume?.("neighbor") === 0, `${voice.peerVolume?.("neighbor")}`);
check("…and the peer connection survives the silence (gain, not teardown)",
  hushPc.closed === false && hushPc.playedAudio === true);
consent.setHush(false);
await sleep(1300);
check("unhush rejoins the SAME peer at full volume",
  (voice.peerVolume?.("neighbor") ?? 0) > 0.9 && created.at(-1) === hushPc,
  `vol=${voice.peerVolume?.("neighbor")}, pcs=${created.length}`);

// -- panel and HUD repaint from one truth -----------------------------------
{
  const hud = document.createElement("div"); hud.id = "hud";
  document.body.appendChild(hud);
  await import("../client/lib/mictoggle.js");
  const ear = document.getElementById("eartoggle")!;
  check("HUD ear glyph exists once a hud does", !!ear);
  const panel = await import("../client/lib/audiopanel.js");
  panel.initAudioPanel();
  const section = document.getElementById("section-audio")!;
  const hearBox = () => [...section.querySelectorAll(".sp-row")].find((r) =>
    r.textContent?.includes("hear voices"))?.querySelector("input") as HTMLInputElement;
  check("panel renders the hear-voices row", !!hearBox());
  consent.setHush(true);
  check("hush flips the HUD ear to its off-state (one truth, no second visual language)",
    ear.title.includes("hushed"), ear.title);
  check("…and the panel checkbox repaints from the same truth", hearBox().checked === false);
  hearBox().checked = true;
  hearBox().dispatchEvent(new Event("change"));   // tick the PANEL row…
  await settle();
  check("…ticking the panel row unhushes the HUD glyph too",
    ear.title.includes("hearing") && consent.isHushed() === false, ear.title);
}

// ---- trickle ICE vs the consent gate (Mica's spec, 2026-08-07) ------------
// Voice only ever worked via peer-reflexive luck: the gate dropped payload.ice
// for mic-only senders, and addIceCandidate failures were swallowed. These
// pin the repaired contract. All five FAIL on pre-fix main.
{
  // T1: mic-ON + receive-OFF sender must still ingest ICE for its own offer
  consent.setReceiveVoice(false);
  if (!voice.micOn()) await voice.toggleMic("me");  // ensure mic ON, receive OFF
  await settle();
  created.length = 0;
  stubs.remotes.set("peerA", { agent: false });     // roster rescan offers to new ids
  bus.emit("roster");
  await settle();
  const out = created.at(-1)!;
  bus.emit("rtc", { from: "peerA", payload: { sdp: { type: "answer", sdp: "x" } } });
  await settle();
  bus.emit("rtc", { from: "peerA", payload: { ice: { candidate: "cand-1" } } });
  await settle();
  check("gate: mic-only sender ingests remote ICE for its own offer (was dropped)",
    out.addedCandidates.length === 1, `${out.addedCandidates.length} added`);

  // T2: ICE arriving BEFORE the answer is queued, then flushed after it
  stubs.remotes.set("peerB", { agent: false });
  bus.emit("roster");
  await settle();
  const out2 = created.at(-1)!;
  bus.emit("rtc", { from: "peerB", payload: { ice: { candidate: "early-1" } } });
  bus.emit("rtc", { from: "peerB", payload: { ice: { candidate: "early-2" } } });
  await settle();
  check("queue: pre-answer ICE neither throws nor lands early", out2.addedCandidates.length === 0);
  bus.emit("rtc", { from: "peerB", payload: { sdp: { type: "answer", sdp: "x" } } });
  await settle();
  check("queue: candidates flush after setRemoteDescription",
    out2.addedCandidates.length === 2, `${out2.addedCandidates.length} flushed`);

  // T3: stray ICE from an unknown sender creates NO peer. Receive is ON for
  // this one — with receive off, main's gate happens to hide its own
  // peer-from-ICE bug behind the gate bug; consent on exposes it (fail-on-main).
  consent.setReceiveVoice(true);
  const n = created.length;
  bus.emit("rtc", { from: "total-stranger", payload: { ice: { candidate: "stray" } } });
  await settle();
  check("stray ICE conjures no peer connection", created.length === n, `${created.length - n} created`);
  consent.setReceiveVoice(false);

  // T4: a rebuilt peer must not inherit the old generation's queued ICE
  stubs.remotes.set("peerC", { agent: false });
  bus.emit("roster");
  await settle();
  const gen1 = created.at(-1)!;
  bus.emit("rtc", { from: "peerC", payload: { ice: { candidate: "gen1-stale" } } });
  await settle();                                   // queued on gen1 (no answer yet)
  gen1.signalingState = "have-local-offer";         // wedge it so recvReady rebuilds
  announce("peerC"); bus.emit("rtc", { from: "peerC", payload: { recvReady: true } });
  await settle();
  const gen2 = created.at(-1)!;
  check("rebuild actually made a fresh pc", gen2 !== gen1);
  bus.emit("rtc", { from: "peerC", payload: { sdp: { type: "answer", sdp: "x" } } });
  await settle();
  check("rebuilt peer inherits NO stale queued ICE from the dropped generation",
    gen2.addedCandidates.length === 0, `${gen2.addedCandidates.length} contaminated`);
  if (voice.micOn()) await voice.toggleMic("me");    // mic back off — leave state clean
}
// T-race: forced interleaving — two offers in the same tick (Mica's review:
// the async race must be FORCED, not hoped for). FakePC ops yield 1ms each,
// so unserialized handlers interleave deterministically.
{
  consent.setReceiveVoice(true);
  (globalThis as { window?: { __iceLog?: unknown[] } }).window ??= globalThis as never;
  const w = globalThis as unknown as { __iceLog: string[] };
  w.__iceLog = [];
  created.length = 0;
  stubs.sent.length = 0;
  announce("racer"); bus.emit("rtc", { from: "racer", payload: { sdp: { type: "offer", sdp: "o1" } } });
  bus.emit("rtc", { from: "racer", payload: { sdp: { type: "offer", sdp: "o2" } } });  // same tick — no settle between
  await new Promise((r) => setTimeout(r, 60));
  const sigFails = (w.__iceLog ?? []).filter((x) => typeof x === "string" && x.startsWith("signal-FAIL"));
  check("forced double-offer interleave: zero signal errors (serialization holds)",
    sigFails.length === 0, sigFails.join(" | ").slice(0, 120));
  const pc9 = created.at(-1)!;
  const answersSent = stubs.sent.filter((m: { to: string; payload: { sdp?: { type?: string } } }) =>
    m.to === "racer" && m.payload?.sdp?.type === "answer").length;
  check("forced double-offer interleave: BOTH answers actually SENT (main loses the second at setLocal)",
    answersSent === 2 && pc9.signalingState === "stable",
    `answersSent=${answersSent} state=${pc9.signalingState}`);
  consent.setReceiveVoice(false);
}


// ---- the one-way bug: consent AFTER a track has already arrived -----------
// Field report 2026-08-08: "they can hear me, I can't hear them." ontrack
// fires ONCE per transceiver. A track arriving while receive is off was
// stop()ed — permanent, since receiver.track is never reassigned (WebRTC-PC
// §5.3.1) — so consenting later repaired the DIRECTION while nothing was ever
// wired. Outbound was unaffected, hence exactly one-way, and dependent on who
// arrived first. All three FAIL on pre-fix main.
{
  consent.setReceiveVoice(false);
  if (!voice.micOn()) await voice.toggleMic("me");   // mic ON, receive OFF
  await settle();
  created.length = 0;
  stubs.remotes.set("oneway", { agent: false });
  bus.emit("roster");
  await settle();
  const pcX = created.at(-1)!;
  if (!pcX) throw new Error("no peer was built for the one-way test");

  pcX.deliverAudio();                       // arrives BEFORE consent
  await settle();
  check("one-way: nothing audible before consent",
    pcX.inboundAudible() === false, "audio played before consent was given");
  check("one-way: the refused track survives for later (not stop()ed)",
    pcX.inboundStopped() === false, "remote track destroyed — unrecoverable");

  consent.setReceiveVoice(true);             // consent arrives AFTER
  await settle();
  check("one-way: consenting AFTER arrival makes the SAME track audible",
    pcX.inboundAudible() === true,
    "direction repaired but the earlier track never became audible — one-way audio");
  // AUDIBLE is not the whole repair. peerLevels() skips any peer with no
  // `p.stream`, so a peer could recover its sound while staying permanently
  // mouth-blind — a half-repair visible only from OUTSIDE the session, which
  // is the same shape as the bug itself. (Mica, #63 review.)
  // Asserted through the real consumer rather than a test-only accessor:
  // peerLevels() does `if (!p.stream) continue`, so a mouth-blind peer is
  // simply absent from its map. AudioContext is unavailable under happy-dom,
  // so the analyser path throws and `continue`s — presence in the map is the
  // signal we can read here, and absence is exactly the bug.
  check("one-way: the repaired peer is also VISIBLE (p.stream pinned for the mouth)",
    // Optional-call so the negative control FAILS rather than crashing: on
    // pre-fix main the export does not exist, and a TypeError would prove only
    // that, not that the mouth is blind. Absent export reads as unbound, which
    // is the same user-visible outcome.
    voice.voiceMouthBound?.()["oneway"] === true,
    "audio recovered but p.stream is unset — peerLevels() skips them, mouth never moves");

  // Repeated revoke/enable must not degrade. NOTE: revoke calls dropPeer, so
  // each cycle builds a NEW RTCPeerConnection — the assertion has to follow
  // the current peer rather than the original handle. (My first version held
  // the stale one and "failed" on a connection the code had correctly closed.)
  let ratchet = "";
  for (let i = 0; i < 5 && !ratchet; i++) {
    consent.setReceiveVoice(false); await settle();
    const closed = created.at(-1)!;
    if (closed.inboundAudible()) ratchet = `cycle ${i}: audible after revoke`;

    consent.setReceiveVoice(true); await settle();
    const fresh = created.at(-1)!;
    fresh.deliverAudio();                    // the far end re-sends on the new leg
    await settle();
    if (!fresh.inboundAudible()) ratchet = `cycle ${i}: silent after re-consent`;
  }
  check("one-way: five revoke/enable cycles stay reversible (no ratchet)",
    ratchet === "", ratchet);
  consent.setReceiveVoice(false);
}

// ---- mic-after-peer: the track must reach peers built before it -----------
// Two races, both leaving a peer with a sender carrying NO track on a
// transceiver negotiated sendrecv: it renegotiates happily and transmits
// silence, forever, while the UI reports "mic LIVE". Field receipt (phone on
// cellular -> Burrow, 2026-08-07): in=1179 out=0.
// Both FAIL on pre-fix main.
{
  // T6: peer exists BEFORE the mic opens.
  // toggleMic is a TOGGLE — drive to the state, never assume a call reaches it.
  if (voice.micOn()) { await voice.toggleMic("me"); await settle(); }
  consent.setReceiveVoice(true);
  created.length = 0;
  stubs.remotes.set("early", { agent: false });
  bus.emit("roster");                                // peer built with no mic
  await settle();
  announce("early"); bus.emit("rtc", { from: "early", payload: { sdp: { type: "offer", sdp: "x" } } });
  await settle();
  const pcEarly = created.at(-1)!;
  if (!voice.micOn()) { await voice.toggleMic("me"); await settle(); }   // mic ON now
  await settle();
  const live = pcEarly.getSenders().filter((s) => s.track);
  check("mic-after-peer: an existing peer gets the track (was a sender with none)",
    live.length === 1, `${live.length} live senders of ${pcEarly.getSenders().length}`);

  // T7: a peer appears WHILE mic acquisition is still pending. This is the
  // race that made it intermittent — getUserMedia takes hundreds of ms, and a
  // peer built inside that await is constructed while micStream is still null,
  // so addTrack skips it AND any one-shot back-fill has already run. Forced
  // deterministically rather than hoped for: the stub holds the promise open
  // until we have created the peer.
  if (voice.micOn()) { await voice.toggleMic("me"); await settle(); }    // back to mic OFF
  created.length = 0;
  let release: (() => void) | null = null;
  const held = new Promise<void>((r) => { release = r; });
  const realGUM = navigator.mediaDevices.getUserMedia;
  (navigator.mediaDevices as { getUserMedia: unknown }).getUserMedia = async (c: unknown) => {
    await held;                                      // peer arrives during this
    return realGUM.call(navigator.mediaDevices, c);
  };
  const micOpening = voice.micOn() ? Promise.resolve(false) : voice.toggleMic("me");
  await settle();
  stubs.remotes.set("during", { agent: false });
  announce("during"); bus.emit("rtc", { from: "during", payload: { sdp: { type: "offer", sdp: "x" } } });
  await settle();                                    // peer now exists, micStream still null
  release!();
  await micOpening;
  await settle();
  (navigator.mediaDevices as { getUserMedia: unknown }).getUserMedia = realGUM;
  const pcDuring = created.at(-1)!;
  const liveDuring = pcDuring.getSenders().filter((s) => s.track);
  check("mic-during-acquisition: a peer born inside the getUserMedia await still gets the track",
    liveDuring.length === 1, `${liveDuring.length} live senders of ${pcDuring.getSenders().length}`);

  // Exactly one — a repair that attaches on every renegotiation must not
  // accumulate duplicate senders on a peer that is offered to repeatedly.
  bus.emit("roster"); await settle();
  bus.emit("roster"); await settle();
  check("mic-after-peer: repeated renegotiation does not stack duplicate senders",
    pcDuring.getSenders().filter((s) => s.track).length === 1,
    `${pcDuring.getSenders().length} senders total`);
}

{
  // Digi/antra field case (commons, 2026-08-07): voice worked ONCE, then never
  // again across mic toggles. removeTrack nulls the sender but leaves it in
  // place, so a later mic-on — which only addTracks on NEW peers — never
  // re-attaches. The first toggle-off is permanent, not unlucky.
  if (voice.micOn()) { await voice.toggleMic("me"); await settle(); }
  consent.setReceiveVoice(true);
  created.length = 0;
  if (!voice.micOn()) { await voice.toggleMic("me"); await settle(); }   // mic ON first
  stubs.remotes.set("digi", { agent: false });
  bus.emit("roster"); await settle();
  const pcT = created.at(-1)!;
  check("toggle: first connection while mic live has a track (the 'hello' that worked)",
    pcT.getSenders().filter((s) => s.track).length === 1);
  await voice.toggleMic("me"); await settle();     // mic OFF
  await voice.toggleMic("me"); await settle();     // mic ON again
  check("toggle: mic off->on re-attaches to the SAME peer (was permanent silence)",
    pcT.getSenders().filter((s) => s.track).length === 1,
    `${pcT.getSenders().filter((s) => s.track).length} live of ${pcT.getSenders().length}`);
}

{
  // The toggle bug bites LISTENERS, not speakers. mic-off drops the peer when
  // we are not receiving (so mic-on rebuilds it with the track — recovers),
  // but keeps it when we are (stripping the track and leaving an empty
  // sender). Digi toggled freely in commons while mic-only; anyone wearing
  // headphones would have been silenced by their own toggle with no signal.
  if (voice.micOn()) { await voice.toggleMic("me"); await settle(); }
  consent.setReceiveVoice(false);                 // mic-only, like Digi
  created.length = 0;
  if (!voice.micOn()) { await voice.toggleMic("me"); await settle(); }
  stubs.remotes.set("deaf", { agent: false });
  bus.emit("roster"); await settle();
  await voice.toggleMic("me"); await settle();    // OFF -> dropPeer
  await voice.toggleMic("me"); await settle();    // ON  -> fresh peer
  bus.emit("roster"); await settle();
  const pcFresh = created.at(-1)!;
  check("toggle while NOT receiving: peer is rebuilt with a track (why Digi's toggles worked)",
    pcFresh.getSenders().filter((s) => s.track).length === 1,
    `${pcFresh.getSenders().filter((s) => s.track).length} live of ${pcFresh.getSenders().length}`);
  consent.setReceiveVoice(true);
}

{
  // Mica's third timing class (#34): the mic opens while a peer is parked in
  // have-remote-offer — mid-negotiation, so renegotiate() bails. The track
  // must still be attached, and the in-flight answer must carry it, without
  // forcing a second negotiation into a state that cannot take one.
  if (voice.micOn()) { await voice.toggleMic("me"); await settle(); }
  consent.setReceiveVoice(true);
  created.length = 0;
  stubs.remotes.set("midneg", { agent: false });
  // hold the answer inside createAnswer so the peer stays in have-remote-offer
  let release: (() => void) | null = null;
  const held = new Promise<void>((r) => { release = r; });
  const origCreateAnswer = FakePC.prototype.createAnswer;
  FakePC.prototype.createAnswer = async function () { await held; return origCreateAnswer.call(this); };
  announce("midneg"); bus.emit("rtc", { from: "midneg", payload: { sdp: { type: "offer", sdp: "x" } } });
  await settle();
  const pcMid = created.at(-1)!;
  check("mid-negotiation: peer is parked in have-remote-offer",
    pcMid.signalingState === "have-remote-offer", pcMid.signalingState);
  if (!voice.micOn()) { await voice.toggleMic("me"); await settle(); }   // mic ON mid-negotiation
  release!();
  await settle();
  FakePC.prototype.createAnswer = origCreateAnswer;
  check("mid-negotiation: the track still lands on a peer renegotiate() would skip",
    pcMid.getSenders().filter((s) => s.track).length === 1,
    `${pcMid.getSenders().filter((s) => s.track).length} live of ${pcMid.getSenders().length}`);
  check("mid-negotiation: peer ends stable with no duplicate offer",
    pcMid.signalingState === "stable", pcMid.signalingState);
}

{
  // Mica's fourth class, the variant I can actually REACH (#62 review). A peer
  // offered with a live mic, then the mic toggled off and on while that offer
  // is still in flight: the in-flight offer describes a track that has since
  // been stopped and replaced. renegotiate() bails while unstable, so unless
  // something reconciles on return to stable, the far end is left holding a
  // description of a dead track.
  //
  // (CORRECTED: the mic-LESS local offer IS reachable, and my "every offer
  // path is mic-gated" reading was wrong — I grepped the offer-INITIATING
  // sites and skipped renegotiate()'s callers. toggleMic's OFF branch calls
  // renegotiate AFTER micStream = null, so it builds a genuinely mic-less
  // offer and parks the peer in have-local-offer. Note it fires only when
  // receive is ON — the same asymmetry as the toggle bug: it selects for
  // listeners. The generation-bound pending-on-stable repair for that case is
  // still outstanding; this test covers the mid-offer variant only.)
  if (voice.micOn()) { await voice.toggleMic("me"); await settle(); }
  consent.setReceiveVoice(true);
  if (!voice.micOn()) { await voice.toggleMic("me"); await settle(); }   // mic ON
  created.length = 0;
  stubs.remotes.set("stale", { agent: false });
  FakePC.gate = new Promise<void>(() => {});          // park the offer in flight
  bus.emit("roster"); await settle();
  const pcStale = created.at(-1)!;
  FakePC.gate = null;
  await voice.toggleMic("me"); await settle();        // mic OFF mid-offer
  await voice.toggleMic("me"); await settle();        // mic ON again
  const liveStale = pcStale.getSenders().filter((s) => s.track);
  check("stale-offer: the peer carries exactly one live track after a mid-offer toggle",
    liveStale.length === 1, `${liveStale.length} live of ${pcStale.getSenders().length}`);
}

// ---- FOURTH TIMING CLASS: mic change during an outstanding local offer ------
// Mica's #62 review. The peer holds a local offer built WITHOUT the mic track;
// toggling the mic attaches locally, but renegotiate() bails while unstable and
// nothing schedules a follow-up — so the far end keeps a description of a
// send-less peer forever and nobody hears you. Field receipt: Digi in commons,
// 2026-08-08, "nobody on desktop or mobile heard her".
//
// HONEST NOTE ON THE FIXTURE: the peer is parked in have-local-offer
// DELIBERATELY, not reached by a natural race. Several attempts at a natural
// repro kept landing in stable because createOffer cannot be reliably held open
// at the moment renegotiate runs. The state is real and reachable in
// production (toggleMic's OFF branch renegotiates after micStream = null);
// this test forces it rather than claiming a repro I do not have.
{
  consent.setReceiveVoice(true);
  if (!voice.micOn()) await voice.toggleMic("me");
  await settle();
  created.length = 0;
  stubs.remotes.set("fourth", { agent: false });
  bus.emit("roster");
  await settle();
  const pc4 = created.at(-1)!;
  if (!pc4) throw new Error("no peer built for the fourth-class test");

  // The peer is ALREADY in have-local-offer: it offered on roster and nobody
  // has answered. That is the real state this class describes, reached
  // naturally — no forcing needed. (I forced it at first and the force was
  // overwritten by the peer's own offer, which is how I noticed.)
  await settle();
  check("fourth class: the peer really is mid-negotiation before we toggle",
    pc4.signalingState === "have-local-offer", pc4.signalingState);
  const offersBefore = pc4.offers ?? 0;
  await voice.toggleMic("me"); await settle();  // mic OFF while unstable
  await voice.toggleMic("me"); await settle();  // mic ON  while unstable

  check("fourth class: no glare — nothing offers into an unstable peer",
    (pc4.offers ?? 0) === offersBefore,
    `offers went ${offersBefore} -> ${pc4.offers} while unstable`);

  // the old answer lands, returning the peer to stable
  bus.emit("rtc", { from: "fourth", payload: { sdp: { type: "answer", sdp: "x" } } });
  await settle();

  // The answer lands and the reconciliation fires — which means the peer is
  // back in have-local-offer, carrying the FOLLOW-UP offer. Asserting "ends
  // stable" was my own error: a successful follow-up necessarily re-enters
  // negotiation. What must be true is that the answer was consumed (the
  // remote description changed) and exactly one new offer went out.
  check("fourth class: the old answer is consumed, not dropped",
    (pc4 as { remote?: unknown }).remote != null,
    "the in-flight answer never reached setRemoteDescription");

  check("fourth class: EXACTLY ONE follow-up offer after returning to stable",
    (pc4.offers ?? 0) === offersBefore + 1,
    `expected ${offersBefore + 1} offers, got ${pc4.offers}`);

  const live4 = pc4.getSenders().filter((s: { track: unknown }) => s.track);
  check("fourth class: the follow-up advertises a LIVE send direction",
    live4.length === 1, `${live4.length} live senders of ${pc4.getSenders().length}`);

  // idempotence: a second trip through stable must not stack another offer
  bus.emit("rtc", { from: "fourth", payload: { sdp: { type: "answer", sdp: "x" } } });
  await settle();
  check("fourth class: no duplicate follow-up on a second return to stable",
    (pc4.offers ?? 0) === offersBefore + 1,
    `offers crept to ${pc4.offers}`);
}

// ---- pending work dies with its peer (generation-bound) --------------------
// An answer carries no negotiation identity, so a follow-up owed by a peer that
// has since been dropped and rebuilt must not be paid by its replacement.
// Asserted on the MECHANISM rather than on an offer count: a replacement peer
// legitimately raises its own pending flag at its own generation, so counting
// offers cannot distinguish "paid the dead peer's debt" from "paid its own".
// (That is exactly how my first version of this test failed — it counted, and
// the count was right for the wrong reason.)
{
  consent.setReceiveVoice(true);
  if (!voice.micOn()) await voice.toggleMic("me");
  await settle();
  created.length = 0;
  stubs.remotes.set("gen", { agent: false });
  bus.emit("roster");
  await settle();
  const genOld = created.at(-1)!;
  const genBefore = voice.voicePendingReneg?.()["gen"];

  consent.setReceiveVoice(false); await settle();   // dropPeer kills the old one
  consent.setReceiveVoice(true);  await settle();   // a NEW peer is built
  const genNew = created.at(-1)!;
  const genAfter = voice.voicePendingReneg?.()["gen"];

  check("generation: a rebuilt peer is a genuinely new object",
    genNew !== genOld, "dropPeer+rebuild returned the same pc");
  check("generation: the replacement carries its OWN generation, not the dead one's",
    genAfter == null || genBefore == null || genAfter !== genBefore,
    `old gen ${genBefore} survived into the replacement as ${genAfter}`);
  consent.setReceiveVoice(false);
}

// ---- the cross-generation seam: an OLD handler resuming after replacement ---
// Mica, #62 review. `owed === p.gen` proves the debt belongs to that peer
// OBJECT — but it is self-referential, so an old answer handler that was
// already mid-await when its peer was dropped and rebuilt compares the old
// object to its own generation, matches, and then renegotiate(id) resolves
// peers.get(id): the REPLACEMENT. The dead peer's debt gets paid by its
// successor, which is exactly what the generation stamp was meant to prevent.
//
// Forced deterministically: the answer handler is held inside
// setRemoteDescription while the peer is replaced underneath it.
{
  consent.setReceiveVoice(true);
  if (!voice.micOn()) await voice.toggleMic("me");
  await settle();
  created.length = 0;
  stubs.remotes.set("seam", { agent: false });
  bus.emit("roster");
  await settle();
  const oldPeer = created.at(-1)!;
  if (!oldPeer) throw new Error("no peer built for the seam test");

  // the old peer owes a follow-up: toggle the mic while it is mid-negotiation
  await voice.toggleMic("me"); await settle();
  await voice.toggleMic("me"); await settle();
  const owedBefore = voice.voicePendingReneg?.()["seam"];
  check("seam: the old peer genuinely owes a follow-up before we replace it",
    owedBefore != null, `pending was ${owedBefore}`);

  // hold the answer handler mid-await, then deliver an answer to the OLD peer
  let releaseAnswer!: () => void;
  FakePC.answerGate = new Promise<void>((r) => { releaseAnswer = r; });
  bus.emit("rtc", { from: "seam", payload: { sdp: { type: "answer", sdp: "held" } } });
  await settle();                       // handler is now parked inside setRemoteDescription

  // replace the peer underneath the parked handler
  consent.setReceiveVoice(false); await settle();   // dropPeer kills the old one
  consent.setReceiveVoice(true);  await settle();   // a NEW peer for the same id
  const newPeer = created.at(-1)!;
  // Settle the replacement into a CLEAN, STABLE, debt-free state. Otherwise
  // renegotiate() bails on signalingState before the identity check is ever
  // reached, and the test passes for a reason that has nothing to do with the
  // fix — which is exactly how my first version of this was vacuous.
  // The replacement legitimately has its own lifecycle (its own pending debt,
  // its own offers). Rather than fighting it into an artificial idle state,
  // clear its debt directly and snapshot the offer count immediately before
  // releasing the old handler — so any offer AFTER that point can only have
  // come from the dead peer's debt being paid by its successor.
  voice.voiceClearPending?.("seam");
  await settle();
  const newOffersBefore = newPeer.offers ?? 0;

  // release the old handler: it resumes against a peer that no longer exists
  FakePC.answerGate = null; releaseAnswer();
  await settle(); await settle();

  // Assert on the MECHANISM. Downstream offer counts are unreliable here: even
  // without the identity check, renegotiate() may bail on the replacement's
  // signaling state, so the leak is real but invisible in the count — the test
  // would pass for a reason unrelated to the fix. (It did, twice, before I
  // looked at what reconcilePending actually saw.) What must be true is that a
  // resumed old handler is REFUSED, and refused for the right reason: its
  // generation check passes (self-referential) and only the identity check
  // stops it.
  const recs = ((globalThis as { __reconcileLog?: string[] }).__reconcileLog ?? [])
    .filter((r) => r.startsWith("id=seam"));
  const resumed = recs.find((r) => r.includes("isCurrent=false"));
  check("seam: the resumed old handler reaches reconcilePending at all",
    resumed !== undefined, `seam records: ${JSON.stringify(recs)}`);
  check("seam: its generation check PASSES (self-referential) — identity is the only guard",
    resumed !== undefined && /owed=(\d+) gen=\1 /.test(resumed + " "),
    `expected owed===gen on the stale handler, got: ${resumed}`);
  check("seam: and it is refused because the peer is no longer current",
    resumed !== undefined && resumed.includes("isCurrent=false"),
    `stale handler was not detected as non-current: ${resumed}`);
  check("seam: the replacement is genuinely a different peer object",
    newPeer !== oldPeer, "dropPeer+rebuild returned the same pc");
  consent.setReceiveVoice(false);
}

// ---- REJOIN: a peer who reloads is a NEW session, not a glare rival --------
// Field, 2026-08-08 (R + Digi): "she could hear me until she hard reloaded."
// A reload sends a fresh offer. If our side still holds a stale peer parked in
// have-local-offer from their dead session, the glare rule fires — and glare's
// premise is that BOTH offers are live, so the loser's offer will be answered.
// A reload breaks that premise: the peer we are protecting no longer exists on
// their end, so returning here discards the only live offer in the exchange and
// strands both sides. Deterministic; no timing needed.
{
  consent.setReceiveVoice(true);
  if (!voice.micOn()) await voice.toggleMic("me");
  await settle();
  created.length = 0;
  stubs.remotes.set("zzz-rejoin", { agent: false });   // id sorts ABOVE "me" — WE win glare
  bus.emit("roster");
  await settle();
  const pcR = created.at(-1)!;
  check("rejoin: our side is parked in have-local-offer (their answer never came)",
    pcR.signalingState === "have-local-offer", pcR.signalingState);

  const answersBefore = pcR.answersCreated ?? 0;
  // they reload and offer fresh
  announce("zzz-rejoin"); bus.emit("rtc", { from: "zzz-rejoin", payload: { sdp: { type: "offer", sdp: "after-reload" } } });
  await settle(); await settle();

  check("rejoin: a reloaded peer's offer is ANSWERED, not discarded as glare",
    (pcR.answersCreated ?? 0) > answersBefore,
    `answersCreated stayed at ${pcR.answersCreated} — their fresh offer was dropped`);
  consent.setReceiveVoice(false);
}

// T5 (relay half) lives in tools/voice-matrix.mjs: RTC_MODE=relay-noturn must
// stay at 0 inbound pkts; RTC_MODE=relay-turn must exceed 0. External harness
// by design — fake RTC cannot prove media.

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
