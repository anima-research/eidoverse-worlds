// bun test/client/loading-recovery-probe.mjs — an object whose model won't load says so, and Retry recovers it (#166).
// A scratch sequencer and the real renderer; every entity is a real request (create, set, delete) through the authority.
//   L1  a model whose download fails every attempt reads `failed`, with its error and a Retry
//   L2  the scene panel's Retry loading button, pressed from the keyboard, queues one retry (a second is coalesced)
//   L3  the retry loads it: `ready`, the error cleared, after exactly one more fetch
//   L4  two downloads sharing a display name keep separate progress entries
//   L5  a far object is a reservation the panel hears of; it reads `deferred` and offers no Retry (no residency bypass)
//   L6  a residency sweep repaints the panel when an object crosses the radius with no load to repaint it (a failed one,
//       in its back-off, carried out of range), and not on every sweep
//   L7  a failure that lands after its object was removed, or re-modelled, revives nothing
//   L8  a world reset forgets every status, and a failure from the old world that lands after it revives none
import { launchBrowser, ownedWorld, checker, skyBoot } from '../harness/probe-harness.mjs';
import { Document, NodeIO } from '@gltf-transform/core';
import { until, pause } from '../gate/wait.ts';
const { check, done } = checker();

// a one-triangle GLB: the bytes a recovered download serves
const doc = new Document();
const buf = doc.createBuffer();
const pos = doc.createAccessor().setType('VEC3').setArray(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0])).setBuffer(buf);
doc.createScene().addChild(doc.createNode().setMesh(doc.createMesh().addPrimitive(doc.createPrimitive().setAttribute('POSITION', pos))));
const GLB = Buffer.from(await new NodeIO().writeBinary(doc));

const world = await ownedWorld({ owner: 'recovery', env: { TRUST_NAMES: '1' } });   // the page owns staging: its creates are admitted
const { browser, page } = await launchBrowser();
try {
  const pg = await page();
  const errs = []; pg.on('pageerror', (e) => errs.push(String(e)));
  // fetchBytes retries a 5xx (three tries): fail the whole first load, then serve the model
  let attempts = 0, healthy = false;
  await pg.route('**/library/store/recovery.glb*', (route) => {
    attempts++;
    return healthy ? route.fulfill({ status: 200, contentType: 'model/gltf-binary', body: GLB }) : route.fulfill({ status: 503, body: 'unavailable' });
  });
  // downloads the probe answers when it chooses; once released, every later attempt (fetchBytes retries a 5xx) fails at once
  const held = []; let release = false;
  await pg.route('**/library/store/held-*.glb*', (route) => (release ? route.fulfill({ status: 503, body: 'stale failure' }) : held.push(route)));
  await pg.route('**/library/store/broken.glb*', (route) => route.fulfill({ status: 503, body: 'unavailable' }));   // never loads
  const failHeld = async () => { release = true; for (const r of held.splice(0)) await r.fulfill({ status: 503, body: 'stale failure' }); };
  await skyBoot(pg, world, 'recovery');   // cloud quality off (a cloudy sky bakes on the CPU here), then the engine, 120 s
  await pg.evaluate(async () => {
    const { sendRequest } = await import('./lib/net.js');
    const { camera, THREE } = await import('./lib/core.js');
    const { bus } = await import('./lib/base.js');
    globalThis.__lr = {
      models: await import('./lib/realize/models.js'), assets: await import('./lib/assets.js'), st: (await import('./lib/state.js')).state, events: [],
      // a create, or any request, through the authority: refused is a probe failure, not a row
      ask: async (verb, args) => { const r = await sendRequest(verb, args); if (!r.ok) throw new Error(`${verb} refused: ${JSON.stringify(r.refused)}`); return r; },
      // two metres in front of the eye, on the ground: inside the residency radius
      near: () => { const p = camera.getWorldPosition(new THREE.Vector3()); return [p.x, 0, p.z - 2]; },
    };
    bus.on('materialization', (e) => globalThis.__lr.events.push(e.id));
  });
  const status = (id) => pg.evaluate((i) => globalThis.__lr.models.materializationStatus(i), id);
  const create = (model, at) => pg.evaluate(async ([m, a]) => {
    const L = globalThis.__lr; const r = await L.ask('create', { id: '$t', model: m, components: { transform: { pos: a ?? L.near() } } });
    return r.ids.$t;
  }, [model, at ?? null]);

  // ---- L1-L3: failure, the panel's keyboard retry, recovery
  const rec = await create('store/recovery.glb');
  await pg.waitForFunction((i) => globalThis.__lr.models.materializationStatus(i)?.state === 'failed', rec, { timeout: 60000 });
  const failed = await status(rec);
  check('L1 a model that fails every attempt reads failed, with its error and a Retry', failed?.state === 'failed' && !!failed.error && failed.retryAvailable === true && attempts === 3, { failed, attempts });
  await pg.evaluate(async (i) => (await import('./lib/scenegraph.js')).sceneSelect(i), rec);
  await pg.waitForSelector('button[data-act="retry"]', { timeout: 20000 });
  healthy = true;
  await pg.press('button[data-act="retry"]', 'Enter');
  const second = await pg.evaluate((i) => globalThis.__lr.models.retryMaterialization(i), rec);
  check('L2 the panel\'s Retry loading, pressed from the keyboard, queues one retry; a second is coalesced', second === false, { second });
  await pg.waitForFunction((i) => globalThis.__lr.models.materializationStatus(i)?.state === 'ready', rec, { timeout: 60000 });
  const ready = await status(rec);
  check('L3 the retry loads it: ready, the error cleared, after one more fetch', ready?.state === 'ready' && !ready.error && attempts === 4, { ready, attempts });

  // ---- L4: two downloads with one display name; L5: a far reservation
  const LABEL = 'identical display name prefix longer than 28';
  await pg.evaluate((l) => { for (const n of ['held-a', 'held-b', 'held-c']) globalThis.__lr.assets.libLabels.set(`store/${n}.glb`, l); }, LABEL);
  const a = await create('store/held-a.glb'), b = await create('store/held-b.glb');
  await until('both held downloads asked for', () => held.length >= 2, { ms: 30000 });
  const side = await pg.evaluate((l) => globalThis.__lr.assets.loadingItems().filter((x) => x.label === l.slice(0, 28)).length, LABEL);
  check('L4 two downloads sharing a display name keep separate progress entries', held.length === 2 && side === 2, { held: held.length, side });
  const n0 = await pg.evaluate(() => globalThis.__lr.events.length);
  const far = await create('store/never-fetch.glb', [3000, 0, 0]);
  const farHeard = await pg.evaluate(([i, n]) => globalThis.__lr.events.slice(n).includes(i), [far, n0]);
  const farStatus = await status(far);
  const farRetry = await pg.evaluate((i) => globalThis.__lr.models.retryMaterialization(i), far);
  check('L5 a far object is a reservation the panel hears of: deferred, no Retry', farHeard && farStatus?.state === 'deferred' && !farStatus.retryAvailable && farRetry === false, { farHeard, farStatus, farRetry });

  // ---- L6: the sweep repaints on a transition only
  // the realizer sweeps on its own every 500 ms: a far object standing still is heard of by none of them
  const heardOf = (i, n) => pg.evaluate(([id, k]) => globalThis.__lr.events.slice(k).filter((x) => x === id).length, [i, n]);
  const q0 = await pg.evaluate(() => { const L = globalThis.__lr; L.models.residencySweep(); return L.events.length; });
  await pause('a still object across two of the realizer\'s own sweeps: the time is the row', 1200);
  const quiet = await heardOf(far, q0);
  // out of range, a failed object starts no load (the sweep promotes only inside the radius): only the transition says so
  const broken = await create('store/broken.glb');
  await until('the broken model fails', async () => (await status(broken))?.state === 'failed', { ms: 60000 });
  const c0 = await pg.evaluate(() => globalThis.__lr.events.length);
  await pg.evaluate(async (i) => { await globalThis.__lr.ask('set', { id: i, component: 'transform', value: { pos: [3000, 0, 0] } }); }, broken);
  const crossed = !!(await until('the panel hears the failed object leave range', () => heardOf(broken, c0), { ms: 5000 }).catch(() => 0));
  const outside = await status(broken);
  check('L6 a sweep repaints the panel when a failed object leaves range, and not on every sweep', quiet === 0 && crossed && outside?.state === 'deferred', { quiet, crossed, outside });

  // ---- L7: stale failures revive nothing
  await pg.evaluate(async ([ia, ib]) => {
    const L = globalThis.__lr;
    await L.ask('delete', { id: ia });
    await L.ask('set', { id: ib, component: 'model', value: 'store/recovery.glb' });
  }, [a, b]);
  await until('the delete and the new model fold', () => pg.evaluate(([ia, ib]) => { const e = globalThis.__lr.st.st.entities; return !e[ia] && e[ib]?.model === 'store/recovery.glb'; }, [a, b]), { ms: 10000 });
  await failHeld();
  await until('the re-modelled object loads', async () => (await status(b))?.state === 'ready', { ms: 30000 }).catch(() => {});
  const [goneA, nowB] = [await status(a), await status(b)];
  check('L7 a failure that lands after its object was removed or re-modelled revives nothing', goneA === null && nowB?.state === 'ready' && !nowB.error, { goneA, nowB });

  // ---- L8: a reset forgets, and the old world's failure revives nothing
  release = false;
  const c = await create('store/held-c.glb');
  await until('its download asked for', () => held.length >= 1, { ms: 30000 });
  await pg.evaluate(async () => (await import('./lib/state.js')).reset());
  await failHeld();
  await pause('the old world\'s failure lands after the reset: that it revives nothing is the row', 500);
  const after = await pg.evaluate((ids) => ids.map((i) => globalThis.__lr.models.materializationStatus(i)), [rec, c]);
  check('L8 a reset forgets every status, and a failure that lands after it revives none', after.every((s) => s === null), { after });
  check('no page errors', errs.length === 0, errs.slice(0, 2).join(' | ') || 'none');
} catch (e) { check('probe ran', false, String(e).slice(0, 400)); }
finally { await browser.close(); await world.close(); }
done();
