// comps-parity-test — the Hierarchy row and the Inspector read ONE record (C7c: the S1-1 two-cache frame).
//
//   SKIP_OPT_SWEEP=1 BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun tools/comps-parity-test.ts
//
// A real browser against an owned world. The owner makes a crate, selects it, then renames it (`set label`). At the
// very state-change event that folds the rename — synchronously, inside the subscriber, before any paint — the label the
// Hierarchy row reads (editPanelsDebug().hierFields() tree rows → crate.rename) must equal the label the Inspector reads
// (inspFields() path flags.label). Before C7c the row read world.js's `comps` Map (synced by the realizer) and the Inspector
// read the fold: two caches, updated at different moments (that Map is gone: world.js bagOf is the one record). Mutation that
// MUST go red: give the row a cache beside the fold — in editpanels.js hierarchyFields, `const lab = bagOf(r.id)?.label;` →
// `const lab = ((globalThis.__lab ??= {})[r.id] ??= bagOf(r.id)?.label);` — the row then reads the old label while the
// Inspector reads the new (verified red 2026-11-02).
// Hygiene (memory reference_browser_probe_hygiene.md): wait on conditions, every gate prints its stage, teardown in finally.
import { scratchBench, mkCheck } from './harness.ts';
import { tryUntil } from './protocol/wait.ts';
import { pagedEval } from './protocol/idalias.ts';

const { cdp, evalJson: evalRaw, cleanup, die, BASE } = await scratchBench('comps-parity', { worlds: ['parity'], owner: 'editbot', serverEnv: { TRUST_NAMES: '1', ACT_RATE: '1000' } });
// R 10-17: the page names its crate with a placeholder (tools/protocol/idalias.ts pageIds); 'crate' in page code is its id
const evalJson = pagedEval(evalRaw, ['crate']);
const { check, tally } = mkCheck();
const becomes = async (expr: string, ms = 8000) => !!(await tryUntil(expr.slice(0, 80), () => evalJson(expr), { ms, step: 100 }));

try {
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: `window.__errs = []; addEventListener('error', (e) => __errs.push('error: ' + e.message)); addEventListener('unhandledrejection', (e) => __errs.push('rejection: ' + (e.reason?.message ?? e.reason)));` });
  await cdp.send('Page.navigate', { url: `${BASE}/?name=editbot&world=parity` });
  const count = async () => (await evalJson(`document.querySelectorAll('.sec').length`).catch(() => 0)) ?? 0;
  const secs = (await tryUntil('the client boots', async () => ((await count()) >= 4 ? count() : null), { ms: 60_000, step: 500 })) ?? (await count());
  check('client boots', secs >= 4, `${secs} sections`);
  if (secs < 4) {   // what the page was doing when it didn't boot (Weft's #322 read: a red should carry its own evidence)
    const page = await evalJson(`import('/lib/net.js').then(() => 'imported', (e) => 'failed: ' + e.message).then((net) => ({ href: location.href, ready: document.readyState, net, errs: (window.__errs ?? []).slice(0, 10), body: document.body?.innerText?.slice(0, 300) ?? null }))`).catch((e) => ({ evalFailed: String(e) }));
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' }).catch(() => null);
    if (shot?.data) { const f = `${process.env.RUNNER_TEMP ?? '/tmp'}/comps-parity-boot.png`; await Bun.write(f, Buffer.from(shot.data, 'base64')); console.log(`  screenshot: ${f}`); }
    await die(1, `the client did not boot: ${JSON.stringify(page)}`);
  }
  check('the fold is live and frozen (a dev host)', await becomes(`import('/lib/net.js').then((m) => m.replica.active && m.replica.frozen === true)`));
  await evalJson(`dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyB' })), true`);
  check('build mode', await becomes(`[...document.querySelectorAll('.frame.edit')].some((f) => getComputedStyle(f).display !== 'none')`));

  const made = await evalJson(`import('/lib/net.js').then((m) => m.sendRequest('create', { id: 'crate', components: { transform: { pos: [1, 0, 2], q: [0, 0, 0, 1], scale: [1, 1, 1] }, label: 'crate' } }))`);
  check('the owner makes a crate (an Empty: no asset to download)', made?.ok === true, JSON.stringify(made?.refused));
  check('…it is realized', await becomes(`import('/lib/world.js').then((m) => !!m.entities.get('crate'))`));
  await evalJson(`import('/lib/scenegraph.js').then((m) => m.sceneSelect('crate')), true`);
  check('…and selected', await becomes(`import('/lib/editpanels.js').then((m) => m.editPanelsDebug().selected === 'crate')`));

  // the probe: at the change event, read both surfaces' label synchronously
  await evalJson(`Promise.all([import('/lib/state.js'), import('/lib/editpanels.js')]).then(([S, E]) => { window.__seen = []; S.onWorldChange((ev) => { if (ev.type !== 'change' || ev.id !== 'crate' || ev.comp !== 'label') return; const d = E.editPanelsDebug(); const row = d.hierFields().flatMap((f) => f.rows ?? []).find((r) => r.id === 'crate'); const insp = d.inspFields().find((f) => f.path === 'flags.label'); window.__seen.push({ row: row?.rename ?? null, insp: insp?.value ?? null }); }); return true; })`);
  const set = await evalJson(`import('/lib/net.js').then((m) => m.sendRequest('set', { id: 'crate', component: 'label', value: 'tall crate' }))`);
  check('the owner renames it', set?.ok === true, JSON.stringify(set?.refused));
  check('the rename folds', await becomes(`import('/lib/net.js').then((m) => m.replica.st.entities['crate']?.c.label === 'tall crate')`));
  check('the change event fired for crate.label', await becomes(`window.__seen.length >= 1`), JSON.stringify(await evalJson(`window.__seen`)));
  const seen = await evalJson(`window.__seen`);
  check('AT THE EVENT the Hierarchy row and the Inspector read the same label (one record, not two caches)', Array.isArray(seen) && seen.length >= 1 && seen.every((s: any) => s.row === 'tall crate' && s.insp === 'tall crate'), JSON.stringify(seen));
  check('no page errors', (await evalJson(`window.__errs`))?.length === 0, JSON.stringify(await evalJson(`window.__errs`)));
} finally {
  console.log(`\n${tally.passed} passed, ${tally.failed} failed`);
  await cleanup(tally.failed ? 1 : 0);
}
process.exit(tally.failed ? 1 : 0);
