// tts-fault-test — the failure paths, executed (#91 r3 B3).
//
//   bun tools/tts-fault-test.ts
//
// The main harness (tts-test.ts) pins the happy paths and the handoff
// architecture; this one pins the FAULTS the revision-2 review enumerated:
// storage refusal, permission states, worker death and recovery, endpoint
// death, wrong file pairings, and the panel's state honesty. Deterministic,
// no network, no real OPFS/worker — each fault is injected, not awaited.

import { GlobalRegistrator } from "@happy-dom/global-registrator";
GlobalRegistrator.register();

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  else { fail++; console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? ` — ${detail}` : ""}`); }
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---- module substitution (same doctrine as tts-test.ts) --------------------
const stubs = await import("./voice-stubs.mjs");
const { mock } = await import("bun:test");
for (const m of ["core", "net", "ui", "controller", "remotes"])
  mock.module(`${import.meta.dir}/../client/lib/${m}.js`, () => stubs);

// fake piper runtime: engine-piper must be testable without ORT/wasm
mock.module("@mintplex-labs/piper-tts-web", () => ({
  TtsSession: class { constructor() { /* never reached in fault tests */ } },
  PATH_MAP: {} as Record<string, string>,
}));

class FakeAudioCtx {
  state = "running";
  resume() { return Promise.resolve(); }
  createGain() { return { gain: { value: 0, setTargetAtTime() {} }, connect() {}, disconnect() {} }; }
  createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
  createMediaStreamDestination() { return { stream: { getTracks: () => [] }, disconnect() {} }; }
  createAnalyser() { return { fftSize: 0, connect() {}, disconnect() {}, getFloatTimeDomainData(b: Float32Array) { b.fill(0); } }; }
}
(globalThis as Record<string, unknown>).AudioContext = FakeAudioCtx;

console.log("\n— model/config pairing: wrong combinations refuse, and say why —");
{
  const ve = await import("../client/lib/voiceengines.js");
  const onnx = new File([new Uint8Array(64)], "voice.onnx");
  const stray = new File([new Uint8Array(64)], "readme.txt");
  let err = "";
  try { await ve.loadFromFiles([stray]); } catch (e) { err = String(e); }
  check("a stray file alone is refused", err.length > 0);
  check("the refusal names known formats (teachable, not just 'no')",
    /onnx|format|engine/i.test(err), err.slice(0, 80));
  err = "";
  try { await ve.loadFromFiles([onnx]); } catch (e) { err = String(e); }
  check("a model without its config is refused (pairing is mandatory)", err.length > 0, err.slice(0, 60));
}

console.log("\n— OPFS refusal: storage failure is a truthful error, not a ready state —");
{
  // navigator.storage.getDirectory throwing is what private browsing, quota
  // exhaustion, and locked-down profiles all look like from here.
  const nav = navigator as unknown as Record<string, unknown>;
  const realStorage = nav.storage;
  Object.defineProperty(navigator, "storage", {
    value: { getDirectory: async () => { throw new DOMException("Quota exceeded", "QuotaExceededError"); } },
    configurable: true,
  });
  const ve = await import("../client/lib/voiceengines.js");
  const onnx = new File([new Uint8Array(64)], "voice.onnx");
  const cfg = new File([JSON.stringify({ audio: { sample_rate: 22050 } })], "voice.onnx.json");
  let err: unknown = null, result: unknown = null;
  try { result = await ve.loadFromFiles([onnx, cfg], () => {}); } catch (e) { err = e; }
  check("quota failure rejects the load (no silent success)", err !== null && result === null,
    err ? String(err).slice(0, 60) : "resolved?!");
  const tts = await import("../client/lib/tts.js");
  const vsrc = await import("../client/lib/voicesource.js");
  check("failed load leaves NO engine selected (provider unavailable)",
    !vsrc.synthProvider()?.available?.());
  void tts;
  Object.defineProperty(navigator, "storage", { value: realStorage, configurable: true });
}

console.log("\n— remembered voices: every permission state, and forget —");
{
  const store = await import("../client/lib/voicestore.js");
  const handle = (q: string, r = q) => ({
    queryPermission: async () => q,
    requestPermission: async () => r,
    getFile: async () => new File([new Uint8Array(8)], "voice.onnx"),
  });
  check("granted → 'granted'", await store.voiceReadable({ handles: [handle("granted")] }) === "granted");
  check("prompt → 'prompt'", await store.voiceReadable({ handles: [handle("prompt")] }) === "prompt");
  check("denied → 'denied'", await store.voiceReadable({ handles: [handle("denied")] }) === "denied");
  check("throwing handle (file/origin gone) → 'gone'",
    await store.voiceReadable({ handles: [{ queryPermission: async () => { throw new Error("gone"); } }] }) === "gone");
  check("no handles at all → 'gone'", await store.voiceReadable({ handles: [] }) === "gone");

  // openVoice: consent boundaries hold
  let err = "";
  try { await store.openVoice({ handles: [handle("prompt")] }, { allowPrompt: false }); } catch (e) { err = String(e); }
  check("prompt-needed without a gesture → refuses, names the fix", /permission/i.test(err), err.slice(0, 50));
  err = "";
  try { await store.openVoice({ handles: [handle("prompt", "denied")] }, { allowPrompt: true }); } catch (e) { err = String(e); }
  check("user refuses the prompt → clean 'permission refused'", /refused/i.test(err), err.slice(0, 50));
  const files = await store.openVoice({ handles: [handle("granted")] });
  check("granted handles yield Files", files.length === 1 && files[0].name === "voice.onnx");

  // storage refusal path: no indexedDB here → remember degrades, never throws
  const ok = await store.rememberVoice("sha256:x", "x", [handle("granted")]);
  check("rememberVoice without IndexedDB returns false, does not throw", ok === false);
  const gone = await store.forgetVoice("sha256:x");
  check("forgetVoice without IndexedDB returns false, does not throw", gone === false);
  check("canRemember() is honest about this environment", store.canRemember() === false);
}

console.log("\n— phonemizer worker: death rejects pending; recovery works —");
{
  // Worker fake: first instance swallows messages (a hung build), then dies.
  // Second instance answers. This is the death→recovery arc piperphon's
  // onerror path implements; here it is EXECUTED.
  let instance = 0;
  const _workers: FakeWorker[] = [];
  class FakeWorker {
    onmessage: ((e: { data: unknown }) => void) | null = null;
    onerror: ((e: { message: string }) => void) | null = null;
    n: number;
    constructor() { this.n = ++instance; _workers.push(this); }
    postMessage(m: { id: number }) {
      if (this.n === 1) return;          // hung: never answers
      setTimeout(() => this.onmessage?.({ data: { id: m.id, ok: true, ids: [1, 2, 3] } }), 5);
    }
    terminate() {}
  }
  (globalThis as Record<string, unknown>).Worker = FakeWorker;
  const phon = await import("../client/lib/piperphon.js");
  // absolute URLs: happy-dom's location is about:blank, which cannot resolve
  // relative wasm paths — and URL resolution is not what this block tests.
  const wasmPaths = { piperWasm: "http://localhost/vendor/piper/piper_phonemize.wasm",
    piperData: "http://localhost/vendor/piper/piper_phonemize.data" };
  const inflight = phon.phonemize("hello", { }, wasmPaths);
  let rejected = "";
  inflight.catch((e: unknown) => { rejected = String(e); });
  await sleep(20);
  check("call against the hung worker is pending (precondition)", rejected === "");
  // the worker dies — every in-flight call must fail LOUDLY, now. The fake
  // registers every instance, so the harness reaches the same onerror hook the
  // browser would fire.
  check("(harness) worker instance constructed", instance >= 1, `${instance}`);
  _workers[0].onerror?.({ message: "wasm OOM" });
  await sleep(20);
  check("worker death rejects the pending call with the cause", /died|OOM/i.test(rejected), rejected.slice(0, 60));
  check("phonReady() is false after a death (no ghost readiness)", phon.phonReady() === false);
  // recovery: next call constructs a fresh worker (instance 2 answers)
  const ids = await phon.phonemize("again", {}, wasmPaths);
  check("next call after death builds a NEW worker and succeeds", Array.isArray(ids) && ids.length === 3);
  check("recovery used a second instance (not the corpse)", instance === 2, `${instance}`);
}

console.log("\n— endpoint voice: socket death settles synthesis; queue never wedges —");
{
  // ws fake: connects, answers one synth, then closes with one still pending.
  const sockets: FakeWs[] = [];
  class FakeWs {
    onopen: (() => void) | null = null;
    onmessage: ((e: { data: string }) => void) | null = null;
    onerror: (() => void) | null = null;
    onclose: (() => void) | null = null;
    readyState = 0;
    sent: { id: number; text: string }[] = [];
    constructor() { sockets.push(this); setTimeout(() => { this.readyState = 1; this.onopen?.(); }, 1); }
    send(s: string) {
      const m = JSON.parse(s);
      this.sent.push(m);
      if (m.text === "answered") {
        const pcm = btoa(String.fromCharCode(...new Uint8Array(new Int16Array(100).fill(7).buffer)));
        setTimeout(() => this.onmessage?.({ data: JSON.stringify({ type: "synth-result", id: m.id, pcm, sampleRate: 22050 }) }), 5);
      } // "orphaned" is never answered — the close must settle it
    }
    close() { this.readyState = 3; this.onclose?.(); }
  }
  (globalThis as Record<string, unknown>).WebSocket = FakeWs;
  const bv = await import("../client/lib/browservoice.js");
  const tts = await import("../client/lib/tts.js");
  const ok = await bv.setEndpointVoice("ws://fake:1/synth", "fake-endpoint");
  check("endpoint connects and registers as the engine", ok === true);
  tts.setTtsEnabled(true);
  const a = await tts.speak("answered");
  check("an answered synthesis speaks", a === true);
  const orphan = tts.speak("orphaned");        // in flight, never answered
  await sleep(10);
  sockets[0].close();                          // the synthesizer goes away
  const o = await Promise.race([orphan, sleep(3000).then(() => "HUNG")]);
  check("socket close settles the in-flight synthesis (no hang)", o !== "HUNG", String(o));
  check("a dead endpoint yields a refusal, not fake audio", o === false);
  // and the queue is not wedged: nothing further can synth (socket dead), but
  // speak() must still return promptly with a refusal
  const after = await Promise.race([tts.speak("after death"), sleep(3000).then(() => "HUNG")]);
  check("speak() after endpoint death returns promptly", after !== "HUNG", String(after));
}

console.log("\n— panel honesty: the row's state matches the provider's —");
{
  const row = await import("../client/lib/ttsrow.js");
  const host = document.createElement("div");
  document.body.appendChild(host);
  try {
    row.ttsSection(host, () => {});
    const text = () => host.textContent ?? "";
    check("panel renders headlessly", host.children.length > 0, `${host.children.length} nodes`);
    // With the endpoint socket dead and no file voice, no row may claim ready:
    // the section must not display a live/ready state for an unavailable provider.
    const vsrc = await import("../client/lib/voicesource.js");
    const avail = !!vsrc.synthProvider()?.available?.();
    const claimsLive = /\blive\b|\bready\b/i.test(text());
    check("panel does not claim ready while provider unavailable",
      avail ? true : !claimsLive, `avail=${avail} text="${text().slice(0, 60)}"`);
  } catch (e) {
    check("panel renders headlessly", false, String(e).slice(0, 80));
  }
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
