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

  // Click 'hear voices' — the cheapest toggle that emits on the bus and does
  // not need a real microphone.
  const boxes = [...body.querySelectorAll('input[type=checkbox]')];
  const hear = boxes[1] ?? boxes[0];
  hear.click();
  await new Promise((r) => setTimeout(r, 500));   // well past any repaint

  const after = rows();
  const kept = after.filter((el) => typeof el.__probeTag === 'string').length;
  const meterKept = body.querySelector('[data-lvl]')?.__probeTag === 'meter';

  return { before, after: after.length, kept, meterKept, checked: hear.checked };
});

const ok = r.kept === r.before && r.before === r.after && r.meterKept;
console.log(`rows before=${r.before} after=${r.after} survived=${r.kept} meter kept=${r.meterKept}`);
console.log(ok ? '✅ PER-ELEMENT UPDATE — nodes survived the click'
               : '❌ FULL TEARDOWN — the panel rebuilt itself (R\'s jumping)');
await b.close();
process.exit(ok ? 0 : 1);
