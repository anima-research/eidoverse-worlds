// colour-picker-bench — the Inspector's colour field is a picker made of solid cells (R 10-12: "shouldn't a color field
// be a color picker?"). The native <input type=color> it replaces opened nothing in a headset: the XR quads draw the DOM
// to a texture and fire synthetic clicks, which never open the browser's dialog. Cells are what a quad can draw and click.
// The widget's rows are test/client/colour-picker-test.ts (happy-dom); this is the page's wiring, end to end.
//
//   CHROME=… bun test/client/colour-picker-bench.ts        (EDIT_SHOT=/path.png saves the open picker)

import { scratchBench, mkCheck, sleep } from '../harness/harness.ts';
import { pagedEval } from '../harness/idalias.ts';
import { pageWaiter } from '../gate/wait.ts';

const { cdp, evalJson: evalRaw, cleanup, die, BASE } = await scratchBench('colourpick', { worlds: ['pickbench'], owner: 'pickbot', serverEnv: { TRUST_NAMES: '1', ACT_RATE: '1000' } });
// R 10-17: the page names its lamp with a placeholder (test/harness/idalias.ts pageIds); 'picklamp' in page code is its id
const evalJson = pagedEval(evalRaw, ['picklamp']);
const { check, tally } = mkCheck();
const waitFor = pageWaiter(evalJson, 6000);
const painted = () => evalJson(`new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true))))`);

await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: `window.__errs = []; addEventListener('error', (e) => __errs.push('error: ' + e.message)); const ce = console.error.bind(console); console.error = (...a) => { __errs.push('console: ' + a.map(String).join(' ')); ce(...a); };` });
await cdp.send('Page.navigate', { url: `${BASE}/?name=pickbot&world=pickbench` });
{
  let secs = 0;
  for (let i = 0; i < 120 && secs < 4; i++) { secs = (await evalJson(`document.querySelectorAll('.sec').length`)) ?? 0; if (secs < 4) await sleep(500); }
  check('client boots', secs >= 4, `${secs} sections`);
  await evalJson(`(() => { const s = document.querySelector('#splash'); if (s) s.style.pointerEvents = 'none'; return true; })()`);
}

const lamp = 'picklamp';
let made: any = null;
for (let i = 0; i < 40 && !made?.ok; i++) {
  made = await evalJson(`import('/lib/net.js').then((m) => m.sendRequest('create', { id: '${lamp}', components: { transform: { pos: [1, 1, 1] }, light: { color: 0xffd9a0, intensity: 16, range: 10 } } }))`);
  if (!made?.ok) await sleep(500);
}
const lampColour = `import('/lib/state.js').then((m) => m.state.st.entities['${lamp}']?.light?.color)`;
check('a light Empty folds', await waitFor(`${lampColour}.then((c) => c === 0xffd9a0)`), JSON.stringify(made));
await evalJson(`dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyB' })), true`);
await evalJson(`import('/lib/edit/selection.js').then((m) => (m.set(['${lamp}']), true))`);
const insp = `[...document.querySelectorAll('.frame.edit')].find((f) => /Inspector/.test(f.querySelector('.fr-title')?.textContent))`;
const row = `${insp}?.querySelector('.sp-f-color')`;
check('the Inspector shows the Light card\'s colour row', await waitFor(`!!${row}`, 8000));

// the picker's own rows (cells, hex, recents, open/close) are test/client/colour-picker-test.ts under happy-dom (G4-050);
// this keeps what only a page shows: the real Inspector reads the lamp's colour into the swatch, and a cell recolours the light
check('closed at first: a swatch in the lamp\'s colour', await evalJson(`getComputedStyle(${row}.querySelector('.sp-color-sw')).backgroundColor === 'rgb(255, 217, 160)'`),
  await evalJson(`getComputedStyle(${row}.querySelector('.sp-color-sw')).backgroundColor`));
await evalJson(`${row}.querySelector('.sp-color-sw').click(), true`);
const pick = await evalJson(`(() => { const c = ${row}.querySelectorAll('.sp-pick-grid .sp-pick-cell')[12 + 12 * 2 + 4]; c.click(); return +c.dataset.c; })()`);
check('a cell click in the Inspector recolours the light to that cell', await waitFor(`${lampColour}.then((c) => c === ${pick})`), String(pick));
if (process.env.EDIT_SHOT) {
  await evalJson(`${row}.scrollIntoView({ block: "center" }), true`);
  await painted();
  const shot = await cdp.send<any>('Page.captureScreenshot', { format: 'png' });
  await Bun.write(process.env.EDIT_SHOT, Buffer.from(shot.data, 'base64'));
  console.log(`  screenshot → ${process.env.EDIT_SHOT}`);
}
// headless Chrome has no working GPU: the sky's finish and WebGPU's error scopes complain on every boot, picker or not
const errs = ((await evalJson(`window.__errs ?? []`)) ?? []).filter((e: string) => !/popErrorScope|sky finish/.test(e));
check('no page errors (beyond headless GPU noise)', errs.length === 0, JSON.stringify(errs));

console.log(`\n${tally.passed} passed, ${tally.failed} failed`);
if (tally.failed) await die(1, 'colour-picker-bench: FAILED');
await cleanup();
process.exit(0);
