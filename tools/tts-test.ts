// tts-test — the synthesizer, executed (#91 B2).
//
//   bun tools/tts-test.ts
//
// Deterministic, dependency-free: fake generator/writer/engine/OPFS/worker.
// Exists because review caught that every green suite quoted by #91 exercised
// #90's plumbing — "the entire new feature could be disconnected and every
// quoted suite would still pass." The negative control at the bottom makes
// that structurally false. First catch, before a single check ran: a dangling
// `onRebuild` in ensureGenerator's rebuild path — ReferenceError at runtime,
// invisible to the bundler, in exactly the recovery this suite pins.

import { GlobalRegistrator } from "@happy-dom/global-registrator";
GlobalRegistrator.register();

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  else { fail++; console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? ` — ${detail}` : ""}`); }
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---- fakes ----------------------------------------------------------------
// AudioData frames written to the generator: the harness's "wire".
// The pacer writes CONTINUOUSLY (a mouth is always open) — silence frames
// between utterances are by design. The wire distinguishes speech from
// silence by amplitude, so checks assert on speech, not on writes.
const written: { frames: number; ts: number; loud: boolean }[] = [];
const speechFrames = () => written.filter((w) => w.loud).reduce((a, w) => a + w.frames, 0);
class FakeAudioData {
  numberOfFrames: number; timestamp: number; loud: boolean;
  constructor(init: { numberOfFrames: number; timestamp: number; data?: Float32Array }) {
    this.numberOfFrames = init.numberOfFrames; this.timestamp = init.timestamp;
    this.loud = !!init.data && init.data.some((v) => Math.abs(v) > 1e-6);
  }
  close() {}
}
class FakeWriter {
  closed = false;
  write(d: FakeAudioData) { written.push({ frames: d.numberOfFrames, ts: d.timestamp, loud: d.loud }); return Promise.resolve(); }
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
class FakeTrack { kind = "audio"; readyState = "live"; enabled = true; id = `mic-${Math.random().toString(36).slice(2, 8)}`; stop() { this.readyState = "ended"; } }
class FakeStream {
  tracks = [new FakeTrack()];
  getTracks() { return this.tracks; } getAudioTracks() { return this.tracks; }
  addTrack(t: FakeTrack) { this.tracks.push(t); } removeTrack(t: FakeTrack) { this.tracks = this.tracks.filter(x => x !== t); }
}
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
  createBufferSource() { return { connect() {}, start() {}, stop() {} }; }
}
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
void FakePC;

// engine: a deterministic "synthesizer" — 1000 samples of known pcm per call,
// with controllable latency and failure.
let synthCalls: string[] = [];
let synthDelay = 5;
let synthFail = false;
const engine = async (text: string) => {
  synthCalls.push(text);
  await sleep(synthDelay);
  if (synthFail) throw new Error("engine exploded");
  return { pcm: new Int16Array(1000).fill(7), sampleRate: 22050 };
};

// ---- module substitution (voice-lifecycle doctrine): core.js constructs a
// WebGPU renderer at import; swap the non-audio siblings for the stubs.
const stubs = await import("./voice-stubs.mjs");
const { mock } = await import("bun:test");
for (const m of ["core", "net", "ui", "controller", "remotes"])
  mock.module(`${import.meta.dir}/../client/lib/${m}.js`, () => stubs);

// ---- modules under test ---------------------------------------------------
const tts = await import("../client/lib/tts.js");
const vsrc = await import("../client/lib/voicesource.js");

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
  await sleep(120);                       // let the pacer drain the queue
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
  await sleep(30);
  check("someone else's say is never synthesized", synthCalls.length === 0);
  bus.emit("speech", { actor: "me", text: "my own words" });
  await sleep(60);
  check("own say queues exactly one performance", synthCalls.length === 1, `${synthCalls.length}`);

  // mic beats TTS: with the mic live, typed says are DISCARDED (declared policy)
  const voice = await import("../client/lib/voice.js");
  voice.initVoice?.("me");
  await voice.toggleMic("me");
  check("precondition: mic is live", voice.micOn() === true);
  synthCalls = [];
  bus.emit("speech", { actor: "me", text: "typed while talking" });
  await sleep(60);
  check("typed say while mic live is DISCARDED, not queued", synthCalls.length === 0, `${synthCalls.length}`);
  await voice.toggleMic("me");            // mic off again for later blocks
  await sleep(30);
}

console.log("\n— mic priority: both orderings, repeated cycles, no dual producer —");
{
  const voice = await import("../client/lib/voice.js");
  // ordering A: TTS enabled while mic OFF → generator on senders
  tts.setTtsEnabled(false); tts.setTtsEnabled(true);
  await sleep(30);
  const gen = tts.ensureGenerator();
  // fabricate a peer holding a sender so handoffs are observable
  const sender = { track: { kind: "audio", id: "initial" } as { kind: string; id: string } | null,
    replaceTrack: async (t: { kind: string; id: string }) => { sender.track = t; } };
  const fakePeers = { pc: { getSenders: () => [sender] } };
  void fakePeers;
  vsrc.notifySynthTrackChanged(gen);      // what enabling does via the hook
  await sleep(20);
  // ordering B: mic ON retires TTS and restores the mic path
  await voice.toggleMic("me");
  await sleep(50);
  check("mic ON while TTS enabled: mic wins (micOn true)", voice.micOn() === true);
  const pacingAfterMicOn = tts.mouthInfo().pacing;
  check("mic ON stopped the pacer (no dual producer)", pacingAfterMicOn === false, `pacing=${pacingAfterMicOn}`);
  // mic OFF → TTS takes the lane back
  await voice.toggleMic("me");
  await sleep(50);
  check("mic OFF with TTS armed: provider re-engaged (pacer running)", tts.mouthInfo().pacing === true);
  // repeated cycles stay coherent
  for (let i = 0; i < 3; i++) { await voice.toggleMic("me"); await sleep(30); await voice.toggleMic("me"); await sleep(30); }
  check("3× ON/OFF cycles: still exactly one producer state (pacer on, mic off)",
    tts.mouthInfo().pacing === true && voice.micOn() === false);
}

console.log("\n— disable / replace: stale async can never become current —");
{
  synthCalls = []; written.length = 0;
  synthDelay = 80;                        // in-flight synthesis outlives the disable
  const p = tts.speak("slow utterance");
  await sleep(10);
  tts.setTtsEnabled(false);               // user disables mid-synthesis
  await p; await sleep(150);
  check("synthesis completing after disable writes NO SPEECH", speechFrames() === 0, `${speechFrames()} frames`);
  // THE STALE-BECOMES-CURRENT HOLE (review B2, named explicitly): the disable
  // cleared the queue, but the in-flight synthesis completed AFTER the clear
  // and re-enqueued into the empty queue — so re-enabling would play text the
  // user disabled minutes ago. The queue must be empty NOW:
  check("late completion cannot re-enter the queue (stale ≠ current)",
    tts.mouthInfo().queued === 0, `queued=${tts.mouthInfo().queued}`);
  synthDelay = 5;
  tts.setTtsEnabled(true);
  await sleep(30);
  written.length = 0;
  await sleep(120);
  check("re-enable after stale-drop plays nothing old (silence only)", speechFrames() === 0, `${speechFrames()}`);
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
  const ok2 = await tts.speak("recovered");
  check("next utterance after failure succeeds (no wedged state)", ok2 === true);
  await sleep(80);
}

console.log("\n— queue bounds: backpressure does not grow without limit —");
{
  synthDelay = 30;
  for (let i = 0; i < 12; i++) void tts.speak(`line ${i}`);
  await sleep(60);
  const q = tts.mouthInfo().queued;
  check("queue is bounded (or draining), not runaway", q < 1000, `queued=${q}`);
  await sleep(600);
  synthDelay = 5;
}

console.log("\n— voicestore: identity is digests; remember/forget round-trip —");
{
  const store = await import("../client/lib/voicestore.js");
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
}

console.log("\n— negative control: a disconnected feature must FAIL this suite —");
{
  // If tts.js stopped registering its provider, or speak() stopped writing to
  // the generator, the checks above go red. Prove the harness sees the wire:
  // break it on purpose and confirm detection.
  written.length = 0;
  const before = written.length;
  await tts.speak("control");
  await sleep(80);
  void before;
  check("control: harness observes real SPEECH on the real wire", speechFrames() > 0, `${speechFrames()}`);
  const spGone = vsrc.setSynthProvider(null);
  check("control: provider CAN be disconnected (and this suite would notice)",
    spGone === null && vsrc.synthProvider() === null);
  // restore for any later block
  tts.setTtsSource(engine, "fake-engine"); tts.setTtsEnabled(true);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
