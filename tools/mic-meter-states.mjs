// mic-meter-states — the sensitivity bar must show THREE states, and latch.
//
// R, 2026-08-16: "when the mic sensitivity waveform is over the sensitivity
// threshold and goes live, can you turn it bright gold (same color as the HUD
// mic when it's live) and leave it gold until it goes off again".
//
// "leave it gold until it goes off again" is hysteresis, and hysteresis is the
// half a screenshot cannot show: a bar photographed mid-syllable looks correct
// whether or not it strobes. So this drives the level directly and samples the
// colour at each step, including the two that only a latch gets right —
// BELOW-after-ABOVE inside the release band (must stay gold) and below it
// (must drop).
//
//   node tools/mic-meter-states.mjs [origin]
import { chromium } from 'playwright';

const ORIGIN = process.argv[2] || 'http://127.0.0.1:8960';
const b = await chromium.launch({
  executablePath: '/home/claude/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome',
  args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream',
         '--autoplay-policy=no-user-gesture-required'],
});
const pg = await (await b.newContext({ permissions: ['microphone'] })).newPage();
await pg.goto(`${ORIGIN}/?world=staging&name=metercheck`, { waitUntil: 'domcontentloaded' });
await pg.waitForSelector('#sec-audio .head', { timeout: 20000 }).catch(() => {});
await new Promise((r) => setTimeout(r, 2000));
await pg.evaluate(() => {
  [...document.querySelectorAll('.sec .head')].find((h) => /audio/i.test(h.textContent || ''))?.click();
});
await pg.waitForFunction(() => !!document.querySelector('#sec-audio [data-lvl]'), null, { timeout: 20000 })
  .catch(() => {});

const r = await pg.evaluate(async () => {
  const lvl = document.querySelector('#sec-audio [data-lvl]');
  const thr = document.querySelector('#sec-audio [data-thr]');
  if (!lvl) return { error: 'no meter' };

  // Take over the level source and the mic state. __sfuMyLevel is what
  // micLevelNow() prefers, so installing it is the supported seam.
  let fake = 0;
  window.__sfuMyLevel = () => fake;
  window.relayDiag = () => ({ micPublished: true, active: true });

  const settle = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  const colour = () => getComputedStyle(lvl).backgroundColor;
  const at = async (v) => { fake = v; await settle(); await settle(); return colour(); };

  // 🔴 ASK THE MODULE, DO NOT PARSE THE CSS. The marker's left is written as
  // `calc(N% - 1px)`, so parseFloat returns garbage and the first run of this
  // probe read floor=0 — which makes `floor * 3` also 0 and the OVER case
  // unreachable. A test whose setup silently degrades to a no-op reports the
  // code as broken while proving nothing.
  const vc = await import('./lib/voiceconsent.js');
  let floor = vc.micFloor();
  if (!(floor > 0)) { vc.setMicFloor(0.02); floor = vc.micFloor(); }

  const out = {};
  out.floor = floor;
  out.muted = await (async () => { window.relayDiag = () => ({ micPublished: false }); fake = 0;
    document.querySelector('#sec-audio [data-lvl]'); await settle();
    // force a repaint through the bus the same way the app would
    const m = await import('./lib/core.js'); m.bus.emit('audio:mic', false); await settle();
    const c = colour(); window.relayDiag = () => ({ micPublished: true, active: true });
    m.bus.emit('audio:mic', true); await settle(); return c; })();
  out.under = await at(floor * 0.3);          // on, well under → warm/dim
  out.over = await at(floor * 3);             // on, over → GOLD
  out.latched = await at(floor * 0.9);        // dipped INSIDE the release band → still gold
  out.released = await at(floor * 0.2);       // properly quiet → drops
  out.marker = getComputedStyle(thr).backgroundColor;
  return out;
});

if (r.error) { console.log('FAIL:', r.error); await b.close(); process.exit(1); }

const GOLD = 'rgb(255, 214, 107)';
const rows = [
  ['mic muted     ', r.muted, (c) => c !== GOLD],
  ['on, under floor', r.under, (c) => c !== GOLD],
  ['on, OVER floor ', r.over, (c) => c === GOLD],
  ['dipped in band ', r.latched, (c) => c === GOLD],   // the hysteresis half
  ['quiet again    ', r.released, (c) => c !== GOLD],
];
let ok = true;
console.log(`floor = ${r.floor.toFixed(4)}`);
for (const [label, c, want] of rows) {
  const good = want(c);
  ok = ok && good;
  console.log(`  ${label}  ${c.padEnd(20)} ${good ? '✅' : '❌'}`);
}
const markerWhite = /255, 255, 255/.test(r.marker);
console.log(`  threshold marker  ${r.marker} ${markerWhite ? '✅ white' : '❌ not white'}`);
ok = ok && markerWhite;
console.log(ok ? '✅ THREE STATES + LATCH' : '❌ meter states wrong');
await b.close();
process.exit(ok ? 0 : 1);
