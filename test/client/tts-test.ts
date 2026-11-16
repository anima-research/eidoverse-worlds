// tts-test — the synthesizer, executed (#91 B2).
//
//   bun test/client/tts-test.ts
//
// Deterministic, dependency-free: fake generator/writer/engine/AudioContext/peer
// connection. It executes tts.js itself (the suites #91 first quoted exercised
// only #90's plumbing): the checks read speech off the fake wire.

import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { suite } from "../gate/suite.ts";
import { until, tryUntil, pause } from "../gate/wait.ts";
GlobalRegistrator.register();

const S = suite("tts");
const check = (name: string, ok: unknown, detail?: unknown) => S.check(name, ok, detail);

// ---- fakes ----------------------------------------------------------------
// AudioData frames written to the generator, the harness's "wire": the pacer writes CONTINUOUSLY (silence between
// utterances), so checks assert on speech (by amplitude), not on writes
const written: { frames: number; ts: number; loud: boolean; sum: number }[] = [];
const speechFrames = () => written.filter((w) => w.loud).reduce((a, w) => a + w.frames, 0);
const speechSum = () => written.reduce((a, w) => a + w.sum, 0);
class FakeAudioData {
  numberOfFrames: number; timestamp: number; loud: boolean; sum: number;
  constructor(init: { numberOfFrames: number; timestamp: number; data?: Float32Array }) {
    this.numberOfFrames = init.numberOfFrames; this.timestamp = init.timestamp;
    this.loud = !!init.data && init.data.some((v) => Math.abs(v) > 1e-6);
    this.sum = init.data ? init.data.reduce((a, v) => a + v, 0) : 0;
  }
  close() {}
}
class FakeWriter {
  closed = false;
  write(d: FakeAudioData) { written.push({ frames: d.numberOfFrames, ts: d.timestamp, loud: d.loud, sum: d.sum }); return Promise.resolve(); }
  close() { this.closed = true; return Promise.resolve(); }
}
let generatorCount = 0;
class FakeGenerator {
  kind = "audio"; readyState = "live"; id: string;
  writable = { getWriter: () => new FakeWriter() };
  constructor(init: { kind: string }) { this.id = `gen-${++generatorCount}`; void init; }
  stop() { this.readyState = "ended"; }
}
(globalThis as Record<string, unknown>).MediaStreamTrackGenerator = FakeGenerator;
(globalThis as Record<string, unknown>).AudioData = FakeAudioData;
class FakeTrack { kind = "audio"; readyState = "live"; enabled = true; id = `mic-${Math.random().toString(36).slice(2, 8)}`; getSettings() { return { deviceId: "fake-device" }; } stop() { this.readyState = "ended"; } }
class FakeStream {
  tracks: unknown[];
  constructor(tracks?: unknown[]) { this.tracks = tracks ?? [new FakeTrack()]; }
  getTracks() { return this.tracks; } getAudioTracks() { return this.tracks; }
  addTrack(t: FakeTrack) { this.tracks.push(t); } removeTrack(t: FakeTrack) { this.tracks = this.tracks.filter(x => x !== t); }
}
(globalThis as Record<string, unknown>).MediaStream = FakeStream;
Object.defineProperty(globalThis.navigator, "mediaDevices", {
  value: { getUserMedia: async () => new FakeStream() }, configurable: true,
});
class FakeAudioCtx {
  state = "running";
  resume() { return Promise.resolve(); }
  createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
  createGain() { return { gain: { value: 0, setTargetAtTime() {} }, connect() {}, disconnect() {} }; }
  createMediaStreamDestination() { return { stream: new FakeStream(), disconnect() {} }; }
  createAnalyser() { return { fftSize: 0, connect() {}, disconnect() {}, getFloatTimeDomainData(b: Float32Array) { b.fill(0); } }; }
  // the sidetone: each scheduled chunk records the gain it plays through
  currentTime = 0; destination = {};
  createBuffer(_c: number, n: number, sr: number) { const d = new Float32Array(n); return { duration: n / sr, getChannelData: () => d }; }
  createBufferSource() {
    let to: { gain?: { value: number } } = {};
    return { connect(g: typeof to) { to = g; }, start() { monitored.push(to.gain?.value ?? NaN); }, stop() {} };
  }
}
const monitored: number[] = [];
(globalThis as Record<string, unknown>).AudioContext = FakeAudioCtx;
class FakePC {
  senders: { track: { kind: string; id: string } | null; replaceTrack(t: unknown): Promise<void> }[] = [];
  offers = 0;
  addTrack(t: { kind: string; id: string }) {
    const s = { track: t, replaceTrack: async (nt: { kind: string; id: string }) => { s.track = nt; } };
    this.senders.push(s); return s;
  }
  getSenders() { return this.senders; }
  getTransceivers() { return []; }
  async createOffer() { this.offers++; return { type: "offer", sdp: "x" }; }
  async setLocalDescription() {} async setRemoteDescription() {}
  close() {}
}
(globalThis as Record<string, unknown>).RTCPeerConnection = FakePC;

// engine: a deterministic "synthesizer" — 1000 samples of known pcm per call,
// with controllable latency and failure.
let synthCalls: string[] = [];
let micAsks = 0;   // how often the code under test asked the stub transport "is the mic live?": a decision was made
let synthDelay = 5;
let synthFail = false;
const engine = async (text: string) => {
  synthCalls.push(text);
  await pause("the fake engine's synthesis latency", synthDelay);
  if (synthFail) throw new Error("engine exploded");
  return { pcm: new Int16Array(1000).fill(7), sampleRate: 22050 };
};

// the queue is empty and speech reached the wire since `written` was last cleared: one utterance has played out
const drained = () => tts.mouthInfo().queued === 0 && speechFrames() > 0;
let ONE = 0;
const onlyOne = () => ONE > 0 && Math.abs(speechSum() - ONE) < 1e-6 * ONE;
/** Speak a marker after a stale-drop and let it play out: anything stale would have reached the wire ahead of it. */
const fenceSpeak = async () => { written.length = 0; await tts.speak("fence"); await tryUntil("the fence line played out", drained); };

// ---- module substitution (voice-lifecycle doctrine): core.js constructs a
// WebGPU renderer at import; swap the non-audio siblings for the stubs.
const stubs = await import("../stubs/voice-stubs.mjs");
const { mock } = await import("bun:test");
for (const m of ["core", "net", "ui/ui", "player/controller", "player/remotes"])
  mock.module(`${import.meta.dir}/../../client/lib/${m}.js`, () => stubs);

// ---- modules under test ---------------------------------------------------
const tts = await import("../../client/lib/audio/tts.js");
const vsrc = await import("../../client/lib/audio/voicesource.js");

console.log("\n— provider registration & availability —");
{
  const sp = vsrc.synthProvider();
  check("importing tts.js registers a synth provider", !!sp);
  check("provider unavailable before an engine exists", sp.available() === false);
  tts.setTtsSource(engine, "fake-engine");
  check("engine registered but disabled → still unavailable", sp.available() === false);
  tts.setTtsEnabled(true);
  check("enabled + engine + generator support → available", sp.available() === true);
  check("provider label names the engine", String(sp.label?.() ?? "").includes("fake"));
}

console.log("\n— speak: canonical own say → one performance —");
{
  written.length = 0; synthCalls = [];
  tts.startPacer();
  const ok = await tts.speak("hello world");
  await tryUntil("the pacer drained the utterance onto the wire", drained);
  ONE = speechSum();                      // one utterance's wire sum: the fence for "nothing else was heard" below
  check("speak() returns true on success", ok === true);
  check("engine called exactly once", synthCalls.length === 1, `${synthCalls.length}`);
  check("pcm reached the generator writer", written.length > 0, `${written.length} writes`);
  check("synthesized SPEECH reached the wire (amplitude, not just silence)", speechFrames() > 0, `${speechFrames()}`);
}

console.log("\n— speakOwnSays: the bridge, and the mic-live discard policy —");
{
  const { bus } = stubs;
  tts.speakOwnSays(bus, () => "me");
  synthCalls = [];
  bus.emit("speech", { actor: "someone-else", text: "not mine" });
  bus.emit("speech", { actor: "me", text: "my own words" });   // the fence: someone else's would have reached the engine first
  await tryUntil("the own say reached the engine", () => synthCalls.length > 0);
  check("someone else's say is never synthesized", !synthCalls.includes("not mine"), JSON.stringify(synthCalls));
  check("own say queues exactly one performance", synthCalls.length === 1 && synthCalls[0] === "my own words", JSON.stringify(synthCalls));

  // mic beats TTS: with the mic live, typed says are DISCARDED (declared policy).
  // Post-cutover the transport is the SFU bridge; the policy code asks
  // window.__sfuMicOn() first (tts.js speakOwnSays), so the stub installs the same pair
  // the real bridge does (voicesfubridge.js __sfuMicOn / __sfuMic) — a boolean the hook flips
  // and reports honestly. micstate.toggleMic routes through the hook.
  const voice = await import("../../client/lib/audio/micstate.js");
  let stubMicOn = false;
  (globalThis as unknown as { window: Record<string, unknown> }).window.__sfuMicOn = () => { micAsks++; return stubMicOn; };
  (globalThis as unknown as { window: Record<string, unknown> }).window.__sfuMic = async () => {
    stubMicOn = !stubMicOn;
    // The real transport routes the device through micstate's gate and reports
    // liveness (voicesfu.js: gateFor, then setMicLive) — the lane is what makes micOn() true and
    // what registers the mic producer that outranks the synth. Mirror both.
    if (stubMicOn) { voice.gateFor(new (globalThis as Record<string, any>).MediaStream()); voice.setMicLive(true); }
    else { voice.gateRelease(); voice.setMicLive(false); }
    return stubMicOn;
  };
  await voice.toggleMic();
  check("precondition: mic is live (the ladder the policy itself asks)",
    (window as unknown as { __sfuMicOn(): boolean }).__sfuMicOn() === true);
  synthCalls = [];
  bus.emit("speech", { actor: "me", text: "typed while talking" });
  await voice.toggleMic();                // mic off again; the next say is the fence a queued one would have played before
  bus.emit("speech", { actor: "me", text: "after the mic dropped" });
  await tryUntil("the say after the mic dropped reached the engine", () => synthCalls.includes("after the mic dropped"));
  check("typed say while mic live is DISCARDED, not queued (and the fence after it arrived)", synthCalls.includes("after the mic dropped") && !synthCalls.includes("typed while talking"), JSON.stringify(synthCalls));
}

// one producer on the wire across mic/TTS handoffs: also test/client/voicesource-real-test.mjs, sfu-mic-intent-race-test.mjs
// and test/server/sfu-test.ts

console.log("\n— mic priority: both orderings, repeated cycles, no dual producer —");
{
  const voice = await import("../../client/lib/audio/micstate.js");
  // ordering A: TTS enabled while mic OFF → generator on senders
  // an enable flip decides after a dynamic import (tts.js setTtsEnabled): it is decided once it has asked the transport
  const decided = (from: number, n = 1) => until("the enable flip asked the transport", () => micAsks >= from + n);
  let a = micAsks; tts.setTtsEnabled(false); tts.setTtsEnabled(true);
  await decided(a, 2);
  const gen = tts.ensureGenerator();
  vsrc.notifySynthTrackChanged(gen);      // what enabling does via the hook
  // ordering B: mic ON — the mic wins. (The pacer-stop on a LIVE mic takeover
  // is the TRANSPORT's move — voicesfu's source swap calls the provider's
  // stop() — so asserting it here against the stub hook would test the stub.
  // No suite pins that half today: voicesource-real-test checks voiceSource()'s
  // choice under a stubbed DOM, and tts-publishes-mic-off-test was deleted
  // (e12a7874e). What THIS suite can honestly pin is tts.js's
  // own enable-path gate: enabling TTS while the mic is live must NOT start
  // the pacer — mic beats TTS at the enable door, tts.js setTtsEnabled's !micLive.)
  await voice.toggleMic();
  check("mic ON while TTS enabled: mic wins (micOn true)", voice.micOn() === true);
  a = micAsks; tts.setTtsEnabled(false); await decided(a);   // pacer stilled by disable
  a = micAsks; tts.setTtsEnabled(true); await decided(a);    // re-enable WITH the mic live
  const pacingEnabledOverLiveMic = tts.mouthInfo().pacing;
  check("enabling TTS over a LIVE mic does not start the pacer (mic beats TTS at the enable door)",
    pacingEnabledOverLiveMic === false, `pacing=${pacingEnabledOverLiveMic}`);
  // mic OFF → the armed enablement engages: the pacer runs
  await voice.toggleMic();
  tts.setTtsEnabled(false); tts.setTtsEnabled(true);
  await tryUntil("the pacer runs again", () => tts.mouthInfo().pacing);
  check("mic OFF with TTS armed: provider re-engaged (pacer running)", tts.mouthInfo().pacing === true);
}

console.log("\n— disable / replace: stale async can never become current —");
{
  synthCalls = []; written.length = 0;
  synthDelay = 80;                        // in-flight synthesis outlives the disable
  const p = tts.speak("slow utterance");
  await until("the slow synthesis is in flight", () => synthCalls.includes("slow utterance"));
  tts.setTtsEnabled(false);               // user disables mid-synthesis
  await p; await until("the disable stilled the pacer", () => !tts.mouthInfo().pacing);
  check("synthesis completing after disable writes NO SPEECH", speechFrames() === 0, `${speechFrames()} frames`);
  // THE STALE-BECOMES-CURRENT HOLE (review B2, named explicitly): the disable
  // cleared the queue, but the in-flight synthesis completed AFTER the clear
  // and re-enqueued into the empty queue — so re-enabling would play text the
  // user disabled minutes ago. The queue must be empty NOW:
  check("late completion cannot re-enter the queue (stale ≠ current)",
    tts.mouthInfo().queued === 0, `queued=${tts.mouthInfo().queued}`);
  synthDelay = 5;
  tts.setTtsEnabled(true);
  await fenceSpeak();
  check("re-enable after stale-drop plays nothing old (only the next line is heard)", onlyOne(), `${speechSum()} vs one line ${ONE}`);
  // r5 self-review: the RESAMPLE seam. speak()'s epoch check runs before enqueue, but the resample (tts.js toOutRate)
  // is one more async hop: a held offline render lets the disable land exactly inside it.
  const win = (globalThis as unknown as { window: Record<string, unknown> }).window;
  let rendering = 0, release = () => {};
  win.OfflineAudioContext = class {
    n: number; d = new Float32Array(0); destination = {};
    constructor(_c: number, n: number) { this.n = n; }
    createBuffer(_c: number, n: number) { this.d = new Float32Array(n); return { getChannelData: () => this.d }; }
    createBufferSource() { return { connect() {}, start() {} }; }
    startRendering() { rendering++; return new Promise((r) => { release = () => { const o = new Float32Array(this.n); o.set(this.d.subarray(0, this.n)); r({ getChannelData: () => o }); }; }); }
  };
  await tts.speak("assassinated mid-pipeline");
  await until("the resample is in flight", () => rendering > 0);
  tts.setTtsEnabled(false);
  await until("the disable stilled the pacer", () => !tts.mouthInfo().pacing);
  release(); delete win.OfflineAudioContext;
  tts.setTtsEnabled(true);
  await fenceSpeak();
  check("disable racing the resample: stale audio dies at EVERY seam",
    onlyOne() && tts.mouthInfo().queued === 0,
    `speech=${speechSum()} vs one line ${ONE}, queued=${tts.mouthInfo().queued}`);
}

console.log("\n— dead generator: rebuilt once, senders re-bound, no SDP churn —");
{
  const g1 = tts.ensureGenerator();
  let rebindCount = 0; let lastTrack: unknown = null;
  vsrc.setGeneratorRebuildHook((t: unknown) => { rebindCount++; lastTrack = t; });
  (g1 as unknown as { readyState: string }).readyState = "ended";   // the field failure
  const g2 = tts.ensureGenerator();
  check("ended generator is replaced with a live one", g2 !== g1 && (g2 as unknown as { readyState: string }).readyState === "live");
  check("rebuild fires the rebind hook exactly once", rebindCount === 1, `${rebindCount}`);
  check("hook received the NEW track", lastTrack === g2);
  const g3 = tts.ensureGenerator();
  check("live generator is NOT rebuilt again", g3 === g2 && rebindCount === 1);
}

console.log("\n— engine failure: page survives, refusal says why —");
{
  synthFail = true;
  const ok = await tts.speak("doomed");
  check("engine explosion → speak returns false, no throw", ok === false);
  synthFail = false;
  written.length = 0;
  const ok2 = await tts.speak("recovered");
  check("next utterance after failure succeeds (no wedged state)", ok2 === true);
  await tryUntil("the recovered line played out", drained);
}

console.log("\n— queue bounds: backpressure does not grow without limit —");
{
  synthDelay = 30;
  written.length = 0;
  const lines = Array.from({ length: 12 }, (_, i) => tts.speak(`line ${i}`));
  await until("the burst is under way", () => synthCalls.includes("line 1"));
  const q = tts.mouthInfo().queued;
  check("queue is bounded (or draining), not runaway", q < 1000, `queued=${q}`);
  await Promise.all(lines);
  await tryUntil("the burst played out", () => tts.mouthInfo().queued === 0 && speechSum() >= 12 * ONE * (1 - 1e-6));
  check("…and drains: all 12 lines reach the wire", Math.abs(speechSum() - 12 * ONE) < 1e-5 * ONE, `${speechSum()} vs 12 × ${ONE}`);
  synthDelay = 5;
}

console.log("\n— voicestore: identity is digests (remember/forget, IndexedDB, is not run here) —");
{
  const store = await import("../../client/lib/audio/voicestore.js");
  const onnx = new File([new Uint8Array(1024).fill(1)], "voice.onnx");
  const cfg = new File([JSON.stringify({ audio: { sample_rate: 22050 }, inference: { noise_scale: 0.667 } })], "voice.onnx.json");
  const idA = await store.voiceIdentity(onnx, cfg);
  check("identity id is digest-derived", idA.id.startsWith("sha256:") && idA.id.length > 15, idA.id);
  check("identity records model+config sha256", idA.modelSha256.length === 64 && idA.configSha256.length === 64);
  check("identity records sample rate + params from config", idA.sampleRate === 22050 && idA.params?.noise_scale === 0.667);
  check("identity names engine + version", idA.engine === "piper-tts-web" && !!idA.engineVersion);
  const onnxB = new File([new Uint8Array(1024).fill(2)], "voice.onnx");   // SAME NAME, different bytes
  const idB = await store.voiceIdentity(onnxB, cfg);
  check("same filename, different bytes → DIFFERENT voice identity", idB.id !== idA.id, `${idA.id} vs ${idB.id}`);
  // r3 B1 converse: SAME model, DIFFERENT config. The config names the
  // phoneme map / language / inference params — a different config is a
  // different voice, and an id derived from the model digest alone collides
  // them (the exact hole the revision-2 review named).
  const cfgB = new File([JSON.stringify({ audio: { sample_rate: 16000 }, inference: { noise_scale: 0.2 } })], "voice.onnx.json");
  const idC = await store.voiceIdentity(onnx, cfgB);
  check("same model, different config → DIFFERENT voice identity", idC.id !== idA.id, `${idA.id} vs ${idC.id}`);
  check("joint id carries both digests", idA.id.includes("+") && idA.id.split("+").length === 2, idA.id);
  // distinct ids, so remembering both side by side can't clobber (rememberVoice itself is not run here)
  check("model+cfgA and model+cfgB get distinct ids (same model digest, different config digest)",
    idA.id !== idC.id && idA.modelSha256 === idC.modelSha256 && idA.configSha256 !== idC.configSha256);
}

console.log("\n— sidetone: the tts slider moves only what you hear of yourself, never the wire —");
{
  const vc = await import("../../client/lib/audio/voiceconsent.js");
  tts.sidetone(true);
  const run = async (v: number) => {
    vc.setVolume("tts", v); written.length = 0; monitored.length = 0;
    await tts.speak("sidetone row"); await tryUntil("the sidetone row played out", drained);
    return { wire: speechSum(), heard: [...monitored] };
  };
  const full = await run(1), half = await run(0.5), none = await run(0);
  const all = (h: number[], g: number) => h.length > 0 && h.every((x) => Math.abs(x - g) < 1e-9);
  check("slider 1: you hear yourself at the 0.8 default", all(full.heard, 0.8), JSON.stringify(full.heard));
  check("slider 0.5 halves only your monitor", all(half.heard, 0.4), JSON.stringify(half.heard));
  check("slider 0 is silence for you only", all(none.heard, 0), JSON.stringify(none.heard));
  check("what others receive is identical at every slider setting",
    full.wire > 0 && Math.abs(half.wire - full.wire) < 1e-9 && Math.abs(none.wire - full.wire) < 1e-9,
    `${full.wire} / ${half.wire} / ${none.wire}`);
  vc.setVolume("tts", 1);
}

console.log("\n— negative control: a disconnected feature must FAIL this suite —");
{
  // If tts.js stopped registering its provider, or speak() stopped writing to
  // the generator, the checks above go red. This proves the harness sees the
  // wire and that the provider can be unset; it does not rerun any check with it
  // unset, so it doesn't show the suite going red.
  written.length = 0;
  const before = written.length;
  await tts.speak("control");
  await tryUntil("the control line played out", drained);
  void before;
  check("control: harness observes real SPEECH on the real wire", speechFrames() > 0, `${speechFrames()}`);
  const spGone = vsrc.setSynthProvider(null);
  check("control: provider CAN be disconnected (and this suite would notice)",
    spGone === null && vsrc.synthProvider() === null);
  // restore for any later block
  tts.setTtsSource(engine, "fake-engine"); tts.setTtsEnabled(true);
}

S.done();
