// bun tools/avatar-perf-probe.mjs — the avatar loupe rank's client half, in a real boot. (1) Wearing a body sends ONE
// metadata-only POST /thumb carrying the body's numbers as LOADED and the version `v` of the path it was loaded from;
// the numbers equal perfscope.statsOf on the live body. (2) A second wear of the same version sends nothing
// (localStorage once-per-version). (3) World › avatar cards: a body with a perf record wears the rank pill in its tier
// color with the numbers in the hover; one without says "not measured yet". POST /thumb is INTERCEPTED (this world's
// OPT_DIR is a real asset copy — the probe writes nothing), and /avatars gets one synthetic perf record for (3).
import { launchBrowser, ownedWorld, checker } from './probe-harness.mjs';
const { check, done } = checker();
const world = await ownedWorld({});
const { browser, page } = await launchBrowser();
try {
  const pg = await page();
  const errs = []; pg.on('pageerror', (e) => errs.push(String(e)));
  const posts = [], auths = [];
  await pg.route('**/thumb?**', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    posts.push(route.request().url()); auths.push(route.request().headers().authorization ?? null);
    // the current server's answer; OLD_SERVER=1 answers like a pre-stamp server (a portrait exists, perf ignored)
    await route.fulfill({ status: 200, contentType: 'application/json', body: process.env.OLD_SERVER ? '{"ok":true,"existed":true}' : '{"ok":true,"meta":true,"perf":true}' });
  });
  let synthName = null, rosterFetches = 0;
  await pg.route('**/avatars', async (route) => {
    rosterFetches++;
    const res = await route.fetch(); const j = await res.json();
    if (j[0]) { synthName = j[0].name; j[0] = { ...j[0], perf: { tris: 123456, draws: 55, mats: 14, alpha: 3, bones: 160, texMB: 44.2, rank: 3, rankName: 'poor', worst: 'tris', v: '1' } }; }
    for (const a of j.slice(1)) a.perf = null;
    await route.fulfill({ response: res, body: JSON.stringify(j), headers: { ...res.headers(), 'content-type': 'application/json' } });
  });
  await pg.goto(`${world.origin}/?world=staging&name=avperf&key=${world.key}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await pg.waitForFunction(() => globalThis.__ewEngineUp, null, { timeout: 60000 });
  // The REAL caller (main.js) waits for whenCalm(): 5 smooth seconds with no loading in flight. Headless software GL
  // is never smooth, so feed the governor its own input — six 60fps seconds, synchronously, between its real 1Hz
  // reads — once loading has settled; nothing else is bypassed.
  const calm = await pg.evaluate(async () => {
    const G = await import('./lib/governor.js');
    let reached = false; G.whenCalm().then(() => { reached = true; });
    for (let i = 0; i < 120 && !reached; i++) { for (let k = 0; k < 6; k++) G.governPerformance(60); await new Promise((r) => setTimeout(r, 500)); }
    return reached;
  });
  check('the governor reached calm (the real call site is now live)', calm);
  for (let i = 0; i < 60 && !posts.some((u) => u.includes('perf=')); i++) await pg.waitForTimeout(500);
  const live = await pg.evaluate(async () => {
    const { getMe, getMyAvatarPath, getMyAvatarName } = await import('./lib/mybody.js');
    const { statsOf } = await import('./lib/perfscope.js');
    const me = getMe(); const s = me?.vrm?.scene ? statsOf(me.vrm.scene, 'me') : null;
    return { path: getMyAvatarPath(), name: getMyAvatarName(), s };
  });
  const perfPosts = posts.filter((u) => u.includes('perf='));
  const q = perfPosts[0] ? new URL(perfPosts[0]).searchParams : null;
  const sent = q ? JSON.parse(q.get('perf')) : null;
  console.log('   worn:', live.name, live.path, '| sent:', JSON.stringify(sent), 'v=', q?.get('v'));
  check('wearing a body sends ONE perf stamp (POST /thumb, metadata only)', perfPosts.length === 1, perfPosts.length);
  check('…for the version it was loaded from (v = the path\'s ?v=)', !!q && q.get('v') === /[?&]v=(\d+)/.exec(live.path)?.[1] && q.get('name') === live.name, [q?.get('v'), live.path]);
  check('…its numbers are the loaded body\'s (statsOf on the live body), and real', !!sent && !!live.s && ['tris', 'draws', 'mats', 'alpha', 'bones', 'texMB'].every((k) => sent[k] === live.s[k]) && sent.tris > 1000 && sent.bones > 10, [sent, live.s]);
  const auth = auths[posts.indexOf(perfPosts[0])];
  check('…with the page\'s key as a Bearer header, never in the URL', auth === `Bearer ${world.key}` && !q?.has('token'), [auth, q?.get('token')]);
  // (2) wear ANOTHER body, then switch BACK — the switch-back really runs contributeThumbnail (mybody.js), so only the
  //     once-per-version flag can keep it from stamping twice (re-wearing the same body never calls it at all)
  const other = await pg.evaluate(async (wornName) => {
    const list = await (await fetch('/avatars')).json();
    const o = list.find((a) => a.name !== wornName && !/corrupt/.test(a.name));
    const { switchAvatar } = await import('./lib/palette.js');
    const { getMyAvatarPath, getMyAvatarName } = await import('./lib/mybody.js');
    const back = { path: getMyAvatarPath(), name: getMyAvatarName() };
    await switchAvatar(o.path, o.name);
    for (let i = 0; i < 120 && getMyAvatarName() !== o.name; i++) await new Promise((r) => setTimeout(r, 250));
    await new Promise((r) => setTimeout(r, 1500));
    await switchAvatar(back.path, back.name);
    for (let i = 0; i < 120 && getMyAvatarName() !== back.name; i++) await new Promise((r) => setTimeout(r, 250));
    await new Promise((r) => setTimeout(r, 2500));
    return { other: o.name, now: getMyAvatarName() };
  }, live.name);
  const stamps = (n) => posts.filter((u) => u.includes('perf=') && new URL(u).searchParams.get('name') === n).length;
  console.log('   switched to', other.other, 'and back to', other.now, '| stamps:', live.name, stamps(live.name), other.other, stamps(other.other));
  check('wearing another body stamps THAT body once', stamps(other.other) === 1, stamps(other.other));
  if (!process.env.OLD_SERVER) check('switching back to the first body (same version) sends no second stamp for it', other.now === live.name && stamps(live.name) === 1, [other.now, stamps(live.name)]);
  // a pre-stamp server answers {existed} and never stores perf: the flag must NOT burn, so the switch-back tries again
  else check('OLD server (perf not confirmed): the switch-back stamps again — nothing was lost to a false "done"', other.now === live.name && stamps(live.name) === 2, [other.now, stamps(live.name)]);
  // (3) the avatar cards
  const cards = await pg.evaluate(async () => {
    document.querySelector('#sec-avatar-tab')?.click();
    for (let i = 0; i < 60 && !document.querySelector('#sec-avatar .av-grid .card'); i++) await new Promise((r) => setTimeout(r, 100));
    return [...document.querySelectorAll('#sec-avatar .av-grid .card')].map((c) => ({ name: c.querySelector('span')?.textContent, title: c.querySelector('.av-shot .opt-rank')?.title ?? '', cardTitle: c.title,
      pill: c.querySelector('.av-shot .opt-rank') ? { rank: c.querySelector('.opt-rank').dataset.rank, bg: getComputedStyle(c.querySelector('.opt-rank')).backgroundColor,
        inShot: (() => { const a = c.querySelector('.av-shot').getBoundingClientRect(), b = c.querySelector('.opt-rank').getBoundingClientRect(); return b.right <= a.right - 4 && b.bottom <= a.bottom - 4 && b.top > a.top + a.height / 2; })() } : null }));
  });
  const syn = cards.find((c) => c.name === synthName), others = cards.filter((c) => c.name !== synthName);
  console.log(`   ${cards.length} avatar cards; synthetic: ${JSON.stringify(syn?.pill)}`);
  check('avatar card with a perf record: rank pill in its tier color, inset on the portrait\'s bottom-right', syn?.pill?.rank === '3' && syn.pill.bg === 'rgb(255, 122, 47)' && syn.pill.inShot, syn);
  check('the perf tooltip is ON the pill; the card tooltip is just the name', syn?.cardTitle === syn?.name && !/perf/.test(syn?.cardTitle ?? ''), [syn?.cardTitle, syn?.name]);
  check('…the pill hover names the rank, the category and the numbers', /^perf: poor — set by triangles\n\s+123,456 tris · 55 draws/.test(syn?.title ?? ''), syn?.title);
  check('cards without a record: no pill; the card tooltip is just the name', others.length > 0 && others.every((c) => !c.pill && !c.title && c.cardTitle === c.name), others.slice(0, 2));
  // (4) with the avatar section OPEN, wearing a not-yet-stamped body repaints it once the stamp is confirmed
  const before = rosterFetches;
  const third = await pg.evaluate(async (skip) => {
    const list = await (await fetch('/avatars')).json();
    const t = list.find((a) => !skip.includes(a.name) && !/corrupt/.test(a.name));
    if (!t) return null;
    const { switchAvatar } = await import('./lib/palette.js');
    await switchAvatar(t.path, t.name); return t.name;
  }, [live.name, other.other]);
  await pg.waitForTimeout(6000);
  const stampedThird = posts.some((u) => u.includes('perf=') && new URL(u).searchParams.get('name') === third);
  check('a confirmed stamp repaints the open avatar section (it re-reads the roster)', !!third && stampedThird && rosterFetches >= before + 2, { third, stampedThird, before, after: rosterFetches });
  check('no page errors', errs.length === 0, errs.slice(0, 2).join(' | ') || 'none');
} catch (e) { check('probe ran', false, String(e).slice(0, 300)); }
finally { await browser.close(); await world.close(); }
done();
