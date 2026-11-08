// tools/credits-probe.mjs — E ▸ About links to the credits page; the page and its vendor links are served; no
// horizontal scroll at phone width. usage: bun tools/credits-probe.mjs [outdir]
import { launchBrowser, ownedWorld } from './probe-harness.mjs';
const out = process.argv[2] ?? '.';
let world = null, b = null, failed = 0;
const check = (n, v, d) => { if (!v) failed++; console.log(`${v ? 'ok  ' : 'FAIL'} ${n}${d !== undefined ? ` — ${JSON.stringify(d).slice(0, 300)}` : ''}`); };
try {
  world = await ownedWorld({ key: 'creditsprobe', env: { BUN_RUNTIME_TRANSPILER_CACHE_PATH: '0' } });
  for (const p of ['/credits.html', '/vendor/piper/LICENSE-GPL-3.0.txt', '/vendor/piper/NOTICE.md']) {
    const r = await fetch(world.origin + p); check(`served: ${p}`, r.status === 200, r.status); }
  b = await launchBrowser(); const pg = await b.page();
  for (const [w, h] of [[1200, 900], [390, 844]]) {
    await pg.setViewportSize({ width: w, height: h });
    await pg.goto(world.origin + '/credits.html', { waitUntil: 'load' });
    const m = await pg.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth, items: document.querySelectorAll('.item').length,
      dead: [...document.querySelectorAll('a[href]')].filter((a) => !a.getAttribute('href')).length }));
    check(`credits @${w}: no horizontal scroll, every item there`, m.sw <= m.cw && m.items >= 15 && !m.dead, m);
    await pg.screenshot({ path: `${out}/credits-${w}.png`, fullPage: false });
  }
  // the About flyout carries the link (the client's own menu code, in the page)
  await pg.setViewportSize({ width: 1280, height: 800 });
  await pg.goto(`${world.origin}/?world=creditsprobe&name=Ann&key=creditsprobe`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  // like a person: the E button (#hud), then the About row; the flyout (#emenu-sub) must hold the link
  let link = null;
  for (let i = 0; i < 120 && !link; i++) { await new Promise((r) => setTimeout(r, 500));
    link = await pg.evaluate(() => {
      const sp = document.getElementById('splash'); if (sp && !sp.classList.contains('gone')) return null;   // after boot, as a person sees it
      const sub = document.getElementById('emenu-sub'); const a = sub && !sub.hidden ? sub.querySelector('a[href="/credits.html"]') : null;
      if (a) return { text: a.textContent, target: a.target };
      const m = document.getElementById('emenu'); if (!m || m.hidden) document.getElementById('hud')?.click();
      else m.querySelector('.mrow[data-item="about"]')?.click();
      return null; }).catch(() => null); }
  if (link) await pg.screenshot({ path: `${out}/about-flyout.png` });
  check('About flyout links to /credits.html', !!link, link);
} catch (e) { failed++; console.log('FAIL probe —', String(e?.stack ?? e).slice(0, 500)); }
finally { try { await b?.close(); } catch {} try { await world?.close(); } catch {} }
process.exit(failed ? 1 : 0);
