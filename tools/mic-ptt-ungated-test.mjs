// Push-to-talk on the UNGATED lane: EXECUTE the product path Mica's #148
// review found open. When the WebAudio gate graph cannot be built and the
// person allowed raw transmission, the SFU publishes the device stream itself
// — there is no gain node, so every gate decision used to land on nothing and
// the raw microphone left the machine continuously while PTT said "released".
// The repair drives the raw tracks' `enabled` flag from the PTT decision
// (micgate.js driveRawTracks). These cases go red if that call is removed.
//
// Run: bun tools/mic-ptt-ungated-test.mjs
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { mock } from "bun:test";
GlobalRegistrator.register({ url: "http://localhost/?world=t&name=p" });
mock.module(new URL('../client/lib/net.js', import.meta.url).pathname, () => ({ sendTyping: () => {} }));
// A context that CANNOT build the gate graph: no createMediaStreamDestination.
mock.module(new URL('../client/lib/audioctx.js', import.meta.url).pathname, () => ({
  audioContext: () => ({
    currentTime: 0, sampleRate: 48000, state: 'running',
    createAnalyser: () => ({ fftSize: 0, getFloatTimeDomainData() {}, connect() {}, disconnect() {} }),
    createMediaStreamSource: () => ({ connect() {}, disconnect() {} }),
  }),
}));
localStorage.clear();
const vc = await import('../client/lib/voiceconsent.js');
const mg = await import('../client/lib/micgate.js');
const ms = await import('../client/lib/micstate.js');

let ok = 0, bad = 0;
const t = (n, cond) => { cond ? ok++ : bad++; console.log(`${cond ? 'ok  ' : 'FAIL'} ${n}`); };
const track = { kind: 'audio', enabled: true, stop() {} };
const stream = { getTracks: () => [track], getAudioTracks: () => [track] };

// ── acquisition order: PTT ARMED BEFORE the raw lane exists ─────────────
// A persisted pttMode, or a mode set before the device is acquired, must
// govern the lane the moment gateFor returns — not one watcher tick later.
// No timers in this leg: every assertion is synchronous with the call.
mg.allowUngated(true);
vc.setPttMode(true);
const early = ms.gateFor(stream);
t('armed-first: gateFor returns the raw stream as the lane', ms.gateIsUnavailable() && early === stream);
t('armed-first: the raw track is DISABLED synchronously, before any tick', track.enabled === false);
t('armed-first: gateOpenness() is 0 synchronously', mg.gateOpenness() === 0);
t('armed-first: speaking is false synchronously', ms.micGateInfo().speaking === false);
ms.setPttHeld(true);
t('armed-first: a press opens the raw track', track.enabled === true);
ms.setPttHeld(false);
t('armed-first: a release closes it', track.enabled === false);
ms.gateRelease();
ms.releaseMicrophone();
vc.setPttMode(false);
track.enabled = true;   // a fresh device stream arrives enabled, as a real one would

// ── the ordinary order: lane first, then the mode ───────────────────────
const lane = ms.gateFor(stream);
t('precondition: the gate is unavailable and the raw stream IS the lane', ms.gateIsUnavailable() && lane === stream);
t('voice activation on a consented raw lane: track transmits (that is what was consented to)', track.enabled === true);
t('…and gateOpenness() says so', mg.gateOpenness() === 1);

// ── arming PTT closes the WIRE, not a gain that does not exist ─────────────
vc.setPttMode(true);
t('PTT armed on the ungated lane: raw track is DISABLED (no key, no audio)', track.enabled === false);
t('…gateOpenness() agrees', mg.gateOpenness() === 0);
ms.setPttHeld(true);
t('PTT held: raw track enabled', track.enabled === true && mg.gateOpenness() === 1);
ms.setPttHeld(false);
t('PTT released: raw track disabled — "release V and the room hears nothing" is TRUE here', track.enabled === false && mg.gateOpenness() === 0);

// ── mute outranks the key on this lane too ────────────────────────────────
ms.toggleMute(true);
ms.setPttHeld(true);
t('held + muted on the ungated lane: raw track stays disabled', track.enabled === false);
t('held + muted reports speaking:false', ms.micGateInfo().speaking === false);
ms.toggleMute(false);
t('unmute while held: raw track enabled again', track.enabled === true);
ms.setPttHeld(false);

// ── leaving PTT restores the consented raw regime ─────────────────────────
vc.setPttMode(false);
t('mode exit: raw lane is open again (voice activation, ungated, as consented)', track.enabled === true && mg.gateOpenness() === 1);
ms.toggleMute(true);
vc.setPttMode(true); vc.setPttMode(false);
t('mode exit while muted does NOT reopen the raw lane', track.enabled === false);
ms.toggleMute(false);

// ── the transport's mic OFF outranks the key too (Mica, round 3) ──────────
// voicesfu.js sfuMic(false) with no synth provider is: disable the tracks,
// then setMicLive(false). sfuMic(true) on a retained device is: enable the
// tracks, then setMicLive(true). Reproduced here verbatim, in that order —
// the ungated lane keeps its sender lane across mic OFF, so `_lane` alone
// said "on" and a later onset tick (or a mode exit) re-enabled a raw track
// the microphone control had turned off. The onset watcher is running on a
// real 20 ms interval throughout; "ticks" below are real ticks.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const transportMicOff = () => { track.enabled = false; ms.setMicLive(false); };
const transportMicOn  = () => { track.enabled = true;  ms.setMicLive(true);  };

// 1. PTT held → mic OFF → several ticks: still off, and says so.
vc.setPttMode(true);
ms.setPttHeld(true);
t('precondition: held on the ungated lane transmits', track.enabled === true && ms.micOn() === true);
transportMicOff();
t('held → mic OFF: raw track is disabled at once', track.enabled === false);
await sleep(90);   // four-plus onset ticks with the key still down
t('held → mic OFF → ticks: raw track STAYS disabled', track.enabled === false);
t('…micOn() is false', ms.micOn() === false);
t('…speaking is false', ms.micGateInfo().speaking === false);
t('…gateOpenness() is 0', mg.gateOpenness() === 0);
ms.setPttHeld(false); ms.setPttHeld(true);
t('a fresh press while the mic is OFF does not reopen the raw track', track.enabled === false);
ms.setPttHeld(false);

// 3a. explicit mic ON restores the PTT regime: key up means closed.
transportMicOn();
t('mic ON under PTT, key up: the transport enabled the track and the regime closed it again, synchronously', track.enabled === false && mg.gateOpenness() === 0);
ms.setPttHeld(true);
t('mic ON under PTT: a press opens', track.enabled === true && ms.micOn() === true && ms.micGateInfo().speaking === true);
ms.setPttHeld(false);

// 2. PTT armed, key up → mic OFF → leave PTT: the exit must not reopen.
t('precondition: armed, key up, track closed', track.enabled === false);
transportMicOff();
vc.setPttMode(false);
t('armed → mic OFF → leave PTT: raw track stays disabled', track.enabled === false);
t('…gateOpenness() stays 0', mg.gateOpenness() === 0);
await sleep(90);
t('…and stays so across ticks in voice activation', track.enabled === false && mg.gateOpenness() === 0);

// 3b. explicit mic ON restores the voice-activation regime: consented raw, open.
transportMicOn();
t('mic ON under voice activation: the consented raw lane is open again', track.enabled === true && mg.gateOpenness() === 1 && ms.micOn() === true);

// ── the transport's fast path must report liveness, not just flip tracks ──
// Source-level, deliberately: sfuMic needs a live RTCPeerConnection to run.
// Both re-enable sites in sfuMic(true) (retained device; awaited pending
// acquisition) set track.enabled and returned; the only setMicLive(true) was
// in sfuPublish. With liveness now part of the lane's authority, OFF→ON
// through that path would have left the gate shut for good.
import { readFileSync } from 'fs';
const sfu = readFileSync(new URL('../client/lib/voicesfu.js', import.meta.url), 'utf8');
const relive = sfu.match(/\(t\.enabled = true\)\);[^;]{0,80}setMicLive\(true\);/g) ?? [];
t('voicesfu: BOTH mic-ON re-enable sites are followed by setMicLive(true)', relive.length === 2);
t('voicesfu: no re-enable site returns without reporting liveness', !/\(t\.enabled = true\)\);\s*return;/.test(sfu));
t('negative control — the pre-fix shape is detected', /\(t\.enabled = true\)\);\s*return;/.test('micStream.getTracks().forEach((t) => (t.enabled = true));\n    return;'));

console.log(`\n${ok} ok, ${bad} failed`);
process.exit(bad ? 1 : 0);
