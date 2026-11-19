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
    createMediaStreamDestination: () => ({ stream: { getTracks: () => [], getAudioTracks: () => [] } }),
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
ms.gateFor({ getTracks: () => [track], getAudioTracks: () => [track] });
t('setup: the gate graph is unavailable and raw is consented', mg.gateUnavailable() === true && mg.ungatedConsent() === true);
room = 0.01; await pause('under the line and past the 700ms hang, so a threshold gate would be shut by now', 1100);
t('consented raw lane, voice activation: gold under the line (the room hears everything)', gold() === true && ms.micGateInfo().speaking === true);
vc.setPttMode(true); await pause('PTT key up on a raw lane closes the wire', 300);
t('consented raw lane, PTT key up: not gold', gold() === false);
vc.setPttMode(false); mg.allowUngated(false); noGraph = false;

// ── 3. a synth voice has no gate (micstate.js gateFor passes it through): the room hears whatever it plays ──
window.__sfuMicOn = () => true;   // the transport publishes the synth lane; micOn() is false for synth (no device)
ms.setMicLive(false);
const synth = { synthetic: true, getTracks: () => [track], getAudioTracks: () => [track] };
ms.gateFor(synth);
room = 0.3; await tryUntil('a playing synth voice turns the glyph gold', () => gold());
t('synth voice playing: gold, and micGateInfo says the room hears it', gold() === true && ms.micGateInfo().speaking === true);
room = 0.001; await tryUntil('a silent synth voice stops being gold', () => !gold());
t('synth voice silent: not gold', gold() === false && ms.micGateInfo().speaking === false);
ms.toggleMute(true); room = 0.3; await pause('muted synth: a playing voice has had time to turn it gold', 400);
t('synth voice muted: not gold', gold() === false && ms.micGateInfo().speaking === false);
ms.toggleMute(false); delete window.__sfuMicOn;
console.log(`${ok} ok, ${bad} failed`);
process.exit(bad ? 1 : 0);
