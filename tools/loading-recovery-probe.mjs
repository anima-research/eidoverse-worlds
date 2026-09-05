// Disposable sequencer + actual renderer: persistent failure, keyboard retry,
// success, and a reservation without geometry metadata. Run with bun.
import { ownedWorld, launchBrowser } from './probe-harness.mjs';
import { Document, NodeIO } from '@gltf-transform/core';
const doc = new Document();
const buffer = doc.createBuffer();
const positions = doc.createAccessor().setType('VEC3').setArray(new Float32Array([0,0,0, 1,0,0, 0,1,0])).setBuffer(buffer);
const mesh = doc.createMesh().addPrimitive(doc.createPrimitive().setAttribute('POSITION', positions));
doc.createScene().addChild(doc.createNode().setMesh(mesh));
const bytes = Buffer.from(await new NodeIO().writeBinary(doc));
const world = await ownedWorld();
let browser;
try {
  browser = await launchBrowser();
  const page = await browser.page();
  page.on('pageerror', e => console.log('pageerror', e.message));
  let attempts = 0;
  await page.route('**/library/recovery.glb*', route => {
    attempts++;
    return attempts === 1 ? route.fulfill({status: 503, body: 'unavailable'})
      : route.fulfill({status: 200, contentType: 'model/gltf-binary', body: bytes});
  });
  await page.goto(`${world.origin}/?key=${world.key}&name=recovery-probe&world=recovery`);
  await page.waitForFunction(() => window.EW?.sendVerb, {timeout: 60000});
  await page.evaluate(async () => {
    window.loadingModels = await import('/lib/realize/models.js');
    const { camera } = await import('/lib/core.js');
    const { foldLive } = await import('/lib/state.js');
    // Drive a logged-shape entry through the normal client fold; network
    // authority is irrelevant to the local failure/retry contract.
    foldLive({verb:'spawn',args:{id:'recovery',lib:'recovery.glb',pos:camera.position.toArray()},seq:100,ts:Date.now(),actor:'probe'});
  });
  await page.waitForFunction(() => window.loadingModels.materializationStatus('recovery')?.state === 'failed');
  await page.evaluate(async () => (await import('/lib/scenegraph.js')).sceneSelect('recovery'));
  const retry = page.getByRole('button', {name: 'Retry loading'});
  await retry.waitFor();
  await retry.focus();
  await page.keyboard.press('Enter');
  if (await page.evaluate(() => window.loadingModels.retryMaterialization('recovery'))) throw new Error('duplicate retry admitted');
  await page.waitForFunction(() => window.loadingModels.materializationStatus('recovery')?.state === 'ready');
  const status = await page.evaluate(async () => (await import('/lib/realize/models.js')).materializationStatus('recovery'));
  if (status.error || attempts !== 2) throw new Error(JSON.stringify({status, attempts}));
  const held = [];
  await page.route('**/library/collision-*.glb*', route => { held.push(route); });
  await page.evaluate(async () => {
    const assets = await import('/lib/assets.js');
    const { foldLive } = await import('/lib/state.js');
    const { camera } = await import('/lib/core.js');
    let seq = 101;
    window.probeFold = (verb, args) => foldLive({verb,args,seq:seq++,ts:Date.now(),actor:'probe'});
    for (const id of ['collision-a', 'collision-b']) {
      assets.libLabels.set(`${id}.glb`, 'identical display name prefix longer than 28');
      window.probeFold('spawn', {id,lib:`${id}.glb`,pos:camera.position.toArray()});
    }
    window.probeFold('spawn', {id:'far',lib:'never-fetch.glb',pos:[100000,0,0]});
  });
  for (let n = 0; held.length < 2 && n < 1500; n++) await new Promise(r => setTimeout(r, 20));
  if (held.length !== 2) throw new Error('held downloads timed out');
  const simultaneous = await page.evaluate(async () => (await import('/lib/assets.js')).loadingItems().filter(x => x.label === 'identical display name prefix longer than 28'.slice(0,28)).length);
  if (simultaneous !== 2) throw new Error(`progress collision: ${simultaneous}`);
  await page.evaluate(() => {
    if (window.loadingModels.materializationStatus('far').state !== 'deferred' || window.loadingModels.retryMaterialization('far')) throw new Error('residency bypass');
    window.probeFold('remove', {id:'collision-a'});
    window.probeFold('spawn', {id:'collision-b',lib:'recovery.glb',pos:[0,0,0]});
  });
  for (const route of held) await route.fulfill({status:503, body:'stale failure'});
  await page.waitForFunction(() => window.loadingModels.materializationStatus('collision-b')?.state === 'ready');
  await page.evaluate(async () => {
    if (window.loadingModels.materializationStatus('collision-a') !== null || window.loadingModels.materializationStatus('collision-b').error) throw new Error('stale failure resurrected');
    (await import('/lib/state.js')).reset();
    if (window.loadingModels.materializationStatus('recovery') !== null) throw new Error('reset retained status');
  });
  console.log('PASS: rendered keyboard retry recovered existing object once; failure cleared; progress identity, replacement, removal, reset and residency passed');
} finally {
  await browser?.close();
  await world.close();
}
