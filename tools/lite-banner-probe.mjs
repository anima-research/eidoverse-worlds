// lite-banner-probe — on a PHONE a died boot demotes to lite and says so in a pinned card (under the emote
// row, surviving the history replay) whose first button enters the 3D world; someone who asked for lite gets
// the card too (a way back, never "type ?lite=0"); a DESKTOP whose boot died is not demoted at all, and gets
// a status-strip pill offering the light version instead (owner, 10-01: lite is default only on mobile).
//   bun tools/lite-banner-probe.mjs [origin]   (no origin: an owned scratch world, probe-harness)
// Mutation witnessed red: drop the liteBanner(WHY) call in lite.js.
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchBrowser, ownedWorld } from './probe-harness.mjs';
const world = await ownedWorld({ live: process.argv[2] || null });
const O = world.origin, K = encodeURIComponent(world.key);
const SHOT = process.env.SHOT ?? join(tmpdir(), 'lite-banner.png');
let fail = 0; const ok = (n, c, d = '') => { if (!c) fail++; console.log(`  ${c ? '✓' : '✗'} ${n}${d ? ' — ' + d : ''}`); };
const { browser: b } = await launchBrowser();
try {
  // seed chat so history replay would bury a chat line
  const ws = new WebSocket(O.replace('http', 'ws') + '/ws?name=talker');
  await new Promise((r, j) => { const t = setTimeout(() => j(new Error(`no snapshot from ${O} in 20 s`)), 20000);
    ws.onerror = () => { clearTimeout(t); j(new Error(`websocket to ${O} failed`)); };
    ws.onopen = () => ws.send(JSON.stringify({ type: 'join', world: 'busy', id: 'talker', token: world.key }));
    ws.onmessage = e => { if (JSON.parse(e.data).type === 'snapshot') { clearTimeout(t); r(); } }; });
  for (let i = 0; i < 40; i++) ws.send(JSON.stringify({ type: 'verb', verb: 'say', args: { text: `chatter line ${i}` } }));
  await new Promise(r => setTimeout(r, 800)); ws.close();
  const PHONE = { viewport: { width: 360, height: 700 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2,
    userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 4a) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36' };
  const DESK = { viewport: { width: 1100, height: 700 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36' };
  // after a press that chooses a client: the page reloads, lands in that client, and the ADDRESS carries no ?lite
  // (a ?lite=0 left there would outrank the crash tripwire and reload a phone into the same crash — review #212)
  // act() is the press; the navigation is awaited from BEFORE it (the address can be unchanged: a plain reload)
  const landedAfter = async (p, lite, act) => { const nav = p.waitForEvent('framenavigated', { timeout: 15000 }).catch(() => null); await act(); await nav;
    return p.waitForFunction((want) => globalThis.__ewLite === want && !new URLSearchParams(location.search).has('lite'), lite, { timeout: 30000, polling: 250 }).then(() => true, () => false); };
  const run = async (label, q, seed, dev = PHONE) => {
    const ctx = await b.newContext(dev); const p = await ctx.newPage(); const errs = [];
    p.on('pageerror', e => errs.push(e.message));
    if (seed) await p.addInitScript(() => { if (sessionStorage.getItem('probe-seeded')) return; sessionStorage.setItem('probe-seeded', '1'); localStorage.setItem('ew-boot-attempt:busy', String(Date.now() - 5000)); })   /* ONE death, not one per navigation */;
    await p.goto(`${O}/?world=busy&name=${label}&key=${K}${q}`);
    await p.waitForFunction(() => globalThis.__ewLite !== undefined && document.querySelector('#lite-emote-host #hud'), null, { timeout: 30000 });
    await p.waitForTimeout(2500);
    const r = await p.evaluate(() => { const bn = document.getElementById('lite-banner'); const rc = bn?.getBoundingClientRect();
      return { lite: globalThis.__ewLite, why: globalThis.__ewLiteWhy, banner: bn?.textContent ?? null, onScreen: !!rc && rc.top >= 0 && rc.bottom <= innerHeight && rc.width > 0,
        clearOfEmotes: (() => { const e = document.getElementById('lite-emote-host')?.getBoundingClientRect(); return !bn || !e || rc.top >= e.bottom; })(),
        chatTail: [...document.querySelectorAll('#chatlog > *')].slice(-1).map(e => e.textContent.slice(0, 30))[0] };
    });
    return { p, ctx, r, errs };
  };
  let { p, ctx, r, errs } = await run('crashed', '', true);
  console.log('phone crash:', JSON.stringify(r));
  ok('a phone whose last boot died is lite (why=crash)', r.lite === true && r.why === 'crash');
  ok('…and SAYS so in a pinned card, on screen after the history replay', !!r.banner && /didn't finish loading/.test(r.banner) && r.onScreen, r.chatTail);
  ok('…below the emote row, not over it (360 px wide, the row wraps)', r.clearOfEmotes === true);
  ok('…it names the way in (the ∃ logo), and its one button is got it', /Tap the \u2203 Eidoverse logo/.test(r.banner) /* a touch phone taps */ && await p.evaluate(() => { const c = document.getElementById('lite-banner'); return c.classList.contains('capnotice') && [...c.querySelectorAll('button')].map(b => b.textContent).join('|') === 'got it'; }));
  ok('…the ∃ mark is centred in its tile (within 1 px)', await p.evaluate(() => { const b = document.getElementById('hud').getBoundingClientRect(), g = document.querySelector('#hud svg').getBoundingClientRect(); return Math.abs((b.left + b.right) / 2 - (g.left + g.right) / 2) <= 1 && Math.abs((b.top + b.bottom) / 2 - (g.top + g.bottom) / 2) <= 1; }));
  ok('…the ∃ is a real tap target (≥ 44 px) leading the top bar', await p.evaluate(() => { const h = document.getElementById('hud'); const r = h.getBoundingClientRect(); return h.parentElement.id === 'lite-emote-host' && h.parentElement.firstElementChild === h && r.height >= 44 && r.width >= 44 && !h.disabled; }));
  const L = await p.evaluate(() => { const R = (q) => document.querySelector(q)?.getBoundingClientRect(); const ov = (a, b) => !!a && !!b && a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
    const bar = R('#lite-emote-host'), card = R('#lite-banner'), chat = R('.frame.chat-frame'), dock = R('#hud'), gear = R('.chat-gear'), input = R('#chatline'), hud = document.getElementById('hud');
    const cs = getComputedStyle(document.querySelector('.frame.chat-frame'));
    return { dockInBar: !!dock && dock.top >= bar.top && dock.bottom <= bar.bottom, dockClearOfCompose: !ov(dock, gear) && !ov(dock, input),
      chatBelowCard: chat.top >= card.bottom, chatToBottom: Math.abs(innerHeight - chat.bottom) <= 1, chatFullWidth: chat.left <= 0.5 && Math.abs(innerWidth - chat.right) <= 0.5,
      square: parseFloat(cs.borderTopLeftRadius) === 0 && parseFloat(cs.borderBottomRightRadius) === 0,
      gap: Math.round(chat.top - card.bottom), cardFullWidth: card.left <= 12 && innerWidth - card.right <= 12, hudVisible: !!hud && getComputedStyle(hud).display !== 'none' }; });
  console.log('phone layout:', JSON.stringify(L));
  ok('layout: the ∃ lives in the top bar, clear of the chat compose row', L.dockInBar && L.dockClearOfCompose);
  ok('layout: the chat is edge to edge — full width, to the bottom, square corners, no dead gap', L.chatBelowCard && L.chatToBottom && L.chatFullWidth && L.square && L.gap <= 16, JSON.stringify(L));
  ok('layout: the card spans the column; the ∃ shows', L.cardFullWidth && L.hudVisible);
  await p.screenshot({ path: SHOT.replace('.png', '-phone.png') });
  // Enter on a FOCUSED cancel button cancels, not confirms (review #212) — checked here via the ∃ menu later; first the ∃
  ok('tapping the ∃ lands in the full world, address clean (no ?lite)', await landedAfter(p, false, () => p.locator('#hud').click()), p.url());
  // THE LOOP the review found: that full boot dies (OOM). The next visit to the SAME address must land in lite, once.
  // (an OOM runs no pagehide, which a navigation from a live page always fires — so the death is planted at the start
  //  of the NEXT document, the state an OOM-killed tab leaves behind)
  await p.addInitScript(() => { if (sessionStorage.getItem('probe-died')) return; sessionStorage.setItem('probe-died', '1'); localStorage.setItem('ew-boot-attempt:busy', String(Date.now())); });
  await p.goto(p.url()); await p.waitForFunction(() => globalThis.__ewLite !== undefined, null, { timeout: 30000 });
  const again = await p.evaluate(() => ({ lite: globalThis.__ewLite, why: globalThis.__ewLiteWhy }));
  ok('…and if the 3D world then kills the phone, reloading that address lands in lite (crash), not the same crash', again.lite === true && again.why === 'crash', JSON.stringify(again));
  ok('no page errors', errs.length === 0, errs.join(' | ').slice(0, 200)); await ctx.close();

  { // a FRESH phone (no history) starts in lite; choosing 3D is remembered on that device
    const ctx = await b.newContext(PHONE); const p = await ctx.newPage(); const errs = []; p.on('pageerror', e => errs.push(e.message));
    await p.goto(`${O}/?world=busy&name=freshphone&key=${K}`);
    await p.waitForFunction(() => globalThis.__ewLite !== undefined && document.querySelector('#lite-emote-host #hud'), null, { timeout: 30000 });
    await p.waitForTimeout(1500);
    const f = await p.evaluate(() => ({ lite: globalThis.__ewLite, why: globalThis.__ewLiteWhy, banner: document.getElementById('lite-banner')?.textContent ?? '' }));
    ok('a fresh phone starts in lite (why=phone), and the card says why: on a phone', f.lite === true && f.why === 'phone' && /You're on a phone/.test(f.banner), JSON.stringify(f));
    const E = await p.evaluate(() => { const row = document.querySelector('#lite-emote-host .lite-emotes'); const t = [...row.querySelectorAll('.lite-emote')].map((b) => b.getBoundingClientRect());
      return { n: t.length, fits: row.scrollWidth <= row.clientWidth + 1, inView: t.every((r) => r.left >= 0 && r.right <= innerWidth), w: Math.round(t[0]?.width ?? 0), h: Math.round(t[0]?.height ?? 0) }; });
    ok('emotes: every one sits on the top row at 360 px, none scrolled off, tiles ≥ 40 px', E.n > 0 && E.fits && E.inView && E.w >= 40 && E.h >= 40, JSON.stringify(E));
    // the compose box grows with what you type, to a cap, then scrolls; Enter sends and it shrinks back
    await p.locator('#lite-banner .cn-ok').click();
    const box = p.locator('#chatline');
    const h0 = await box.evaluate((el) => el.getBoundingClientRect().height);
    await box.click(); await box.pressSequentially('one');
    for (let i = 0; i < 2; i++) { await box.press('Shift+Enter'); await box.pressSequentially('more'); }
    const h3 = await box.evaluate((el) => el.getBoundingClientRect().height);
    for (let i = 0; i < 12; i++) { await box.press('Shift+Enter'); await box.pressSequentially('line'); }
    const G = await box.evaluate((el) => { const cs = getComputedStyle(el); const lh = parseFloat(cs.lineHeight); const pane = el.closest('.fr-body').clientHeight;
      return { h: el.getBoundingClientRect().height, lh, pane, ov: cs.overflowY, scrolls: el.scrollHeight > el.clientHeight, val: el.value.split('\n').length }; });
    ok('compose: one line at rest, three lines when three are typed (Shift+Enter is a new line)', h3 > h0 * 2 && h3 < h0 * 4, JSON.stringify({ h0, h3 }));
    ok('compose: past the cap it stops at ≤ 6 lines and ≤ 40% of the pane, and scrolls', G.val === 15 && G.h <= G.lh * 6 + 20 && G.h <= G.pane * 0.4 + 1 && G.ov === 'auto' && G.scrolls, JSON.stringify(G));
    await box.press('Enter');
    const after = await box.evaluate((el) => ({ v: el.value, h: el.getBoundingClientRect().height }));
    ok('compose: Enter sends, and the box is empty and one line again', after.v === '' && Math.abs(after.h - h0) <= 1, JSON.stringify({ ...after, h0 }));
    const sent = await p.waitForFunction(() => [...document.querySelectorAll('#chatlog .line')].some((l) => /one\s*more\s*more/.test(l.textContent)), null, { timeout: 8000 }).then(() => true, () => false);
    ok('compose: the multi-line message arrived in the log', sent);
    ok('compose: …and keeps its line breaks in the log', await p.evaluate(() => { const l = [...document.querySelectorAll('#chatlog .line')].find((x) => /one/.test(x.textContent) && /more/.test(x.textContent)); const b = l?.querySelector('.body'); return !!b && getComputedStyle(b).whiteSpace === 'pre-line' && b.getBoundingClientRect().height > parseFloat(getComputedStyle(b).lineHeight) * 10; }));
    await p.screenshot({ path: SHOT.replace('.png', '-compose.png') });
    await box.click();
    for (let i = 0; i < 4; i++) { await box.pressSequentially('typing a longer message to show the box growing '); }
    await p.screenshot({ path: SHOT.replace('.png', '-compose-grow.png') });
    await box.fill('');
    ok('…the ∃ goes full and remembers it (ew-lite=0), address clean', await landedAfter(p, false, () => p.locator('#hud').click()) && await p.evaluate(() => localStorage.getItem('ew-lite') === '0'));
    await p.goto(`${O}/?world=busy&name=freshphone&key=${K}`);
    await p.waitForFunction(() => globalThis.__ewLite !== undefined, null, { timeout: 30000 });
    const g = await p.evaluate(() => ({ lite: globalThis.__ewLite, why: globalThis.__ewLiteWhy }));
    ok('…so the next plain visit on that phone is full (why=saved)', g.lite === false && g.why === 'saved', JSON.stringify(g));
    ok('no page errors on the fresh phone', errs.length === 0, errs.join(' | ').slice(0, 200)); await ctx.close();
  }

  ({ p, ctx, r, errs } = await run('asked', '&lite=1', false, DESK));
  { // a WIDE desktop window: lite keeps to a centred column; tiles stay tiles, packed against the ∃
    await p.setViewportSize({ width: 2000, height: 1000 }); await p.waitForTimeout(400);
    const W = await p.evaluate(() => { const R = (q) => document.querySelector(q)?.getBoundingClientRect(); const t = [...document.querySelectorAll('.lite-emote')].map((b) => b.getBoundingClientRect());
      const card = R('#lite-banner'), chat = R('.frame.chat-frame'), hud = R('#hud');
      return { tileMax: Math.round(Math.max(...t.map((r) => r.width))), packed: t.length > 0 && t[0].left - hud.right < 20 && t.every((r, i) => !i || r.left - t[i - 1].right < 12),
        card: Math.round(card.width), chat: Math.round(chat.width), centred: Math.abs((chat.left + chat.right) / 2 - innerWidth / 2) <= 2 && Math.abs((card.left + card.right) / 2 - innerWidth / 2) <= 2 }; });
    ok('wide desktop: emote tiles stay ≤ 52 px and pack against the ∃', W.tileMax <= 52 && W.packed, JSON.stringify(W));
    ok('wide desktop: the card and the chat keep to a centred column ≤ 720 px', W.card <= 720 && W.chat <= 720 && W.centred, JSON.stringify(W));
    await p.screenshot({ path: SHOT.replace('.png', '-wide.png') });
    await p.setViewportSize({ width: 1100, height: 700 });
  }
  ok('someone who ASKED for lite (a desktop link) gets the card too, naming the way back', r.lite === true && r.why === 'url' && /This link opens the lite client/.test(r.banner ?? '') && /Click the \u2203 Eidoverse logo/.test(r.banner ?? '') /* a mouse clicks */, JSON.stringify(r));
  await p.screenshot({ path: SHOT });
  ok('the ∃ lands in the full world from a ?lite=1 link too (the link param dropped)', await landedAfter(p, false, () => p.locator('#hud').click()), p.url()); await ctx.close();

  ({ p, ctx, r, errs } = await run('dismiss', '', true));
  await p.evaluate(() => { globalThis.__roOff = 0; const d = ResizeObserver.prototype.disconnect; ResizeObserver.prototype.disconnect = function () { globalThis.__roOff++; return d.call(this); }; });
  await p.locator('#lite-banner .cn-ok').click();
  ok('got it dismisses it', await p.evaluate(() => !document.getElementById('lite-banner')));
  await p.waitForTimeout(200);
  ok('…and the chat grows flush up to the bar', await p.evaluate(() => Math.abs(document.querySelector('.frame.chat-frame').getBoundingClientRect().top - document.getElementById('lite-emote-host').getBoundingClientRect().bottom) <= 1));
  ok('…and stops following the emote row (its ResizeObserver disconnects)', await p.evaluate(() => globalThis.__roOff === 1)); await ctx.close();

  { // a DESKTOP whose last boot died: full client, plus a pill offering the light version
    const ctx = await b.newContext(DESK); const p = await ctx.newPage(); const errs = []; p.on('pageerror', e => errs.push(e.message));
    await p.addInitScript(() => { if (sessionStorage.getItem('probe-seeded')) return; sessionStorage.setItem('probe-seeded', '1'); localStorage.setItem('ew-boot-attempt:busy', String(Date.now() - 5000)); })   /* ONE death, not one per navigation */;
    await p.goto(`${O}/?world=busy&name=deskcrash&key=${K}`);
    await p.waitForFunction(() => globalThis.__ewLite !== undefined, null, { timeout: 30000 });
    const d = await p.evaluate(() => ({ lite: globalThis.__ewLite, why: globalThis.__ewLiteWhy }));
    ok('a desktop whose last boot died is NOT demoted (full, why=retry)', d.lite === false && d.why === 'retry', JSON.stringify(d));
    const chip = await p.waitForSelector('#stchip-lite-retry', { timeout: 60000 }).then(() => true, () => false);
    ok('…and gets the "last load stalled" pill', chip);
    if (chip) {
      await p.locator('#stchip-lite-retry').click();
      ok('…which offers the lite client as a button', await p.evaluate(() => [...document.querySelectorAll('#stpop button')].some(b => /lite client/.test(b.textContent))));
      await p.screenshot({ path: SHOT.replace('.png', '-desktop-retry.png') });
    }
    // the ∃ menu offers the light version, behind a centred confirmation (owner, 10-01)
    await p.keyboard.press('Escape'); await p.waitForTimeout(200);
    // reopen the REAL menu deterministically (round-3 review: a pointer that left the menu arms ui.js's 450 ms mouse-away
    // close; a row that still looked visible skipped the reopen and the timer shut the menu under the click). The pointer
    // goes onto the ∃ first, which disarms that timer; the ∃ is clicked only if the menu is actually hidden (a click on an
    // open menu toggles it shut); then the row must be VISIBLE, not merely attached. No force-click.
    const menuRow = async () => {
      await p.locator('#hud').hover();
      if (await p.evaluate(() => document.getElementById('emenu')?.hidden !== false)) await p.locator('#hud').click();
      return p.waitForSelector('#emenu .mrow[data-item=lite]', { state: 'visible', timeout: 5000 }).then(() => true, () => false);
    };
    ok('∃ menu: a "Lite client" item', await menuRow());
    await p.locator('#emenu .mrow[data-item=lite]').click();
    const C = await p.evaluate(() => { const c = document.querySelector('#confirm-center .cc-card')?.getBoundingClientRect(); return c && { cx: Math.round((c.left + c.right) / 2 - innerWidth / 2), cy: Math.round((c.top + c.bottom) / 2 - innerHeight / 2), ok: document.querySelector('#confirm-center .cc-ok').textContent, focus: document.activeElement?.className }; });
    ok('…asks first, in the middle of the screen, Switch focused', !!C && Math.abs(C.cx) <= 2 && Math.abs(C.cy) <= 2 && C.ok === 'Switch' && C.focus === 'cc-ok', JSON.stringify(C));
    await p.keyboard.press('Escape'); await p.waitForTimeout(300);
    ok('…Esc says no: the dialog closes and nothing navigates', await p.evaluate(() => !document.getElementById('confirm-center') && !/lite=1/.test(location.search)));
    // a waterfall row's tooltip sits BESIDE the menus, never over the rows below it (owner, 10-01)
    await menuRow(); await p.locator('#emenu .mrow[data-item=save]').hover(); await p.waitForTimeout(800);
    const T = await p.evaluate(() => { const t = document.getElementById('tipchip'), m = document.getElementById('emenu').getBoundingClientRect(), r = document.querySelector('#emenu .mrow[data-item=save]').getBoundingClientRect(), tr = t.getBoundingClientRect();
      return { show: t.classList.contains('show'), clear: tr.left >= m.right || tr.right <= m.left, level: Math.abs((tr.top + tr.bottom) / 2 - (r.top + r.bottom) / 2) <= 2 || tr.top <= 6 /* the top row's tall tip is held on screen */, tipTop: Math.round(tr.top) }; });
    ok('∃ menu: a row\'s tooltip shows beside the menu, level with its row, off the rows', T.show && T.clear && T.level, JSON.stringify(T));
    await p.mouse.move(5, 600); await p.waitForTimeout(300);
    ok('…and goes when the pointer leaves the row', await p.evaluate(() => !document.getElementById('tipchip').classList.contains('show')));
    ok('the bar at the bottom wears the lighthouse (the Panels row\'s icon), not the ∃', await p.evaluate(() => { const g = document.querySelector('#lantern-pill .lp-glyph')?.innerHTML ?? ''; return /M208,80/.test(g) && !/M4\.675 3/.test(g); }));
    // Enter on the FOCUSED cancel button cancels (review #212: Enter used to mean yes whatever had focus); Tab stays in the card
    ok('…the menu reopens for the next press', await menuRow()); await p.locator('#emenu .mrow[data-item=lite]').click();
    await p.keyboard.press('Tab');
    const onNo = await p.evaluate(() => document.activeElement?.classList.contains('cc-no'));
    await p.keyboard.press('Tab');
    const backOk = await p.evaluate(() => document.activeElement?.classList.contains('cc-ok'));
    await p.keyboard.press('Tab'); await p.keyboard.press('Enter'); await p.waitForTimeout(500);
    ok('confirm: Tab cycles OK ↔ Cancel inside the card; Enter on Cancel cancels', onNo && backOk && await p.evaluate(() => !document.getElementById('confirm-center') && globalThis.__ewLite === false));
    ok('…and again before the final Switch', await menuRow()); await p.locator('#emenu .mrow[data-item=lite]').click();
    ok('…Switch lands in the lite client and REMEMBERS it (ew-lite=1), address clean', await landedAfter(p, true, () => p.locator('#confirm-center .cc-ok').click()) && await p.evaluate(() => localStorage.getItem('ew-lite') === '1'));
    ok('no page errors on the desktop retry', errs.length === 0, errs.join(' | ').slice(0, 200)); await ctx.close();
  }
} catch (e) { fail++; console.log('PROBE FAILED', e.message); } finally { await b.close(); await world.close(); }
console.log(fail ? `${fail} failed` : 'all green'); process.exit(fail ? 1 : 0);
