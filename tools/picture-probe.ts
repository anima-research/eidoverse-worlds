// picture-probe — the ONE owned browser receipt for the `picture` component:
// a real sequencer, a real model, a real image off the library route.
//
//   bun tools/picture-probe.ts          (EIDOVERSE_DIR must point at the library)
//
// What must hold (ported to the partless picture and the request path, #260 house I479: a picture is the thing's own
// quad now, shared/picture.js; writes go through net.sendRequest; the authority mints the console's id). A–D read one
// page, E a second; the first page's rows are all read before the long late-join leg, since a headless context lost
// late in a run reloads the page (gpulost.js) and resets what the rows read:
//   A. hanging a picture puts a quad on the thing carrying the image as its map — set before the GLB lands, so the
//      comp reaches pictures.js before the spawn and the hang goes through `pending` (the live in-flight path);
//   B. `lit: "self"` draws it unlit (a basic material), base colour white;
//   C. taking it down removes the quad;
//   D. an https link this viewer hasn't allowed is never fetched: the empty plate stands, marked untrusted;
//   E. LATE JOIN — a fresh client whose comp rode the snapshot hangs it once the GLB lands (realize/models.js
//      emitCompBag: a snapshot comp is announced AFTER the spawn, so this is the other path, not `pending`).
// Plus a screenshot for the by-eye check the tests cannot make.
import { launchBrowser, ownedWorld, checker, waitJoined } from './probe-harness.mjs';
import { join } from 'node:path';
import * as OP from '../shared/requests.js';
import { qFromYaw } from '../shared/rot.js';

const LIB = 'eidoverse/assets/models/scif_cyberpunk_crt_retro_computer_monitor_screen_keyboard_tower.glb';
// Default image: the model's own library preview. PICTURE_SRC overrides (e.g.
// an orientation card in an OPT_DIR overlay) for the by-eye flip check.
const IMG = process.env.PICTURE_SRC ?? 'eidoverse/assets/models/scif_cyberpunk_crt_retro_computer_monitor_screen_keyboard_tower_preview.jpg';
const { check, done } = checker();
// founded, owned by the page's typed name (TRUST_NAMES), so its writes are admitted
const world = await ownedWorld({ worlds: ['picprobe'], owner: 'picprobe', env: { TRUST_NAMES: '1', EIDOVERSE_DIR: process.env.EIDOVERSE_DIR ?? join(process.env.HOME!, 'origin/eidoverse-video'), ...(process.env.OPT_DIR ? { OPT_DIR: process.env.OPT_DIR } : {}) } });
const { page, close } = await launchBrowser();
// the late joiner gets a browser of its own: a second engine page in one headless browser costs the first its WebGL
// context (CONTEXT_LOST_WEBGL, seen 11-03), and gpulost.js then reloads it mid-cycle
const late = await launchBrowser();
const errs: string[] = [];
async function joinAs(name: string, newPage = page) {
  const pg = await newPage();
  pg.on('pageerror', (e) => errs.push(e.message));
  pg.on('console', (m) => { const t = m.text(); if (/\[pictures\]/.test(t)) console.log('   console:', t.slice(0, 160)); });
  pg.on('dialog', (d) => d.dismiss().catch(() => {}));
  // the order the bus saw for a picture comp vs. the thing's spawn (A and E read it; base.js imports nothing, so an early import is safe)
  await pg.addInitScript(() => { (globalThis as any).__picOrder = []; import('/lib/base.js').then(({ bus }: any) => {
    bus.on('comp', ({ id, type }: any) => { if (type === 'picture') (globalThis as any).__picOrder.push(`comp:${id}`); });
    bus.on('entity', ({ id, kind }: any) => { if (kind === 'spawn') (globalThis as any).__picOrder.push(`spawn:${id}`); }); }); });
  await pg.goto(`${world.origin}/?world=picprobe&key=${world.key}&name=${name}`, { waitUntil: 'domcontentloaded' });
  await pg.fill('#d-name', name, { timeout: 5000 }).catch(() => {});   // the entry dialog, when it shows
  await pg.click('#d-go', { timeout: 5000 }).catch(() => {});
  const reloads = await waitJoined(pg);
  return Object.assign(pg, { reloads });
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
    order: ((globalThis as any).__picOrder ?? []).filter((e: string) => e.endsWith(`:${id}`)).map((e: string) => e.split(':')[0]),
  };
}, ID);
const until = async (pg: any, pred: (s: any) => boolean, ms = 20000) => { const t0 = Date.now(); let s; while (Date.now() - t0 < ms) { s = await state(pg); if (pred(s)) return s; await new Promise((r) => setTimeout(r, 200)); } return s; };
try {
  const pg = await joinAs('picprobe');
  const made = await req(pg, OP.create('$console', { model: LIB, transform: { pos: [1.3, 0.5, -2.2], q: qFromYaw(0.6) } }));
  ID = made.ids?.['$console'];
  if (!ID) throw new Error(`create named no id: ${JSON.stringify(made)}`);
  // the picture is set in the same breath as the create: the 40 MB GLB is still in flight, so the comp lands first
  await req(pg, OP.set(ID, 'picture', { src: IMG, description: "the console's own preview", lit: 'self' }));
  let s = await until(pg, (x) => x.entity, 90_000);
  check('the console spawned', s.entity, JSON.stringify(s));
  s = await until(pg, (x) => x.hung && x.mapW > 0);
  // the setup, asserted (bot #326): the comp reached the bus before the spawn, so the hang went through `pending`
  check('A. (setup) the comp landed before the GLB: the pending path was taken', s.order.indexOf('comp') >= 0 && s.order.indexOf('spawn') > s.order.indexOf('comp'), JSON.stringify(s.order));
  check('A. the picture hangs as one quad of its own', s.hung && s.quads === 1, JSON.stringify(s));
  check('A. …carrying the image as its map (decoded, non-zero width)', s.mapW > 0, JSON.stringify(s));
  check('B. self-lit: an unlit (basic) material, base colour white', s.basic && s.white === true, JSON.stringify(s));
  await new Promise((r) => setTimeout(r, 1500));
  if (process.env.PICTURE_SHOT) await pg.screenshot({ path: process.env.PICTURE_SHOT });
  // C. take it down
  await req(pg, OP.unset(ID, 'picture'));
  s = await until(pg, (x) => !x.hung);
  check('C. taking it down removes the quad', !s.hung && s.quads === 0, JSON.stringify(s));
  // D. an https link this viewer hasn't allowed: kept by the authority, never fetched here — the empty plate stands
  const fetched: string[] = [];   // the network, watched (bot #327): "never fetched" is a request count, not a texture width
  const onReq = (r: any) => { if (/example\.com/.test(r.url())) fetched.push(r.url()); };
  pg.on('request', onReq);
  await req(pg, OP.set(ID, 'picture', { src: 'https://example.com/x.png', description: 'a link' }));
  s = await until(pg, (x) => x.hung);
  await new Promise((r) => setTimeout(r, 1500));
  s = await state(pg);
  pg.off('request', onReq);
  check('D. an unallowed link is never fetched: the plate stands, marked untrusted', s.hung && s.quads === 1 && s.mapW === 0 && s.blocked === 'untrusted', JSON.stringify(s));
  check('D. …and the browser made no request to its host', fetched.length === 0, fetched.join(' '));
  // every row above read the first page: a reload (gpulost.js, after a lost headless context) would have reset what they read
  check('no page errors so far', errs.length === 0, errs.join(' | '));
  check('the first page never reloaded while its rows were read', pg.reloads.length === 0, pg.reloads.join(' | '));
  // E. late join: the picture back up, then a second client gets the comp on join, before the GLB lands
  await req(pg, OP.set(ID, 'picture', { src: IMG, description: "the console's own preview", lit: 'self' }));
  const pg2 = await joinAs('latecomer', late.page);
  // The late joiner fetches the 40 MB model and the image together; on a
  // loaded host that takes longer than the 20 s default (the original
  // realizer missed it too, 2026-09-14). The property is order, not speed.
  const s2 = await until(pg2, (x) => x.hung && x.mapW > 0, 90_000);
  // the setup, asserted (bot #326): the comp rode the snapshot, announced once and after the spawn (models.js emitCompBag)
  check('E. (setup) the late joiner\'s comp rode the snapshot: announced after the spawn', JSON.stringify(s2.order) === '["spawn","comp"]', JSON.stringify(s2.order));
  check('E. …and hangs the picture', s2.hung && s2.quads === 1 && s2.mapW > 0, JSON.stringify(s2));
  check('no page errors across the cycle', errs.length === 0, errs.join(' | '));
} finally {
  await close(); await late.close(); await world.close();
}
done();
