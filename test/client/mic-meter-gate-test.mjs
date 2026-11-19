// The sensitivity meter tells the truth about the gate (bot #333 130): the gate opens at gateThreshold()
// (dB-mapped, voiceconsent.js), so a level that opens it must read live and sit past the marker. The bar reads the gate
// itself (its RMS and its decision), so the stub microphone feeds the real gate.
//
// Run: bun test/client/mic-meter-gate-test.mjs
import { fileURLToPath } from "node:url";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { mock } from "bun:test";
import { pause, tryUntil } from "../gate/wait.ts";
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
window.__sfuMyLevel = () => level;
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

const g = vc.gateThreshold();
t('setup: the default gate opens well under micFloor (the case the bot named)', g < vc.micFloor() * 0.7, `${g} vs ${vc.micFloor()}`);
level = (g + vc.micFloor()) / 2;   // opens the gate, under the old linear marker
await tryUntil('the bar goes live when the gate opens', () => GOLD.test(lvl.style.background));
t('a level that opens the gate reads live (gold)', GOLD.test(lvl.style.background), lvl.style.background);
t('...and its bar reaches past the marker', pct(lvl.style.width) > pct(thr.style.left), `${lvl.style.width} vs ${thr.style.left}`);
level = g * 0.5;   // under the gate
await pause('under the gate and past its 700ms hang', 1100);
t('a level under the gate is not live', !GOLD.test(lvl.style.background), lvl.style.background);
t('...and its bar stops short of the marker', pct(lvl.style.width) < pct(thr.style.left), `${lvl.style.width} vs ${thr.style.left}`);

console.log(`\n${ok} ok, ${bad} failed`);
process.exit(bad ? 1 : 0);
