// bun tools/access-panel-probe.mjs — World › 🔒 access, driven in a real browser (docs/DESIGN-world-access.md).
// Alice (signed in) founds a world and opens the tab; Bob (signed in) is standing in it. Closing the world asks twice
// (Bob isn't listed), then removes him; the search finds him by name and adds him bound to his identity; his role and
// time are changed from his row; removing him takes him off. A non-owner sees the same facts with no controls.
// Screenshots: $SHOT_DIR (default the OS temp dir) access-panel-*.png
import { generateKeyPairSync, createPublicKey, sign as cryptoSign } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchBrowser, ownedWorld, checker } from './probe-harness.mjs';

const { check, done } = checker();
const SHOT_DIR = process.env.SHOT_DIR ?? tmpdir();

// a scratch issuer, so the probe can sign people in (same minting as tools/access-test.ts)
const pair = generateKeyPairSync('ed25519');
const spki = createPublicKey(pair.privateKey).export({ format: 'der', type: 'spki' });
const ISSUER_ID = `ed25519:${spki.subarray(spki.length - 32).toString('base64url')}`;
let jti = 0;
const mint = (sub, name) => {
  const now = Math.floor(Date.now() / 1000);
  const seg = Buffer.from(JSON.stringify({ v: 1, iss: 'id.test', sub, kind: 'human', name, aud: 'eidoverse',
    scopes: ['worlds:join', 'worlds:spectate'], iat: now, exp: now + 900, jti: `p${jti++}` })).toString('base64url');
  return `aid1.${seg}.${cryptoSign(null, Buffer.from(`aid1.${seg}`), pair.privateKey).toString('base64url')}`;
};
const scratch = mkdtempSync(join(tmpdir(), 'access-panel-'));
writeFileSync(join(scratch, 'tokens.json'), '{}');
const world = await ownedWorld({ env: { HN_ISSUER_KEY: ISSUER_ID, HN_ISS: 'id.test', HN_REQUIRE_LOGIN: '0',
  AGENT_TOKENS_PATH: join(scratch, 'tokens.json'), HN_SESSIONS_FILE: join(scratch, 'sessions.json'), VERB_RATE: '500' } });
const O = world.origin;
const login = async (sub, name) => {
  const r = await fetch(`${O}/auth`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: mint(sub, name) }) });
  return /ew_sess=([a-f0-9]{64})/.exec(r.headers.get('set-cookie') ?? '')?.[1] ?? '';
};
const joinAs = (sid, w) => new Promise((resolve) => {
  const ws = new WebSocket(`${O.replace('http', 'ws')}/ws`, { headers: { cookie: `ew_sess=${sid}` } });
  const s = { ws, closedWith: null, snap: null };
  ws.onopen = () => ws.send(JSON.stringify({ type: 'join', world: w }));
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.type === 'snapshot') { s.snap = m; resolve(s); } };
  ws.onclose = (e) => { s.closedWith = e.code; resolve(s); };
  setTimeout(() => resolve(s), 5000);
});

const W = `accp-${Date.now().toString(36)}`;
const { browser, page } = await launchBrowser();
try {
  const alice = await login('human:discord:7001', 'Alice');
  const bob = await login('human:discord:7002', 'Bob');
  const pg = await page();
  const errs = []; pg.on('pageerror', (e) => errs.push(String(e)));
  const host = new URL(O).hostname;
  await pg.context().addCookies([{ name: 'ew_sess', value: alice, domain: host, path: '/' }]);
  // a signed-in arrival gets the "step in" door: press "enter as …", as a person would
  const stepIn = async (p) => {
    await p.waitForFunction(() => globalThis.__ewEngineUp && [...document.querySelectorAll('#door button')].some((b) => /^enter as/.test(b.textContent.trim())), null, { timeout: 90000 });
    await p.evaluate(() => [...document.querySelectorAll('#door button')].find((b) => /^enter as/.test(b.textContent.trim())).click());
    await p.waitForFunction(() => document.querySelector('#sec-access-tab'), null, { timeout: 60000 });
  };
  await pg.goto(`${O}/?world=${W}&lite=0&key=${world.key}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await stepIn(pg);
  await pg.waitForTimeout(1500);
  const B1 = await joinAs(bob, W);
  check('bob walks into the open world', !!B1.snap, `code=${B1.closedWith}`);
  await pg.evaluate(() => document.querySelector('#sec-access-tab').click());
  const panel = () => pg.evaluate(() => document.querySelector('#sec-access .body')?.innerText ?? '');
  await pg.waitForFunction(() => /here now, not listed/i.test(document.querySelector('#sec-access .body')?.innerText ?? ''), null, { timeout: 15000 }).catch(() => {});
  const t0 = await panel();
  console.log('--- panel, open world ---\n' + t0);
  check('the tab names the world and shows the door as open', /who can come into/i.test(t0) && /anyone may come in and build/.test(t0), t0);
  check('alice is listed as owner (you)', /Alice \(you\)/.test(t0));
  check('bob shows under "here now, not listed"', /here now, not listed \(1\)/i.test(t0) && /\+ Bob/.test(t0), t0);
  const frame = await pg.$('#sec-access');
  await (await frame.evaluateHandle((n) => n.closest('.frame') ?? n)).asElement().screenshot({ path: join(SHOT_DIR, 'access-panel-1-open.png') });

  // close: asks twice, then removes bob
  const clickBtn = (label) => pg.evaluate((l) => { const b = [...document.querySelectorAll('#sec-access button')].find((x) => x.textContent.trim() === l); b?.click(); return !!b; }, label);
  await clickBtn('members only');
  await pg.waitForTimeout(300);
  const armed = await panel();
  check('closing with bob here asks first, and says who must leave', /1 person here isn't listed and will have to leave/.test(armed), armed);
  check('…and has not closed anything yet', B1.closedWith == null);
  await (await frame.evaluateHandle((n) => n.closest('.frame') ?? n)).asElement().screenshot({ path: join(SHOT_DIR, 'access-panel-2-armed.png') });
  await clickBtn('members only');
  await pg.waitForFunction(() => /invisible to everyone not listed/.test(document.querySelector('#sec-access .body')?.innerText ?? ''), null, { timeout: 8000 }).catch(() => {});
  await new Promise((r) => setTimeout(r, 800));
  check('the second click closes it; bob is removed (4010)', B1.closedWith === 4010, `code=${B1.closedWith}`);
  check('the door now reads members only', /invisible to everyone not listed/.test(await panel()));

  // add bob back through the search: bound to his identity
  await pg.fill('#sec-access input[type=search]', 'Bo');
  await pg.waitForFunction(() => /human · /.test(document.querySelector('#sec-access .body')?.innerText ?? ''), null, { timeout: 8000 }).catch(() => {});
  const found = await panel();
  check('typing "Bo" finds Bob among people who have signed in', /Bob\s+human ·/.test(found), found);
  await (await frame.evaluateHandle((n) => n.closest('.frame') ?? n)).asElement().screenshot({ path: join(SHOT_DIR, 'access-panel-3-search.png') });
  await clickBtn('add');
  await pg.waitForFunction(() => /listed by name \(2\)/i.test(document.querySelector('#sec-access .body')?.innerText ?? ''), null, { timeout: 8000 }).catch(() => {});
  const added = await panel();
  check('bob is listed, and the search is cleared', /listed by name \(2\)/i.test(added) && /^Bob$/m.test(added) && !/human · /.test(added), added);
  const B2 = await joinAs(bob, W);
  check('…and gets in, as a visitor', B2.snap?.yourRights?.role === 'visitor', `code=${B2.closedWith} ${JSON.stringify(B2.snap?.yourRights)}`);

  // his row: role and time
  const setRow = (name, idx, value) => pg.evaluate(([n, i, v]) => {
    const row = [...document.querySelectorAll('#sec-access .mod-row')].find((r) => r.querySelector('.mod-nm')?.textContent === n);
    const sel = row?.querySelectorAll('select')[i]; if (!sel) return false;
    sel.value = v; sel.dispatchEvent(new Event('change')); return true;
  }, [name, idx, value]);
  check('the role select offers "no access" too (Greptile #258)', await pg.evaluate(() => [...([...document.querySelectorAll('#sec-access .mod-row')].find((r) => r.querySelector('.mod-nm')?.textContent === 'Bob')?.querySelector('select')?.options ?? [])].some((o) => o.value === 'none' && o.textContent === 'no access')));
  check('bob\'s role select is there', await setRow('Bob', 0, 'builder'));
  await pg.waitForTimeout(800);
  await pg.waitForFunction(() => [...document.querySelectorAll('#sec-access .mod-row')].find((r) => r.querySelector('.mod-nm')?.textContent === 'Bob')?.querySelector('select')?.value === 'builder', null, { timeout: 5000 }).catch(() => {});
  check('…making him a builder reaches the world (the refreshed row says builder)', await pg.evaluate(() => [...document.querySelectorAll('#sec-access .mod-row')].find((r) => r.querySelector('.mod-nm')?.textContent === 'Bob')?.querySelector('select')?.value === 'builder'));
  check('bob\'s time select is there', await setRow('Bob', 1, '1h'));
  await pg.waitForTimeout(800);
  const timed = await panel();
  check('…giving him an hour shows it on his row', /Bob\s+here now · (60 min|1 h) left/.test(timed), timed);
  await (await frame.evaluateHandle((n) => n.closest('.frame') ?? n)).asElement().screenshot({ path: join(SHOT_DIR, 'access-panel-4-members.png') });

  // a non-owner sees it read-only
  const pg2 = await page();
  await pg2.context().addCookies([{ name: 'ew_sess', value: bob, domain: host, path: '/' }]);
  B2.ws.close();
  await pg2.goto(`${O}/?world=${W}&lite=0&key=${world.key}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await stepIn(pg2);
  await pg2.waitForTimeout(1500);
  await pg2.evaluate(() => document.querySelector('#sec-access-tab').click());
  await pg2.waitForFunction(() => /you are a/.test(document.querySelector('#sec-access .body')?.innerText ?? ''), null, { timeout: 10000 }).catch(() => {});
  const ro = await pg2.evaluate(() => ({ text: document.querySelector('#sec-access .body')?.innerText ?? '', controls: document.querySelectorAll('#sec-access button, #sec-access select, #sec-access input').length }));
  console.log('--- panel, bob (not an owner) ---\n' + ro.text);
  check('bob sees the door and his own standing, with no controls', /members only: invisible/.test(ro.text) && /you are a builder \((60 min|1 h) left\)/.test(ro.text) && ro.controls === 0, JSON.stringify(ro));
  const f2 = await pg2.$('#sec-access');
  await (await f2.evaluateHandle((n) => n.closest('.frame') ?? n)).asElement().screenshot({ path: join(SHOT_DIR, 'access-panel-5-readonly.png') });

  // remove him
  const removed = await pg.evaluate(() => { const row = [...document.querySelectorAll('#sec-access .mod-row')].find((r) => r.querySelector('.mod-nm')?.textContent === 'Bob'); const b = [...(row?.querySelectorAll('button') ?? [])].find((x) => x.textContent === '✕'); b?.click(); return !!b; });
  await pg.waitForTimeout(1200);
  check('✕ takes bob off the list', removed && !/^Bob$/m.test(await panel()));
  check('no page errors', errs.length === 0, errs.join(' | '));
} finally {
  await browser.close();
  await world.close();
}
done();
