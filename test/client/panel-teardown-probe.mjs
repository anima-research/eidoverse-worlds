// panel-teardown-probe — the audio panel must UPDATE, not rebuild.
//
// R, 2026-08-16: "it looks like you're doing a full-panel teardown because I
// can see elements in the panel jumping around on the tick after a click. You
// need to make that tear-down per element and not the whole panel."
//
// The claim under test is about NODE IDENTITY, which is the only thing that
// distinguishes an update from a rebuild: after a click, are the row elements
// the SAME objects? A screenshot cannot answer that (both look identical once
// settled), and neither can a syntax check — so this probe tags every row,
// clicks, and looks for its own tags afterwards. A rebuilt panel loses them.
//
// It also checks the meter NODE survives: micFloorRow's beat() loop ends itself
// on !row.isConnected, so a teardown silently restarts the animation. After the
// clicks the loop itself must still ask for frames (a stopped loop on a kept node fails).
//
//   bun test/client/panel-teardown-probe.mjs [origin]
import { launchBrowser, ownedWorld } from '../harness/probe-harness.mjs';

const world = await ownedWorld({ live: process.argv[2] || null });
const ORIGIN = world.origin;
const { page, close } = await launchBrowser({ mic: true });
const shut = async () => { await close(); await world.close(); };
const pg = await page();
pg.on('pageerror', (e) => console.log('  [pageerror]', String(e).slice(0, 140)));
await pg.goto(`${ORIGIN}/?world=staging&key=${world.key}&name=panelprobe`, { waitUntil: 'domcontentloaded' });
// The panel frame is built during boot; clicking a head before it exists is a
// no-op that looks exactly like a broken selector. Wait for the section first.
await pg.waitForSelector('#sec-audio-tab', { timeout: 20000 }).catch(() => {});
await new Promise((r) => setTimeout(r, 2000));

// Open the 🔊 audio section. The click and the CHECK must be separate calls:
// makeSection's toggle awaits onOpen(body), so a sleep inside the same
// evaluate() races the very build it is waiting for.
await pg.evaluate(() => {
  const head = [...document.querySelectorAll('.sec-tabs .pf-tab')].find((h) => /audio/i.test(h.textContent || ''));
  head?.click();
});
// the audiopanel's settings rows are .sp-row.row with .nm labels; gate on checkbox rows existing (the panel's own
// controls, so a lone-resident owned world renders them all)
const opened = await pg.waitForFunction(
  () => [...(document.querySelector('#sec-audio .body')?.querySelectorAll('.row') ?? [])]
    .filter((r) => r.querySelector('input[type=checkbox]')).length >= 2,
  null, { timeout: 20000 },
).then(() => true).catch(() => false);
if (!opened) { console.log('FAIL: could not open the audio section'); await shut(); process.exit(1); }

const r = await pg.evaluate(async () => {
  const body = document.querySelector('#sec-audio .body');
  const rows = () => [...body.querySelectorAll('.row')];

  // Tag every row object. Only surviving NODES keep an expando.
  rows().forEach((el, i) => { el.__probeTag = `row${i}`; });
  const before = rows().length;

  // Grab the meter and remember its width-setting node, plus a live sample of
  // whether the rAF loop is still ticking after the click.
  const meterEl = body.querySelector('[data-lvl]');
  if (meterEl) meterEl.__probeTag = 'meter';
  // …and count the meter's own rAF loop (audiopanel.js beat): a kept node whose loop stopped is a dead meter
  const raf0 = window.requestAnimationFrame; let beats = 0;
  window.requestAnimationFrame = (f) => { if (f?.name === 'beat') beats++; return raf0.call(window, f); };

  // Click EVERY checkbox, not a representative one: a row can live in another
  // module with its own build() (the TTS tick does). Targets are found by
  // LABEL, not index: an index shifts when a row is skipped or replaced, and
  // would pair one box's click with another box's tags.
  const labels = [...body.querySelectorAll('.row')]
    .filter((r) => r.querySelector('input[type=checkbox]') && r.style.display !== 'none')
    .map((r) => r.querySelector('.nm')?.textContent?.trim())
    .filter(Boolean);
  const perBox = [];
  for (const label of labels) {
    const rowOf = () => [...body.querySelectorAll('.row')]
      .find((r) => r.querySelector('.nm')?.textContent?.trim() === label);
    const live = rowOf()?.querySelector('input[type=checkbox]');
    if (!live) continue;
    // Let the previous restore settle before tagging: each iteration clicks
    // twice (test, then put it back), and a restore still repainting when the
    // next iteration tags reads as that control's teardown.
    await new Promise((r) => setTimeout(r, 250));
    rows().forEach((el, n) => { el.__probeTag = `row${n}`; });
    const n0 = rows().length;
    live.click();
    await new Promise((r) => setTimeout(r, 500));
    const survived = rows().filter((el) => typeof el.__probeTag === 'string').length;
    perBox.push({ label, before: n0, survived, after: rows().length });
    live.click();                                   // put it back
    await new Promise((r) => setTimeout(r, 400));
  }

  const after = rows();
  const kept = after.filter((el) => typeof el.__probeTag === 'string').length;
  const meterKept = body.querySelector('[data-lvl]')?.__probeTag === 'meter';
  const b0 = beats;   // ten frames: the loop asks for every one
  for (let i = 0; i < 10 && beats <= b0; i++) await new Promise((f) => raf0.call(window, () => f()));
  const meterTicking = beats > b0; window.requestAnimationFrame = raf0;

  return { before, after: after.length, kept, meterKept, meterTicking, perBox };
});

let ok = r.meterKept && r.meterTicking;
for (const b of r.perBox) {
  const good = b.survived === b.before;
  ok = ok && good;
  console.log(`  ${String(b.label).padEnd(24)} ${b.survived}/${b.before} rows survived  ${good ? '✅' : '❌ TEARDOWN'}`);
}
console.log(`  meter node kept: ${r.meterKept ? '✅' : '❌'}; its loop still ticking: ${r.meterTicking ? '✅' : '❌'}`);
console.log(ok ? '✅ PER-ELEMENT UPDATE — every checkbox leaves the panel standing'
               : '❌ FULL TEARDOWN on at least one control (R\'s jumping), or the meter stopped');
await shut();
process.exit(ok ? 0 : 1);
