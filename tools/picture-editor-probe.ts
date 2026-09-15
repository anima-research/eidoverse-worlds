// picture-editor-probe — the owned browser receipt for how a HUMAN hangs a
// picture: the scene panel's semantic block (client/lib/pictures.js editor),
// with a real sequencer, a real model, and the image door.
//
//   bun tools/picture-editor-probe.ts     (EIDOVERSE_DIR must point at the library)
//
// What must hold, in order:
//   A. selecting a placed model shows the block with the model's NAMED PARTS
//      listed (screenplane among them) — no guessing the part name;
//   B. the upload button lands a PNG in the store and fills `src` with the
//      store path the door returned;
//   C. `hang` commits ONE comp with the normalized bag: the picture hangs on
//      the chosen part with the uploaded image as its map, look line kept;
//   D. a bad source is refused HERE, before any round-trip (no comp sent);
//   E. `take down` commits null: the material is restored.
import { launchBrowser, ownedWorld, checker } from './probe-harness.mjs';
import { join } from 'node:path';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

const LIB = 'eidoverse/assets/models/scif_cyberpunk_crt_retro_computer_monitor_screen_keyboard_tower.glb';
const { check, done } = checker();
const OPT = process.env.OPT_DIR ?? mkdtempSync(join(tmpdir(), 'picedit-opt-'));
const world = await ownedWorld({ env: { EIDOVERSE_DIR: process.env.EIDOVERSE_DIR ?? join(process.env.HOME!, 'origin/eidoverse-video'), OPT_DIR: OPT } });
const { page, close } = await launchBrowser();
const errs: string[] = [];
// a 2×2 PNG, red — small enough to be a header test, real enough to decode
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEUlEQVR42mP4z8DwH4QZYAwAR8oH+Rq28akAAAAASUVORK5CYII=', 'base64');
const pngFile = join(mkdtempSync(join(tmpdir(), 'picedit-')), 'red square.png');
writeFileSync(pngFile, PNG);

const state = (pg: any) => pg.evaluate(async () => {
  const { entities, findPart, comps } = await import('/lib/world.js');
  const { _hung } = await import('/lib/pictures.js');
  const root = entities.get('console'); const part = root ? findPart(root, 'screenplane') : null;
  const h = _hung.get('console');
  const mat: any = part?.material;
  const block = document.querySelector('[data-pe-root]');
  const opts = block ? [...block.querySelectorAll('[data-pe="part"] option')].map((o: any) => o.value) : null;
  return {
    entity: !!root, part: !!part, hung: !!h, mapW: mat?.map?.image?.width ?? 0,
    cloned: !!(h && part && mat === h.material && mat !== h.original),
    block: !!block, parts: opts, src: (block?.querySelector('[data-pe="src"]') as any)?.value ?? null,
    msg: block?.querySelector('[data-pe="msg"]')?.textContent ?? null,
    comp: comps.get('console')?.picture ?? null,
  };
});
const until = async (pg: any, pred: (s: any) => boolean, ms = 30000) => { const t0 = Date.now(); let s; while (Date.now() - t0 < ms) { s = await state(pg); if (pred(s)) return s; await new Promise((r) => setTimeout(r, 200)); } return s; };

try {
  const pg = await page();
  pg.on('pageerror', (e) => { errs.push(e.message); console.log('   pageerror:', e.message.slice(0, 300)); });
  pg.on('console', (m) => { const t = m.text(); if (m.type() === 'error' || /\[pictures\]|editor/.test(t)) console.log(`   console.${m.type()}:`, t.slice(0, 300)); });
  pg.on('dialog', (d) => d.dismiss().catch(() => {}));
  await pg.goto(`${world.origin}/?world=piceditprobe&key=${world.key}&name=editor`, { waitUntil: 'domcontentloaded' });
  await pg.fill('#d-name', 'editor').catch(() => {});
  await pg.click('#d-go').catch(() => {});
  await pg.waitForSelector('#micbtn, #mictoggle', { timeout: 30000 });   // the mic badge: #micbtn since the desktop UI (#185); #mictoggle before it
  await pg.evaluate((lib) => import('/lib/net.js').then((n: any) => n.sendVerb('spawn', { id: 'console', lib, pos: [1.3, 0.5, -2.2], yaw: 0.6 })), LIB);
  let s = await until(pg, (x) => x.part, 90_000);
  check('the model spawned and has a part named screenplane', s.part, JSON.stringify(s));

  // A. select it in the scene panel — the block lists the model's parts
  await pg.evaluate(() => import('/lib/scenegraph.js').then((m: any) => m.sceneSelect('console')));
  s = await until(pg, (x) => x.block);
  check('A. the picture block appears for the selected model', s.block, JSON.stringify(s));
  check('A. …listing its named parts, screenplane among them', Array.isArray(s.parts) && s.parts.includes('screenplane') && s.parts.length > 1, JSON.stringify(s.parts));

  // B. the upload door fills src with the store path
  await pg.setInputFiles('[data-pe="file"]', pngFile);
  s = await until(pg, (x) => typeof x.src === 'string' && x.src.startsWith('store/images/'));
  check('B. upload… lands the PNG in the store and fills src with its path', /^store\/images\/[a-f0-9]{16}\.png$/.test(s.src ?? ''), JSON.stringify({ src: s.src, msg: s.msg }));
  const uploaded = s.src;

  // C. hang: one comp, normalized, on the chosen part
  await pg.selectOption('[data-pe="part"]', 'screenplane');
  await pg.fill('[data-pe="look"]', 'a red square, hung by hand');
  await pg.selectOption('[data-pe="lit"]', 'self');
  await pg.click('[data-pe="hang"]');
  s = await until(pg, (x) => x.hung && x.mapW > 0);
  check('C. hang commits the comp — the picture hangs on screenplane with the uploaded image', s.hung && s.cloned && s.mapW === 2, JSON.stringify(s));
  check('C. …with the normalized bag in the fold (src, part, look, lit)', s.comp?.src === uploaded && s.comp?.part === 'screenplane' && s.comp?.look === 'a red square, hung by hand' && s.comp?.lit === 'self' && s.comp?.flip === false, JSON.stringify(s.comp));

  // D. a URL typed into src is refused in the block, and no comp goes out
  const seqBefore = await pg.evaluate(() => import('/lib/world.js').then((m: any) => JSON.stringify(m.comps.get('console')?.picture)));
  await pg.fill('[data-pe="src"]', 'https://example.com/trollface.png');
  await pg.click('[data-pe="hang"]');
  await new Promise((r) => setTimeout(r, 800));
  s = await state(pg);
  const seqAfter = await pg.evaluate(() => import('/lib/world.js').then((m: any) => JSON.stringify(m.comps.get('console')?.picture)));
  check('D. a URL source is refused in the block, naming the rule, and nothing was sent', /not an allowed picture source/.test(s.msg ?? '') && seqBefore === seqAfter && s.hung, JSON.stringify({ msg: s.msg, same: seqBefore === seqAfter }));

  // E. take down restores the material
  await pg.click('[data-pe="down"]');
  s = await until(pg, (x) => !x.hung);
  check('E. take down commits null — nothing hung, comp gone', !s.hung && s.comp == null, JSON.stringify(s));
  check('no page errors across the cycle', errs.length === 0, errs.join(' | '));
} catch (e: any) {
  console.log('probe aborted:', e?.message ?? e);
  if (errs.length) console.log('page errors:', errs.join(' | '));
  check('the probe ran to the end', false, e?.message ?? String(e));
} finally {
  await close(); await world.close();
}
done();
