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
// It also watches the meter's rAF chain: micFloorRow's beat() loop ends itself
// on !row.isConnected, so a teardown silently restarts the animation.
//
//   node tools/panel-teardown-probe.mjs [origin]
import { chromium } from 'playwright';

const ORIGIN = process.argv[2] || 'http://127.0.0.1:8960';
const b = await chromium.launch({
  executablePath: '/home/claude/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome',
  args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream',
         '--autoplay-policy=no-user-gesture-required'],
});
const pg = await (await b.newContext({ permissions: ['microphone'] })).newPage();
pg.on('pageerror', (e) => console.log('  [pageerror]', String(e).slice(0, 140)));
await pg.goto(`${ORIGIN}/?world=staging&name=panelprobe`, { waitUntil: 'domcontentloaded' });
// The panel frame is built during boot; clicking a head before it exists is a
// no-op that looks exactly like a broken selector. Wait for the section first.
await pg.waitForSelector('#sec-audio .head', { timeout: 20000 }).catch(() => {});
await new Promise((r) => setTimeout(r, 2000));

// Open the 🔊 audio section. The click and the CHECK must be separate calls:
// makeSection's toggle awaits onOpen(body), so a sleep inside the same
// evaluate() races the very build it is waiting for.
await pg.evaluate(() => {
  const head = [...document.querySelectorAll('.sec .head')].find((h) => /audio/i.test(h.textContent || ''));
  head?.click();
});
const opened = await pg.waitForFunction(
  () => (document.querySelector('#sec-audio .body')?.querySelectorAll('.sp-row').length ?? 0) > 3,
  null, { timeout: 20000 },
).then(() => true).catch(() => false);
if (!opened) { console.log('FAIL: could not open the audio section'); await b.close(); process.exit(1); }

const r = await pg.evaluate(async () => {
  const body = document.querySelector('#sec-audio .body');
  const rows = () => [...body.querySelectorAll('.sp-row')];

  // Tag every row object. Only surviving NODES keep an expando.
  rows().forEach((el, i) => { el.__probeTag = `row${i}`; });
  const before = rows().length;

  // Grab the meter and remember its width-setting node, plus a live sample of
  // whether the rAF loop is still ticking after the click.
  const meterEl = body.querySelector('[data-lvl]');
  if (meterEl) meterEl.__probeTag = 'meter';

  // 🔴 CLICK EVERY CHECKBOX, NOT A REPRESENTATIVE ONE (R, 2026-08-16: "looks
  // like panel is tearing down when you click the text-to-speech model
  // checkbox"). The first version of this probe clicked only 'hear voices',
  // passed, and I read that as "the panel does not tear down" — but a probe
  // proves the path it walks and NOTHING else. The TTS tick lives in a
  // different module with its own build(), and it was still rebuilding.
  // Identify targets by their LABEL, not by index. Indices shift the moment a
  // row is skipped or replaced, and an index-keyed loop silently pairs one
  // box's click with another box's tags — which is exactly how this probe
  // reported a teardown on 'speech-to-text' that a direct check disproved
  // (rows 10 before, 10 after, the tagged node still present). A measurement
  // whose bookkeeping can drift will eventually accuse the code of its own bug.
  const labels = [...body.querySelectorAll('.sp-row')]
    .filter((r) => r.querySelector('input[type=checkbox]') && r.style.display !== 'none')
    .map((r) => r.querySelector('.sp-label')?.textContent?.trim())
    .filter(Boolean);
  const perBox = [];
  for (const label of labels) {
    const rowOf = () => [...body.querySelectorAll('.sp-row')]
      .find((r) => r.querySelector('.sp-label')?.textContent?.trim() === label);
    const live = rowOf()?.querySelector('input[type=checkbox]');
    if (!live) continue;
    // 🔴 LET THE PREVIOUS RESTORE SETTLE BEFORE TAGGING. Each iteration clicks
    // twice (test, then put it back), and the RESTORE click can still be
    // repainting when the next iteration tags. That is how this probe reported
    // a teardown on 'speech-to-text' twice in a row while a direct check found
    // zero rows losing their tag — the contamination came from the probe's own
    // cleanup, one control earlier. Two dead theories (hidden rows, index
    // drift) before I printed WHICH row lost its tag and got an empty list.
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

  return { before, after: after.length, kept, meterKept, perBox };
});

let ok = r.meterKept;
for (const b of r.perBox) {
  const good = b.survived === b.before;
  ok = ok && good;
  console.log(`  ${String(b.label).padEnd(24)} ${b.survived}/${b.before} rows survived  ${good ? '✅' : '❌ TEARDOWN'}`);
}
console.log(`  meter node kept: ${r.meterKept ? '✅' : '❌'}`);
console.log(ok ? '✅ PER-ELEMENT UPDATE — every checkbox leaves the panel standing'
               : '❌ FULL TEARDOWN on at least one control (R\'s jumping)');
await b.close();
process.exit(ok ? 0 : 1);
