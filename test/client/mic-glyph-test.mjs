// The onset gate driven one 20ms tick at a time, and the HUD glyph's gold as the gate's decision rather than a level of
// its own (R 10-17 gym: gold under the sensitivity line). One tick over the line opens the gate: that's deliberate.
// Run: BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun test/client/mic-glyph-test.mjs
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { mock } from "bun:test";
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { pause, tryUntil } from '../gate/wait.ts';
GlobalRegistrator.register({ url: "http://localhost/?world=t&name=p" });

const lib = (p) => fileURLToPath(new URL(`../../client/lib/${p}`, import.meta.url));
let room = 0;   // the RMS the stub "microphone" hears right now
mock.module(lib('audio/audioctx.js'), () => ({
  audioContext: () => ({
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

// ── 1. the machine itself, on a clock we hold ────────────────────────────────
const { makeOnsetGate } = await import(lib('audio/micgate.js'));
let clock = 1_000_000, tick = null, lv = 0.001;
const realNow = Date.now, realSI = globalThis.setInterval;
Date.now = () => clock;
globalThis.setInterval = (fn) => { tick = fn; return 1; };
const g = makeOnsetGate({ level: () => lv, threshold: () => 0.25, drive() {}, announce() {} });
g.start();
t('setup: start() handed us its tick', typeof tick === 'function');
const step = (level, n = 1) => { for (let i = 0; i < n; i++) { lv = level; clock += 20; tick(); } };
step(0.001, 40);                                   // settle + learn a quiet room (800ms)
t('setup: a quiet room is closed', g.info().speaking === false);
step(0.4, 1);
t('one tick over the line opens it (the deliberate one-tick open)', g.info().speaking === true);
step(0.001, 20);                                   // 400ms of quiet: inside the 700ms hang
t('the hang still holds through a pause', g.info().speaking === true);
step(0.001, 30);
t('and it closes after the hang', g.info().speaking === false);
step(0.001, 40);
step(0.4, 2);
t('setup: open before the restart', g.info().speaking === true);
g.stop(); g.start();                               // release + reacquire inside the 700ms hang
t('a restarted gate starts closed, not inside the old hang', g.info().speaking === false);
Date.now = realNow; globalThis.setInterval = realSI; g.stop();

// ── 2. the HUD glyph: gold under the line was the bug ────────────────────────
document.body.innerHTML = '<div id="hud"></div>';
const vc = await import(lib('audio/voiceconsent.js'));
const ms = await import(lib('audio/micstate.js'));
vc.setMicFloor(0.16);                              // 80%: the line is -12 dBFS ≈ 0.25 RMS
const track = { kind: 'audio', enabled: true, stop() {} };
ms.gateFor({ getTracks: () => [track], getAudioTracks: () => [track] });
await import(lib('audio/mictoggle.js'));
const gold = () => (document.querySelector('#micbtn')?.innerHTML || '').includes('drop-shadow');
room = 0.001; await pause('the real gate settles and learns a quiet room', 1200);
t('setup: the glyph exists', !!document.querySelector('#micbtn'));
room = 0.08; await pause('a level above the old fixed 0.02 but under the 0.25 line has had time to turn it gold', 400);
t('glyph is NOT gold for a level under the sensitivity line', gold() === false && ms.micGateInfo().speaking === false);
room = 0.5; await tryUntil('the gate opens for a loud room', () => gold() && ms.micGateInfo().speaking);
t('glyph IS gold when the gate is open', gold() === true && ms.micGateInfo().speaking === true);
room = 0.08; await pause('back under the line, still inside the 700ms hang', 300);
t('glyph stays gold through the hang (it follows the gate, not a level)', gold() === true);

vc.setPttMode(true); room = 0.5; await pause('PTT key up: a loud room has had time to turn it gold', 400);
t('PTT, key up: loud input does not turn the glyph gold', gold() === false);
ms.setPttHeld(true); await tryUntil('PTT key down turns it gold', () => gold());
t('PTT, key down: gold', gold() === true);
ms.setPttHeld(false); vc.setPttMode(false);
console.log(`${ok} ok, ${bad} failed`);
process.exit(bad ? 1 : 0);
