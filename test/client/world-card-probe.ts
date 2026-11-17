// world-card-probe — Create ▸ Environment and the Hierarchy's environment rows open the world's card for that component
// (333-cm bug a5); the Hierarchy's row also scrolls its header into view (a5 below), Create ▸ Environment does not.
// A real browser against an owned world.
//
//   BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun test/client/world-card-probe.ts
//
// Mutations (must go red): in client/lib/edit/panels.js fold key `sky` instead of `c:sky` in openWorldCard or in the
// 'wsel' case; or scroll by the old `[data-group=…]` selector.
import { scratchBench, mkCheck } from '../harness/harness.ts';
import { tryUntil } from '../gate/wait.ts';

const { cdp, evalJson, cleanup, die, BASE } = await scratchBench('world-card', { worlds: ['wcard'], owner: 'editbot', serverEnv: { TRUST_NAMES: '1' } });
const { check, tally } = mkCheck();
const becomes = async (expr: string, ms = 8000) => !!(await tryUntil(expr.slice(0, 80), () => evalJson(expr), { ms, step: 100 }));
const E = `import('/lib/edit/panels.js')`;
const skyOpen = () => evalJson(`${E}.then((m) => m.editPanelsDebug().inspFields().find((f) => f.t === 'group' && f.k === 'c:sky')?.open ?? null)`);
const shut = async () => { if (await skyOpen()) await evalJson(`${E}.then((m) => { m.editPanelsDebug().inspDo('fold', 'c:sky'); return true; })`); return (await skyOpen()) === false; };

try {
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: `window.__errs = []; addEventListener('error', (e) => __errs.push('error: ' + e.message));` });
  await cdp.send('Page.navigate', { url: `${BASE}/?name=editbot&world=wcard` });
  const count = async () => (await evalJson(`document.querySelectorAll('.sec').length`).catch(() => 0)) ?? 0;
  const secs = (await tryUntil('the client boots', async () => ((await count()) >= 4 ? count() : null), { ms: 60_000, step: 500 })) ?? (await count());
  check('client boots', secs >= 4, `${secs} sections`);
  if (secs < 4) await die(1, 'the client did not boot');
  // B until build mode shows (a press before the editor is wired does nothing; a second press after it would leave it)
  const inBuild = `[...document.querySelectorAll('.frame.edit')].some((f) => getComputedStyle(f).display !== 'none')`;
  check('build mode', !!(await tryUntil('build mode', async () => (await evalJson(inBuild)) || (await evalJson(`dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyB' })), false`)), { ms: 20_000, step: 1500 })));
  await evalJson(`${E}.then((m) => { m.editPanelsDebug().hierDo('wsel'); return true; })`);
  check('setup: the world is selected and its Sky card shows', await becomes(`${E}.then((m) => m.editPanelsDebug().worldSel === true)`) && (await skyOpen()) !== null, String(await skyOpen()));

  check('setup: the Sky card folded shut', await shut());
  await evalJson(`${E}.then((m) => { m.openWorldCard('sky'); return true; })`);
  check('a5 Create ▸ Environment ▸ Sky opens the folded Sky card', (await skyOpen()) === true, String(await skyOpen()));

  check('setup: the Sky card folded shut again', await shut());
  const HEADS = `[...document.querySelectorAll('[data-frame="inspector"] .sp-group')].map((b) => b.textContent)`;
  check('setup: the Inspector has painted the world\'s Sky card header', await becomes(`${HEADS}.some((t) => /^[▸▾]\\s*Sky/.test(t))`, 20_000), JSON.stringify(await evalJson(HEADS)));
  await evalJson(`window.__scrolled = []; const o = Element.prototype.scrollIntoView; Element.prototype.scrollIntoView = function (...a) { __scrolled.push(this.textContent); return o?.apply(this, a); }; true`);
  await evalJson(`${E}.then((m) => { m.editPanelsDebug().hierDo('wsel', 'env:sky'); return true; })`);
  check('a5 the Hierarchy Sky row opens the folded Sky card', (await skyOpen()) === true, String(await skyOpen()));
  check('a5 …and scrolls the Sky card header into view', await becomes(`window.__scrolled.some((t) => /^[▸▾]\\s*Sky/.test(t))`, 3000), JSON.stringify(await evalJson(`({ scrolled: window.__scrolled, build: ${inBuild}, heads: ${HEADS} })`)));
  check('no page errors', (await evalJson(`window.__errs`))?.length === 0, JSON.stringify(await evalJson(`window.__errs`)));
} finally {
  console.log(`\n${tally.passed} passed, ${tally.failed} failed`);
  await cleanup(tally.failed ? 1 : 0);
}
process.exit(tally.failed ? 1 : 0);
