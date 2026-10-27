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
//   D. a bad source is refused HERE, before any round-trip (no comp sent) —
//      and the refusal OUTLIVES a scene-panel repaint: the block is rebuilt on
//      every echo, so the message and the `take down` control must both be
//      there after one (Mica, round 1: 8/9 with the message blank, or the
//      message kept and the control gone, depending on when the echo landed);
//   E. `take down` commits null: the material is restored — and its line
//      survives the echo's repaint too (the echo AGREES with what was said);
//   F. the line is about ONE entity: remove the console, spawn another under
//      the same id, reopen — the replacement has no line (Mica, round 2:
//      the note map was keyed by id alone and the successor opened with its
//      predecessor's "taken down");
//   G. the line is about ONE bag: a refusal is left in the block, then
//      someone ELSE hangs a picture through the verb — the echo disagrees
//      with what the line was about, so the line retires rather than reading
//      as newer than the world.
//
// Synchronization is on the AUTHORITATIVE repaint, never a sleep: after C the
// probe waits for the block that only exists once the comp is in the bag (it
// carries `take down`), and after D it polls for the refusal text.
import { launchBrowser, ownedWorld, checker } from './probe-harness.mjs';
import { join } from 'node:path';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as OP from '../shared/protocol/requests.js';
import { qFromYaw } from '../shared/rot.js';

const LIB = 'eidoverse/assets/models/scif_cyberpunk_crt_retro_computer_monitor_screen_keyboard_tower.glb';
const { check, done } = checker();
const OPT = process.env.OPT_DIR ?? mkdtempSync(join(tmpdir(), 'picedit-opt-'));
// founded, owned by the page's typed name (TRUST_NAMES), so its writes are admitted
const world = await ownedWorld({ worlds: ['piceditprobe'], owner: 'editor', env: { TRUST_NAMES: '1', EIDOVERSE_DIR: process.env.EIDOVERSE_DIR ?? join(process.env.HOME!, 'origin/eidoverse-video'), OPT_DIR: OPT } });
const { page, close } = await launchBrowser();
const errs: string[] = [];
// a 2×2 PNG, red — small enough to be a header test, real enough to decode
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEUlEQVR42mP4z8DwH4QZYAwAR8oH+Rq28akAAAAASUVORK5CYII=', 'base64');
const pngFile = join(mkdtempSync(join(tmpdir(), 'picedit-')), 'red square.png');
writeFileSync(pngFile, PNG);

// writes go through net.sendRequest (net.sendVerb is gone; #260 house I479); the authority mints the console's id. A picture
// is the thing's own quad now (shared/picture.js), so a hang is read off the quad; the part is only the model's readiness
const req = async (pg: any, op: any) => {
  const r = await pg.evaluate((op: any) => import('/lib/net.js').then((n: any) => n.sendRequest(op.verb, op.args)), op);
  if (!r?.ok) throw new Error(`${op.verb} refused: ${JSON.stringify(r?.refused ?? r)}`);
  return r;
};
let ID = '';
const spawn = async (pg: any) => {
  const r = await req(pg, OP.create('$console', { model: LIB, transform: { pos: [1.3, 0.5, -2.2], q: qFromYaw(0.6) } }));
  ID = r.ids?.['$console']; if (!ID) throw new Error(`create named no id: ${JSON.stringify(r)}`);
};
const state = (pg: any) => pg.evaluate(async (id: string) => {
  const { entities, findPart, bagOf } = await import('/lib/world.js');
  const { _hung } = await import('/lib/pictures.js');
  const root = entities.get(id); const part = root ? findPart(root, 'screenplane') : null;
  const h = _hung.get(id);
  let mat: any = null; h?.quad?.traverse((o: any) => { if (o.isMesh && !mat) mat = o.material; });
  const block = document.querySelector('[data-pe-root]');
  const opts = block ? [...block.querySelectorAll('[data-pe="part"] option')].map((o: any) => o.value) : null;
  return {
    entity: !!root, part: !!part, hung: !!h, mapW: mat?.map?.image?.width ?? 0,
    block: !!block, parts: opts, src: (block?.querySelector('[data-pe="src"]') as any)?.value ?? null,
    msg: block?.querySelector('[data-pe="msg"]')?.textContent ?? null,
    down: !!block?.querySelector('[data-pe="down"]'),   // rendered only when the bag holds a picture: the repaint's receipt
    comp: bagOf(id)?.picture ?? null,
  };
}, ID);
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
  await spawn(pg);
  let s = await until(pg, (x) => x.part, 90_000);
  check('the model spawned and has a part named screenplane', s.part, JSON.stringify(s));

  // A. select it in the scene panel — the block lists the model's parts
  await pg.evaluate((id: string) => import('/lib/scenegraph.js').then((m: any) => m.sceneSelect(id)), ID);
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
  await pg.fill('[data-pe="description"]', 'a red square, hung by hand');
  await pg.selectOption('[data-pe="lit"]', 'self');
  await pg.click('[data-pe="hang"]');
  // the comp landing (hung) and the panel's repaint of it (down) are two
  // events ~300ms apart; D must start after the second or it types into a
  // block about to be replaced
  s = await until(pg, (x) => x.hung && x.mapW > 0 && x.down);
  check('C. hang commits the comp — the picture hangs with the uploaded image', s.hung && s.mapW === 2, JSON.stringify(s));
  // the hang's own echo agrees with what the line said, so the repaint it
  // queued (the one that produced `down`) carried the line through
  check('C. …and the block\'s line survives the echo that agrees with it', s.msg === 'hung on screenplane', JSON.stringify({ msg: s.msg }));
  check('C. …with the normalized bag in the fold (src, part, look, lit)', s?.src === uploaded && s?.part === 'screenplane' && s?.look === 'a red square, hung by hand' && s?.lit === 'self' && s?.flip === false, JSON.stringify(s.comp));

  // D. a URL typed into src is refused in the block, and no comp goes out
  const seqBefore = await pg.evaluate((id: string) => import('/lib/world.js').then((m: any) => JSON.stringify(m.bagOf(id)?.picture)), ID);
  await pg.fill('[data-pe="src"]', 'https://example.com/trollface.png');
  await pg.click('[data-pe="hang"]');
  s = await until(pg, (x) => /not an allowed picture source/.test(x.msg ?? ''), 5000);
  const seqAfter = await pg.evaluate((id: string) => import('/lib/world.js').then((m: any) => JSON.stringify(m.bagOf(id)?.picture)), ID);
  check('D. a URL source is refused in the block, naming the rule, and nothing was sent', /not an allowed picture source/.test(s.msg ?? '') && seqBefore === seqAfter && s.hung, JSON.stringify({ msg: s.msg, same: seqBefore === seqAfter }));
  // D2. force the repaint a late echo would cause (any comp event queues one)
  // and require the refusal AND the control to survive it. Without the
  // editor-local note this reads a blank message on a fresh block.
  await pg.evaluate((id: string) => import('/lib/base.js').then((m: any) => m.bus.emit('comp', { id, type: 'probe-repaint', data: true })), ID);
  await new Promise((r) => setTimeout(r, 600));   // the repaint is queued 300ms out; this is a deliberate over-wait, not a sync
  s = await state(pg);
  check('D. …and the refusal outlives a scene-panel repaint, with take down still offered', /not an allowed picture source/.test(s.msg ?? '') && s.down && s.hung, JSON.stringify({ msg: s.msg, down: s.down }));

  // E. take down restores the material
  await pg.click('[data-pe="down"]');
  s = await until(pg, (x) => !x.hung);
  check('E. take down commits null — nothing hung, comp gone', !s.hung && s.comp == null, JSON.stringify(s));
  // the null echo's repaint removes the control; the line it agrees with stays
  s = await until(pg, (x) => x.block && !x.down);
  check('E. …and "taken down" outlives the echo\'s repaint', s.msg === 'taken down' && !s.down, JSON.stringify({ msg: s.msg, down: s.down }));

  // F. another entity opens with NO line (ids are minted now, so the successor has its own id; the note must still not carry over)
  await req(pg, OP.remove(ID));
  s = await until(pg, (x) => !x.entity);
  check('F. the console is removed', !s.entity, JSON.stringify({ entity: s.entity }));
  await spawn(pg);
  s = await until(pg, (x) => x.part, 90_000);
  await pg.evaluate((id: string) => import('/lib/scenegraph.js').then((m: any) => m.sceneSelect(id)), ID);
  s = await until(pg, (x) => x.block);
  check('F. a new console under the same id opens with no inherited line', s.block && (s.msg ?? '') === '' && !s.down && !s.hung, JSON.stringify({ msg: s.msg, down: s.down, hung: s.hung }));

  // G. a line about one bag retires when someone else changes the bag
  await pg.fill('[data-pe="src"]', 'https://example.com/trollface.png');
  await pg.click('[data-pe="hang"]');
  s = await until(pg, (x) => /not an allowed picture source/.test(x.msg ?? ''), 5000);
  check('G. a refusal is in the block again', /not an allowed picture source/.test(s.msg ?? ''), JSON.stringify({ msg: s.msg }));
  // not through the block: a request, as another actor's hand would be
  await req(pg, OP.set(ID, 'picture', { src: uploaded, description: 'hung by someone else' }));
  s = await until(pg, (x) => x.hung && x.down);
  check('G. …the outside hang lands and the block repaints with take down', s.hung && s.down && s.comp?.description === 'hung by someone else', JSON.stringify({ hung: s.hung, down: s.down, comp: s.comp }));
  check('G. …and the refusal line is gone: it was about a bag the world moved past', (s.msg ?? '') === '', JSON.stringify({ msg: s.msg }));
  check('no page errors across the cycle', errs.length === 0, errs.join(' | '));
} catch (e: any) {
  console.log('probe aborted:', e?.message ?? e);
  if (errs.length) console.log('page errors:', errs.join(' | '));
  check('the probe ran to the end', false, e?.message ?? String(e));
} finally {
  await close(); await world.close();
}
done();
