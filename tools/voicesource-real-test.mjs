// A REAL test for voiceSource(): it IMPORTS client/lib/voicesource.js and
// exercises the shipped function. Replaces the eye-verified transcription in
// tts-publishes-mic-off-test.mjs, which imports nothing and cannot fail when
// the module breaks (audit, 2026-08-16).
//
// Only the BROWSER SURFACE is stubbed — navigator.mediaDevices and the minimum
// WebAudio the synth path touches. The decision logic under test is the real
// one, so reverting the micWanted fix in voicesource.js makes this go red.
// voicesource.js imports core.js, which builds a canvas at module scope — so a
// real import needs a real DOM. happy-dom is already the repo's pattern for
// this (tools/tts-fault-test.ts, tools/chat-log-test.ts).
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { mock } from "bun:test";
GlobalRegistrator.register({ url: "http://localhost/?world=test&name=probe" });

// voicesource.js needs exactly ONE thing from core.js — `report` — but core.js
// constructs a THREE.WebGPURenderer at module scope, which cannot initialise
// headlessly. That single edge is the real reason the earlier version of this
// test re-typed the logic instead of importing it.
//
// Mocking the MODULE (not the logic) keeps the thing under test real: the
// decision code executing below is the shipped code, byte for byte. Revert the
// micWanted fix in voicesource.js and this goes red — which is the whole
// property the transcription version could never have.
mock.module('../client/lib/core.js', () => ({
  report: (...a) => console.error('[report]', ...a),
  bus: { on() {}, emit() {} },
}));

let gumCalls = 0, gumBehaviour = 'ok';
Object.defineProperty(globalThis.navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: async () => {
  gumCalls++;
  if (gumBehaviour === 'throw') throw new Error('NotAllowedError');
  return { kind: 'microphone', getTracks: () => [{ kind: 'audio', stop() {} }] };
}}});
class FakeNode { connect() { return this; } disconnect() {} }
globalThis.MediaStream = globalThis.MediaStream ?? class { constructor(t){ this._t=t||[]; } getTracks(){ return this._t; } };
globalThis.AudioContext = class {
  createMediaStreamDestination() { return { stream: { synthetic: true, getTracks: () => [{ kind: 'audio', stop() {} }] } }; }
  createGain() { return new FakeNode(); }
  get destination() { return new FakeNode(); }
  resume() {} get sampleRate() { return 48000; }
};

const mod = await import('../client/lib/voicesource.js');
const { voiceSource, setSynthProvider } = mod;
if (typeof setSynthProvider !== "function") { console.log("FAIL — setSynthProvider not exported; test would pass vacuously"); process.exit(1); }

let pass = 0, fail = 0;
const check = (name, cond) => { cond ? (pass++, console.log(`ok   ${name}`))
                                     : (fail++, console.log(`FAIL ${name}`)); };

// 1. No provider, mic works → the microphone.
gumCalls = 0; gumBehaviour = 'ok';
let s = await voiceSource();
check('mic available and wanted → microphone', s.kind === 'microphone' && gumCalls === 1);

// 2. THE FIX: mic switched off + provider available → synth, WITHOUT opening a device.
// The REAL provider contract (voicesource.js:104): start() returns a TRACK,
// which synthStream() wraps in a MediaStream and marks .synthetic. The
// transcription version had this as stream() → an object, and was green anyway
// — it was asserting against its own invented interface.
setSynthProvider({ available: () => true, start: () => ({ kind: 'audio', stop() {} }) });
gumCalls = 0;
s = await voiceSource({ micWanted: false });
check('mic OFF + provider → synthetic source', !!s && s.kind !== 'microphone');
check('mic OFF does not call getUserMedia', gumCalls === 0);

// 3. Default stays mic — every existing call site unchanged.
gumCalls = 0;
s = await voiceSource();
check('default (micWanted omitted) still takes the mic', s.kind === 'microphone' && gumCalls === 1);

// 4. Original fallback intact: gUM throws + provider → synth.
gumBehaviour = 'throw'; gumCalls = 0;
s = await voiceSource();
check('gUM throws + provider → synthetic (original path)', !!s && s.kind !== 'microphone');

// 5. Negative control: no provider + gUM throws → must THROW, never silently mute.
//    (setSynthProvider(null) may be rejected by a guard; clear via a provider
//    that reports unavailable, which is the same state from the caller's view.)
setSynthProvider({ available: () => false, start: () => { throw new Error('must not be called'); } });
let threw = false;
try { await voiceSource(); } catch { threw = true; }
check('no provider + no mic → throws (does not fake a source)', threw);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
