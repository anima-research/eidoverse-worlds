// ui-menu — the ∃ menu: the File-style waterfall beside the rail, its flyouts, the pins and HUD layout mode.
import { chooseClient } from './litechoice.js';
import { confirmCenter } from '../edit/confirmcenter.js';
import { bus, CONFIG, forgetRememberedWorlds } from '../base.js';
import { versionReady } from '../version.js';
import { resizeZoneAt, getFrame, isLocked, setLocked } from './windows.js';
import { flipMic, flipEar, micLive, earOn, glyphPinned, setGlyphPinned, micGlyph, micIndicator, earGlyph, xrGlyph, xrGlyphAvailable, flipXr } from '../audio/mictoggle.js';
import { fsvg } from './icons.js';
import { paint, escapeHtml } from './markup.js';
import { register as registerAction } from './actions.js';
import { openLantern, closeLantern, isLanternOpen, CHORD, pillPinned, setPillPinned } from './commandbar.js';
import { el, openOverlay, resetHudLayout, toast, toggleHelp } from './ui.js';
import { SEARCH_ENTRY, bindMenu, dockEntries, iconOf, paintDock, pins, savePins } from './ui-dock.js';
const $ = (id) => document.getElementById(id);

// ---- the ∃ menu: a File-style waterfall -------------------
// It pops out beside the ∃/dock, over the mic/headphones/visor icons. Top level: Save world · Load world · Panels ▸ ·
// Lite client · Log in · Help · Keys · About ▸. Settings and Profile stay on the rail. Panels ▸ holds HUD layout mode, the pins, the
// lock and reset layout. An item never dismisses the menu unless it takes you to another window (help, a login page);
// the menu goes on mouse-away (desktop), a press outside it, and Esc.
addEventListener('keydown', (e) => { if (e.key === 'Alt') document.body.classList.add('altgrab'); });
addEventListener('keyup', (e) => { if (e.key === 'Alt') document.body.classList.remove('altgrab'); });
addEventListener('blur', () => document.body.classList.remove('altgrab'));

// What the menu needs to know that it cannot import (net.js is above this rung): INJECTED by main.js, like ui.js's
// load list. Defaults are the truth for a client with no server: no build rights, no sign-in.
let menuSrc = { buildRights: () => false, loginUrl: () => null };
export function setMenuSources(src) { menuSrc = { ...menuSrc, ...src }; if (!emenuEl()?.hidden) paintEMenu(); }

// Save and load are honest stubs: the server has no save points to make or restore (a world IS its append-only log,
// so every change is already kept; /fork copies a world's current things under a new name, owner-only: not its chat, and
// of its about only the title, server/worldlog.ts forkWorld).
const NEEDS_RIGHTS = 'needs build rights in this world';
const SAVE_WHY = 'not yet — this world already keeps every change as it happens (its log); save points need server support. /fork <name> copies its things today, not its chat (owner)';
const LOAD_WHY = 'not yet — restoring a saved world needs server support; a copy made with /fork is its own world (?world=<name>)';
const NO_LOGIN = 'this server has no sign-in — it admits by door key';
const AWAY_MS = 450;   // mouse-away grace: crossing the gap to a flyout, or a wobble off the edge, does not shut the menu

const emenuEl = () => document.getElementById('emenu');
const subEl = () => document.getElementById('emenu-sub');
let subFor = null;     // which top-level row the open flyout belongs to ('panels' | 'about'), null = none
let subCloseT = null;
let layoutBar = null;

// ---- HUD layout mode: the old click-∃ behaviour, now its own switch. Frames show their title tabs and rims, the rail
// its grip, the lantern's resting line goes grabbable (index.html body.arranging). It ends on Esc, on a press out in
// the world, or on its own switch; never because the menu closed.
const isLayoutMode = () => document.body.classList.contains('arranging');
function setLayoutMode(on) {
  document.body.classList.toggle('arranging', !!on);
  paintLayoutBar();
  paintEMenu();
}
function paintLayoutBar() {
  if (!layoutBar) return;
  layoutBar.hidden = !isLayoutMode();
  if (!layoutBar.hidden) anchorBeside(layoutBar);
}

function initEMenu() {
  el.hud.onclick = () => toggleEMenu();
  const m = emenuEl();
  let s = subEl();
  if (!s) { s = document.createElement('div'); s.id = 'emenu-sub'; s.className = 'panel'; s.hidden = true; m.after(s); }
  s.addEventListener('pointerenter', () => clearTimeout(subCloseT));
  for (const box of [m, s]) {
    box.setAttribute('role', 'menu');
    // a pin is bookkeeping: it never takes focus, so an open lantern keeps its line and stays open
    box.addEventListener('mousedown', (e) => { if (e.target.closest?.('.mpin')) e.preventDefault(); });
  }
  layoutBar = document.createElement('div');
  layoutBar.id = 'layoutbar'; layoutBar.className = 'panel'; layoutBar.hidden = true;
  layoutBar.innerHTML = `${fsvg('arrows-out-cardinal', 14)}<span>HUD layout — drag panels, the rail's grip, the resting line</span><kbd>Esc</kbd><button class="lb-done">done</button>`;
  layoutBar.querySelector('.lb-done').onclick = () => setLayoutMode(false);
  document.body.appendChild(layoutBar);
  addEventListener('resize', () => { paintLayoutBar(); if (!m.hidden) { anchorBeside(m); placeSub(); } });
  bus.on('dock-moved', () => { paintLayoutBar(); if (!m.hidden) { anchorBeside(m); placeSub(); } });
  // the mic row follows the HUD glyph as it changes (gold, a mute), not only at the dock's 2 s sweep
  bus.on('mic:indicator', () => paintEMenu());

  // Esc: the deepest level first — the flyout, then the menu, then HUD layout mode (windows.js's Tab toggle stands
  // aside for all three: escapeIsClaimed sees the open menu and body.arranging)
  addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!m.hidden) { if (subFor) closeSub(); else toggleEMenu(false); }
    else if (isLayoutMode()) setLayoutMode(false);
  });
  addEventListener('pointerdown', (e) => {
    const t = e.target instanceof Element ? e.target : null;
    // a press outside the menu (and outside the ∃, which toggles it by its own click) dismisses it — tap-outside
    if (!m.hidden && !t?.closest('#emenu, #emenu-sub, #hud')) toggleEMenu(false);
    // HUD layout mode survives presses on ANY chrome (panels, headers, the rail, the menu, the resting line) — it ends
    // out in the world (canvas/body)
    if (isLayoutMode() && !el.hud.contains(t)) {
      const inChrome = (t && t.closest('#emenu, #emenu-sub, #layoutbar, .frame, #dock, .panel, .hud-pop, #micbtn, #earbtn, #xrbtn, #hudstatus'))
        || resizeZoneAt(e.clientX, e.clientY);   // the grab band hangs 6px outside frames
      if (!inChrome) setLayoutMode(false);
    }
  }, true);
  // mouse-away (desktop only: a pen or a finger has no hover to leave with)
  let away = null;
  const arm = () => { if (!away) away = setTimeout(() => { away = null; toggleEMenu(false); }, AWAY_MS); };
  const disarm = () => { clearTimeout(away); away = null; };
  document.addEventListener('pointermove', (e) => {
    if (m.hidden || e.pointerType !== 'mouse') return;
    if (e.target instanceof Element && e.target.closest('#emenu, #emenu-sub, #hud')) disarm(); else arm();
  }, true);
  document.addEventListener('pointerout', (e) => { if (!m.hidden && e.pointerType === 'mouse' && !e.relatedTarget) arm(); }, true);   // left the window
  m.addEventListener('pointerenter', disarm);

  // the same acts, findable by name in the lantern ("save", "layout mode")
  registerAction({ id: 'menu:save', title: 'save world', group: 'world', icon: 'floppy-disk', keywords: ['save', 'snapshot', 'world', 'file'],
    detail: 'not yet — it tells you why', run: () => toast(menuSrc.buildRights() ? SAVE_WHY : `save world — ${NEEDS_RIGHTS}`, 'info', 9000) });
  registerAction({ id: 'menu:load', title: 'load world', group: 'world', icon: 'folder-open', keywords: ['load', 'open', 'restore', 'world', 'file'],
    detail: 'not yet — it tells you why', run: () => toast(menuSrc.buildRights() ? LOAD_WHY : `load world — ${NEEDS_RIGHTS}`, 'info', 9000) });
  registerAction({ id: 'menu:layout', title: 'HUD layout mode', group: 'panels', icon: 'arrows-out-cardinal',
    keywords: ['layout', 'arrange', 'move', 'hud', 'panels', 'drag'], detail: 'move panels, the rail and the resting line',
    run: () => setLayoutMode(!isLayoutMode()) });
  registerAction({ id: 'menu:reset-layout', title: 'reset layout', group: 'panels', icon: 'sparkle', keywords: ['layout', 'reset', 'default', 'panels'],
    detail: 'every window back where it started', run: () => { resetHudLayout(); paintDock(); } });
  registerAction({ id: 'menu:lock', title: 'lock / unlock the layout', group: 'panels', icon: 'lock', keywords: ['layout', 'lock', 'unlock', 'panels'],
    run: () => { setLocked(!isLocked()); paintEMenu(); } });
  registerAction({ id: 'menu:keys', title: 'keys', group: 'view', icon: 'keyboard', keywords: ['keys', 'controls', 'shortcuts', 'bindings'],
    detail: 'the key table', run: () => openKeys() });
  registerAction({ id: 'menu:about', title: 'about this build', group: 'view', icon: 'info', keywords: ['about', 'version', 'build', 'sha'],
    run: () => buildInfo().then((v) => toast(`eidoverse-worlds · ${v.lines.join(' · ')}`, 'info', 9000)) });
  registerAction({ id: 'menu:login', title: 'log in / log out', group: 'view', keywords: ['login', 'logout', 'sign in', 'sign out', 'account', 'discord'],
    run: () => { const it = loginItem(); if (it.dead) toast(it.dead, 'info'); else it.run(); } });
}

export function toggleEMenu(force) {
  const m = emenuEl();
  const open = force ?? m.hidden;
  if (!open) { closeSub(); m.hidden = true; return; }
  m.hidden = false;
  paintEMenu();
  anchorBeside(m);
}
// Beside the ∃, on the side away from the rail's edge: to the right of a left rail (over the mic/ear/visor glyphs),
// left of a right one, under a top rail, over a bottom one. Clamped to the viewport. Never remembered: a dropdown
// hangs from what opened it.
function anchorBeside(node) {
  // flush with the RAIL's box, not the glyph inside it
  const h = el.dock.getBoundingClientRect();
  const edge = el.dock.dataset.edge || 'left';
  node.style.left = node.style.top = '0px'; node.style.right = node.style.bottom = 'auto';
  const r = node.getBoundingClientRect();
  let x = h.right, y = h.top;
  if (edge === 'right') x = h.left - r.width;
  else if (edge === 'top') { x = h.left; y = h.bottom; }
  else if (edge === 'bottom') { x = h.left; y = h.top - r.height; }
  node.style.left = `${Math.round(Math.max(4, Math.min(innerWidth - r.width - 4, x)))}px`;
  node.style.top = `${Math.round(Math.max(4, Math.min(innerHeight - r.height - 4, y)))}px`;
}

// ---- the flyout: one at a time, beside its row
function openSub(id) {
  clearTimeout(subCloseT);
  const s = subEl();
  if (subFor !== id) {
    subFor = id;
    delete s.dataset.key;
    s.innerHTML = '';
    if (id === 'about') buildAbout(s); else buildPanels(s);
  }
  s.hidden = false;
  paintEMenu();
  placeSub();
}
function closeSub() {
  clearTimeout(subCloseT);
  const s = subEl();
  if (!s) return;
  subFor = null; s.hidden = true; s.innerHTML = ''; delete s.dataset.key;
  for (const r of emenuEl().querySelectorAll('.mrow.subopen')) r.classList.remove('subopen');
}
function placeSub() {
  const s = subEl(), m = emenuEl();
  if (!s || s.hidden || !subFor) return;
  const row = m.querySelector(`.mrow[data-item="${subFor}"]`);
  if (!row) return;
  const mr = m.getBoundingClientRect(), rr = row.getBoundingClientRect();
  s.style.left = s.style.top = '0px'; s.style.maxHeight = '';
  const r = s.getBoundingClientRect();
  // away from the rail: right of the menu, unless the rail is on the right; the other side when that one has no room
  const right = mr.right + 2, left = mr.left - 2 - r.width;
  const fitsR = right + r.width <= innerWidth - 4, fitsL = left >= 4;
  let x, y;
  if (fitsR || fitsL) {
    x = (el.dock.dataset.edge === 'right' ? fitsL || !fitsR : !fitsR) ? left : right;
    y = Math.max(4, Math.min(innerHeight - r.height - 4, rr.top - 6));   // its first row level with its parent row
  } else {
    // a phone: no room on either side — it hangs off its row, indented, so the row that opened it stays in view, on
    // whichever side has more screen, and scrolls inside exactly what is left there (never taller than the room)
    x = Math.max(4, Math.min(innerWidth - r.width - 4, mr.left + 16));
    const below = innerHeight - rr.bottom - 6, above = rr.top - 6;
    const h = Math.min(r.height, Math.max(below, above));
    y = below >= Math.min(r.height, 120) || below >= above ? rr.bottom + 2 : rr.top - 2 - h;
    s.style.maxHeight = `${Math.max(0, Math.round(h))}px`;
  }
  s.style.left = `${Math.round(x)}px`; s.style.top = `${Math.round(y)}px`;
}

// ---- rows
const fsvgOr = (name, size, fallback = 'puzzle-piece') => fsvg(name, size) || fsvg(fallback, size);
/** a top-level item: { id, icon, label, key?, tag?, detail?, title?, sub?, dead?, away?, run? } */
function topRow(it) {
  const row = document.createElement('button');
  row.className = `mrow${it.dead ? ' dead soft' : ''}${it.sub ? ' hassub' : ''}`;
  row.dataset.item = it.id;
  row.setAttribute('role', 'menuitem');
  const tail = it.sub ? `<span class="mcaret">${fsvg('caret-right', 10)}</span>`
    : it.key ? `<kbd class="mkey">${escapeHtml(it.key)}</kbd>` : it.tag ? `<span class="mtag">${escapeHtml(it.tag)}</span>` : '';
  row.innerHTML = `${fsvgOr(it.icon, 15)}<span class="mname">${escapeHtml(it.label)}${it.detail ? ` <em class="mdetail">${escapeHtml(it.detail)}</em>` : ''}</span>${tail}`;
  if (it.dead) {
    // listed, not offered — and it SAYS why on a press too (a finger or a laser has no hover for the tooltip)
    row.setAttribute('aria-disabled', 'true');
    row.title = `${it.label} — ${it.dead}`;
    row.onclick = () => { closeSub(); toast(`${it.label} — ${it.dead}`, 'info', 9000); };
  } else if (it.sub) {
    row.setAttribute('aria-haspopup', 'menu');
    row.onclick = () => openSub(it.id);   // opens, never toggles shut: a hover may have opened it a moment ago
    let t = null;
    row.addEventListener('pointerenter', (e) => { if (e.pointerType === 'mouse') { clearTimeout(t); t = setTimeout(() => openSub(it.id), 110); } });
    row.addEventListener('pointerleave', () => clearTimeout(t));
  } else {
    if (it.title) row.title = it.title;
    row.onclick = () => { closeSub(); it.run(); if (it.away) toggleEMenu(false); else paintEMenu(); };
  }
  // hovering a plain row shuts another row's flyout — after a beat, which the flyout cancels when the pointer reaches it
  // (the way there can graze the row below)
  if (!it.sub) row.addEventListener('pointerenter', (e) => { if (e.pointerType === 'mouse' && subFor) { clearTimeout(subCloseT); subCloseT = setTimeout(closeSub, 250); } });
  return row;
}
function loginItem() {
  if (CONFIG.authed) return { id: 'login', icon: 'sign-out', label: 'Log out', detail: CONFIG.name, away: true, run: logOut };
  const url = menuSrc.loginUrl?.();
  if (url) return { id: 'login', icon: 'sign-in', label: 'Log in', detail: 'with Discord', away: true, run: () => { location.href = url; } };
  return { id: 'login', icon: 'sign-in', label: 'Log in', dead: NO_LOGIN };
}
async function logOut() {
  if (!confirm(`Log out of ${location.host}? You will leave "${CONFIG.world}".`)) return;
  try { await fetch('/logout', { credentials: 'same-origin' }); } catch { /* the reload below still drops the session's page */ }
  // net.js bounces a browser that USED to be signed in straight back through the login (silent while Discord still
  // authorizes) — forget that, or logging out would log you back in
  try { localStorage.removeItem('ew-authed'); } catch { /* private mode */ }
  // and where they have been: a shared browser's next visitor must not land in (or be told the name of) the last
  // person's world. The bare path, not a reload: a reload keeps ?world=, rejoins that world, and remembers it again
  forgetRememberedWorlds();
  location.replace(location.pathname);
}
function topItems() {
  const rights = !!menuSrc.buildRights?.();
  return [
    { id: 'save', icon: 'floppy-disk', label: 'Save world', dead: rights ? SAVE_WHY : NEEDS_RIGHTS, tag: rights ? 'not yet' : 'builders' },
    { id: 'load', icon: 'folder-open', label: 'Load world', dead: rights ? LOAD_WHY : NEEDS_RIGHTS, tag: rights ? 'not yet' : 'builders' },
    'sep',
    { id: 'panels', icon: 'layout', label: 'Panels', sub: true },
    // the way down to the lite client, asked first; its ∃ logo is the way back up
    { id: 'lite', icon: 'chat-circle', label: 'Lite client', title: "the lite client: chat, the action bar and who's here, with no 3D world", run: () => confirmCenter({
      title: 'Switch to the lite client?',
      body: "Chat, the action bar and who's here, with no 3D world. Useful on a slow or struggling machine. Click the \u2203 logo there to come back.",
      ok: 'Switch', cancel: 'Stay in 3D',
    }).then((yes) => { if (yes) chooseClient(true); }) },
    'sep',
    loginItem(),
    { id: 'help', icon: 'question', label: 'Help', key: 'H', away: true, run: () => toggleHelp() },
    { id: 'keys', icon: 'keyboard', label: 'Keys', away: true, run: () => openKeys() },
    { id: 'about', icon: 'info', label: 'About', sub: true },
  ];
}
const sep = () => { const s = document.createElement('div'); s.className = 'msep'; s.setAttribute('role', 'separator'); return s; };
function buildTop(m) {
  m.innerHTML = '';
  for (const it of topItems()) m.appendChild(it === 'sep' ? sep() : topRow(it));
}
const topKey = () => `${!!menuSrc.buildRights?.()}|${CONFIG.authed ? 'out' : menuSrc.loginUrl?.() ? 'in' : 'none'}`;

// Keys: the help sheet's key table (defs/ui/_help.json), opened at that table
function openKeys() {
  openOverlay(el.help);
  const h = [...el.help.querySelectorAll('h2')].find((x) => /^keys$/i.test(x.textContent.trim()));
  h?.scrollIntoView({ block: 'start' });
}
// About: what /version said this build is (the page's one answer, version.js: the build this page negotiated with)
let versionAsk = null;
function buildInfo() {
  versionAsk ??= versionReady.then((v) => { if (!v) throw new Error('no /version'); return v; }).then((v) => {
    const sha = `${String(v.sha ?? '').slice(0, 7) || 'unknown'}${v.dirty === true ? ' +dirty' : ''}`;
    const when = (t) => (t && t !== 'unknown' ? new Date(t).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : 'unknown');
    return { sha, lines: [`build ${sha}`, `code from ${when(v.commitTime)}`, `server up since ${when(v.startedAt)}`] };
  }).catch(() => { versionAsk = null; return { sha: 'unknown', lines: ['build unknown — /version did not answer'] }; });
  return versionAsk;
}
// the projects this client is built on, their licences and sources (client/credits.html)
const CREDITS_ROW = `<div class="minfo"><a href="/credits.html" target="_blank" rel="noopener">Credits &amp; licences ↗</a></div>`;
function buildAbout(s) {
  s.innerHTML = `<div class="minfo"><b>eidoverse-worlds</b></div><div class="minfo dim">asking the server…</div>${CREDITS_ROW}`;
  buildInfo().then((v) => {
    if (subFor !== 'about') return;
    s.innerHTML = `<div class="minfo"><b>eidoverse-worlds</b></div>${v.lines.map((l) => `<div class="minfo">${escapeHtml(l)}</div>`).join('')}${CREDITS_ROW}`;
    placeSub();
  });
}

const emenuKey = () => dockEntries.filter((e) => !e.action || !e.gate || e.gate()).map((e) => e.id).join('|');
function paintEMenu() {
  const m = emenuEl();
  if (!m || m.hidden) return;
  if (m.dataset.key !== topKey()) { const keep = subFor; buildTop(m); m.dataset.key = topKey(); if (keep) m.querySelector(`.mrow[data-item="${keep}"]`)?.classList.add('subopen'); }
  for (const r of m.querySelectorAll('.mrow[data-item]')) r.classList.toggle('subopen', r.dataset.item === subFor);
  const s = subEl();
  if (!s || s.hidden || subFor !== 'panels') return;
  // rows are built once per entry-set; the 2s sweep only moves their state
  const key = emenuKey();
  if (s.dataset.key !== key) { buildPanels(s); s.dataset.key = key; placeSub(); }
  s.querySelector('.mrow[data-layout]')?.classList.toggle('open', isLayoutMode());
  s.querySelector('.mrow[data-layout]')?.setAttribute('aria-checked', String(isLayoutMode()));
  for (const row of s.querySelectorAll('.mrow[data-row]')) {
    const id = row.dataset.row;
    const entry = dockEntries.find((x) => x.id === id);
    const on = id === 'glyph:mic' ? micLive() : id === 'glyph:ear' ? earOn() : id === 'lantern' ? isLanternOpen()
      : entry?.action ? !!entry.active?.() : !!getFrame(id)?.visible;
    row.classList.toggle('open', on);
    // the glyph bakes its ink at build; re-stamp it when what it draws changes (the mic: on/off, mute, gold, synth)
    // the mic's key and glyph come from one read (micIndicator), so a change between two reads can't set them apart
    const ind = id === 'glyph:mic' ? micIndicator() : null;
    const glyph = ind ? ind.svg : id === 'glyph:ear' ? earGlyph : id === 'glyph:xr' ? xrGlyph : null;
    const drawn = ind ? ind.state : String(on);
    if (glyph && row.dataset.on !== drawn) {
      row.dataset.on = drawn;
      const g = row.querySelector('svg');
      if (g) g.outerHTML = glyph(16);
    }
  }
  for (const pin of s.querySelectorAll('.mpin[data-pin]')) {
    const id = pin.dataset.pin;
    const on = id.startsWith('glyph:') ? glyphPinned(id.slice(6)) : id === 'lantern' ? pillPinned() : pins.has(id);
    pin.classList.toggle('on', on);
    pin.setAttribute('aria-pressed', String(on));
    if (pin.disabled) continue;
    pin.title = id === 'lantern'
      ? (on ? `hide the resting line — ${CHORD} and the rail's search still open the lantern` : 'rest the line bottom-centre again')
      : id.startsWith('glyph:')
      ? (on ? `detach ${pin.dataset.nm} from the rail` : `attach ${pin.dataset.nm} to the rail`)
      : (on ? 'unpin from rail' : 'pin to rail');
  }
  const lock = s.querySelector('.mrow[data-lock]');
  const lockHtml = `${fsvg(isLocked() ? 'lock' : 'lock-open', 15)}<span class="mname">${isLocked() ? 'layout locked' : 'layout unlocked'}</span>`;
  if (lock && lock.dataset.lock !== String(isLocked())) { lock.dataset.lock = String(isLocked()); lock.innerHTML = lockHtml; }
  lock?.classList.toggle('open', isLocked());
}
bindMenu({ init: initEMenu, paint: paintEMenu });   // the dock's rail and initDock reach the menu through this
// THE LANTERN'S RESTING LINE: a group of its own between the voice rows and the windows (not quite a panel, so it
// can't be docked). The row opens the lantern, and its pin keeps the pill bottom-centre (commandbar.js setPillPinned,
// its own key ew-lantern-pinned, like the glyphs'). Unpinned, the lantern is still one chord away.
const LANTERN_GLYPH = 'lantern';   // its own glyph, so it reads apart from the search glass
function pinButton(id, onclick) {
  const pin = document.createElement('button');
  pin.className = 'mpin'; pin.dataset.pin = id;
  pin.innerHTML = fsvg('push-pin', 13);
  if (onclick) pin.onclick = (e) => { e.stopPropagation(); onclick(); paintDock(); paintEMenu(); };
  return pin;
}
function lanternRow() {
  const row = document.createElement('button');
  row.className = 'mrow'; row.dataset.row = 'lantern'; row.dataset.lanternToggle = '';
  row.innerHTML = `${fsvg(LANTERN_GLYPH, 15)}<span class="mname">lantern</span>`;
  row.title = `the lantern — type or say anything (${CHORD}). Its pin keeps the resting line bottom-centre; unpinned, ${CHORD} and the rail's search still open it`;
  row.onclick = () => { isLanternOpen() ? closeLantern() : openLantern(); paintEMenu(); };
  row.appendChild(pinButton('lantern', () => setPillPinned(!pillPinned())));
  return row;
}
// Panels ▸ — the old ∃ menu, whole: layout mode, the voice glyphs, the lantern, every window, the lock and the reset.
// A row toggles its thing (a window opening beside the HUD is not "another window" — the menu stays); its pin is
// whether that thing rides the rail.
function buildPanels(s) {
  s.innerHTML = '';
  const lay = document.createElement('button');
  lay.className = 'mrow'; lay.dataset.layout = ''; lay.setAttribute('role', 'menuitemcheckbox');
  lay.innerHTML = `${fsvg('arrows-out-cardinal', 15)}<span class="mname">HUD layout mode</span>`;
  lay.title = 'move panels, the rail (its grip) and the lantern\'s resting line — Esc or a click out in the world ends it';
  lay.onclick = () => setLayoutMode(!isLayoutMode());
  s.appendChild(lay);
  s.appendChild(sep());
  // voice first: mic + headphones lead in their own section — they matter more than any window, and they wear the SAME
  // glyphs as the floating pair
  const voiceRows = [['mic', 'mic', micGlyph, flipMic], ['headphones', 'ear', earGlyph, flipEar], ['VR', 'xr', xrGlyph, flipXr]];
  for (const [nm, key, glyph, flip] of voiceRows) {
    // VR: the row is always LISTED, but greyed with an explainer when no headset
    // can present, and its pin is dead, so an absent glyph cannot be pinned to
    // the rail. The HUD itself never shows the visor unsensed.
    const dead = key === 'xr' && !xrGlyphAvailable();
    const row = document.createElement('button');
    row.className = `mrow${dead ? ' dead' : ''}`; row.dataset.row = `glyph:${key}`;
    row.innerHTML = `${glyph(16)}<span class="mname">${nm}</span>`;
    if (dead) { row.disabled = true; row.title = 'no headset sensed — Chrome finds the OpenXR runtime only at browser start (chrome://restart after SteamVR is up)'; }
    else row.onclick = async () => { if (key === 'xr') toggleEMenu(false); await flip(); paintEMenu(); };   // entering VR is another window
    const pin = pinButton(`glyph:${key}`, dead ? null : () => setGlyphPinned(key, !glyphPinned(key)));
    pin.dataset.nm = nm;
    if (dead) { pin.disabled = true; pin.title = 'nothing to pin until a headset is sensed'; }
    row.appendChild(pin);
    s.appendChild(row);
  }
  s.appendChild(sep());
  s.appendChild(lanternRow());
  s.appendChild(sep());
  // ORDER AT PAINT TIME, not at registration: initDock sorts `last` to the end
  // once, but registerPanel pushes later mods onto dockEntries after that sort.
  // `last` entries stay at the bottom of both the rail and this menu.
  const ordered = [...dockEntries].sort((a, b) => (a.last ? 1 : 0) - (b.last ? 1 : 0));
  const flipPin = (id) => () => { pins.has(id) ? pins.delete(id) : pins.add(id); savePins(); };
  for (const entry of ordered) {
    const { id, action, gate } = entry;
    const icon = iconOf(entry);
    if (action) {
      // ALWAYS a row, gated or not: a dead row is the menu's vocabulary for "listed, not offered".
      const open = gate ? !!gate() : true;
      const row = document.createElement('button');
      row.className = `mrow${open ? '' : ' dead'}`; row.dataset.row = id;
      if (id === SEARCH_ENTRY.id) row.dataset.lanternToggle = '';
      row.innerHTML = `${fsvgOr(icon, 15)}<span class="mname">${escapeHtml(id)}</span>`;
      if (!open) { row.disabled = true; row.title = `${id} — needs build rights in this world`; }
      else row.onclick = () => { action(); paintDock(); paintEMenu(); };
      // a pin, like any window: pinned = the wrench stays on the rail. Dead row, dead pin: CSS `pointer-events: none`
      // only stops a hover, so a dead pin gets no handler at all.
      const pin = pinButton(id, open ? flipPin(id) : null);
      if (!open) { pin.disabled = true; pin.title = 'nothing to pin until you have build rights'; }
      row.appendChild(pin);
      s.appendChild(row);
      continue;
    }
    if (!getFrame(id)) continue;   // an entry with no frame behind it (a caller's stale id) gets no row
    const row = document.createElement('button');
    row.className = 'mrow'; row.dataset.row = id;
    row.innerHTML = `${fsvgOr(icon, 15)}<span class="mname">${escapeHtml(id)}</span>`;
    // click = toggle; the row's brightness IS the open state
    row.onclick = () => { const f = getFrame(id); if (!f) return; f.toggle(); paintDock(); paintEMenu(); };
    row.appendChild(pinButton(id, flipPin(id)));
    s.appendChild(row);
  }
  s.appendChild(sep());
  const lock = document.createElement('button');
  lock.className = 'mrow'; lock.dataset.lock = '';
  lock.onclick = () => { setLocked(!isLocked()); paintEMenu(); };
  s.appendChild(lock);
  const reset = document.createElement('button');
  reset.className = 'mrow'; reset.dataset.reset = '';
  reset.innerHTML = `${fsvg('sparkle', 15)}<span class="mname">reset layout</span>`;
  reset.title = 'put every window back where it started, and the lantern\'s resting line';
  reset.onclick = () => { resetHudLayout(); paintDock(); paintEMenu(); };
  s.appendChild(reset);
}
