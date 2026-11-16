// The sensitivity meter tells the truth about the gate (bot #333 130): the gate opens at gateThreshold()
// (dB-mapped, voiceconsent.js), so a level that opens it must read live and sit past the marker.
//
// Run: bun test/client/mic-meter-gate-test.mjs
import { fileURLToPath } from "node:url";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { mock } from "bun:test";
GlobalRegistrator.register({ url: "http://localhost/?world=t&name=p" });

const at = (p) => fileURLToPath(new URL(p, import.meta.url));
mock.module(at('../../client/lib/ui/ui.js'), () => ({
  flashHint: () => {},
  makeSection: (title, build, opts = {}) => { const el = document.createElement('div'); el.id = `sec-${opts.id}`; document.body.appendChild(el); build(el); return el; },
}));
mock.module(at('../../client/lib/audio/ttsrow.js'), () => ({ ttsSection: () => document.createElement('div') }));
mock.module(at('../../client/lib/net.js'), () => ({ say: () => {}, sendTyping: () => {}, sendRequest: async () => ({ ok: true }), net: {} }));

localStorage.clear();
const vc = await import('../../client/lib/audio/voiceconsent.js');
const { initAudioPanel } = await import('../../client/lib/audio/audiopanel.js');
let level = 0;
window.__sfuMyLevel = () => level;
window.relayDiag = () => ({ micPublished: true });
initAudioPanel();

let ok = 0, bad = 0;
const t = (n, cond, d = '') => { cond ? ok++ : bad++; console.log(`${cond ? 'ok  ' : 'FAIL'} ${n}${cond ? '' : `  — ${d}`}`); };
const lvl = document.querySelector('#sec-audio [data-lvl]');
const thr = document.querySelector('#sec-audio [data-thr]');
t('setup: the meter is mounted', !!lvl && !!thr);
const frames = () => new Promise((r) => setTimeout(r, 120));
const pct = (s) => parseFloat(/([\d.]+)%/.exec(s)?.[1] ?? 'NaN');
const GOLD = /255, 214, 107|#ffd66b/i;

const g = vc.gateThreshold();
t('setup: the default gate opens well under micFloor (the case the bot named)', g < vc.micFloor() * 0.7, `${g} vs ${vc.micFloor()}`);
level = (g + vc.micFloor()) / 2;   // opens the gate, under the old linear marker
await frames();
t('a level that opens the gate reads live (gold)', GOLD.test(lvl.style.background), lvl.style.background);
t('...and its bar reaches past the marker', pct(lvl.style.width) > pct(thr.style.left), `${lvl.style.width} vs ${thr.style.left}`);
level = g * 0.5;   // under the gate
await frames();
t('a level under the gate is not live', !GOLD.test(lvl.style.background), lvl.style.background);
t('...and its bar stops short of the marker', pct(lvl.style.width) < pct(thr.style.left), `${lvl.style.width} vs ${thr.style.left}`);

console.log(`\n${ok} ok, ${bad} failed`);
process.exit(bad ? 1 : 0);
