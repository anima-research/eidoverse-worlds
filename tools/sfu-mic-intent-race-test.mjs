// The SFU transport, EXECUTED: mic intent that changes while an acquisition
// is in flight. Mica's #148 round-4 probe: two same-pc callers share one slow
// permission prompt, the person turns the mic OFF before it resolves, the
// device arrives — and the old code published it live, then a parked waiter
// re-enabled it and reported liveness. The user's OFF was visible in wantMic
// and nowhere else.
//
// Only the browser boundary is stubbed: RTCPeerConnection, the WebAudio
// context (gate graph unbuildable → consented ungated lane, so the published
// track IS the device track and its enabled flag is the wire), and
// voiceSource() as a deferred acquisition we resolve by hand. voicesfu.js,
// micstate.js, micgate.js and voiceconsent.js are the shipped modules.
//
// Run: bun tools/sfu-mic-intent-race-test.mjs
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { mock } from "bun:test";
GlobalRegistrator.register({ url: "http://localhost/?world=t&name=p" });
const M = (p) => new URL(`../client/lib/${p}`, import.meta.url).pathname;
mock.module(M('net.js'), () => ({ sendTyping: () => {}, requestHistory: () => {} }));
mock.module(M('chat.js'), () => ({ logChat: () => {} }));
mock.module(M('audiounlock.js'), () => ({ playWhenAllowed: () => {} }));
mock.module(M('audioctx.js'), () => ({
  audioContext: () => ({
    currentTime: 0, sampleRate: 48000, state: 'running',
    createAnalyser: () => ({ fftSize: 0, getFloatTimeDomainData() {}, connect() {}, disconnect() {} }),
    createMediaStreamSource: () => ({ connect() {}, disconnect() {} }),
  }),
}));
// Every acquisition parks here until the test resolves it — a permission
// prompt with the test's finger on the button.
let provider = null;
const acquisitions = [];
mock.module(M('voicesource.js'), () => ({
  synthProvider: () => provider,
  voiceSource: ({ micWanted = true } = {}) => new Promise((resolve, reject) => acquisitions.push({ micWanted, resolve, reject })),
}));
class FakePC {
  constructor() { this.connectionState = 'new'; this.iceConnectionState = 'new'; this.added = []; this.closed = false; }
  getTransceivers() { return []; }
  addTrack(t, s) { this.added.push({ track: t, stream: s }); }
  close() { this.closed = true; }
}
globalThis.RTCPeerConnection = FakePC;

const mg = await import('../client/lib/micgate.js');
const ms = await import('../client/lib/micstate.js');
const sfu = await import('../client/lib/voicesfu.js');
mg.allowUngated(true);

let ok = 0, bad = 0;
const t = (n, cond) => { cond ? ok++ : bad++; console.log(`${cond ? 'ok  ' : 'FAIL'} ${n}`); };
// A mutation that leaves a caller parked forever (nothing ever re-asks the
// current question) would hang here rather than fail. A hang is a red.
const watchdog = setTimeout(() => {
  console.log('FAIL watchdog: an await never settled — some caller is parked forever');
  console.log(`\n${ok} ok, ${bad + 1} failed`);
  process.exit(1);
}, 5000);
const flush = () => new Promise((r) => setTimeout(r, 0));
const mkTrack = () => ({ kind: 'audio', enabled: true, stopped: false, stop() { this.stopped = true; } });
const mkDevice = () => { const tr = mkTrack(); return { track: tr, getTracks: () => [tr], getAudioTracks: () => [tr] }; };
const mkSynth  = () => { const tr = mkTrack(); return { synthetic: true, track: tr, getTracks: () => [tr], getAudioTracks: () => [tr] }; };
const lastPublished = (pc) => pc.added[pc.added.length - 1]?.stream;

const pc = await sfu.sfuConnect({}, () => {});

// ── 1. Mica's sequence: ON, ON (shared prompt), OFF, prompt resolves ─────
let p1 = sfu.sfuMic(true);
await flush();
t('1: the first ON opened an acquisition asking for the mic', acquisitions.length === 1 && acquisitions[0].micWanted === true);
let p2 = sfu.sfuMic(true);            // parks on the same pending
let p3 = sfu.sfuMic(false);           // the person turns the mic OFF while the prompt is up
await flush();
t('1: OFF is the recorded intent while the prompt is still up', sfu.sfuMicWanted() === false);
const dev1 = mkDevice();
acquisitions[0]?.resolve(dev1);
await Promise.all([p1, p2, p3]); await flush();
t('1: intent is still OFF after the prompt resolved', sfu.sfuMicWanted() === false);
t('1: the device that arrived after OFF was stopped', dev1.track.stopped === true);
t('1: …and its track is not enabled', dev1.track.enabled === false);
t('1: it was NOT published', pc.added.length === 0 && sfu.sfuMicOn() === false);
t('1: micstate does not believe a device is live', ms.micDeviceLive() === false);
t('1: micOn() is false', ms.micOn() === false);
t('1: no provider → nothing else was acquired', acquisitions.length === 1);

// ── 2. the same race with a synth provider: OFF meant "speak for me" ──────
provider = { available: () => true, start: () => mkTrack() };
p1 = sfu.sfuMic(true);
await flush();
t('2: ON opened an acquisition for the mic', acquisitions.length === 2 && acquisitions[1].micWanted === true);
p3 = sfu.sfuMic(false);               // provider present: the OFF path wants a synth swap
await flush();
const dev2 = mkDevice();
acquisitions[1]?.resolve(dev2);
await flush(); await flush();
t('2: the device that arrived after OFF was stopped', dev2.track.stopped === true);
t('2: the synth the OFF path wanted is now being acquired', acquisitions.length === 3 && acquisitions[2].micWanted === false);
const syn2 = mkSynth();
acquisitions[2]?.resolve(syn2);
await Promise.all([p1, p3]); await flush();
t('2: the synth is what got published', lastPublished(pc) === syn2 && pc.added.length === 1);
t('2: a synth is not a live device', ms.micDeviceLive() === false && sfu.sfuMicWanted() === false);

// ── 3. the mirror image: ON while a synth acquisition is in flight ────────
// First bring a real device live the ordinary way (ON after a synth swap
// re-acquires — the 2026-08-16 rule), then OFF with the provider present so a
// synth acquisition parks, then ON before it resolves.
p1 = sfu.sfuMic(true);
await flush();
t('3: ON after a synth re-acquires the mic', acquisitions.length === 4 && acquisitions[3].micWanted === true && syn2.track.stopped === true);
const dev3 = mkDevice();
acquisitions[3]?.resolve(dev3);
await p1; await flush();
t('3: precondition — the device is published and live', lastPublished(pc) === dev3 && ms.micDeviceLive() === true && ms.micOn() === true);
p3 = sfu.sfuMic(false);               // swap to synth: acquisition parks
await flush();
t('3: OFF stopped the device and opened a synth acquisition', dev3.track.stopped === true && acquisitions.length === 5 && acquisitions[4].micWanted === false);
p1 = sfu.sfuMic(true);                // …and the person changes their mind before it lands
await flush();
const syn3 = mkSynth();
acquisitions[4]?.resolve(syn3);
await flush(); await flush();
t('3: the synth that arrived after ON was stopped, not published', syn3.track.stopped === true && lastPublished(pc) === dev3);
t('3: the mic is being acquired again', acquisitions.length === 6 && acquisitions[5].micWanted === true);
const dev4 = mkDevice();
acquisitions[5]?.resolve(dev4);
await Promise.all([p1, p3]); await flush();
t('3: the device is published and live', lastPublished(pc) === dev4 && ms.micDeviceLive() === true && ms.micOn() === true && sfu.sfuMicWanted() === true);

// ── 4. the retained-device fast path reports liveness (round 3, executed) ─
provider = null;
await sfu.sfuMic(false);
t('4: OFF with no provider disables the device and reports it not live', dev4.track.enabled === false && ms.micDeviceLive() === false && ms.micOn() === false);
await sfu.sfuMic(true);
t('4: ON re-enables the retained device without a new acquisition', dev4.track.enabled === true && acquisitions.length === 6);
t('4: …and reports it live, so micOn() agrees', ms.micDeviceLive() === true && ms.micOn() === true);

clearTimeout(watchdog);
console.log(`\n${ok} ok, ${bad} failed`);
process.exit(bad ? 1 : 0);
