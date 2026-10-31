// picture-probe — the ONE owned browser receipt for the `picture` component:
// a real sequencer, a real model, a real image off the library route.
//
//   bun tools/picture-probe.ts          (EIDOVERSE_DIR must point at the library)
//
// What must hold, in order (ported to the partless picture and the request path, #260 house I479: a picture is the
// thing's own quad now, shared/picture.js; writes go through net.sendRequest; the authority mints the console's id):
//   A. hanging a picture puts a quad on the thing carrying the image as its map;
//   B. `lit: "self"` draws it unlit (a basic material), base colour white;
//   C. taking it down removes the quad;
//   D. an https link this viewer hasn't allowed is never fetched: the empty plate stands, marked untrusted;
//   E. LATE JOIN — a fresh client that receives the comp before the GLB has landed still hangs it (the pending path).
// Plus a screenshot for the by-eye check the tests cannot make.
import { launchBrowser, ownedWorld, checker } from './probe-harness.mjs';
import { join } from 'node:path';
import * as OP from '../shared/protocol/requests.js';
import { qFromYaw } from '../shared/rot.js';

const LIB = 'eidoverse/assets/models/scif_cyberpunk_crt_retro_computer_monitor_screen_keyboard_tower.glb';
// Default image: the model's own library preview. PICTURE_SRC overrides (e.g.
// an orientation card in an OPT_DIR overlay) for the by-eye flip check.
const IMG = process.env.PICTURE_SRC ?? 'eidoverse/assets/models/scif_cyberpunk_crt_retro_computer_monitor_screen_keyboard_tower_preview.jpg';
const { check, done } = checker();
// founded, owned by the page's typed name (TRUST_NAMES), so its writes are admitted
const world = await ownedWorld({ worlds: ['picprobe'], owner: 'picprobe', env: { TRUST_NAMES: '1', EIDOVERSE_DIR: process.env.EIDOVERSE_DIR ?? join(process.env.HOME!, 'origin/eidoverse-video'), ...(process.env.OPT_DIR ? { OPT_DIR: process.env.OPT_DIR } : {}) } });
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
  await pg.waitForSelector('#micbtn, #mictoggle', { timeout: 30000 });   // the mic badge: #micbtn since the desktop UI (#185); #mictoggle before it
  return pg;
}
const req = async (pg: any, op: any) => {
  const r = await pg.evaluate((op: any) => import('/lib/net.js').then((n: any) => n.sendRequest(op.verb, op.args)), op);
  if (!r?.ok) throw new Error(`${op.verb} refused: ${JSON.stringify(r?.refused ?? r)}`);
  return r;
};
let ID = '';
const state = (pg: any) => pg.evaluate(async (id: string) => {
  const { entities } = await import('/lib/world.js');
  const { _hung, _blocked } = await import('/lib/pictures.js');
  const root = entities.get(id); const h = _hung.get(id);
  let mat: any = null; h?.quad?.traverse((o: any) => { if (o.isMesh && !mat) mat = o.material; });
  let quads = 0; root?.traverse((o: any) => { if (o.userData?.pictureQuad) quads++; });
  return {
    entity: !!root, hung: !!h, quads, mapW: mat?.map?.image?.width ?? 0, basic: mat?.type === 'MeshBasicMaterial',
    white: mat?.color ? mat.color.getHex() === 0xffffff : null, blocked: _blocked.get(id) ?? null,
  };
}, ID);
const until = async (pg: any, pred: (s: any) => boolean, ms = 20000) => { const t0 = Date.now(); let s; while (Date.now() - t0 < ms) { s = await state(pg); if (pred(s)) return s; await new Promise((r) => setTimeout(r, 200)); } return s; };
try {
  const pg = await joinAs('picprobe');
  const made = await req(pg, OP.create('$console', { model: LIB, transform: { pos: [1.3, 0.5, -2.2], q: qFromYaw(0.6) } }));
  ID = made.ids?.['$console'];
  if (!ID) throw new Error(`create named no id: ${JSON.stringify(made)}`);
  let s = await until(pg, (x) => x.entity);
  check('the console spawned', s.entity, JSON.stringify(s));
  await req(pg, OP.set(ID, 'picture', { src: IMG, description: "the console's own preview", lit: 'self' }));
  s = await until(pg, (x) => x.hung && x.mapW > 0);
  check('A. the picture hangs as one quad of its own', s.hung && s.quads === 1, JSON.stringify(s));
  check('A. …carrying the image as its map (decoded, non-zero width)', s.mapW > 0, JSON.stringify(s));
  check('B. self-lit: an unlit (basic) material, base colour white', s.basic && s.white === true, JSON.stringify(s));
  await new Promise((r) => setTimeout(r, 1500));
  if (process.env.PICTURE_SHOT) await pg.screenshot({ path: process.env.PICTURE_SHOT });
  // E. late join: a second client gets the comp on join, before the GLB lands
  const pg2 = await joinAs('latecomer');
  // The late joiner fetches the 40 MB model and the image together; on a
  // loaded host that takes longer than the 20 s default (the original
  // realizer missed it too, 2026-09-14). The property is order, not speed.
  const s2 = await until(pg2, (x) => x.hung && x.mapW > 0, 90_000);
  check('E. a late joiner hangs the picture (pending path)', s2.hung && s2.quads === 1 && s2.mapW > 0, JSON.stringify(s2));
  await pg2.close();
  // C. take it down
  await req(pg, OP.unset(ID, 'picture'));
  s = await until(pg, (x) => !x.hung);
  check('C. taking it down removes the quad', !s.hung && s.quads === 0, JSON.stringify(s));
  // D. an https link this viewer hasn't allowed: kept by the authority, never fetched here — the empty plate stands
  await req(pg, OP.set(ID, 'picture', { src: 'https://example.com/x.png', description: 'a link' }));
  s = await until(pg, (x) => x.hung);
  await new Promise((r) => setTimeout(r, 1500));
  s = await state(pg);
  check('D. an unallowed link is never fetched: the plate stands, marked untrusted', s.hung && s.quads === 1 && s.mapW === 0 && s.blocked === 'untrusted', JSON.stringify(s));
  check('no page errors across the cycle', errs.length === 0, errs.join(' | '));
} finally {
  await close(); await world.close();
}
done();
