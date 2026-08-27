// Push-to-talk: EXECUTE the gate decision under both regimes. Not a source
// grep — the stubs stop at the browser boundary (AudioContext, bus, net) and
// the code under test is the shipped code, same doctrine as
// micstate-exec-test.mjs and for the same reason: every prior mic defect in
// this repo passed source-level checks and failed only when run.
//
// The observable is micgate's gateOpenness() — the gate's INTENT, the same
// value the "am I being heard" indicator trusts. If these tests and that
// indicator ever disagree, believe neither and go listen.
//
// Run: bun tools/mic-ptt-test.mjs
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { mock } from "bun:test";
GlobalRegistrator.register({ url: "http://localhost/?world=t&name=p" });

// A REAL (tiny) bus, not a noop: micstate subscribes to 'audio:ptt' to drop a
// held key on mode exit, and voiceconsent emits it. A noop stub would pass a
// broken subscription silently — the exact class of blindness these files
// keep writing warnings about.
const handlers = {};
const bus = {
  on: (t, f) => { (handlers[t] ??= []).push(f); },
  emit: (t, ...a) => { for (const f of handlers[t] ?? []) f(...a); },
};
mock.module(new URL('../client/lib/core.js', import.meta.url).pathname, () => ({
  report: () => {}, bus,
}));
let typed = 0;
mock.module(new URL('../client/lib/net.js', import.meta.url).pathname, () => ({
  sendTyping: () => { typed++; },
}));
// Full enough for the gate GRAPH to build (micstate-exec-test's stub lacks
// createGain/createMediaStreamDestination, so its gate is always unavailable
// — fine for its questions, blinding for these: an unbuilt gate reports
// openness 0 forever and every assertion below would vacuously pass).
mock.module(new URL('../client/lib/audioctx.js', import.meta.url).pathname, () => ({
  audioContext: () => ({
    currentTime: 0, sampleRate: 48000, state: 'running',
    createAnalyser: () => ({ fftSize: 0, getFloatTimeDomainData() {}, connect() {}, disconnect() {} }),
    createMediaStreamSource: () => ({ connect() {}, disconnect() {} }),
    createGain: () => ({ gain: { value: 0, setTargetAtTime(v) { this.value = v; } }, connect() {}, disconnect() {} }),
    createMediaStreamDestination: () => ({ stream: { getTracks: () => [], getAudioTracks: () => [] } }),
    createDelay: () => ({ delayTime: { value: 0, setTargetAtTime() {} }, connect() {}, disconnect() {} }),
  }),
}));

localStorage.clear();
const vc = await import('../client/lib/voiceconsent.js');
const ms = await import('../client/lib/micstate.js');
const mg = await import('../client/lib/micgate.js');

const track = { kind: 'audio', enabled: true, stop() {} };
const stream = { getTracks: () => [track], getAudioTracks: () => [track] };

let ok = 0, bad = 0;
const t = (n, cond) => { cond ? ok++ : bad++; console.log(`${cond ? 'ok  ' : 'FAIL'} ${n}`); };

ms.gateFor(stream);   // lane up, device live — the state every case below assumes

// ── voice activation (the default): the key is NOT the gate ────────────────
ms.setPttHeld(true);
t('VA mode: holding the key does not open the gate', mg.gateOpenness() === 0);
ms.setPttHeld(false);

// ── PTT: the key IS the gate ───────────────────────────────────────────────
// The announce assertions ride the FIRST press: the 🎙 shares its 1500ms
// rate-limit with the onset watcher through _lastOnset, so any earlier press
// in this file would eat the window and make "did it announce" untestable.
vc.setPttMode(true);
t('PTT armed: gate starts closed', mg.gateOpenness() === 0);
typed = 0;
ms.setPttHeld(true);
t('PTT: press opens', mg.gateOpenness() === 1);
t('press announces the 🎙 gesture', typed === 1);
ms.setPttHeld(false);
t('PTT: release closes', mg.gateOpenness() === 0);
ms.setPttHeld(true);   // re-press inside the 1500ms window
t('rapid re-press does not spam the announce', typed === 1);
ms.setPttHeld(false);

// ── mute outranks the key, exactly as it outranks speech ───────────────────
ms.toggleMute(true);
ms.setPttHeld(true);
t('PTT: mute is authoritative over a held key', mg.gateOpenness() === 0);
ms.toggleMute(false);
ms.setPttHeld(false); ms.setPttHeld(true);   // re-press now that mute is off
t('PTT: unmuted re-press opens again', mg.gateOpenness() === 1);

// ── leaving the mode must not leave a phantom finger on the gate ───────────
vc.setPttMode(false);
t('mode exit drops the held key', ms.pttHeld() === false);
t('mode exit closes the gate', mg.gateOpenness() === 0);

// ── the stuck-key class: keyup/blur handling exists in the UI layer ────────
// Source-level, deliberately: mictoggle self-injects against a real DOM and
// does not export its handlers, so execution would test happy-dom's event
// plumbing more than our code. What must be TRUE of the source: a keyup path
// and a blur path both drop the hold. Alt-tab with the key down is how every
// PTT implementation ships an open mic that says it is closed.
import { readFileSync } from 'fs';
const mt = readFileSync(new URL('../client/lib/mictoggle.js', import.meta.url), 'utf8');
t('mictoggle: keyup releases the hold', /keyup[\s\S]{0,200}setPttHeld\(false\)/.test(mt));
t('mictoggle: window blur releases the hold', /'blur'[\s\S]{0,200}setPttHeld\(false\)/.test(mt));
t('mictoggle: badge gold is gated on the key under PTT', /!pttMode\(\) \|\| pttHeld\(\)/.test(mt));
const ap = readFileSync(new URL('../client/lib/audiopanel.js', import.meta.url), 'utf8');
t('audiopanel: sensitivity row dims under PTT (no control that lies)', /audio:ptt.*dimFloor|dimFloor[\s\S]{0,400}audio:ptt/.test(ap.replace(/\n/g, ' ')) || (/dimFloor/.test(ap) && /bus\.on\('audio:ptt', dimFloor\)/.test(ap)));

console.log(`\n${ok} ok, ${bad} failed`);
process.exit(bad ? 1 : 0);
