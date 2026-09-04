// panelbench — the world panel's sections actually PAINT, in a real browser.
//
//   bun tools/panelbench.ts
//
// The palette sections (build / avatar / ground / sky) and the debug panel
// lazy-build their DOM on first open, so a construction error there is
// invisible to every boot gate — paritybench and lightbench boot the client
// but never open a panel, which is how these surfaces went their whole lives
// eyeball-verified only. Born with the R4 split (build.js → palette/
// groundpanel/skypanel/seatedit + rows.js): the exact change that could
// silently break a paint is the one that finally bought it a gate.

import { scratchBench, mkCheck, sleep } from './harness.ts';

const { cdp, evalJson, cleanup, die, BASE } = await scratchBench('panelbench');
const { check, tally } = mkCheck();

// console/exception collector, installed before any document loads
await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
  source: `window.__errs = [];
    addEventListener('error', (e) => __errs.push('error: ' + e.message));
    const ce = console.error.bind(console);
    console.error = (...a) => { __errs.push('console: ' + a.map(String).join(' ')); ce(...a); };`,
});

await cdp.send('Page.navigate', { url: `${BASE}/?name=panelbot&world=panelbench` });

// boot: the palette registers its four sections during main.js init
{
  let secs = 0;
  for (let i = 0; i < 120 && secs < 4; i++) {
    secs = (await evalJson(`document.querySelectorAll('.sec').length`)) ?? 0;
    if (secs < 4) await sleep(500);
  }
  check('client boots and the palette registers its sections', secs >= 4, `${secs} sections`);
}

console.log('\nsections paint on open:');
for (const [id, probe, what] of [
  ['build', `!!document.querySelector('#sec-build .body input[type=search]') && document.querySelectorAll('#sec-build .body .card').length > 0`, 'search box + starter cards'],
  ['avatar', `document.querySelectorAll('#sec-avatar .body .card').length > 0`, 'roster cards'],
  ['ground', `document.querySelectorAll('#sec-ground .body select').length >= 4 && document.querySelectorAll('#sec-ground .body button').length >= 5`, '4 selects + the grow/mow/shape buttons'],
  ['sky', `document.querySelectorAll('#sec-sky .body input[type=range]').length >= 8 && document.querySelectorAll('#sec-sky .body select').length >= 6`, '8 sliders + 6 selects'],
] as const) {
  await evalJson(`document.querySelector('#sec-${id} .head')?.click(), true`);
  await sleep(id === 'avatar' || id === 'build' ? 900 : 400);   // fetches
  const ok = await evalJson(probe);
  check(`${id} section paints (${what})`, !!ok);
}

console.log('\nedit mode (the gesture core survives the split):');
{
  await evalJson(`dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyB' })), true`);
  await sleep(200);
  check('B enters edit mode', !!(await evalJson(`document.body.classList.contains('edit-mode')`)));
  await evalJson(`dispatchEvent(new KeyboardEvent('keydown', { code: 'Escape' })), true`);
  await sleep(200);
  check('Esc leaves it', !(await evalJson(`document.body.classList.contains('edit-mode')`)));
}

console.log('\nthe help overlay (def-fed prose):');
{
  const built = await evalJson(`(() => {
    const s = document.querySelector('#help .sheet');
    if (!s) return null;
    return {
      keys: s.querySelectorAll('dl.keys dt').length,
      sections: s.querySelectorAll('h2').length,
      reset: !!s.querySelector('#help-reset'),
    };
  })()`);
  check('help sheet builds from the def', !!built, JSON.stringify(built));
  check('...key table populated (≥15 rows)', (built?.keys ?? 0) >= 15, `${built?.keys}`);
  check('...prose sections + the code-side layout section', (built?.sections ?? 0) >= 6 && !!built?.reset,
    `${built?.sections} sections`);
}

console.log('\ndebug panel (rows.js builds every family):');
{
  await evalJson(`dispatchEvent(new KeyboardEvent('keydown', { code: 'F3' })), true`);
  await sleep(300);
  const counts = await evalJson(`(() => {
    const f = [...document.querySelectorAll('.frame')].find((x) => x.textContent.includes('collider volumes'));
    if (!f) return null;
    return {
      sliders: f.querySelectorAll('input[type=range]').length,
      checks: f.querySelectorAll('input[type=checkbox]').length,
      selects: f.querySelectorAll('select').length,
      buttons: f.querySelectorAll('button').length,
    };
  })()`);
  // 12 dials + blink 6 + hair 6 + limp 2 + wings 14 + joints ≥4 = 44+;
  // 2 view rows + 9 switches = 11 checkboxes; the joint picker select;
  // re-drop/pause/reset + per-family reset/copy pairs
  check('debug panel builds', !!counts, JSON.stringify(counts));
  check('...all slider families present (≥44)', (counts?.sliders ?? 0) >= 44, `${counts?.sliders}`);
  check('...switches + view toggles (≥11)', (counts?.checks ?? 0) >= 11, `${counts?.checks}`);
  check('...the joint picker', (counts?.selects ?? 0) >= 1);
  check('...the button rows (≥9)', (counts?.buttons ?? 0) >= 9, `${counts?.buttons}`);
}

{
  const errs: string[] = (await evalJson(`window.__errs`)) ?? [];
  // the boot chatter this world legitimately produces is not an error;
  // anything else that reached console.error is
  const real = errs.filter((e) => !/favicon|Autoplay|WebGPU.*warning/i.test(e));
  check('no console errors across the whole tour', real.length === 0, real.slice(0, 3).join(' | '));
}

console.log(`\n${tally.passed} passed, ${tally.failed} failed`);
if (tally.failed) await die(1, 'panelbench: FAILED');
await cleanup();
process.exit(0);
