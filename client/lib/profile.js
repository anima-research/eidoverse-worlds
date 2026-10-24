// profile — the PERSON noun's home (four-noun taxonomy, 08-29): who you are,
// where you are, what you're wearing, what you carry, who you know.
// Today: identity up top (portrait = presence control, header), and four tabs.
// satchel / worlds / friends have no server surface yet — R, 2026-09-11: "I would make them fully clickable panels ... aspirational so someone (maybe us!) can build it some day".

import { CONFIG, bus, colorFor, setName } from './base.js';
import { registerXRPanel } from './xrpanels.js';
import { getMyAvatarName, getMe } from './mybody.js';
import { bodiesFields, bodiesDispatch, mountBodies } from './bodies.js';
import { presence, setPresence, STATES } from './presence.js';
import { renderDOM } from './panels.js';
import { makeFrame, fitTabStrip } from './windows.js';
import { fsvg } from './icons.js';
import { net } from './net.js';

let frame = null;

// the profile as a VR quad: who you are, your presence, and the bodies list
// (folded in from bodies.js — one declaration, shown here on both surfaces).
function profileFields() {
  return [
    { t: 'info', label: 'name', value: CONFIG.name ?? '—' },
    { t: 'info', label: 'world', value: CONFIG.world ?? '—' },
    { t: 'list', label: 'presence', rows: STATES.map((st) => ({ id: st, label: st, active: presence() === st, actions: presence() === st ? [] : [{ k: 'presence', label: 'set' }] })) },
    ...bodiesFields(),
  ];
}
function profileDispatch(k, v) {
  if (k === 'presence') { setPresence(v); bus.emit('xr:repaint'); return; }
  bodiesDispatch(k, v);
}

export function initProfile() {
  registerXRPanel({ id: 'profile', title: 'profile', fields: profileFields, dispatch: profileDispatch });
  frame = makeFrame('profile', {
    title: 'profile', x: 64, y: 60, w: 420, h: 440, minW: 320, minH: 300, hidden: true,   // portrait + header + tabs + pane
  });
  frame.body.classList.add('profile-body');
  paint();
  bus.on('roster', paint);      // world/avatar facts can drift; repaint is cheap
  bus.on('avatar-worn', () => { if (frame?.body) delete frame.body.dataset.painted; paint(); });   // a palette switch changes the header
  bus.on('presence:me', () => { if (frame.visible) paint(); bus.emit('xr:repaint'); });
  return frame;
}

// ---- the body: portrait (= presence control) · header · tabs · one pane
// live — "try for the redesign, it was a stub anyway":
//   • the portrait circle carries the profile glyph as its placeholder and IS
//     the presence control: click → a Discord-style pop with present/away/busy
//   • tabs across the top under the header (side tabs fight 420 px; bottom
//     tabs read as a dock): avatars · satchel · worlds · friends
//   • the last tab is remembered per browser (ew-profile-tab)
//   • the bodies list is the avatars tab's content — no more folding
const TABS = [
  ['avatars', 'person-arms-spread', 'bodies you have worn'],
  ['satchel', 'backpack', 'personal inventory'],
  ['worlds', 'planet', 'places you know'],
  ['friends', 'users', 'people you keep'],
];
const TAB_KEY = 'ew-profile-tab';
let tab = (() => { try { const t = localStorage.getItem(TAB_KEY); return TABS.some(([k]) => k === t) ? t : 'avatars'; } catch { return 'avatars'; } })();
const PRESENCE_WORD = { present: 'present · here and active', away: 'away · idle or elsewhere', busy: 'busy · here, not to be disturbed' };

function paint() {
  if (!frame?.visible && frame?.body.dataset.painted) return;
  frame.body.dataset.painted = '1';
  // getMyAvatarName() is INTENT, not fact: it is set at module load from
  // ?avatar= / localStorage / the literal 'claude', and it never clears when a
  // body fails to load. So the header said "wearing claude" while the bodies
  // list two tiles down said "nothing worn yet" and the scene held no avatar —
  // R, 2026-09-11, with the screenshot. getMe() is the real signal (mybody.js:
  // set only after makeAvatar resolves). Name it when there IS a body; say
  // None when there isn't. Both panels repaint on `avatar-worn`, which fires
  // right after setMe on the success path, so a late body is not left stale.
  const avatar = getMe() ? (getMyAvatarName() || 'default') : 'None';
  const st = presence();
  frame.body.innerHTML = `
    <div class="pf-id">
      <button class="pf-portrait" data-presence="${st}" title="presence · ${st} — click to change" aria-haspopup="menu" aria-expanded="false"
        style="--who:${colorFor(CONFIG.name)}">${fsvg('user-circle', 20)}<span class="pf-portrait-dot"></span></button>
      <div class="pf-who">
        <button class="pf-name" type="button" title="your name — click to change it">${escape(CONFIG.name)}</button>
        <span>in <b>${escape(CONFIG.world)}</b> · wearing <b>${escape(avatar)}</b> · <i class="pf-state">${st}</i></span>
      </div>
    </div>
    <div class="pf-tabs" role="tablist">
      ${TABS.map(([id, icon, note]) => `<button class="pf-tab${id === tab ? ' on' : ''}" role="tab" aria-selected="${id === tab}" data-tab="${id}" title="${note}">${fsvg(icon, 14)}<span>${id}</span></button>`).join('')}
    </div>
    <div class="pf-pane" data-tab="${tab}"></div>`;

  // the presence pop, anchored to the portrait
  const portrait = frame.body.querySelector('.pf-portrait');
  portrait.onclick = (e) => {
    e.stopPropagation();
    const open = frame.body.querySelector('.pf-pop');
    if (open) { open.remove(); portrait.setAttribute('aria-expanded', 'false'); return; }
    const pop = document.createElement('div');
    pop.className = 'pf-pop panel'; pop.setAttribute('role', 'menu');
    let dismissRef = () => pop.remove();   // rebound to dismiss() below, once the listeners exist
    for (const s of STATES) {
      const b = document.createElement('button');
      b.type = 'button'; b.className = `pf-pop-row${s === presence() ? ' on' : ''}`; b.dataset.presence = s; b.setAttribute('role', 'menuitemradio'); b.setAttribute('aria-checked', String(s === presence()));
      b.innerHTML = `<span class="pf-pop-dot" data-presence="${s}"></span><span>${PRESENCE_WORD[s]}</span>`;
      b.onclick = (ev) => { ev.stopPropagation(); setPresence(s); dismissRef(); paint(); };
      pop.append(b);
    }
    frame.body.querySelector('.pf-id').append(pop);
    portrait.setAttribute('aria-expanded', 'true');
    const dismiss = () => { pop.remove(); portrait.setAttribute('aria-expanded', 'false'); removeEventListener('pointerdown', close, true); removeEventListener('keydown', onKey, true); };
    const close = (ev) => { if (!pop.contains(ev.target) && ev.target !== portrait) dismiss(); };
    const onKey = (ev) => { if (ev.key === 'Escape') { ev.stopPropagation(); ev.preventDefault(); dismiss(); } };   // Esc closes the pop and goes no further
    addEventListener('pointerdown', close, true);
    addEventListener('keydown', onKey, true);
    dismissRef = dismiss;
  };

  // the name is the control (R 10-11: "make the display name an invisible field that you can click on… a popup window and a
  // warning to pick carefully because you can only rename yourself every so often"). The account stays (base.js
  // CONFIG.account); the door enforces the cooldown and says when the next change is allowed (net.renameAfter).
  frame.body.querySelector('.pf-name').onclick = () => openRenameDialog();

  // tabs
  frame.body.querySelectorAll('.pf-tab').forEach((b) => {
    b.onclick = () => { tab = b.dataset.tab; try { localStorage.setItem(TAB_KEY, tab); } catch {} paint(); };
  });
  paintPane(frame.body.querySelector('.pf-pane'));
  // the four tabs fit a phone-width frame by dropping the unchosen tabs' words (windows.js fitTabStrip)
  const fit = () => fitTabStrip(frame.body.querySelector('.pf-tabs'));
  fit();
  if (!frame.body._fitRO && typeof ResizeObserver !== 'undefined') { frame.body._fitRO = new ResizeObserver(fit); frame.body._fitRO.observe(frame.body); }
}

let bodiesHost = null;   // mounted ONCE: mountBodies subscribes bus listeners, so re-mounting per repaint would leak them
function paintPane(pane) {
  if (tab === 'avatars') {
    if (!bodiesHost) { bodiesHost = document.createElement('div'); bodiesHost.className = 'pf-bodies'; mountBodies(bodiesHost); }
    pane.append(bodiesHost);
    return;
  }

  // SAY SO WHEN IT IS EMPTY BY DESIGN. R, 2026-09-11: the old sketch carried
  // "this is a stub - yet to be built" on these panes "just so you'd know it
  // hadn't rendered nothing on accident" — an empty box is indistinguishable
  // from a broken one. satchel/worlds/friends have no server surface yet; the
  // tabs are aspirational, so the panes say which.
  const STUB = {
    satchel: 'a stub — what you carry, once there is somewhere to carry it from.',
    worlds: 'a stub — places you know, once the server keeps a list.',
    friends: 'a stub — people you keep, once there is a way to keep them.',
  };
  if (STUB[tab]) {
    const d = document.createElement('div');
    d.className = 'pf-stub';
    d.textContent = STUB[tab];
    pane.append(d);
  }
}

const escape = (v) => String(v).replace(/[&<>"]/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// Which rename this session has (house I180): a signed-in name is the sign-in's (net.js takes identity.name over ours on
// every load, so a reload would undo a change); an account on a name-trusting server renames by reload, under the
// door's cooldown (the snapshot's renameAfter says so); anyone else is a guest, someone new on each visit, whose name is
// all they carry (no cooldown, no roles to keep).
const renameKind = () => (CONFIG.authed ? 'signin' : net.renameAfter != null ? 'account' : 'guest');

function openRenameDialog() {
  document.querySelector('.pf-rename-dlg')?.remove();
  const kind = renameKind();
  const days = net.renameCooldownDays ?? 7, after = net.renameAfter ?? 0, wait = kind === 'signin' || (kind === 'account' && after > Date.now());
  const when = new Date(after).toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });
  const dlg = document.createElement('div'); dlg.className = 'pf-rename-dlg'; dlg.setAttribute('role', 'dialog'); dlg.setAttribute('aria-modal', 'true');
  dlg.innerHTML = `<div class="pf-rename-card panel">
      <h3>Your name</h3>
      <p>This is the name everyone sees over your head, in chat and in the history of what you build.${kind === 'account'
        ? ' You stay the same person whatever it says: your roles and your things stay yours.' : ''}</p>
      <input class="pf-rename-in" maxlength="32" value="${escape(CONFIG.name)}" ${wait ? 'disabled' : ''} aria-label="your name">
      <p class="pf-rename-warn">${kind === 'signin' ? 'Your name comes from the account you signed in with: change it there, and it changes here the next time you come in.'
        : kind === 'guest' ? 'You\'re a guest: each visit you\'re someone new to the world, so a name is all you carry. Changing it reloads the page.'
        : wait ? `You changed it recently. You can change it again on <b>${escape(when)}</b>.`
        : `Pick carefully: once you change it, you can't change it again for ${days} days.`}</p>
      <p class="pf-rename-err" hidden></p>
      <div class="pf-rename-btns"><button type="button" class="pf-rename-cancel">${wait ? 'Close' : 'Cancel'}</button>${wait ? '' : '<button type="button" class="pf-rename-ok" disabled>Change my name</button>'}</div>
    </div>`;
  document.body.append(dlg);
  const inp = dlg.querySelector('.pf-rename-in'), ok = dlg.querySelector('.pf-rename-ok'), err = dlg.querySelector('.pf-rename-err');
  const close = () => { dlg.remove(); removeEventListener('keydown', onKey, true); };
  const valid = () => { const v = inp.value.trim(); const bad = /[<>"]/.test(v) ? '< > and " can\'t be part of a name' : v.length > 32 ? 'at most 32 characters' : '';
    err.hidden = !bad; err.textContent = bad; if (ok) ok.disabled = !!bad || !v || v === CONFIG.name; return !bad && v && v !== CONFIG.name ? v : null; };
  const submit = () => { const v = valid(); if (!v) return;
    setName(v); const u = new URL(location.href); if (u.searchParams.has('name')) u.searchParams.set('name', v); history.replaceState(null, '', u); location.reload(); };
  const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); close(); } else if (e.key === 'Enter' && !e.isComposing && document.activeElement === inp) { e.stopPropagation(); e.preventDefault(); submit(); } else e.stopPropagation(); };
  addEventListener('keydown', onKey, true);
  inp.oninput = valid; dlg.querySelector('.pf-rename-cancel').onclick = close; if (ok) ok.onclick = submit;
  dlg.onpointerdown = (e) => { if (e.target === dlg) close(); };
  if (!wait) { inp.focus(); inp.select(); }
}
