// picture-race-probe — async intent under HELD image loads (Mica, #186
// review, blocker 1). The bag in the fold is the authority; a load is a
// request to realize it, and the request routinely outlives its authority.
// Each leg holds the library fetch for the picture, changes the intent while
// the load is in flight, releases the fetch, and checks what is on the part.
//
//   bun tools/picture-race-probe.ts     (EIDOVERSE_DIR must point at the library)
//
//   A. remove under a held load — nothing installs after data:null (Mica's
//      exact sequence; on 6d3a107: {"hung":true,"count":1,"hasMap":true});
//   B. replace under a held load — older A finishing after newer B leaves B;
//   C. entity removed under a held load — nothing installs, no clone kept;
//   D. entity re-realized (remove + spawn) under a held load — the stale
//      load does not land on the new subtree;
//   E. world reset under a held load — nothing installs;
//   F. the unheld happy path still hangs (the gate refuses only STALE loads);
//   G. LOD demote + promote under a held load with the entity PRESENT — the
//      stale load is refused and the still-authored picture rehangs from
//      pending (Mica, round 2: {part:true, hung:false, mapSrc:null}).
//
// Ported to the request path (#260 house I397/I401): writes go through net.sendRequest with ops built by
// shared/protocol/requests.js; the authority mints ids, so the console's id is read from each create's reply. A picture
// has no part any more (shared/picture.js): it is the thing's own quad, so a hang is judged by that quad's texture,
// and a held load shows the empty plate (hung, no map) until it lands.
import { launchBrowser, ownedWorld, checker } from './probe-harness.mjs';
import { join } from 'node:path';
import * as OP from '../shared/protocol/requests.js';
import { qFromYaw } from '../shared/rot.js';

const LIB = 'eidoverse/assets/models/scif_cyberpunk_crt_retro_computer_monitor_screen_keyboard_tower.glb';
// ONE UNPRIMED IMAGE PER HELD LEG. The host caches library bytes for the
// session (assets.js primeFiles → denoFiles), so a second load of the same
// path never fetches — and a hold on a fetch that never happens holds
// nothing: the load completes before the intent changes and the leg proves
// nothing (found 2026-09-14 when a mutation stayed green). Every held leg
// takes a fresh preview from this pool and asserts the hold engaged.
const M = 'eidoverse/assets/models/';
const POOL = [
  'scif_cyberpunk_crt_retro_computer_monitor_screen_keyboard_tower_preview.jpg',
  'apocalyptic_destroyed_rubble_debris_concrete_rebar_chunk_preview.jpg',
  'apocalyptic_destroyed_rubble_debris_pile_building_collapse_preview.jpg',
  'apocalyptic_destroyed_rubble_debris_pile_ruins_preview.jpg',
  'apocalyptic_destroyed_rubble_debris_streetlight_lamp_light_street_preview.jpg',
  'apocalyptic_scifi_cyberpunk_destroyed_rubble_debris_pile_preview.jpg',
  'bagger_288_bucketwheel_excavator_mining_extraction_preview.jpg',
  'cactus_wren_bird_animated_desert_songbird_calling_hopping_walking_preview.jpg',
  'computer_servers_rack_with_fans_on_back_row_of_four_4_columns_preview.jpg',
].map((f) => M + f);
let poolIdx = 0;
const fresh = () => { if (poolIdx >= POOL.length) throw new Error('image pool exhausted'); return POOL[poolIdx++]; };
const { check, done } = checker();
// founded, owned by the page's typed name (TRUST_NAMES), so its writes are admitted
const world = await ownedWorld({ worlds: ['raceprobe'], owner: 'raceprobe', env: { TRUST_NAMES: '1', EIDOVERSE_DIR: process.env.EIDOVERSE_DIR ?? join(process.env.HOME!, 'origin/eidoverse-video') } });
const { page, close } = await launchBrowser();
const errs: string[] = [];

async function joinAs(name: string) {
  const pg = await page();
  pg.on('pageerror', (e) => errs.push(e.message));
  pg.on('dialog', (d) => d.dismiss().catch(() => {}));
  await pg.goto(`${world.origin}/?world=raceprobe&key=${world.key}&name=${name}`, { waitUntil: 'domcontentloaded' });
  await pg.fill('#d-name', name, { timeout: 5000 }).catch(() => {});   // the entry dialog, when it shows
  await pg.click('#d-go', { timeout: 5000 }).catch(() => {});
  await pg.waitForSelector('#micbtn', { state: 'attached', timeout: 30000 });   // hidden when not pinned
  return pg;
}
const req = async (pg: any, op: any) => {
  const r = await pg.evaluate((op: any) => import('/lib/net.js').then((n: any) => n.sendRequest(op.verb, op.args)), op);
  if (!r?.ok) throw new Error(`${op.verb} refused: ${JSON.stringify(r?.refused ?? r)}`);
  return r;
};
let ID = '';   // the console's id: minted by the authority on each spawn
const spawn = async (pg: any) => {
  const r = await req(pg, OP.create('$console', { model: LIB, transform: { pos: [1.3, 0.5, -2.2], q: qFromYaw(0.6) } }));
  ID = r.ids?.['$console'];
  if (!ID) throw new Error(`create named no id: ${JSON.stringify(r)}`);
};
const remove = (pg: any) => req(pg, OP.remove(ID));
const comp = (pg: any, src: string | null) => req(pg, src ? OP.set(ID, 'picture', { src, description: 'race', lit: 'self' }) : OP.unset(ID, 'picture'));
const state = (pg: any) => pg.evaluate(async (id: string) => {
  const { entities } = await import('/lib/world.js');
  const { _hung } = await import('/lib/pictures.js');
  const root = entities.get(id); const h = _hung.get(id);
  let mat: any = null; h?.quad?.traverse((o: any) => { if (o.isMesh && !mat) mat = o.material; });
  return { entity: !!root, hung: !!h, count: _hung.size, hasMap: !!mat?.map, mapSrc: h?.picture?.src ?? null, original: !!root && !h };
}, ID);
const until = async (pg: any, pred: (s: any) => boolean, ms = 20000) => { const t0 = Date.now(); let s; while (Date.now() - t0 < ms) { s = await state(pg); if (pred(s)) return s; await new Promise((r) => setTimeout(r, 150)); } return s; };
const settle = (ms = 1500) => new Promise((r) => setTimeout(r, ms));

/** Hold every library fetch for `src` until release() is called. */
async function hold(pg: any, src: string) {
  const file = src.split('/').pop()!;
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  let held = 0;
  await pg.route((u: URL) => u.pathname.includes('/library/') && u.pathname.endsWith(file), async (route: any) => { held++; await gate; await route.continue(); });
  return { release: async () => { release(); await pg.unroute((u: URL) => u.pathname.includes('/library/') && u.pathname.endsWith(file)); }, heldCount: () => held };
}

try {
  const pg = await joinAs('raceprobe');
  await spawn(pg);
  let s = await until(pg, (x) => x.entity);
  check('the console spawned', s.entity, JSON.stringify(s));

  // A. Mica's sequence: hold the fetch, author, remove, release.
  {
    const img = fresh();
    const h = await hold(pg, img);
    await comp(pg, img);
    await until(pg, () => h.heldCount() > 0, 10000);
    check('A. the hold engaged (a real fetch is in flight)', h.heldCount() > 0);
    await comp(pg, null);
    await settle(300);
    await h.release();
    await settle();
    s = await state(pg);
    check('A. a load released after data:null installs NOTHING', !s.hung && s.count === 0 && !s.hasMap && s.original, JSON.stringify(s));
  }
  // B. older A held, newer B lands first, A released after: B stays.
  {
    const imgA = fresh(), imgB = fresh();
    const h = await hold(pg, imgA);
    await comp(pg, imgA);
    await until(pg, () => h.heldCount() > 0, 10000);
    check('B. the hold engaged', h.heldCount() > 0);
    await comp(pg, imgB);
    s = await until(pg, (x) => x.hung && x.hasMap && x.mapSrc === imgB);
    check('B. the newer bag hangs while the older load is still held', s.hung && s.hasMap && s.mapSrc === imgB, JSON.stringify(s));
    await h.release();
    await settle();
    s = await state(pg);
    check('B. the older load, released late, does not overwrite the newer picture', s.hung && s.hasMap && s.mapSrc === imgB && s.count === 1, JSON.stringify(s));
    await comp(pg, null);
    await until(pg, (x) => !x.hung);
  }
  // C. entity removed under a held load.
  {
    const img = fresh();
    const h = await hold(pg, img);
    await comp(pg, img);
    await until(pg, () => h.heldCount() > 0, 10000);
    check('C. the hold engaged', h.heldCount() > 0);
    await remove(pg);
    await until(pg, (x) => !x.entity);
    await h.release();
    await settle();
    s = await state(pg);
    check('C. a load released after the entity left installs nothing and keeps no clone', !s.hung && s.count === 0 && !s.entity, JSON.stringify(s));
  }
  // D. remove + respawn (a new subtree) under a held load.
  {
    await spawn(pg);
    await until(pg, (x) => x.entity);
    const img = fresh();
    const h = await hold(pg, img);
    await comp(pg, img);
    await until(pg, () => h.heldCount() > 0, 10000);
    check('D. the hold engaged', h.heldCount() > 0);
    await remove(pg);
    await until(pg, (x) => !x.entity);
    await spawn(pg);
    await until(pg, (x) => x.entity);
    await h.release();
    await settle();
    s = await state(pg);
    check('D. the stale load does not land on the re-realized subtree', !s.hung && s.count === 0 && s.original, JSON.stringify(s));
  }
  // E. world reset under a held load.
  {
    const img = fresh();
    const h = await hold(pg, img);
    await comp(pg, img);
    await until(pg, () => h.heldCount() > 0, 10000);
    check('E. the hold engaged', h.heldCount() > 0);
    await pg.evaluate(() => import('/lib/base.js').then((b: any) => b.bus.emit('world-reset', {})));
    await settle(300);
    await h.release();
    await settle();
    s = await state(pg);
    check('E. a load released after a world reset installs nothing', !s.hung && s.count === 0, JSON.stringify(s));
  }
  // F. the gate refuses only STALE loads.
  {
    await spawn(pg);
    await until(pg, (x) => x.entity);
    const img = fresh();
    await comp(pg, img);
    s = await until(pg, (x) => x.hung && x.hasMap);
    check('F. an unheld load still hangs (the happy path is untouched)', s.hung && s.hasMap && s.mapSrc === img, JSON.stringify(s));
  }
  // G. the entity is present when the load starts; a demote/promote cycle
  //    happens while the fetch is held.
  {
    await comp(pg, null);
    await until(pg, (x) => !x.hung);
    const img = fresh();
    const h = await hold(pg, img);
    await comp(pg, img);
    await until(pg, () => h.heldCount() > 0, 10000);
    check('G. the hold engaged', h.heldCount() > 0);
    await pg.evaluate((id: string) => import('/lib/base.js').then((b: any) => { b.bus.emit('entity', { id, kind: 'demote' }); b.bus.emit('entity', { id, kind: 'spawn' }); }), ID);
    await settle(300);
    await h.release();
    s = await until(pg, (x) => x.hung && x.hasMap);
    check('G. demote+promote during a held load: the still-authored picture rehangs', s.hung && s.hasMap && s.mapSrc === img && s.count === 1, JSON.stringify(s));
  }
  check('no page errors across the cycle', errs.length === 0, errs.join(' | '));
} finally {
  await close(); await world.close();
}
done();
