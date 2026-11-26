// mictoggle.js: the HUD glyph is gold on the gate's own decision (micstate.js micGateInfo), never a level of its own.
// Run: BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun test/client/mictoggle-glyph-test.mjs
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { mock } from "bun:test";
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { pause, until, tryUntil } from '../gate/wait.ts';
GlobalRegistrator.register({ url: "http://localhost/?world=t&name=p" });

const lib = (p) => fileURLToPath(new URL(`../../client/lib/${p}`, import.meta.url));
let room = 0;   // the RMS the stub "microphone" hears right now
let noGraph = false;   // true: this device can't build the gate graph
mock.module(lib('audio/audioctx.js'), () => ({
  audioContext: () => noGraph ? { currentTime: 0, sampleRate: 48000, state: 'running',
    createAnalyser: () => ({ fftSize: 0, getFloatTimeDomainData(buf) { buf.fill(room); }, connect() {}, disconnect() {} }),
    createMediaStreamSource: () => ({ connect() {}, disconnect() {} }) } : ({
    currentTime: 0, sampleRate: 48000, state: 'running',
    createAnalyser: () => ({ fftSize: 0, getFloatTimeDomainData(buf) { buf.fill(room); }, connect() {}, disconnect() {} }),
    createMediaStreamSource: () => ({ connect() {}, disconnect() {} }),
    createGain: () => ({ gain: { value: 0, setTargetAtTime(v) { this.value = v; } }, connect() {}, disconnect() {} }),
    createMediaStreamDestination: () => { const tr = { kind: 'audio', enabled: true, stop() {} }; return { stream: { getTracks: () => [tr], getAudioTracks: () => [tr] } }; },
    createDelay: () => ({ delayTime: { value: 0, setTargetAtTime() {} }, connect() {}, disconnect() {} }),
  }),
}));
// every net.js export as a no-op: the glyph's import graph reaches it, and nothing here may touch a socket
const netSrc = readFileSync(lib('net.js'), 'utf8');
const NET = [...netSrc.matchAll(/^export\s+(?:async\s+)?(?:function\*?|const|let|var|class)\s+([A-Za-z_$][\w$]*)/gm)].map(m => m[1]);
for (const m of netSrc.matchAll(/^export\s*\{([^}]*)\}/gm)) for (const n of m[1].split(',')) { const k = n.trim().split(/\s+as\s+/).pop(); if (k) NET.push(k); }
mock.module(lib('net.js'), () => ({ net: {}, ...Object.fromEntries(NET.filter(n => n !== 'net').map(n => [n, () => {}])) }));
// stt.js reaches ui.js (the whole page); the glyph only asks it two things
mock.module(lib('audio/stt.js'), () => ({ setSTT() {}, sttAvailable: () => false, sttOn: () => false }));

let ok = 0, bad = 0;
const t = (n, cond) => { cond ? ok++ : bad++; console.log(`${cond ? 'ok  ' : 'FAIL'} ${n}`); };

// ── 1. the HUD glyph: gold under the line was the bug ────────────────────────
document.body.innerHTML = '<div id="hud"></div>';
const vc = await import(lib('audio/voiceconsent.js'));
const ms = await import(lib('audio/micstate.js'));
// the transport carries whatever lane it is given: this suite is the gate's side (mic-room-hears-test.mjs runs the real one)
ms.setLaneCarrier?.(() => true);
vc.setMicFloor(0.16);                              // 80%: the line is -12 dBFS ≈ 0.25 RMS
const track = { kind: 'audio', enabled: true, stop() {} };
ms.gateFor({ getTracks: () => [track], getAudioTracks: () => [track] });
await import(lib('audio/mictoggle.js'));
const gold = () => (document.querySelector('#micbtn')?.innerHTML || '').includes('drop-shadow');
room = 0.001; await until('the real gate is ticking on the lane and has learned a quiet room', () => ms.micGateInfo().noise < 0.002);
t('setup: the glyph exists', !!document.querySelector('#micbtn'));
room = 0.08; await pause('a level above the old fixed 0.02 but under the 0.25 line has had time to turn it gold', 400);
t('glyph is NOT gold for a level under the sensitivity line', gold() === false && ms.micGateInfo().speaking === false);
room = 0.5; await tryUntil('the gate opens for a loud room', () => gold() && ms.micGateInfo().speaking);
t('glyph IS gold when the gate is open', gold() === true && ms.micGateInfo().speaking === true);
// hold the clock inside the 700ms hang, so a loaded host can't run the row past it
const realNow = Date.now, held = Date.now(); Date.now = () => held;
room = 0.01; await pause('back under the line (and under the old 0.02), the clock held inside the hang: three glyph polls', 400);
t('glyph stays gold through the hang (it follows the gate, not a level)', gold() === true && ms.micGateInfo().speaking === true);
Date.now = realNow;
await until('the hang ends once the clock runs again', () => !ms.micGateInfo().speaking);

vc.setPttMode(true); room = 0.5; await pause('PTT key up: a loud room has had time to turn it gold', 400);
t('PTT, key up: loud input does not turn the glyph gold', gold() === false);
ms.setPttHeld(true); await tryUntil('PTT key down turns it gold', () => gold());
t('PTT, key down: gold', gold() === true);
ms.setPttHeld(false); vc.setPttMode(false);

// ── 2. a consented raw lane (no gate graph on this device) transmits under the line: the glyph must say so ──
const mg = await import(lib('audio/micgate.js'));
noGraph = true; mg.allowUngated(true);
const rawTrack = { kind: 'audio', enabled: true, stop() {} };   // a fresh device: gateFor stops the previous one
ms.gateFor({ getTracks: () => [rawTrack], getAudioTracks: () => [rawTrack] });
t('setup: the gate graph is unavailable and raw is consented', mg.gateUnavailable() === true && mg.ungatedConsent() === true);
room = 0.01; await pause('under the line and past the 700ms hang, so a threshold gate would be shut by now', 1100);
t('consented raw lane, voice activation: gold under the line (the room hears everything)', gold() === true && ms.micGateInfo().speaking === true);
vc.setPttMode(true); await pause('PTT key up on a raw lane closes the wire', 300);
t('consented raw lane, PTT key up: not gold, and the raw track is off', gold() === false && rawTrack.enabled === false);
vc.setPttMode(false);
t('setup: back to voice activation, the raw track is on', !!(await tryUntil('the raw lane reopens', () => rawTrack.enabled)));
ms.toggleMute(true);
rawTrack.enabled = true; ms.setMicLive(true);   // what voicesfu.js sfuMic(true) does to a device it still holds
t('muted raw lane: the transport re-enabling it and reporting live (unchanged) closes it at once', rawTrack.enabled === false);
ms.toggleMute(false);
t('setup: unmute reopens the raw lane', !!(await tryUntil('the raw lane reopens on unmute', () => rawTrack.enabled)));
// the transport turns the lane off while the device is still reported live (sfuMic(false)'s window before setMicLive)
ms.setLaneEnabled(false);
await pause('gate ticks after the transport turned the raw lane off', 200);
t('the transport turned the raw lane off: the gate ticks keep it off (they honour setLaneEnabled)', rawTrack.enabled === false);
ms.setLaneEnabled(true);
t('setup: the transport turns it back on', !!(await tryUntil('the raw lane back on', () => rawTrack.enabled)));
mg.allowUngated(false);
t('consent revoked on a live raw lane: the track is off at once, and micGateInfo says so', rawTrack.enabled === false && ms.micGateInfo().speaking === false);
await pause('revoked: gate ticks and glyph polls have had time to reopen it', 300);
t('consent revoked: ticks keep it off, and the glyph is not gold', rawTrack.enabled === false && gold() === false);
mg.allowUngated(true);
t('re-consented: the raw track is on in the same call, agreeing with micGateInfo (no tick between)',
  rawTrack.enabled === true && ms.micGateInfo().speaking === true);
t('re-consented: the glyph is gold', !!(await tryUntil('the re-consented raw lane goes gold', () => rawTrack.enabled && gold())));
mg.allowUngated(false);
noGraph = false;

// ── 3. a synth voice has no gate (micstate.js gateFor passes it through): the room hears whatever it plays ──
window.__sfuMicOn = () => true;   // the transport publishes the synth lane; micOn() is false for synth (no device)
ms.setMicLive(false);
const synthTrack = { kind: 'audio', enabled: true, stop() {} };
const synth = { synthetic: true, getTracks: () => [synthTrack], getAudioTracks: () => [synthTrack] };
ms.gateFor(synth);
// the raw lane above left the glyph gold until its next poll: start the synth rows from a repainted, silent glyph
room = 0; await tryUntil('the silent synth lane has repainted the glyph off gold', () => !gold());   // silence: a synth lane sends anything above it
room = 0.3; await tryUntil('a playing synth voice turns the glyph gold', () => gold());
t('synth voice playing: gold, and micGateInfo says the room hears it', gold() === true && ms.micGateInfo().speaking === true);
room = 0; await tryUntil('a silent synth voice stops being gold', () => !gold());
t('synth voice silent: not gold', gold() === false && ms.micGateInfo().speaking === false);
room = 0.01; await tryUntil('a quiet synth voice (-40 dBFS RMS) turns the glyph gold', () => gold());
t('synth voice quiet (-40 dBFS): gold, the room hears it', gold() === true && ms.micGateInfo().speaking === true);
{ // hold the clock inside the 700ms hang, as for the device lane
  // the synth hang runs on performance.now (monotonic); hold both clocks
  const realNow = Date.now, held = Date.now(); Date.now = () => held;
  const realPerf = performance.now.bind(performance), heldPerf = performance.now(); performance.now = () => heldPerf;
  room = 0; await pause('a gap between words, the clock held inside the hang: three glyph polls', 400);
  t('synth voice, a gap between words: stays gold through the hang', gold() === true && ms.micGateInfo().speaking === true);
  Date.now = realNow; performance.now = realPerf;
}
t('the synth hang ends once the clock runs again', !!(await tryUntil('the synth hang ends once the clock runs again', () => !gold())));
ms.toggleMute(true); room = 0.3; await pause('muted synth: a playing voice has had time to turn it gold', 400);
t('synth voice muted: its track is off (the room hears nothing), and not gold', synthTrack.enabled === false && gold() === false && ms.micGateInfo().speaking === false);
ms.toggleMute(false);
t('synth voice unmuted: its track is on again', synthTrack.enabled === true);
await tryUntil('an unmuted playing synth voice is gold again', () => gold());
t('synth voice unmuted: gold again', gold() === true);
ms.setLaneEnabled(false);   // the transport turns the lane off (voicesfu.js sfuMic(false) with no provider)
ms.toggleMute(true); ms.toggleMute(false);
t('mute and unmute never re-enable a synth track the transport turned off', synthTrack.enabled === false);
ms.toggleMute(true);
const rebuilt = { kind: 'audio', enabled: true, stop() {} };   // the generator rebuilt while muted
ms.gateFor({ synthetic: true, getTracks: () => [rebuilt], getAudioTracks: () => [rebuilt] });
t('muted: a replacement synth track is off before any sender gets it', rebuilt.enabled === false);
ms.toggleMute(false);
t('...and on again at unmute', rebuilt.enabled === true);
delete window.__sfuMicOn;
console.log(`${ok} ok, ${bad} failed`);
process.exit(bad ? 1 : 0);
