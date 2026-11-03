// lantern-probe — the lantern prompt (client/lib/lantern.js) and the HUD quiet defaults, in the REAL
// client against an owned scratch world (probe-harness). Clouds are forced OFF before boot: a cloudy sky
// bakes on the CPU in headless Chromium and has frozen the host.
//
//   bun tools/lantern-probe.mjs [--shots <dir>]
//
// What must hold:
//   quiet defaults — a fresh profile arrives with the world panel CLOSED, and (on WebGL 2, which headless
//     is) the capability note as a small chip that expands to its full text on click, not a card;
//   Enter still opens chat (the prompt is additive);
//   Ctrl+K opens the prompt; THE KEYS: Enter SAYS what you typed (the say row is always first), Tab
//   DOES the highlighted action (default: the best match, wearing a Tab badge) — so "sit"+Enter says
//   "sit" in chat and does NOT sit, "sit"+Tab sits, "wave"+Tab plays the emote (playEmote observed),
//   "sky"+Tab opens the world panel on its sky tab; a highlight MOVED with ↑/↓ makes
//   Enter run that row; "hello there" + Enter goes through chat's own send path (server echo in #chatlog);
//   the resting line and the open panel keep clear of the chat compose box, and the hint bar and the
//   resting line never show at once;
//   "/who" passes through to the command path; Esc closes; a mouse click on a row runs it;
//   a typo + Tab does nothing (Tab never says); while open, the hint bar steps off the footer and a
//   click on the footer keeps the lantern open;
//   Esc quiet puts the resting line away WITH the panels, and with no panel open too (only the dock stays; still away after the flash; Ctrl+K still opens the lantern,
//   whose Esc comes first) and brings it back with them; the ∃ menu's lantern row unpins the resting line (gone,
//   saved) without taking Ctrl+K away, and pins it back.
// --shots writes the after/ screenshots (1280x720 and 390x844) as it goes.
import { launchBrowser, ownedWorld, checker } from './probe-harness.mjs';
import { mkdirSync } from 'node:fs';

const { check, done } = checker();
const shotDir = (() => { const i = process.argv.indexOf('--shots'); return i > 0 ? process.argv[i + 1] : null; })();
if (shotDir) mkdirSync(shotDir, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const world = await ownedWorld({ env: { SKIP_OPT_SWEEP: '1' } });
const { browser, close } = await launchBrowser();

async function boot(ctxOpts, name) {
  const ctx = await browser.newContext(ctxOpts);
  // THE SKY GUARD, before any module reads localStorage (sky.js)
  await ctx.addInitScript(() => { try { localStorage.setItem('ew-cloud-quality', 'off'); } catch {} });
  const pg = await ctx.newPage();
  const errs = [];
  pg.on('pageerror', (e) => errs.push(e.message));
  pg.on('dialog', (d) => d.dismiss().catch(() => {}));
  await pg.goto(`${world.origin}/?world=lantern&name=${name}&key=${world.key}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await pg.waitForFunction(() => document.getElementById('splash')?.classList.contains('gone') && !!globalThis.EW?.me?.(),
    null, { timeout: 120000 });
  await sleep(4000);   // panels, glyphs, the chip's first placement
  return { ctx, pg, errs };
}
const shot = async (pg, file) => { if (shotDir) await pg.screenshot({ path: `${shotDir}/${file}` }); };
const lantern = (pg) => pg.evaluate(() => {
  const el = document.getElementById('lantern');
  const rows = [...(el?.querySelectorAll('.ln-row') ?? [])].map((r) => ({
    title: r.dataset.title, shown: r.querySelector('.ln-title')?.textContent, key: r.querySelector('.ln-key')?.textContent ?? null,
    do: r.querySelector('.ln-do')?.textContent ?? null, kind: r.className.replace('ln-row ', ''), sel: r.classList.contains('sel') }));
  return { open: !!el && !el.hidden, focused: document.activeElement === el?.querySelector('.ln-input'), rows, hl: rows.find((r) => r.sel) ?? null };
});
// how many chat lines read exactly `text` (the server's echo of a send)
const said = (pg, text) => pg.evaluate((t) => [...document.querySelectorAll('#chatlog .line.me')]
  .filter((l) => l.textContent.trim().endsWith(t)).length, text);
const rect = (pg, sel) => pg.evaluate((s) => { const e = document.querySelector(s); if (!e) return null;
  const r = e.getBoundingClientRect(); const cs = getComputedStyle(e);
  return { l: r.left, t: r.top, r: r.right, b: r.bottom, shown: cs.display !== 'none' && cs.visibility !== 'hidden' && +cs.opacity > 0 && r.width > 0 }; }, sel);
const meets = (a, b) => a && b && a.l < b.r && a.r > b.l && a.t < b.b && a.b > b.t;
// the ∃ menu is a dropdown (owner, 10-01): what the old menu held lives in its Panels ▸ flyout, HUD layout mode (the old
// click-∃ arranging) included — one place to say how they are reached
const menuOpen = (pg) => pg.evaluate(() => !document.getElementById('emenu').hidden);
const openPanels = async (pg) => {
  if (!(await menuOpen(pg))) { await pg.click('#hud'); await sleep(250); }
  await pg.click('#emenu .mrow[data-item="panels"]'); await sleep(250);
};
const closeMenu = async (pg) => { for (let i = 0; i < 2 && (await menuOpen(pg)); i++) { await pg.keyboard.press('Escape'); await sleep(200); } };
const layoutMode = async (pg, on) => {
  if ((await pg.evaluate(() => document.body.classList.contains('arranging'))) === on) return;
  if (on) { await openPanels(pg); await pg.click('#emenu-sub .mrow[data-layout]'); await sleep(200); await closeMenu(pg); }
  else { await pg.keyboard.press('Escape'); await sleep(250); }
};
const resetLayoutViaMenu = async (pg) => {
  await openPanels(pg);
  await pg.click('#emenu-sub .mrow[data-reset]'); await sleep(300);
  await closeMenu(pg);
};
const type = async (pg, text) => { await pg.keyboard.press('Control+k'); await sleep(150); await pg.keyboard.type(text, { delay: 15 }); await sleep(200); };

try {
  // ------------------------------------------------------------ desktop 1280x720
  const { ctx, pg, errs } = await boot({ viewport: { width: 1280, height: 720 } }, 'lanterndesk');
  await shot(pg, '01-default-1280x720.png');

  const d = await pg.evaluate(() => {
    const w = document.querySelector('.frame[data-frame="world"]');
    const chip = document.getElementById('stchip-webgl')?.getBoundingClientRect();   // statuschips.js: #stchip-<id>
    const pop = document.getElementById('stpop');
    return { world: w ? getComputedStyle(w).display : 'absent', chip: chip ? [chip.width, chip.height] : null,
      popHidden: pop?.hidden ?? null, card: !!document.querySelector('.capnotice:not(#lite-banner)') };
  });
  check('quiet default: the world panel starts CLOSED on a fresh profile', d.world === 'none', JSON.stringify(d));
  check('quiet default: the WebGL 2 note is a small chip (≤ 140×32), its text folded away',
    d.chip && d.chip[0] > 0 && d.chip[0] <= 140 && d.chip[1] <= 32 && d.popHidden === true && !d.card, JSON.stringify(d));

  await pg.click('#stchip-webgl');
  await sleep(300);
  const pop = await pg.evaluate(() => { const p = document.getElementById('stpop'); const r = p.getBoundingClientRect();
    return { hidden: p.hidden, text: p.textContent, inView: r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight }; });
  check('chip click expands the full text, with "don’t show again", inside the viewport',
    !pop.hidden && /Running on WebGL 2/.test(pop.text) && /show again/.test(pop.text) && pop.inView, JSON.stringify(pop));
  await shot(pg, '04-chip-expanded-1280x720.png');
  await pg.click('#stchip-webgl'); await sleep(200);

  // Enter-to-chat is untouched
  await pg.mouse.click(640, 300); await sleep(200);
  await pg.keyboard.press('Enter'); await sleep(300);
  check('Enter still focuses the chat line (the prompt is additive)', await pg.evaluate(() => document.activeElement?.id === 'chatline'));
  await pg.keyboard.press('Escape'); await sleep(200);

  // PEOPLE HERE, collapsed: no strip in the chat body, so tabs/log/compose sit centred; the tab row's presence chip
  // is the toggle (R, 09-29: off-centre "when it's collapsed")
  { const cols = await rect(pg, '.chat-frame .chat-cols'), main = await rect(pg, '.chat-frame .chat-main');
    const strip = await rect(pg, '.chat-frame .chat-side-tog'), chip = await rect(pg, '.chat-frame .chat-who');
    const chipText = await pg.evaluate(() => document.querySelector('.chat-frame .chat-who')?.textContent?.trim());
    check('people collapsed: no side strip, the chat body spans the whole panel (centred)',
      !strip?.shown && cols && main && Math.abs(main.l - cols.l) < 1 && Math.abs(main.r - cols.r) < 1, JSON.stringify({ cols, main, strip }));
    check('…and the presence chip sits in the tab row, reading "just you"', chip?.shown && chipText === 'just you', JSON.stringify({ chip, chipText }));
    await pg.click('.chat-frame .chat-who'); await sleep(250);
    // OPEN: the chip steps out of the tab row and the column's header is the close control, its chevron toward the edge
    // the column collapses to; the column sits on the side Chat ▸ settings names
    const openState = () => pg.evaluate(() => {
      const c = document.querySelector('.chat-frame .chat-who'), head = document.querySelector('.chat-frame .chat-side-head');
      const side = document.querySelector('.chat-frame .chat-side').getBoundingClientRect(), main = document.querySelector('.chat-frame .chat-main').getBoundingClientRect();
      const cs = getComputedStyle(head, head.dataset.chev && document.querySelector('.chat-frame .chat-cols').classList.contains('side-left') ? '::before' : '::after');
      return { chipShown: !!c && getComputedStyle(c).display !== 'none', role: head.getAttribute('role'), chev: cs.content.replace(/"/g, ''), headText: head.textContent,
        sideLeftOfMain: side.right <= main.left + 1, sideRightOfMain: side.left >= main.right - 1, sideW: side.width,
        chevX: head.getBoundingClientRect(), bar: [...(c?.parentElement?.children ?? [])].map((x) => x.className) };
    });
    let st = await openState();
    check('open (left, the default): the chip is hidden; the column sits LEFT of the chat, its header a button with ‹',
      !st.chipShown && st.role === 'button' && st.chev === '‹' && st.sideLeftOfMain && st.sideW > 0, JSON.stringify(st));
    await pg.mouse.move(900, 300); await sleep(150);
    await shot(pg, '13-people-open-header-close.png');
    // the gear: at the right end of the compose box, its popover opening UPWARD from there
    const gear = await rect(pg, '.chat-frame .chat-compose > .chat-gear'), line = await rect(pg, '#chatline');
    check('the gear sits inside the compose box, at its right end (not in the tab row)',
      gear?.shown && line && gear.l > line.l && gear.r <= line.r && gear.t >= line.t - 1 && gear.b <= line.b + 1 && line.r - gear.r < 16
      && !(await pg.$('.chat-frame .chat-tabs .chat-gear')), JSON.stringify({ gear, line }));
    await pg.click('.chat-frame .chat-compose > .chat-gear'); await sleep(200);
    const gp = await rect(pg, '.chat-frame .chat-gearpop');
    check('…its popover opens upward from it, right edges aligned', gp?.shown && gp.b <= gear.t && gear.t - gp.b <= 10 && Math.abs(gp.r - gear.r) <= 1, JSON.stringify({ gp, gear }));
    await shot(pg, '12-chat-gear-in-compose.png');
    await pg.click('.chat-gearpop [data-side="right"]'); await sleep(250);
    await pg.keyboard.press('Escape'); await sleep(150);
    st = await openState();
    check('Chat ▸ settings → right: the column moves RIGHT of the chat, its header’s chevron ›, the chip still hidden',
      !st.chipShown && st.chev === '›' && st.sideRightOfMain, JSON.stringify(st));
    await pg.mouse.move(900, 300);
    await shot(pg, '13b-people-open-right-header-close.png');
    await pg.click('.chat-frame .chat-side-head'); await sleep(250);
    const back = await pg.evaluate(() => { const c = document.querySelector('.chat-frame .chat-who');
      return { shown: getComputedStyle(c).display !== 'none', last: c.parentElement.lastElementChild === c, text: c.textContent.trim(),
        closed: document.querySelector('.chat-frame .chat-side').classList.contains('closed') }; });
    check('clicking the header closes the column; the chip comes back at the right end of the tab row', back.closed && back.shown && back.last && back.text === 'just you', JSON.stringify(back));
    await pg.click('.chat-frame .chat-compose > .chat-gear'); await sleep(200);
    await pg.click('.chat-gearpop [data-side="left"]'); await sleep(250);
    await pg.keyboard.press('Escape'); await sleep(150);
    const lf = await pg.evaluate(() => { const c = document.querySelector('.chat-frame .chat-who'); return c.parentElement.firstElementChild === c; });
    check('…and back on the left, the chip is first in the row', lf);
  }

  // THE RAIL'S SEARCH ENTRY, between emotes and debug: the house tooltip names it and its chord; a click opens the prompt
  { const titles = await pg.evaluate(() => Object.fromEntries([...document.querySelectorAll('#dock button[data-toggles]')]
      .map((b) => [b.dataset.toggles, b.getAttribute('title') ?? b._tip])));
    check('every rail tooltip names its key where the registry knows one (real client: main.js merges them)',
      titles.chat === 'Chat · Enter' && titles.debug === 'Debug · F3' && titles.world === 'World' && /^Edit · B/.test(titles.edit ?? ''), JSON.stringify(titles));
    const rail = await pg.evaluate(() => [...document.querySelectorAll('#dock button[data-toggles]')].map((b) => b.dataset.toggles));
    check('the search entry sits between emotes and debug, pinned (owner, 10-01)', rail.indexOf('search') === rail.indexOf('emotes') + 1
      && rail.indexOf('debug') === rail.indexOf('search') + 1 && !(await pg.evaluate(() => document.querySelector('#dock button[data-toggles="search"]').hidden)), rail.join());
    await pg.hover('#dock button[data-toggles="search"]'); await sleep(700);
    const tipc = await pg.evaluate(() => { const t = document.getElementById('tipchip'); return { show: t.classList.contains('show'), text: t.textContent }; });
    check('hovering it shows the house tooltip "Search & commands · Ctrl K"', tipc.show && tipc.text === 'Search & commands · Ctrl K', JSON.stringify(tipc));
    await shot(pg, '14-dock-search-tooltip.png');
    await pg.click('#dock button[data-toggles="search"]'); await sleep(250);
    const lit = await pg.evaluate(() => document.querySelector('#dock button[data-toggles="search"]').classList.contains('on'));
    check('clicking it opens the prompt, and the entry lights while it is open', (await lantern(pg)).open && lit);
    await pg.keyboard.press('Escape'); await sleep(200);
    check('…Esc closes it, and the entry goes dark', !(await lantern(pg)).open
      && !(await pg.evaluate(() => document.querySelector('#dock button[data-toggles="search"]').classList.contains('on'))));
  }

  // Ctrl+K opens
  await pg.keyboard.press('Control+k'); await sleep(250);
  let L = await lantern(pg);
  check('Ctrl+K opens the prompt with its line focused', L.open && L.focused, JSON.stringify({ open: L.open, focused: L.focused }));
  check('an empty prompt lists the registry (> 40 actions)', L.rows.length > 40, String(L.rows.length));
  const counts = await pg.evaluate(async () => {
    const A = await import('/lib/actions.js');
    const by = {}; for (const a of A.all()) by[a.group] = (by[a.group] ?? 0) + 1;
    return { total: A.all().length, by };
  });
  console.log('  registry:', JSON.stringify(counts));
  // the hint bar shares the open panel's bottom band (both bottom 24px): while the lantern is open it steps aside
  await pg.evaluate(async () => (await import('/lib/ui.js')).flashHint('probe flash over the open lantern', 1500)); await sleep(150);
  { const hb = await rect(pg, '#hintbar'), foot = await rect(pg, '#lantern .ln-foot');
    check('open: a flash does not paint the hint bar over the lantern\'s footer', foot?.shown && !(hb?.shown && meets(hb, foot)), JSON.stringify({ hb, foot })); }
  await sleep(1500);
  // a press on the panel's own chrome (the footer) keeps it open with the caret in the line
  { const fr = await rect(pg, '#lantern .ln-foot');
    await pg.mouse.click(Math.round(fr.l + 6), Math.round((fr.t + fr.b) / 2)); await sleep(300);
    const after = await lantern(pg);
    check('a click on the footer keeps the lantern open and its line focused', after.open && after.focused, JSON.stringify({ open: after.open, focused: after.focused })); }
  await pg.keyboard.press('Escape'); await sleep(150);
  check('Esc closes it', !(await lantern(pg)).open);

  // the resting line: ONE element bottom-centre, clear of the chat compose box
  const compose = await rect(pg, '.chat-compose');
  const rest = await rect(pg, '#lantern-pill');
  check('the resting line keeps clear of the chat compose box (1280x720)', rest?.shown && compose?.shown && !meets(rest, compose),
    JSON.stringify({ rest, compose }));
  // the bar fades in (opacity .5s) from the faded state the open-lantern flash above left it in: wait for it
  await pg.evaluate(async () => (await import('/lib/ui.js')).flashHint('probe flash', 1500));
  for (let i = 0; i < 20 && !(await rect(pg, '#hintbar'))?.shown; i++) await sleep(50);
  const during = { hint: await rect(pg, '#hintbar'), rest: await rect(pg, '#lantern-pill') };
  check('a flash borrows the resting line’s spot: the hint shows, the line steps aside (never both)',
    during.hint?.shown && !during.rest?.shown && Math.abs((during.hint.l + during.hint.r) / 2 - (rest.l + rest.r) / 2) < 2,
    JSON.stringify(during));
  await sleep(2200);
  check('…and the line comes back when the flash is done', (await rect(pg, '#lantern-pill'))?.shown);

  // ESC QUIET: with nothing else claiming Esc it puts every open panel away and says how to get them back; Esc again
  // brings back exactly those. The layered closes come first: an open ∃ menu or the chat gear's popover takes Esc
  // and the panels stay.
  { const shown = () => pg.evaluate(() => [...document.querySelectorAll('.frame')].filter((f) => getComputedStyle(f).display !== 'none')
      .map((f) => f.dataset.frame).sort().join());
    await pg.mouse.click(900, 300); await sleep(200);
    const before = await shown();
    await pg.click('#hud'); await sleep(250);
    await pg.keyboard.press('Escape'); await sleep(200);
    check('Esc with the ∃ menu open closes the menu, not the panels',
      await pg.evaluate(() => document.getElementById('emenu').hidden) && (await shown()) === before, JSON.stringify({ before, now: await shown() }));
    await pg.click('.chat-frame .chat-compose > .chat-gear'); await sleep(200);
    await pg.keyboard.press('Escape'); await sleep(200);
    check('Esc with the chat gear’s popover open folds it, not the panels',
      await pg.evaluate(() => document.querySelector('.chat-gearpop').hidden) && (await shown()) === before, JSON.stringify({ before, now: await shown() }));
    await pg.mouse.click(900, 300); await sleep(200);
    await pg.keyboard.press('Escape'); await sleep(300);
    const hid = { frames: await shown(), hint: await rect(pg, '#hintbar'), hintText: await pg.evaluate(() => document.getElementById('hintbar').textContent),
      pill: await rect(pg, '#lantern-pill') };
    check('Esc (nothing else claiming it) hides every open panel', before.length > 0 && hid.frames === '', JSON.stringify({ before, ...hid }));
    check('…and the hint bar says "panels hidden · Esc to bring back" in the resting line’s place', hid.hint?.shown && /^panels hidden · Esc to bring back$/.test(hid.hintText.trim()) && !hid.pill?.shown,
      JSON.stringify(hid));
    await shot(pg, '15-esc-hidden.png');
    // the resting line went WITH the panels (owner, 10-01: "have it obey the 'esc to hide' feature") — so it stays away
    // after the flash is done too, not only while the hint bar borrows its spot
    await sleep(4300);
    const later = { frames: await shown(), hintGone: await pg.evaluate(() => document.getElementById('hintbar').classList.contains('gone')),
      pill: await rect(pg, '#lantern-pill'), cls: await pg.evaluate(() => document.getElementById('lantern-pill').className) };
    check('…and once the flash is done the resting line stays away with the panels', later.frames === '' && !later.pill?.shown && /quiet/.test(later.cls),
      JSON.stringify(later));
    // Ctrl+K still opens the lantern while they are away; Esc then closes the LANTERN first (its line owns the key)
    await pg.keyboard.press('Control+k'); await sleep(250);
    const kOpen = (await lantern(pg)).open;
    await pg.keyboard.press('Escape'); await sleep(300);
    const kShut = { open: (await lantern(pg)).open, frames: await shown(), pill: await rect(pg, '#lantern-pill') };
    check('panels hidden: Ctrl+K still opens the lantern, and Esc closes the lantern first (panels and pill stay away)',
      kOpen && !kShut.open && kShut.frames === '' && !kShut.pill?.shown, JSON.stringify({ kOpen, ...kShut }));
    await pg.keyboard.press('Escape'); await sleep(300);
    const back = { frames: await shown(), hintGone: await pg.evaluate(() => document.getElementById('hintbar').classList.contains('gone')), pill: await rect(pg, '#lantern-pill') };
    check('Esc again brings back exactly those panels, and the hint gives the spot back at once', back.frames === before && back.hintGone && back.pill?.shown, JSON.stringify({ before, ...back }));
    // NO PANEL OPEN (owner, 10-01: "Basically only the dock should be visible"): Esc still puts the resting line away
    await pg.evaluate(async () => { const F = await import('/lib/frames.js'); for (const f of F.allFrames()) f.hide(); });
    await sleep(200);
    await pg.keyboard.press('Escape'); await sleep(300);
    const bare = { frames: await shown(), pill: await rect(pg, '#lantern-pill'), dock: await rect(pg, '#dock'),
      hintText: await pg.evaluate(() => document.getElementById('hintbar').textContent) };
    check('no panel open: Esc puts the resting line away, the dock stays, the hint says "hidden · Esc to bring back"',
      bare.frames === '' && !bare.pill?.shown && bare.dock?.shown && /^hidden · Esc to bring back$/.test(bare.hintText.trim()), JSON.stringify(bare));
    await shot(pg, '15b-esc-only-the-dock.png');
    await pg.keyboard.press('Escape'); await sleep(300);
    const bareBack = { frames: await shown(), pill: await rect(pg, '#lantern-pill') };
    check('…and the next Esc brings the resting line back, opening no panel', bareBack.frames === '' && bareBack.pill?.shown, JSON.stringify(bareBack));
    await pg.evaluate(async (ids) => { const F = await import('/lib/frames.js'); for (const id of ids.split(',').filter(Boolean)) F.getFrame(id)?.show(); }, before);
    await sleep(200);
  }

  // UNPIN (owner, 10-01: "add it as a pin feature for the reverse-E menu (might need its own logo to differentiate)"): the
  // ∃ menu's lantern row, in a group of its own after the voice rows, pins the resting line. Unpinned: no pill, but
  // Ctrl+K still opens it.
  { const menuRow = () => pg.evaluate(() => { const r = document.querySelector('#emenu-sub .mrow[data-row="lantern"]');
      return r && { prev: r.previousElementSibling?.className ?? null, prevRow: r.previousElementSibling?.previousElementSibling?.dataset.row ?? null,
        next: r.nextElementSibling?.className ?? null, on: r.querySelector('.mpin')?.classList.contains('on'), pinTitle: r.querySelector('.mpin')?.title }; });
    await openPanels(pg);
    const r0 = await menuRow();
    check('the ∃ menu (Panels ▸) lists the lantern in a group of its own after the voice rows, pinned', r0?.prev === 'msep' && r0?.next === 'msep'
      && r0?.prevRow === 'glyph:xr' && r0?.on === true, JSON.stringify(r0));
    await shot(pg, '16a-emenu-lantern-group.png');
    await pg.click('#emenu-sub .mpin[data-pin="lantern"]'); await sleep(200);
    const r1 = await menuRow();
    await shot(pg, '16-emenu-lantern-unpinned.png');
    await closeMenu(pg);   // the open menu takes these Escs (the flyout, then the menu); the panels stay
    const un = { pill: await rect(pg, '#lantern-pill'), saved: await pg.evaluate(() => localStorage.getItem('ew-lantern-pinned')),
      menu: await pg.evaluate(() => document.getElementById('emenu').hidden) };
    check('unpinned: no resting line, and the choice is saved', r1?.on === false && !un.pill?.shown && un.saved === '0' && un.menu, JSON.stringify({ r1, ...un }));
    await pg.keyboard.press('Control+k'); await sleep(250);
    const kU = (await lantern(pg)).open;
    await pg.keyboard.press('Escape'); await sleep(250);
    check('…but Ctrl+K still opens the lantern, and Esc closes it', kU && !(await lantern(pg)).open);
    // pin it back for the rest of the walk (localStorage lives on in this context)
    await openPanels(pg);
    await pg.click('#emenu-sub .mpin[data-pin="lantern"]'); await sleep(200);
    await closeMenu(pg);
    check('pinned again: the resting line is back', (await rect(pg, '#lantern-pill'))?.shown);
  }

  // observe the acts the keys may or may not fire
  await pg.evaluate(async () => {
    const A = await import('/lib/actions.js');
    globalThis.__acts = [];
    for (const id of ['body:sit', 'cmd:sit', 'section:world:sky']) {
      const a = A.get(id); if (!a?.run) continue;
      const orig = a.run; a.run = (...r) => { globalThis.__acts.push(id); return orig(...r); };
    }
    const me = globalThis.EW.me(); const orig = me.playEmote.bind(me);
    globalThis.__emoted = []; me.playEmote = (n, ...r) => { globalThis.__emoted.push(n); return orig(n, ...r); };
  });
  const acts = () => pg.evaluate(() => globalThis.__acts.splice(0));
  const posture = () => pg.evaluate(async () => (await import('/lib/controller.js')).getPosture?.() ?? null);

  // "sk" — the say row first, the best action highlighted with its Tab badge (screenshot 02)
  await type(pg, 'sk');
  L = await lantern(pg);
  check('"sk": the say row is first and carries the Enter badge', L.rows[0]?.kind.startsWith('say') && L.rows[0]?.do === 'Enter',
    JSON.stringify(L.rows.slice(0, 3)));
  check('"sk": the sky section is the highlighted best match, wearing Tab', L.hl?.title === 'sky' && L.hl?.do === 'Tab', JSON.stringify(L.hl));
  const pbox = await rect(pg, '#lantern');
  check('the open panel keeps clear of the chat compose box', pbox?.shown && !meets(pbox, compose), JSON.stringify({ pbox, compose }));
  check('the resting line is hidden while the panel is open (one element)', !(await rect(pg, '#lantern-pill'))?.shown);
  await shot(pg, '02-lantern-sk-1280x720.png');

  // "sky" + Tab → the section
  await pg.keyboard.type('y'); await sleep(150);
  await pg.keyboard.press('Tab'); await sleep(1500);
  const sky = await pg.evaluate(() => ({ world: getComputedStyle(document.querySelector('.frame[data-frame="world"]')).display,
    open: document.getElementById('sec-sky')?.classList.contains('open') ?? null,
    tab: document.getElementById('sec-sky-tab')?.classList.contains('on') ?? null,
    others: [...document.querySelectorAll('.frame[data-frame="world"] .sec.open')].map((x) => x.id) }));
  check('"sky" + Tab opens the world panel on its sky TAB (that pane alone, its tab chosen)', sky.world !== 'none' && sky.open === true && sky.tab === true && sky.others.join() === 'sec-sky', JSON.stringify(sky));
  check('running an action closes the prompt', !(await lantern(pg)).open);
  await acts();
  await pg.evaluate(() => { document.querySelector('#dock button[data-toggles="world"]')?.click(); });   // put it away again
  await sleep(300);

  // "sit" + Enter SAYS it — and does not sit
  const saidBefore = await said(pg, 'sit');
  const p0 = await posture();
  await type(pg, 'sit');
  L = await lantern(pg);
  check('"sit": the say row first, a sit action highlighted with Tab', L.rows[0]?.kind.startsWith('say') && /sit/.test(L.hl?.title ?? '') && L.hl?.do === 'Tab',
    JSON.stringify({ first: L.rows[0], hl: L.hl }));
  await shot(pg, '07-lantern-sit-tab.png');
  await pg.keyboard.press('Enter');
  const sitSaid = await pg.waitForFunction((n) => [...document.querySelectorAll('#chatlog .line.me')]
    .filter((l) => l.textContent.trim().endsWith('sit')).length > n, saidBefore, { timeout: 8000 }).then(() => true, () => false);
  await sleep(600);
  const a1 = await acts(); const p1 = await posture();
  check('"sit" + Enter sends "sit" through chat (echoed into #chatlog)', sitSaid);
  check('"sit" + Enter does NOT sit (no sit action ran, posture unchanged)', a1.length === 0 && p1 === p0, JSON.stringify({ a1, p0, p1 }));

  // "sit" + Tab sits
  await type(pg, 'sit');
  await pg.keyboard.press('Tab'); await sleep(800);
  const a2 = await acts(); const p2 = await posture();
  check('"sit" + Tab sits (a sit action ran; posture is sit)', a2.some((x) => /sit$/.test(x)) && p2 === 'sit', JSON.stringify({ a2, p2 }));
  check('…and Tab said nothing in chat', (await said(pg, 'sit')) === saidBefore + 1, String(await said(pg, 'sit')));
  await pg.evaluate(async () => (await import('/lib/actions.js')).run('posture:stand')); await sleep(500);
  await acts();

  // a MOVED highlight: Enter runs the row the person chose
  await type(pg, 'sky');
  await pg.keyboard.press('ArrowDown'); await pg.keyboard.press('ArrowUp'); await sleep(100);
  L = await lantern(pg);
  check('after ↑/↓ the highlighted row wears Enter and the say row gives it up', L.hl?.do === 'Enter' && L.rows[0]?.do === null, JSON.stringify({ first: L.rows[0], hl: L.hl }));
  await pg.keyboard.press('Enter'); await sleep(1200);
  const a3 = await acts();
  check('…and Enter runs that row (the sky section), not speech', a3.includes('section:world:sky') && !(await said(pg, 'sky')), JSON.stringify(a3));
  await pg.evaluate(() => { document.querySelector('#dock button[data-toggles="world"]')?.click(); });
  await sleep(300);

  // "wave" + Tab — the emote plays
  await type(pg, 'wave');
  L = await lantern(pg);
  check('"wave" highlights the wave emote, its number key and Tab shown', L.hl?.title === 'wave' && /^[1-9]$/.test(L.hl?.key ?? '') && L.hl?.do === 'Tab', JSON.stringify(L.hl));
  await shot(pg, '03-lantern-wave-1280x720.png');
  await pg.keyboard.press('Tab'); await sleep(400);
  check('"wave" + Tab plays the emote (playEmote("wave") observed)', (await pg.evaluate(() => globalThis.__emoted)).includes('wave'),
    JSON.stringify(await pg.evaluate(() => globalThis.__emoted)));

  // a typo + Tab: nothing to do, so nothing happens — Tab never says
  { const before = await said(pg, 'zzqx');
    await type(pg, 'zzqx'); await pg.keyboard.press('Tab'); await sleep(600);
    const after = await lantern(pg);
    check('"zzqx" + Tab says nothing and leaves the lantern open', (await said(pg, 'zzqx')) === before && after.open, JSON.stringify({ before, now: await said(pg, 'zzqx'), open: after.open }));
    await pg.keyboard.press('Escape'); await sleep(150); }

  // plain speech: the say row first → chat's own send path (server echo lands in the log)
  await type(pg, 'hello there');
  L = await lantern(pg);
  check('"hello there" offers say-in-chat as the first row', /^say “hello there” in chat$/.test(L.rows[0]?.shown ?? ''), JSON.stringify(L.rows.slice(0, 2)));
  await pg.keyboard.press('Enter');
  const hello = await pg.waitForFunction(() => /hello there/.test(document.getElementById('chatlog')?.textContent ?? ''), null, { timeout: 8000 }).then(() => true, () => false);
  check('Enter sends it through the existing chat path (echoed into #chatlog)', hello);

  // "/" passes through to the command path
  await type(pg, '/who');
  L = await lantern(pg);
  check('"/who" leads with the pass-through row', L.rows[0]?.shown === 'run /who', JSON.stringify(L.rows.slice(0, 2)));
  await pg.keyboard.press('Enter');
  const who = await pg.waitForFunction(() => /here now:/.test(document.getElementById('chatlog')?.textContent ?? ''), null, { timeout: 5000 }).then(() => true, () => false);
  check('"/who" + Enter runs the command (its "here now:" line appears)', who);

  // the mouse: the pill opens it, a click on a row runs it
  await pg.click('#lantern-pill'); await sleep(200);
  await pg.keyboard.type('mute'); await sleep(150);
  L = await lantern(pg);
  check('the resting line opens the prompt; "mute" highlights the microphone (keyword) with its key', L.open && L.hl?.title === 'microphone on / off' && L.hl?.key === 'V', JSON.stringify(L.rows.slice(0, 2)));
  await pg.keyboard.press('Control+a'); await pg.keyboard.type('audio'); await sleep(150);
  await pg.locator('#lantern .ln-row', { has: pg.locator('.ln-title', { hasText: /^audio$/ }) }).first().click();
  await sleep(1000);
  const audio = await pg.evaluate(() => ({ settings: getComputedStyle(document.querySelector('.frame[data-frame="settings"]')).display,
    open: document.getElementById('sec-audio')?.classList.contains('open') ?? null,
    tab: document.getElementById('sec-audio-tab')?.classList.contains('on') ?? null,
    others: [...document.querySelectorAll('.frame[data-frame="settings"] .sec.open')].map((x) => x.id) }));
  check('clicking the "audio" row opens settings on its audio TAB', audio.settings !== 'none' && audio.open === true && audio.tab === true && audio.others.join() === 'sec-audio', JSON.stringify(audio));
  // MOVE (owner, 10-01: "enable grabbing and moving the lantern … in menu-moving mode"): in HUD layout mode the resting line
  // drags like a frame; the hint bar that borrows its spot follows it, the open panel stays on screen (hanging down from
  // a pill in the top half), the spot survives a reload, and reset layout puts it back
  { await pg.mouse.click(900, 300); await sleep(300);   // (not Esc: with nothing open to close, Esc puts the resting line away)
    const centre = (r) => r && [(r.l + r.r) / 2, (r.t + r.b) / 2];
    const p0 = await rect(pg, '#lantern-pill');
    const c0 = centre(p0);
    await layoutMode(pg, true);
    await pg.mouse.move(c0[0], c0[1]); await pg.mouse.down();
    for (let i = 1; i <= 8; i++) { await pg.mouse.move(c0[0] - (300 * i) / 8, c0[1] - (420 * i) / 8); await sleep(16); }
    await pg.mouse.up(); await sleep(200);
    const m = { pill: await rect(pg, '#lantern-pill'), saved: await pg.evaluate(() => localStorage.getItem('ew-lantern-pos')), open: (await lantern(pg)).open };
    const c1 = centre(m.pill);
    check('HUD layout mode: dragging the resting line moves it with the pointer, and the spot is saved',
      Math.abs(c1[0] - (c0[0] - 300)) < 3 && Math.abs(c1[1] - (c0[1] - 420)) < 3 && !!m.saved, JSON.stringify({ c0, c1, ...m }));
    check('…and the drag does not open the lantern', !m.open);
    await shot(pg, '17-lantern-moved-layout-mode.png');
    await layoutMode(pg, false);
    await pg.evaluate(async () => (await import('/lib/ui.js')).flashHint('probe flash', 1500));
    for (let i = 0; i < 20 && !(await rect(pg, '#hintbar'))?.shown; i++) await sleep(50);
    const h = centre(await rect(pg, '#hintbar'));
    check('the hint bar that borrows its spot follows the moved line', h && Math.abs(h[0] - c1[0]) < 2 && Math.abs(h[1] - c1[1]) < 2, JSON.stringify({ h, c1 }));
    await sleep(1800);
    await pg.keyboard.press('Control+k'); await sleep(250);
    const ln = await rect(pg, '#lantern');
    check('opened from a pill in the top half, the lantern hangs down from it and stays on screen',
      ln?.shown && ln.l >= 0 && ln.r <= 1280 && ln.t >= 0 && ln.b <= 720 && Math.abs(ln.t - m.pill.t) < 2, JSON.stringify({ ln, pill: m.pill }));
    await shot(pg, '18-lantern-moved-open.png');
    await pg.keyboard.press('Escape'); await sleep(200);
    await pg.reload({ waitUntil: 'domcontentloaded' });
    await pg.waitForFunction(() => document.getElementById('splash')?.classList.contains('gone') && !!globalThis.EW?.me?.(), null, { timeout: 120000 });
    await sleep(2500);
    const c2 = centre(await rect(pg, '#lantern-pill'));
    check('after a reload the resting line is where it was moved', Math.abs(c2[0] - c1[0]) < 2 && Math.abs(c2[1] - c1[1]) < 2, JSON.stringify({ c1, c2 }));
    await resetLayoutViaMenu(pg);
    const p3 = await rect(pg, '#lantern-pill');
    check('reset layout puts it back on the bottom band, the saved spot gone',
      Math.abs(p3.b - (720 - 24)) < 2 && !(await pg.evaluate(() => localStorage.getItem('ew-lantern-pos'))), JSON.stringify(p3));
  }
  check('no page errors on the desktop run', errs.length === 0, errs.slice(0, 3).join(' | '));
  await ctx.close();

  // ------------------------------------------------------------ phone 390x844
  const ph = await boot({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 1 }, 'lanternphone');
  await shot(ph.pg, '05-phone-default-390x844.png');
  const pr = await ph.pg.evaluate(() => { const r = document.getElementById('lantern-pill').getBoundingClientRect(); return [r.left, r.top, r.right, r.bottom]; });
  check('phone: the pill is on screen', pr[0] >= 0 && pr[2] <= 390 && pr[1] >= 0 && pr[3] <= 844, JSON.stringify(pr));
  await ph.pg.tap('#lantern-pill'); await sleep(300);
  await ph.pg.keyboard.type('sk'); await sleep(200);
  const PL = await lantern(ph.pg);
  const box = await ph.pg.evaluate(() => { const r = document.getElementById('lantern').getBoundingClientRect(); return [r.left, r.top, r.right, r.bottom]; });
  check('phone: tapping the pill opens the prompt inside the viewport', PL.open && box[0] >= 0 && box[2] <= 390 && box[1] >= 0 && box[3] <= 844, JSON.stringify(box));
  await shot(ph.pg, '06-phone-lantern-open-390x844.png');
  check('no page errors on the phone run', ph.errs.length === 0, ph.errs.slice(0, 3).join(' | '));
  await ph.ctx.close();
} finally {
  await close().catch(() => {});
  await world.close();
}
done();
