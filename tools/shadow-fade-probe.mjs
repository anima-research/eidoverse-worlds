// shadow-fade-probe — a caster's dithered fade runs through the REAL depth pass without a shader error (the mask is
// a maskShadowNode on every lit material: materials.js FADE_MASK; lightrig stepFades drives mesh.userData.shadowFade).
// Real client; the witness is the console (a WGSL/pipeline error is console.error) plus rigDebug's caster amounts.
//   code/scripts/eido-probe.sh -C <worktree> tools/shadow-fade-probe.mjs
import { launchBrowser, ownedWorld, checker } from './probe-harness.mjs';
const { check, done } = checker();
const W = `fade-${Math.random().toString(36).slice(2, 7)}`;
const world = await ownedWorld({ worlds: [W], owner: 'seeder', env: { TRUST_NAMES: '1' } });   // the seeder owns W, so its creates are admitted
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// a few crates near the origin in a world of our own (staging is founded empty and owned; a stranger's spawn there is refused)
const ws = new WebSocket(world.origin.replace('http', 'ws') + '/ws');
await new Promise((r) => (ws.onopen = r));
ws.send(JSON.stringify({ type: 'join', world: W, id: 'seeder', token: world.key, replica: true }));
await sleep(800);
const replies = []; ws.onmessage = (m) => { const d = JSON.parse(String(m.data)); if (d.type === 'reply') replies.push(d.reply); };
for (let i = 0; i < 6; i++) ws.send(JSON.stringify({ type: 'request', id: `c${i}`, verb: 'create', args: { id: `crate${i}`, model: `eidoverse/assets/models/crate_large_${i % 2 ? 'red' : 'blue'}.glb`, components: { transform: { pos: [(i - 2.5) * 2.5, 0, -5 - (i % 3) * 2] } } } }));
await sleep(1500);
console.log('    seeded:', replies.filter((r) => r?.ok).length, 'of 6', replies.find((r) => !r?.ok) ? JSON.stringify(replies.find((r) => !r?.ok)).slice(0, 200) : '');
const { browser, page } = await launchBrowser(); const pg = await page();
const errs = []; pg.on('pageerror', (e) => errs.push(String(e)));
const shader = []; pg.on('console', (m) => { const t = m.text(); if (/^\[(jank|longtask|load)\]/.test(t)) return; if (m.type() === 'error' || /WGSL|shader|ShadowNode|maskShadow|compilation/i.test(t)) shader.push(`${m.type()}: ${t.slice(0, 240)}`); });
const poll = async (fn, ms, every = 250) => { const t0 = Date.now(); let v; while (Date.now() - t0 < ms) { v = await pg.evaluate(fn); if (v) return v; await pg.waitForTimeout(every); } return v; };
try {
  await pg.goto(`${world.origin}/`, { waitUntil: 'domcontentloaded' });
  await pg.evaluate(() => { localStorage.setItem('ew-cloud-quality', 'off'); localStorage.setItem('ew-shadows', 'on'); });
  await pg.goto(`${world.origin}/?world=${W}&name=shadowfade&key=${world.key}&lite=0&webgpu=1`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await pg.waitForFunction(() => globalThis.__ewEngineUp, null, { timeout: 120000 });
  await pg.evaluate(async () => { globalThis.__rig = await import('./lib/lightrig.js'); });
  const up = await poll(() => { const l = globalThis.__rig.rigDebug().casterList; return l.some((c) => c.casting && c.fade === 1) ? l.filter((c) => c.casting).length : 0; }, 90000);
  console.log('    casters faded in through the depth pass:', up, 'of', await pg.evaluate(() => globalThis.__rig.casterCount()), 'backend:', await pg.evaluate(async () => (await import('./lib/core.js')).backendName()));
  check('at least one caster faded IN to 1 (a fade ran through the real shadow pass)', up > 0, JSON.stringify(await pg.evaluate(() => globalThis.__rig.rigDebug().casterList.slice(0, 6))));
  const beforeErrs = shader.length;
  await pg.evaluate(() => globalThis.__rig.setCasterBudget(0));
  const mid = await poll(() => { const l = globalThis.__rig.rigDebug().casterList; const f = l.filter((c) => !c.casting && c.fade > 0 && c.fade < 1); return f.length ? f.slice(0, 3) : null; }, 3000, 40);
  check('shedding the budget to 0 fades OUT (amounts seen strictly between 0 and 1)', !!mid, JSON.stringify(mid));
  const out = await poll(() => globalThis.__rig.rigDebug().casterList.every((c) => !c.casting && c.fade === 0) && globalThis.__rig.fadingCount() === 0, 8000);
  check('…and every caster ends at 0, nothing left fading', out === true, JSON.stringify(await pg.evaluate(() => [globalThis.__rig.fadingCount(), globalThis.__rig.getCasterBudget(), globalThis.__rig.rigDebug().casterList])));
  await pg.evaluate(() => globalThis.__rig.setCasterBudget(globalThis.__rig.getCasterCeiling()));
  const back = await poll(() => globalThis.__rig.rigDebug().casterList.some((c) => c.casting && c.fade === 1), 20000);
  check('restoring the budget fades back in', back === true);
  await pg.waitForTimeout(1500);
  check('no shader / pipeline / console errors while casters faded', shader.length === beforeErrs, shader.slice(beforeErrs, beforeErrs + 3).join(' | '));
  check('no page errors', errs.length === 0, errs.slice(0, 3).join(' | '));
  if (shader.length) console.log('    pre-existing console errors at boot (emulator signatures):', shader.slice(0, 3).join(' | '));
} catch (e) { check('probe ran', false, e.message); }
finally { try { ws.close(); } catch {} try { await browser.close(); } catch {} try { await world.close(); } catch {} }
done();
