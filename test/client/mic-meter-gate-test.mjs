// The sensitivity meter tells the truth about the gate (audiopanel.js micFloorRow): gold is the gate's decision
// (gateThreshold, dB-mapped, voiceconsent.js, plus its hang), the bar is the level the gate reads, and it still moves while
// muted. The stub microphone feeds the real gate.
//
// Run: BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun test/client/mic-meter-gate-test.mjs
import { fileURLToPath } from "node:url";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { mock } from "bun:test";
import { pause, until, tryUntil } from "../gate/wait.ts";
GlobalRegistrator.register({ url: "http://localhost/?world=t&name=p" });

const at = (p) => fileURLToPath(new URL(p, import.meta.url));
mock.module(at('../../client/lib/ui/ui.js'), () => ({
  flashHint: () => {},
  makeSection: (title, build, opts = {}) => { const el = document.createElement('div'); el.id = `sec-${opts.id}`; document.body.appendChild(el); build(el); return el; },
}));
mock.module(at('../../client/lib/audio/ttsrow.js'), () => ({ ttsSection: () => document.createElement('div') }));
let level = 0;   // the RMS the stub microphone hears
mock.module(at('../../client/lib/audio/audioctx.js'), () => ({
  audioContext: () => ({
    currentTime: 0, sampleRate: 48000, state: 'running',
    createAnalyser: () => ({ fftSize: 0, getFloatTimeDomainData(buf) { buf.fill(level); }, connect() {}, disconnect() {} }),
    createMediaStreamSource: () => ({ connect() {}, disconnect() {} }),
    createGain: () => ({ gain: { value: 0, setTargetAtTime(v) { this.value = v; } }, connect() {}, disconnect() {} }),
    createMediaStreamDestination: () => ({ stream: { getTracks: () => [], getAudioTracks: () => [] } }),
    createDelay: () => ({ delayTime: { value: 0, setTargetAtTime() {} }, connect() {}, disconnect() {} }),
  }),
}));
mock.module(at('../../client/lib/net.js'), () => ({ say: () => {}, sendTyping: () => {}, sendRequest: async () => ({ ok: true }), net: {} }));

localStorage.clear();
const vc = await import('../../client/lib/audio/voiceconsent.js');
const { initAudioPanel } = await import('../../client/lib/audio/audiopanel.js');
const ms = await import('../../client/lib/audio/micstate.js');
const track = { kind: 'audio', enabled: true, stop() {} };
ms.gateFor({ getTracks: () => [track], getAudioTracks: () => [track] });
window.relayDiag = () => ({ micPublished: true });
initAudioPanel();

let ok = 0, bad = 0;
const t = (n, cond, d = '') => { cond ? ok++ : bad++; console.log(`${cond ? 'ok  ' : 'FAIL'} ${n}${cond ? '' : `  — ${d}`}`); };
const lvl = document.querySelector('#sec-audio [data-lvl]');
const thr = document.querySelector('#sec-audio [data-thr]');
t('setup: the meter is mounted', !!lvl && !!thr);
level = 0.0005; await pause('the gate settles on a quiet room', 600);
const pct = (s) => parseFloat(/([\d.]+)%/.exec(s)?.[1] ?? 'NaN');
const GOLD = /255, 214, 107|#ffd66b/i;
const DARK = /107, 95, 66|#6b5f42/i;
const WARM = /154, 138, 94|#9a8a5e/i;

const g = vc.gateThreshold();
t('setup: the default gate opens well under micFloor (the case the bot named)', g < vc.micFloor() * 0.7, `${g} vs ${vc.micFloor()}`);
level = (g + vc.micFloor()) / 2;   // opens the gate, under the old linear marker
await tryUntil('the bar goes live when the gate opens', () => GOLD.test(lvl.style.background));
t('a level that opens the gate reads live (gold)', GOLD.test(lvl.style.background), lvl.style.background);
t('...and its bar reaches past the marker', pct(lvl.style.width) > pct(thr.style.left), `${lvl.style.width} vs ${thr.style.left}`);
// hold the clock inside the gate's 700ms hang, so a loaded host can't run the row past it
const realNow = Date.now, held = Date.now(); Date.now = () => held;
level = g * 0.5;   // under the gate
await pause('under the gate, the clock held inside its hang: many frames', 300);
t("through the gate's hang the bar stays live (gold), as the gate does", GOLD.test(lvl.style.background) && ms.micGateInfo().speaking === true, lvl.style.background);
Date.now = realNow;
await until('the hang ends once the clock runs again', () => !ms.micGateInfo().speaking);
await tryUntil('the bar repaints off gold', () => !GOLD.test(lvl.style.background));
t('a level under the gate is not live: warm (live, but the room is not getting it)', WARM.test(lvl.style.background), lvl.style.background);
t('...and its bar stops short of the marker', pct(lvl.style.width) < pct(thr.style.left), `${lvl.style.width} vs ${thr.style.left}`);


// muted: dark, and the bar still moves, so the sensitivity can be tuned without transmitting
ms.toggleMute(true);
level = vc.micFloor();   // loud enough to open the gate
await tryUntil('the muted bar follows the device', () => pct(lvl.style.width) > pct(thr.style.left));
t('muted: the bar still moves (past the marker for a loud level)', pct(lvl.style.width) > pct(thr.style.left), `${lvl.style.width} vs ${thr.style.left}`);
t('...and reads dark, not live', DARK.test(lvl.style.background) && ms.micGateInfo().speaking === false, lvl.style.background);
ms.toggleMute(false);
await tryUntil('unmuted, a loud level reads live again', () => GOLD.test(lvl.style.background));
t('unmuted: live again', GOLD.test(lvl.style.background), lvl.style.background);

// a synth voice has no gate: the bar goes gold when it plays, as the HUD glyph does (mictoggle-glyph-test.mjs)
level = 0.0005;
await tryUntil('the device goes quiet and the bar leaves gold, so the synth row starts from warm', () => WARM.test(lvl.style.background));
t('setup: the bar is warm before the synth voice', WARM.test(lvl.style.background), lvl.style.background);
ms.setMicLive(false);
const synthTrack = { kind: 'audio', enabled: true, stop() {} };   // a fresh source: gateFor stops the device
const synth = { synthetic: true, getTracks: () => [synthTrack], getAudioTracks: () => [synthTrack] };
ms.gateFor(synth);
level = 0.3;
await tryUntil('a playing synth voice reads live', () => GOLD.test(lvl.style.background));
t('synth voice playing: the bar is gold, agreeing with the glyph', GOLD.test(lvl.style.background) && ms.micGateInfo().speaking === true, lvl.style.background);

console.log(`\n${ok} ok, ${bad} failed`);
process.exit(bad ? 1 : 0);
