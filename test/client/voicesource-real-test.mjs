// A REAL test for voiceSource(): it IMPORTS client/lib/audio/voicesource.js and
// exercises the shipped function. Replaces the eye-verified transcription in
// tts-publishes-mic-off-test.mjs, which imports nothing and cannot fail when
// the module breaks (audit, 2026-08-16).
//
// Only the BROWSER SURFACE is stubbed — navigator.mediaDevices and the minimum
// WebAudio the synth path touches. The decision logic under test is the real
// one, so reverting the micWanted fix in voicesource.js makes this go red.
// voicesource.js takes `report` from base.js (once from core.js, which builds a canvas at module scope; the core.js
// mock below is left from then) — a real import still wants a real DOM. happy-dom is already the repo's pattern for
// this (test/client/tts-fault-test.ts, test/client/chat-log-test.ts).
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { mock } from "bun:test";
import { suite } from "../gate/suite.ts";
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
mock.module('../../client/lib/core.js', () => ({
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
// 🔴 THE STUB MUST BE AS STRICT AS THE BROWSER. A permissive stub hides real
// bugs: `new MediaStream([null])` throws TypeError in Chrome, but a stub that
// stores the array happily let mutation M4 (provider.start() returning null)
// pass 8/8. A test double looser than the thing it doubles is a source of false
// green — the same defect as a test that imports nothing, wearing a disguise.
globalThis.MediaStream = class {
  constructor(t) {
    const tracks = t || [];
    for (const x of tracks) {
      if (x == null || typeof x !== 'object' || x.kind !== 'audio') {
        throw new TypeError("Failed to construct 'MediaStream': invalid track");
      }
    }
    this._t = tracks;
  }
  getTracks() { return this._t; }
};
globalThis.AudioContext = class {
  createMediaStreamDestination() { return { stream: { synthetic: true, getTracks: () => [{ kind: 'audio', stop() {} }] } }; }
  createGain() { return new FakeNode(); }
  get destination() { return new FakeNode(); }
  resume() {} get sampleRate() { return 48000; }
};

const mod = await import('../../client/lib/audio/voicesource.js');
const { voiceSource, setSynthProvider, setGeneratorRebuildHook, notifySynthTrackChanged } = mod;
if (typeof setSynthProvider !== "function") { console.log("FAIL — setSynthProvider not exported; test would pass vacuously"); process.exit(1); }

const S = suite("voicesource-real");
const check = (name, cond) => S.check(name, cond);

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
// 🔴 ASSERT THE POSITIVE (.synthetic === true), not "not a microphone": voicesfu.js's re-acquire-after-synth guard
// branches on the flag
check('mic OFF + provider → synthetic source', !!s && s.synthetic === true);
check('mic OFF source is NOT a microphone', s.kind !== 'microphone');
check('mic OFF does not call getUserMedia', gumCalls === 0);

// 3. Default stays mic — every existing call site unchanged.
gumCalls = 0;
s = await voiceSource();
check('default (micWanted omitted) still takes the mic', s.kind === 'microphone' && gumCalls === 1);

// 3b. The provider contract itself: start() must yield a usable track.
//     (Mutation M4: start() returning null left the old version green, because
//     `new MediaStream([null])` is tolerated by the stub while a real browser
//     throws. Assert the track exists rather than trusting the wrapper.)
const synth = await voiceSource({ micWanted: false });   // the synthetic path's own stream, not the mic's above
const tracks = synth?.synthetic === true && typeof synth.getTracks === 'function' ? synth.getTracks() : [];
check('synthetic stream carries a real track', tracks.length === 1 && tracks[0] != null);

// A provider whose start() yields nothing must FAIL LOUDLY, not publish silence.
// (Mutation M4. The strict MediaStream stub above makes this throw the way a
// browser does; catching it here turns a crash into a reported assertion.)
setSynthProvider({ available: () => true, start: () => null });
let m4threw = false;
try { await voiceSource({ micWanted: false }); } catch { m4threw = true; }
check('provider.start() returning null throws, not silent publish', m4threw);
setSynthProvider({ available: () => true, start: () => ({ kind: 'audio', stop() {} }) });

// 4. Original fallback intact: gUM throws + provider → synth.
gumBehaviour = 'throw'; gumCalls = 0;
s = await voiceSource();
check('gUM throws + provider → synthetic (original path)', !!s && s.synthetic === true);

// 5. Negative control: no provider + gUM throws → must THROW, never silently mute.
//    (setSynthProvider(null) may be rejected by a guard; clear via a provider
//    that reports unavailable, which is the same state from the caller's view.)
setSynthProvider({ available: () => false, start: () => { throw new Error('must not be called'); } });
let threw = false;
try { await voiceSource(); } catch { threw = true; }
check('no provider + no mic → throws (does not fake a source)', threw);

// 6. mic OFF + no provider publishes nothing and never opens the device
gumBehaviour = 'ok'; gumCalls = 0;
let offThrew = false;
try { await voiceSource({ micWanted: false }); } catch { offThrew = true; }
check('mic OFF + no provider → throws, getUserMedia untouched', offThrew && gumCalls === 0);

// 7. two transports register the rebuild hook: both fire, a thrower does not silence the rest, and unsubscribe works
const fired = [];
const offs = [() => fired.push('mesh'), () => { throw new Error('sfu blew up'); }, () => fired.push('sfu-later')].map(setGeneratorRebuildHook);
notifySynthTrackChanged({ kind: 'audio' });
check('every rebuild hook fires; a throwing one does not silence the rest', fired.join() === 'mesh,sfu-later');
offs.forEach((off) => off());
notifySynthTrackChanged({ kind: 'audio' });
check('…and an unsubscribed hook no longer fires', fired.length === 2);

S.done();
