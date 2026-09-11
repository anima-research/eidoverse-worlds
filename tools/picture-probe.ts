// picture-probe — the ONE owned browser receipt for the `picture` component:
// a real sequencer, a real model, a real image off the library route.
//
//   bun tools/picture-probe.ts          (EIDOVERSE_DIR must point at the library)
//
// What must hold, in order:
//   A. hanging a picture textures the NAMED PART's material — a clone, not
//      the model's own material (the same material serves every instance);
//   B. `lit: "self"` drives emissive from the image; the base colour is white;
//   C. taking it down restores the original material object;
//   D. a URL source hangs nothing (allow-list, product path);
//   E. LATE JOIN — a fresh client that receives the comp before the GLB has
//      landed still hangs it once the part exists (the pending path).
// Plus a screenshot for the by-eye check the tests cannot make.
import { launchBrowser, ownedWorld, checker } from './probe-harness.mjs';
import { join } from 'node:path';

const LIB = 'eidoverse/assets/models/scif_cyberpunk_crt_retro_computer_monitor_screen_keyboard_tower.glb';
// Default image: the model's own library preview. PICTURE_SRC overrides (e.g.
// an orientation card in an OPT_DIR overlay) for the by-eye flip check.
const IMG = process.env.PICTURE_SRC ?? 'eidoverse/assets/models/scif_cyberpunk_crt_retro_computer_monitor_screen_keyboard_tower_preview.jpg';
const { check, done } = checker();
const world = await ownedWorld({ env: { EIDOVERSE_DIR: process.env.EIDOVERSE_DIR ?? join(process.env.HOME!, 'origin/eidoverse-video'), ...(process.env.OPT_DIR ? { OPT_DIR: process.env.OPT_DIR } : {}) } });
const { page, close } = await launchBrowser();
const errs: string[] = [];
async function joinAs(name: string) {
  const pg = await page();
  pg.on('pageerror', (e) => errs.push(e.message));
  pg.on('console', (m) => { const t = m.text(); if (/\[pictures\]/.test(t)) console.log('   console:', t.slice(0, 160)); });
  pg.on('dialog', (d) => d.dismiss().catch(() => {}));
  await pg.goto(`${world.origin}/?world=picprobe&key=${world.key}&name=${name}`, { waitUntil: 'domcontentloaded' });
  await pg.fill('#d-name', name).catch(() => {});
  await pg.click('#d-go').catch(() => {});
  await pg.waitForSelector('#mictoggle', { timeout: 30000 });
  return pg;
}
const state = (pg: any) => pg.evaluate(async () => {
  const { entities, findPart } = await import('/lib/world.js');
  const { _hung } = await import('/lib/pictures.js');
  const root = entities.get('console'); const part = root ? findPart(root, 'screenplane') : null;
  const h = _hung.get('console');
  const mat: any = part?.material;
  return {
    entity: !!root, part: !!part, hung: !!h,
    cloned: !!(h && part && mat === h.material && mat !== h.original),
    mapW: mat?.map?.image?.width ?? 0, emissiveMap: !!mat?.emissiveMap, white: mat?.color ? mat.color.getHex() === 0xffffff : null,
    restored: !!(part && !h && !mat?.map) ,
  };
});
const until = async (pg: any, pred: (s: any) => boolean, ms = 20000) => { const t0 = Date.now(); let s; while (Date.now() - t0 < ms) { s = await state(pg); if (pred(s)) return s; await new Promise((r) => setTimeout(r, 200)); } return s; };
try {
  const pg = await joinAs('picprobe');
  await pg.evaluate((lib) => import('/lib/net.js').then((n: any) => n.sendVerb('spawn', { id: 'console', lib, pos: [1.3, 0.5, -2.2], yaw: 0.6 })), LIB);
  let s = await until(pg, (x) => x.part);
  check('the model spawned and has a part named screenplane', s.part, JSON.stringify(s));
  const original = await pg.evaluate(async () => { const { entities, findPart } = await import('/lib/world.js'); const p = findPart(entities.get('console'), 'screenplane'); (window as any).__origMat = p.material; return p.material.uuid; });
  await pg.evaluate((src) => import('/lib/net.js').then((n: any) => n.sendVerb('comp', { id: 'console', type: 'picture', data: { src, part: 'screenplane', look: "the console's own preview, hung on its screen", lit: 'self' } })), IMG);
  s = await until(pg, (x) => x.hung && x.mapW > 0);
  check('A. the picture hangs on the named part as a CLONED material', s.hung && s.cloned, JSON.stringify(s));
  check('A. …carrying the image as its map (decoded, non-zero width)', s.mapW > 0, JSON.stringify(s));
  check('B. self-lit: emissive map is the image, base colour white', s.emissiveMap && s.white === true, JSON.stringify(s));
  await new Promise((r) => setTimeout(r, 1500));
  if (process.env.PICTURE_SHOT) await pg.screenshot({ path: process.env.PICTURE_SHOT });
  // E. late join: a second client gets the comp on join, before the GLB lands
  const pg2 = await joinAs('latecomer');
  const s2 = await until(pg2, (x) => x.hung && x.mapW > 0);
  check('E. a late joiner hangs the picture once the part exists (pending path)', s2.hung && s2.cloned && s2.mapW > 0, JSON.stringify(s2));
  await pg2.close();
  // C. take it down
  await pg.evaluate(() => import('/lib/net.js').then((n: any) => n.sendVerb('comp', { id: 'console', type: 'picture', data: null })));
  s = await until(pg, (x) => !x.hung);
  const sameObj = await pg.evaluate(async () => { const { entities, findPart } = await import('/lib/world.js'); return findPart(entities.get('console'), 'screenplane').material === (window as any).__origMat; });
  check('C. taking it down restores the model\'s own material object', !s.hung && sameObj && s.restored, JSON.stringify(s));
  // D. a URL source: refused at the meaning layer, nothing hung, material untouched
  await pg.evaluate(() => import('/lib/net.js').then((n: any) => n.sendVerb('comp', { id: 'console', type: 'picture', data: { src: 'https://example.com/x.png', part: 'screenplane', look: 'smuggled' } })));
  await new Promise((r) => setTimeout(r, 1500));
  s = await state(pg);
  const stillOrig = await pg.evaluate(async () => { const { entities, findPart } = await import('/lib/world.js'); return findPart(entities.get('console'), 'screenplane').material === (window as any).__origMat; });
  check('D. a URL source hangs nothing and leaves the material alone', !s.hung && stillOrig, JSON.stringify(s));
  check('no page errors across the cycle', errs.length === 0, errs.join(' | '));
} finally {
  await close(); await world.close();
}
done();
