// The one claim the whole lite-mode change rests on: a lite boot must never REQUEST
// the engine. Decided in index.html ahead of the module graph precisely because a
// runtime branch inside main.js would render nothing and still pay the download — so
// the test is a network ledger, not a screenshot. Measured against an owned server.
//
// Recipe: `node tools/lite-weight-test.mjs` (BUN_PATH=<abs bun.exe> on Windows —
// playwright's launch hangs under bun there, see probe-harness).
import { launchBrowser, ownedWorld, checker } from './probe-harness.mjs';

const ENGINE = /three\.webgpu|three\.tsl|three-vrm|three-mesh-bvh/;
const { check, done } = checker();
const world = await ownedWorld();
const { browser, page: mkPage } = await launchBrowser();

async function weigh(query, label) {
  const page = await mkPage();
  const asked = [];
  page.on('request', (r) => asked.push(r.url()));
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  await page.goto(`${world.origin}/?world=staging&name=liteprobe&key=${world.key}${query}`, { waitUntil: 'load' });
  await page.waitForTimeout(6000);   // generous: preloads start at parse, not at load
  const why = await page.evaluate(() => globalThis.__ewLiteWhy ?? null);
  const lite = await page.evaluate(() => globalThis.__ewLite === true);
  const engine = asked.filter((u) => ENGINE.test(u));
  console.log(`\n  ${label}: __ewLite=${lite} why=${why} · ${asked.length} requests, ${engine.length} engine`);
  for (const u of engine.slice(0, 3)) console.log(`      ${u.split('/').pop()}`);
  await page.close();
  return { engine, asked, why, lite, errs };
}

const full = await weigh('', 'full (default)');
check('the full client is not lite', full.lite === false && full.why === 'default');
check('the full client DOES fetch the engine', full.engine.length > 0,
  'if this fails the preloads are broken for everyone, not just lite');

const lite = await weigh('&lite=1', 'lite (?lite=1)');
check('?lite=1 is decided as lite', lite.lite === true && lite.why === 'url');
check('a lite boot requests ZERO engine bytes', lite.engine.length === 0,
  `still asked for: ${lite.engine.map((u) => u.split('/').pop()).join(', ')}`);
check('a lite boot is dramatically lighter overall',
  lite.asked.length < full.asked.length,
  `lite ${lite.asked.length} vs full ${full.asked.length} requests`);

// Weight is only half the claim: a lite client that never boots is 7 requests of
// nothing. The splash is the seam — it is static markup that only boot.js takes down,
// so a cleared splash proves lite.js ran, connected, and called finishBoot.
{
  const page = await mkPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  await page.goto(`${world.origin}/?world=staging&name=liteprobe&key=${world.key}&lite=1`, { waitUntil: 'load' });
  const cleared = await page.waitForFunction(
    () => { const el = document.getElementById('splash'); return !el || el.classList.contains('gone'); },
    { timeout: 25000 },
  ).then(() => true).catch(() => false);
  const chat = await page.evaluate(() => !!document.querySelector('.chat-cols, #chat, [data-frame="chat"]'));
  const canvas = await page.evaluate(() => document.querySelectorAll('canvas:not(.sp-rays)').length);
  console.log(`\n  lite boot: splash cleared=${cleared} chat=${chat} non-splash canvases=${canvas} errors=${errs.length}`);
  for (const e of errs.slice(0, 3)) console.log(`      ! ${e}`);
  check('a lite client actually finishes booting (splash clears)', cleared,
    'lite.js calls initBoot/markPhase/finishBoot — if this hangs, one of them is missing');
  check('a lite boot raises no page errors', errs.length === 0, errs.slice(0, 2).join(' | '));
  check('a lite client renders NO world canvas', canvas === 0);
  await page.close();
}

// Reported from a real phone, 2026-09-15: "my messages were not appearing... but once I
// reloaded the client the chat history appeared". A lite client could SEND and never
// see. The live path is realize/causes.js turning a 'say' entry into a chat line, which
// lite.js was not subscribing to; the reload path is social.js replaying history, which
// it was — hence a chat that only worked in the past tense. This pins the live path.
{
  const page = await mkPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  await page.goto(`${world.origin}/?world=staging&name=echoprobe&key=${world.key}&lite=1`, { waitUntil: 'load' });
  await page.waitForFunction(
    () => { const el = document.getElementById('splash'); return !el || el.classList.contains('gone'); },
    { timeout: 25000 },
  ).catch(() => {});
  const MSG = `echo-probe-${Date.now()}`;
  const typed = await page.evaluate(async (text) => {
    const input = document.getElementById('chatline');
    if (!input) return 'no #chatline';
    input.focus();
    input.value = text;
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    return 'sent';
  }, MSG);
  const appeared = await page.waitForFunction(
    (t) => document.body.innerText.includes(t), MSG, { timeout: 12000 },
  ).then(() => true).catch(() => false);
  console.log(`\n  chat echo: input=${typed} own message rendered live=${appeared} errors=${errs.length}`);
  for (const e of errs.slice(0, 2)) console.log(`      ! ${e}`);
  check('a lite client SEES ITS OWN message without reloading', appeared,
    'initCauses() subscribes the live say->chat path; without it chat only works in the past tense');
  await page.close();
}

// Reported from a real phone, 2026-09-15: tapping an emote answered "verb not allowed:
// emote - the verb set is closed by design". There is no emote verb and never was; an
// emote is a one-shot field on the PRESENCE POSE, which lite was not sending because it
// had no myState. This reads the actual socket frames: the emote must leave as a pose,
// and the server must not answer with a refusal.
{
  const page = await mkPage();
  const sent = [], got = [];
  page.on('websocket', (ws) => {
    ws.on('framesent', (f) => sent.push(String(f.payload)));
    ws.on('framereceived', (f) => got.push(String(f.payload)));
  });
  await page.goto(`${world.origin}/?world=staging&name=emoteprobe&key=${world.key}&lite=1`, { waitUntil: 'load' });
  await page.waitForFunction(
    () => { const el = document.getElementById('splash'); return !el || el.classList.contains('gone'); },
    { timeout: 25000 },
  ).catch(() => {});
  await page.waitForFunction(() => document.querySelectorAll('.lite-emote').length > 0, { timeout: 15000 })
    .then(() => true).catch(() => false);
  const tapped = await page.evaluate(() => {
    const b = document.querySelector('.lite-emote');
    if (!b) return null;
    b.click();
    return b.dataset.emote;
  });
  await page.waitForTimeout(2500);
  const poseWithEmote = sent.filter((f) => f.includes('"type":"pose"') && f.includes('"emote"'));
  const refusals = got.filter((f) => /verb not allowed|not allowed: emote/i.test(f));
  console.log(`\n  emote: tapped=${tapped} pose-frames-carrying-emote=${poseWithEmote.length} refusals=${refusals.length}`);
  if (poseWithEmote[0]) console.log(`      ${poseWithEmote[0].slice(0, 140)}`);
  for (const r of refusals.slice(0, 1)) console.log(`      ! ${r.slice(0, 160)}`);
  check('an emote button exists to tap', !!tapped);
  check('an emote leaves as a presence pose, not a verb', poseWithEmote.length > 0,
    'there is no emote verb; it rides pose.emote and needs a finite p');
  check('the server does not refuse it', refusals.length === 0, refusals[0]?.slice(0, 120));
  await page.close();
}

const back = await weigh('&lite=0', 'escape hatch (?lite=0)');
check('?lite=0 forces the full client back', back.lite === false && back.why === 'url');
check('?lite=0 fetches the engine again', back.engine.length > 0);

await browser.close();
await world.close();
done();
