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

// The socket, observed from INSIDE the page.
//
// Playwright's `framesent` was the instrument here and it is not reliable: this suite
// reported 19/19 locally while an independent reviewer got 18/19 on the same commit,
// the emote frame missing from the observer while an in-page receipt proved the product
// had sent it (#188 B4). A gate that flakes is worse than no gate - it taught us the
// wrong thing about our own code. So we patch WebSocket.prototype.send before any app
// script runs and keep the frames ourselves: same object the client actually calls,
// nothing between us and it.
const SOCKET_SPY = `
  globalThis.__frames = { sent: [], opened: 0 };
  const _send = WebSocket.prototype.send;
  WebSocket.prototype.send = function (data) {
    try { globalThis.__frames.sent.push(String(data)); } catch (e) {}
    return _send.call(this, data);
  };
  const _WS = WebSocket;
  globalThis.WebSocket = new Proxy(_WS, {
    construct(t, a) { globalThis.__frames.opened++; return new t(...a); },
  });
`;
const framesOf = (page) => page.evaluate(() => globalThis.__frames ?? { sent: [], opened: 0 });

// B1: one arrival, one socket generation. The inline early socket joins before the lite
// decision exists, and net.js adopts it ONLY when the join it would send matches byte for
// byte. lite asking for avatar:'' missed, so the early socket was discarded and a second
// opened - the server saw arrive -> leave -> arrive, and a held whisper delivered to the
// first socket could be marked delivered server-side and then thrown away with it.
{
  const page = await mkPage();
  await page.addInitScript(SOCKET_SPY);
  await page.goto(`${world.origin}/?world=staging&name=litejoin&key=${world.key}&lite=1`, { waitUntil: 'load' });
  await page.waitForFunction(
    () => { const el = document.getElementById('splash'); return !el || el.classList.contains('gone'); },
    { timeout: 25000 },
  ).catch(() => {});
  await page.waitForTimeout(2500);
  const f = await framesOf(page);
  const joins = f.sent.filter((x) => x.includes('"type":"join"'));
  const avatars = joins.map((j) => { try { return JSON.parse(j).avatar; } catch { return '?'; } });
  console.log(`\n  join lifecycle: sockets=${f.opened} joins=${joins.length} avatars=${JSON.stringify(avatars)}`);
  check('a lite client opens ONE socket generation', f.opened <= 1,
    `opened ${f.opened}; the early socket must be adopted, not replaced`);
  check('a lite client sends exactly ONE join', joins.length === 1,
    `sent ${joins.length}: ${JSON.stringify(avatars)}`);
  check('lite joins with the avatar the early socket used, not an empty one',
    avatars.length > 0 && avatars.every((a) => a && a !== ''),
    'avatar:"" is what made net.js reject the early socket');
  await page.close();
}

// B2: an emote must carry the remembered body UNCHANGED and add only the one-shot.
// Specimen shape borrowed from the review: a seated, pitched, wing-folded resident
// holding a custom pose. Before the fix a wave emitted idle/0/false and no held pose.
{
  const page = await mkPage();
  await page.addInitScript(SOCKET_SPY);
  const STORED = { p: [2, 0, 3], yaw: 1.2, clip: 'sit', pitch: 0.1, wingsFolded: true, pose: { head: [0, 0, 0, 1] } };

  // Establish the body as the FULL client would leave it, so the server remembers it.
  await page.goto(`${world.origin}/?world=staging&name=bodykeep&key=${world.key}&lite=1`, { waitUntil: 'load' });
  await page.waitForFunction(() => globalThis.__ewLite === true, { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(2000);
  // Route to a remembered pose: join as this identity on a plain socket, send the pose,
  // disconnect. The server calls rememberPose on disconnect (server.ts:212), so the next
  // join under the same id gets it back as `restore`.
  await page.evaluate(async (pose) => {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const sock = new WebSocket(`${proto}://${location.host}/ws`);
    await new Promise((res) => { sock.onopen = res; });
    const q = new URLSearchParams(location.search);
    sock.send(JSON.stringify({ type: 'join', world: q.get('world'), id: q.get('name'),
      avatar: globalThis.__ewWantAvatar ?? 'claude', spectate: false, renderer: false, token: q.get('key') }));
    await new Promise((res) => setTimeout(res, 1200));
    sock.send(JSON.stringify({ type: 'pose', pose }));
    await new Promise((res) => setTimeout(res, 800));
    sock.close();
  }, STORED);
  await page.waitForTimeout(1200);

  // Now arrive in lite under that identity and tap one emote.
  await page.goto(`${world.origin}/?world=staging&name=bodykeep&key=${world.key}&lite=1`, { waitUntil: 'load' });
  await page.waitForFunction(() => document.querySelectorAll('.lite-emote').length > 0, { timeout: 20000 })
    .catch(() => {});
  await page.waitForTimeout(1500);
  const tapped = await page.evaluate(() => {
    const b = document.querySelector('.lite-emote');
    if (!b) return null;
    b.click();
    return b.dataset.emote;
  });
  await page.waitForTimeout(1500);
  const f2 = await framesOf(page);
  const poses = f2.sent.filter((x) => x.includes('"type":"pose"') && x.includes('"emote"'));
  let sentPose = null;
  try { sentPose = JSON.parse(poses[poses.length - 1]).pose; } catch { /* none */ }
  console.log(`\n  emote: tapped=${tapped} pose-frames=${poses.length}`);
  if (sentPose) console.log(`      ${JSON.stringify(sentPose).slice(0, 190)}`);

  check('an emote button exists to tap', !!tapped);
  check('an emote leaves as a presence pose, not a verb', !!sentPose,
    'there is no emote verb; it rides pose.emote and needs a finite p');
  if (sentPose) {
    check('the emote itself rides along', sentPose.emote === tapped);
    check('a seated resident stays seated', sentPose.clip === STORED.clip,
      `clip=${sentPose.clip} (stored ${STORED.clip})`);
    check('pitch survives the emote', sentPose.pitch === STORED.pitch,
      `pitch=${sentPose.pitch} (stored ${STORED.pitch})`);
    check('folded wings stay folded', sentPose.wingsFolded === true,
      `wingsFolded=${sentPose.wingsFolded}`);
    check('a held pose is not dropped', JSON.stringify(sentPose.pose) === JSON.stringify(STORED.pose),
      `pose=${JSON.stringify(sentPose.pose)}`);
    check('position and facing survive', JSON.stringify(sentPose.p) === JSON.stringify(STORED.p)
      && sentPose.yaw === STORED.yaw, `p=${JSON.stringify(sentPose.p)} yaw=${sentPose.yaw}`);
  }
  await page.close();
}

// ARRIVAL DELIVERY. The window between adopting the early socket and having somewhere
// to put what it carries.
//
// Round two of the review found real message loss here: connect() adopts the early
// socket and drains what raced ahead of us - the join snapshot, and any whisper the
// server held while we were away. The server deletes its pending copy the moment it
// sends one, so a chat window that did not exist yet meant logWhisper() threw inside the
// drain, connect() reported it and carried on, and a successfully delivered private
// message was gone for good. These gates hold the ordering that fixes it.
//
// `raw` drives a plain socket from inside the page: a second participant, no client.
const RAW = `
  globalThis.__raw = async (msgs, { id, wait = 900 }) => {
    const q = new URLSearchParams(location.search);
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const sock = new WebSocket(proto + '://' + location.host + '/ws');
    await new Promise((res, rej) => { sock.onopen = res; sock.onerror = rej; });
    sock.send(JSON.stringify({ type: 'join', world: q.get('world'), id,
      avatar: 'claude', spectate: false, renderer: false, token: q.get('key') }));
    await new Promise((res) => setTimeout(res, wait));
    for (const m of msgs) { sock.send(JSON.stringify(m)); await new Promise((res) => setTimeout(res, 250)); }
    await new Promise((res) => setTimeout(res, wait));
    sock.close();
    await new Promise((res) => setTimeout(res, 400));
    return true;
  };
`;

{
  const WORLD = `arrival${Date.now().toString(36)}`;
  const READER = 'reader';
  const SECRET = `held-whisper-${Date.now()}`;
  const PRIOR = `prior-say-${Date.now()}`;

  // A page that is NOT the reader, used only to drive the other participant.
  const driver = await mkPage();
  await driver.addInitScript(RAW);
  await driver.goto(`${world.origin}/?world=${WORLD}&name=driver&key=${world.key}&lite=1&earlysock=0`,
    { waitUntil: 'load' });
  await driver.waitForTimeout(1500);

  // One ordinary say (becomes the room's pre-existing context), then a whisper to
  // someone who is not here - which the server holds for delivery on arrival.
  await driver.evaluate(async ({ secret, prior, reader }) => {
    await globalThis.__raw([
      { type: 'verb', verb: 'say', args: { text: prior } },
      { type: 'whisper', to: reader, text: secret },
    ], { id: 'sender' });
  }, { secret: SECRET, prior: PRIOR, reader: READER });
  await driver.close();

  // Now the reader arrives, in lite, for the first time.
  const page = await mkPage();
  const asked = [];
  page.on('request', (r) => asked.push(r.url()));
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  const consoleErrs = [];
  page.on('console', (m) => { if (/TypeError|Cannot read prop|net whisper/i.test(m.text())) consoleErrs.push(m.text()); });

  await page.goto(`${world.origin}/?world=${WORLD}&name=${READER}&key=${world.key}&lite=1`, { waitUntil: 'load' });
  await page.waitForFunction(
    () => { const el = document.getElementById('splash'); return !el || el.classList.contains('gone'); },
    { timeout: 25000 },
  ).catch(() => {});
  await page.waitForTimeout(3000);

  const body = await page.evaluate(() => document.body.innerText);
  const countOf = (hay, needle) => hay.split(needle).length - 1;
  const whisperHits = countOf(body, SECRET);
  const priorHits = countOf(body, PRIOR);
  const engine = asked.filter((u) => ENGINE.test(u)).length;

  console.log(`\n  arrival delivery: held-whisper x${whisperHits}  prior-say x${priorHits}  engine=${engine}  pageErrors=${errs.length}  drainErrors=${consoleErrs.length}`);
  for (const e of consoleErrs.slice(0, 2)) console.log(`      ! ${e.slice(0, 140)}`);

  check('a held whisper survives a lite arrival', whisperHits > 0,
    'the server deletes its pending copy on send; a consumer built after the drain never sees it');
  check('the held whisper arrives exactly once', whisperHits === 1, `seen ${whisperHits}x`);
  check('pre-existing room chat is there on first arrival', priorHits > 0,
    'state.st.recentChat is hydrated from the join snapshot; someone has to replay it');
  check('pre-existing chat is not duplicated', priorHits === 1, `seen ${priorHits}x`);
  check('nothing throws inside the drain', consoleErrs.length === 0, consoleErrs[0]?.slice(0, 120));
  check('arrival delivery raises no page errors', errs.length === 0, errs[0]?.slice(0, 120));
  check('none of this costs engine bytes', engine === 0);
  await page.close();
}

// B3: a first-time visitor to a key-gated world must be able to GET IN from lite.
// The owned world sets JOIN_TOKEN, so arriving without ?key= earns close code 4003, which
// net.js turns into `bad-key`. The full client answers that by reopening openDoor - which
// lives in ui.js and arrives with the engine attached. "Try the full world" is not a door
// for someone whose phone the full world kills, so lite needs its own, and it has to work
// without fetching a single engine byte.
{
  const page = await mkPage();
  const asked = [];
  page.on('request', (r) => asked.push(r.url()));
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  // A first-time visitor remembers nothing.
  await page.addInitScript(() => { try { localStorage.removeItem('ew-key'); } catch (e) {} });

  await page.goto(`${world.origin}/?world=staging&name=doorprobe&lite=1`, { waitUntil: 'load' });
  const doorShown = await page.waitForSelector('#lite-door', { timeout: 20000 })
    .then(() => true).catch(() => false);
  const engineBeforeKey = asked.filter((u) => ENGINE.test(u)).length;
  console.log(`\n  key door: shown=${doorShown} engine-requests-so-far=${engineBeforeKey}`);
  check('a key-gated lite visitor gets a key door', doorShown,
    'without it the only escape is the full client, which is what kills the device');
  check('the key door costs no engine bytes', engineBeforeKey === 0);

  if (doorShown) {
    await page.fill('#lite-door .lite-door-key', world.key);
    await page.click('#lite-door .lite-door-go');
    const joined = await page.waitForFunction(
      () => !document.getElementById('lite-door') && !!document.getElementById('chatline'),
      { timeout: 20000 },
    ).then(() => true).catch(() => false);
    const engineAfter = asked.filter((u) => ENGINE.test(u)).length;
    console.log(`  key door: entered key -> joined=${joined} engine-requests-total=${engineAfter} errors=${errs.length}`);
    for (const e of errs.slice(0, 2)) console.log(`      ! ${e}`);
    check('a correct key lets a lite visitor in', joined,
      'setToken + connect() should close the door and leave a usable chat');
    check('recovering through the key door still loads no engine', engineAfter === 0);
    check('the key door raises no page errors', errs.length === 0, errs.slice(0, 1).join(''));
  }
  await page.close();
}

// THE TRIPWIRE, which cannot be tested against the world that motivated it: the commons
// is a different deployment serving its own client, and a world log only arrives over the
// socket on join, so there is no way to mirror that load locally. What CAN be tested is
// the mechanism, and the mechanism is cause-agnostic by design - it asks only "did a full
// boot arm the flag and never come back to clear it". A tab the OS reaped for memory and
// a tab killed by hand leave identical evidence, so the arming and the per-world keying
// are the whole of what needs proving here.
{
  const page = await mkPage();

  // 1. A world whose last full boot never finished: lite, and SAYS why.
  await page.goto(`${world.origin}/?world=alpha&name=trip&key=${world.key}&lite=0`, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => localStorage.setItem('ew-boot-attempt:alpha', String(Date.now())));
  await page.goto(`${world.origin}/?world=alpha&name=trip&key=${world.key}`, { waitUntil: 'load' });
  const alpha = await page.evaluate(() => ({ lite: globalThis.__ewLite, why: globalThis.__ewLiteWhy }));
  console.log(`\n  tripwire: world alpha (died) -> lite=${alpha.lite} why=${alpha.why}`);
  check('a world whose last boot died opens lite', alpha.lite === true && alpha.why === 'crash');

  // 2. A DIFFERENT world on the same device is untouched. This is the one the phone
  //    report forced: an empty instance runs the full client fine on hardware the
  //    commons kills, so a device-wide flag would strand it in lite on worlds it holds.
  await page.goto(`${world.origin}/?world=beta&name=trip&key=${world.key}`, { waitUntil: 'load' });
  const beta = await page.evaluate(() => ({ lite: globalThis.__ewLite, why: globalThis.__ewLiteWhy }));
  console.log(`  tripwire: world beta (fine)  -> lite=${beta.lite} why=${beta.why}`);
  check('a different world on the same device is NOT demoted', beta.lite === false,
    'the key is per world: capability is a property of the (device, world) pair');

  // 3. A full boot that survives disarms its own world, and only after the load tail goes
  //    quiet - not at arrival, which is when the phone was still alive and about to die.
  const armedDuring = await page.evaluate(() => localStorage.getItem('ew-boot-attempt:beta') !== null);
  // The disarm has two paths, and this gates the one that carries the meaning: PAGEHIDE.
  // Leaving deliberately fires it; an out-of-memory kill does not, and that asymmetry is
  // the whole discrimination. Navigating away is exactly the event a real clean exit
  // raises, so this is the product path, not a simulation of it.
  //
  // The 60s dwell is the other path and is deliberately NOT gated here: waiting it out
  // costs the suite a minute and a half and turns a green run into a race against
  // whatever else is loading the server - which is precisely how the previous version of
  // this check passed on a 5s boot and failed on a 12s one, teaching us about the
  // harness instead of the code.
  // ARRIVE first. The pagehide listener is registered by finishBoot, so leaving before
  // the client ever got in is correctly no evidence of anything - which is what the first
  // version of this check accidentally measured.
  const betaArrived = await page.waitForFunction(
    () => { const el = document.getElementById('splash'); return !el || el.classList.contains('gone'); },
    { timeout: 60000 },
  ).then(() => true).catch(() => false);
  check('the full client arrives on a fresh world', betaArrived);

  await page.goto(`${world.origin}/?world=gamma&name=trip&key=${world.key}&lite=1`, { waitUntil: 'load' });
  const disarmed = await page.evaluate(() => localStorage.getItem('ew-boot-attempt:beta') === null);
  console.log(`  tripwire: beta armed during boot=${armedDuring}, cleared on clean exit=${disarmed}`);
  check('a full boot arms the flag before fetching the engine', armedDuring);
  check('leaving a surviving world cleanly disarms it', disarmed,
    'pagehide is the signal an OOM kill cannot fake');

  // 4. alpha is still tripped: surviving beta says nothing about alpha.
  const alphaStill = await page.evaluate(() => localStorage.getItem('ew-boot-attempt:alpha') !== null);
  check('surviving one world does not clear another', alphaStill);

  await page.close();
}

const back = await weigh('&lite=0', 'escape hatch (?lite=0)');
check('?lite=0 forces the full client back', back.lite === false && back.why === 'url');
check('?lite=0 fetches the engine again', back.engine.length > 0);

await browser.close();
await world.close();
done();
