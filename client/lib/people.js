// people.js — who someone is here and what you may do to them (research roles 10-06, S6; PLAN decisions 10-06).
//
// ONE function decides the menu: personActions(me, them) in shared/v4/roles.js (pure, tested in tools/v4/roles-check.ts
// P1–P3). It shows only what you may do to that one person, so a visitor sees "Message" and nothing else, and when rank
// is the only reason nothing more shows, one dim line says so. This file draws it on three surfaces, and the door
// decides every act again (the menu is a courtesy, never the gate):
//   desktop  right-click a row in Chat › People, or the ⋯ on a nameplate card: the house context menu; an act with
//            choices (how long, which channels, why) opens one small centred card
//   phone    long-press a row (500 ms, a haptic pulse where the device has one), or the card's ⋯: a bottom sheet at full
//            width (the people column is 72–260 px), with large chips and no free text required
//   VR       no popups and no long-presses in a headset (audiopanel.js): a trigger on a row expands an inline strip of
//            rows under it, choices are rows of chips, and kick and ban take a second trigger on a "confirm" row
// The role ▸ submenu lists the roles you may give (grantableRoles: ranked below yours, with only switches you hold).
// The badge: none for a visitor, "guest" for someone without an account, else the role's name (badgeOf).
import { CONFIG, bus, report } from './base.js';
import { net, identities, guests, requestV4, v4 } from './net.js';
import { contextMenu, closeContextMenu } from './panels.js';
import * as R from '../../shared/v4/roles.js';

let deps = { openConvo: () => {}, presenting: () => false, openModLog: () => {}, toast: () => {} };
export function initPeople(d) { deps = { ...deps, ...d }; }

const wc = () => v4.st?.entities?.['@world']?.c ?? {};
/** The person behind a display name here: {display, id, anon, role, name, rank, switches, muted, me}. */
export function personOf(display) {
  const me = display === CONFIG.name;
  if (me) { const r = net.myRights ?? {};
    return { display, me, id: net.v4you ?? null, anon: !!r.guest, role: r.role ?? 'visitor', name: r.roleName ?? r.role, rank: r.rank ?? 0, switches: r.switches ?? [], muted: !!r.muted }; }
  const id = identities.get(display) ?? null, anon = guests.has(display);
  const e = id ? R.effectiveOf(wc(), id, { anon }) : { role: 'visitor', name: 'Visitor', rank: 0, switches: [] };
  return { display, me: false, id, anon, ...e, muted: !!(id && net.modMuted?.[id]) };
}
export const myself = () => personOf(CONFIG.name);
/** The items the menu shows for this person (pure: roles.js personActions). */
export function menuFor(display) {
  const me = myself(), them = personOf(display);
  if (!them.id && !them.me) return [{ id: 'message', label: 'Message' }];   // not known to the door yet (an old client)
  return R.personActions(me, them, { muted: them.muted, ghosted: false });
}
export const badgeHtml = (display, esc) => { const b = R.badgeOf(personOf(display)); return b ? `<span class="who-badge" data-tone="${b.tone}">${esc(b.text)}</span>` : ''; };
export const isPhone = () => (typeof matchMedia !== 'undefined' && matchMedia('(pointer: coarse)').matches) || innerWidth <= 600;

// ---------------------------------------------------------------- the acts
const PRESETS = {
  mute: [[5, '5 min'], [60, '1 hour'], [1440, '1 day'], [10080, '7 days']],
  kick: [[10, '10 min'], [60, '1 hour']],
  ghost: [[60, '1 hour'], [1440, '1 day']],
  ban: [[1, '1 day'], [7, '7 days'], [30, '30 days']],
};
const REASONS = ['spam', 'harassment', 'other'];
const VERB = { warn: 'Warn', mute: 'Mute', kick: 'Kick', ghost: 'Ghost', ban: 'Ban' };
const SAY = { warn: 'They see a notice they must dismiss.', mute: 'Nobody hears them on the chosen channels until it ends. They may still whisper to a moderator.',
  kick: "They're removed now and can't come back until it ends.", ghost: "They stay, unseen: they can look and walk, but not act or talk.", ban: "They're removed and kept out until it ends." };

async function run(tool, args, what) {
  const r = await requestV4(tool, args);
  if (r?.ok) deps.toast(`${what}: done`, 'info'); else deps.toast(`${what}: ${r?.refused?.reason ?? 'refused'}`, 'warn', 8000);
  return r;
}
/** Do a menu item. Acts with choices open the form on `surface` ('card' | 'sheet' | {strip: host}). */
export function act(item, display, surface = 'card') {
  const them = personOf(display);
  switch (item) {
    case 'message': return deps.openConvo(display);
    case 'history': return deps.openModLog(them.id);
    case 'unmute': return run('unmute', { who: them.id }, `unmute ${display}`);
    case 'unghost': return run('unghost', { who: them.id }, `bring ${display} back`);
    case 'role': return roleMenu(display, surface);
    default: if (VERB[item]) return openForm(item, display, surface);
  }
}

// ---------------------------------------------------------------- the menu, per surface
/** Desktop: the house context menu at (x, y). */
export function menuAt(display, x, y) {
  const items = menuFor(display);
  contextMenu(x, y, items.map((it) => ({ k: it.id, label: it.label, ...(it.dim ? { title: it.label } : {}), ...(['kick', 'ban', 'ghost'].includes(it.id) ? { danger: true } : {}) })),
    (k) => { if (k !== 'rank-line') act(k, display, 'card'); });
  const m = document.querySelector('.sp-ctx'); m?.setAttribute('data-person', display);
  for (const b of m?.querySelectorAll('.sp-ctx-item') ?? []) if (b.textContent.startsWith("they're")) { b.classList.add('dim'); b.disabled = true; }
  const head = document.createElement('div'); head.className = 'sp-ctx-head'; head.textContent = display; m?.prepend(head);
  return m;
}
/** Phone: a bottom sheet, the menu as large rows; an act's form replaces the rows in the same sheet. */
export function sheetFor(display) {
  const sh = sheet(); const items = menuFor(display);
  sh.body.innerHTML = '';
  sh.title.textContent = display;
  for (const it of items) {
    if (it.dim) { const p = document.createElement('p'); p.className = 'pm-dim'; p.textContent = it.label; sh.body.append(p); continue; }
    const b = document.createElement('button'); b.type = 'button'; b.className = `pm-row${['kick', 'ban', 'ghost'].includes(it.id) ? ' danger' : ''}`; b.textContent = it.label; b.dataset.act = it.id;
    b.onclick = () => { if (!sh.armed) return; if (!VERB[it.id] && it.id !== 'role') closeSheet(); act(it.id, display, 'sheet'); };
    sh.body.append(b);
  }
  // the press that opened the sheet is still down: lifting it must not "click" the row that slid under the finger
  // (the phone probe caught it choosing Ghost…). Rows act only after a fresh press that starts inside the sheet.
  sh.armed = false;
  sh.root.hidden = false; requestAnimationFrame(() => sh.root.classList.add('open'));
  try { navigator.vibrate?.(15); } catch { /* no haptics */ }
  return sh.root;
}
/** VR (and any surface without popups): an inline strip of rows in `host` (under the person's row). */
export function stripFor(display, host) {
  host.innerHTML = ''; host.className = 'pm-strip';
  for (const it of menuFor(display)) {
    if (it.dim) { const p = document.createElement('div'); p.className = 'pm-dim'; p.textContent = it.label; host.append(p); continue; }
    const b = document.createElement('button'); b.type = 'button'; b.className = `pm-row${['kick', 'ban', 'ghost'].includes(it.id) ? ' danger' : ''}`; b.textContent = it.label; b.dataset.act = it.id;
    b.onclick = (e) => { e.stopPropagation(); act(it.id, display, { strip: host }); };
    host.append(b);
  }
  return host;
}

let sh = null;
function sheet() {
  if (sh?.root.isConnected) return sh;
  const root = document.createElement('div'); root.id = 'person-sheet'; root.hidden = true;
  root.innerHTML = '<div class="pm-sheet panel" role="dialog" aria-modal="true"><div class="pm-grab"></div><b class="pm-title"></b><div class="pm-body"></div><button type="button" class="pm-close">Close</button></div>';
  document.body.append(root);
  root.addEventListener('pointerdown', (e) => { if (e.target === root) closeSheet(); else sh.armed = true; });
  root.querySelector('.pm-close').onclick = closeSheet;
  sh = { root, title: root.querySelector('.pm-title'), body: root.querySelector('.pm-body') };
  return sh;
}
export function closeSheet() { if (!sh) return; sh.root.classList.remove('open'); sh.root.hidden = true; }

// ---------------------------------------------------------------- the role ▸ submenu
function roleMenu(display, surface) {
  const me = myself(), them = personOf(display);
  const roles = R.grantableRoles(wc(), me).filter((r) => r.id !== 'none');
  const pick = (rid) => run('set', { id: '@world', component: `roles:${them.id}`, value: { role: rid } }, `make ${display} ${rid}`);
  const items = [...roles.map((r) => ({ k: r.id, label: `${r.id === them.role ? '✓ ' : ''}${r.name}` })), ...(me.role === 'owner' || me.switches.includes('grantRoles') ? [{ k: '::can', label: 'Exceptions…' }] : [])];
  const choose = (k) => (k === '::can' ? openCanForm(display, surface) : pick(k));
  if (surface === 'card') { const r = document.querySelector('.sp-ctx')?.getBoundingClientRect(); contextMenu(r ? r.left + 8 : innerWidth / 2, r ? r.top + 8 : innerHeight / 3, items, choose); return; }
  const host = surface === 'sheet' ? sheet().body : surface.strip;
  host.innerHTML = '';
  const t = document.createElement('div'); t.className = 'pm-label'; t.textContent = `${display}'s role`; host.append(t);
  for (const it of items) { const b = document.createElement('button'); b.type = 'button'; b.className = 'pm-row'; b.textContent = it.label; b.onclick = (e) => { e.stopPropagation(); if (surface === 'sheet') closeSheet(); choose(it.k); }; host.append(b); }
}

// ---------------------------------------------------------------- the one form (warn, mute, kick, ghost, ban)
let card = null;
function closeCard() { card?.remove(); card = null; }
/** The form: who (name + identity, small: homoglyphs), how long (preset chips), channels (mute), why (chips + text),
 *  confirm. In a strip (VR), kick/ban/ghost confirm with a second press on a confirm row. */
export function openForm(verb, display, surface = 'card') {
  const them = personOf(display), me = myself(); const owner = me.role === 'owner';
  const st = { len: (PRESETS[verb] ?? [])[0]?.[0], forever: false, ch: new Set(['voice', 'chat']), reason: '', why: '' };
  const host = document.createElement('div'); host.className = 'pm-form'; host.dataset.verb = verb;
  const row = (cls, label) => { const r = document.createElement('div'); r.className = `pm-field ${cls}`; if (label) { const l = document.createElement('div'); l.className = 'pm-label'; l.textContent = label; r.append(l); } host.append(r); return r; };
  const chips = (r, opts, isOn, onPick) => { const box = document.createElement('div'); box.className = 'pm-chips';
    const paint = () => box.querySelectorAll('button').forEach((b, i) => b.setAttribute('aria-pressed', String(isOn(opts[i][0]))));
    for (const [v, label] of opts) { const b = document.createElement('button'); b.type = 'button'; b.className = 'pm-chip'; b.textContent = label; b.onclick = (e) => { e.stopPropagation(); onPick(v); paint(); }; box.append(b); }
    r.append(box); paint(); return box; };
  { const r = row('pm-who'); const n = document.createElement('b'); n.textContent = `${VERB[verb]} ${display}`; const i = document.createElement('code'); i.textContent = them.id ?? ''; i.title = 'their identity: the door acts on this, never on a name';
    const p = document.createElement('p'); p.textContent = SAY[verb]; r.append(n, i, p); }
  if (PRESETS[verb]) {
    const opts = [...PRESETS[verb], ...(verb === 'ban' && owner ? [['forever', 'until lifted']] : [])];
    chips(row('pm-len', 'for how long'), opts, (v) => (v === 'forever' ? st.forever : !st.forever && st.len === v), (v) => { if (v === 'forever') st.forever = true; else { st.forever = false; st.len = v; } });
  }
  if (verb === 'mute') chips(row('pm-ch', 'channels'), [['voice', 'voice'], ['chat', 'chat']], (v) => st.ch.has(v), (v) => { if (st.ch.has(v) && st.ch.size > 1) st.ch.delete(v); else st.ch.add(v); });
  { const r = row('pm-why', verb === 'warn' ? 'why (they see it)' : 'why (optional)');
    chips(r, REASONS.map((x) => [x, x]), (v) => st.reason === v, (v) => { st.reason = st.reason === v ? '' : v; });
    const t = document.createElement('input'); t.type = 'text'; t.maxLength = R.REASON_MAX; t.placeholder = 'in your own words (optional)'; t.className = 'pm-text';
    t.addEventListener('keydown', (e) => e.stopPropagation()); t.oninput = () => { st.why = t.value; }; r.append(t); }
  const btns = row('pm-btns'); const cancel = document.createElement('button'); cancel.type = 'button'; cancel.className = 'pm-cancel'; cancel.textContent = 'Cancel';
  const go = document.createElement('button'); go.type = 'button'; go.className = `pm-go${['kick', 'ban', 'ghost'].includes(verb) ? ' danger' : ''}`; go.textContent = VERB[verb];
  btns.append(cancel, go);
  const done = () => { if (surface === 'card') closeCard(); else if (surface === 'sheet') closeSheet(); else surface.strip.innerHTML = ''; };
  cancel.onclick = (e) => { e.stopPropagation(); done(); };
  const strip = typeof surface === 'object';
  let armed = false;
  go.onclick = async (e) => {
    e.stopPropagation();
    const reason = [st.reason, st.why.trim()].filter(Boolean).join(': ');
    if (verb === 'warn' && !reason) { go.textContent = 'say why first'; return; }
    if (strip && ['kick', 'ban', 'ghost'].includes(verb) && !armed) { armed = true; go.textContent = `confirm: ${VERB[verb].toLowerCase()} ${display}`; go.classList.add('armed'); return; }   // VR: a second trigger, never a centred dialog
    const args = { who: them.id, ...(reason ? { reason } : {}) };
    if (verb === 'mute') Object.assign(args, { minutes: st.len, channels: [...st.ch] });
    if (verb === 'kick' || verb === 'ghost') args.minutes = st.len;
    if (verb === 'ban' && !st.forever) args.days = st.len;
    const r = await run(verb, args, `${VERB[verb].toLowerCase()} ${display}`);
    if (r?.ok) done(); else if (r?.refused) { let p = host.querySelector('.pm-err'); if (!p) { p = document.createElement('p'); p.className = 'pm-err'; host.insertBefore(p, btns); } p.textContent = r.refused.reason; }
  };
  if (surface === 'card') { closeCard(); card = document.createElement('div'); card.id = 'person-form'; const c = document.createElement('div'); c.className = 'pm-card panel'; c.setAttribute('role', 'dialog'); c.append(host); card.append(c);
    card.addEventListener('pointerdown', (e) => { if (e.target === card) closeCard(); }); card.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); closeCard(); } });
    document.body.append(card); go.focus(); }
  else if (surface === 'sheet') { const s2 = sheet(); s2.title.textContent = ''; s2.body.innerHTML = ''; s2.body.append(host); s2.root.hidden = false; s2.root.classList.add('open'); }   // the form names them itself
  else { surface.strip.innerHTML = ''; surface.strip.append(host); }
  return host;
}
/** Exceptions… (per-person can): one toggle per switch, three states (role's own / on / off). Owners and grantRoles. */
function openCanForm(display, surface) {
  const them = personOf(display); const cur = wc()[`roles:${them.id}`]?.can ?? {};
  const host = document.createElement('div'); host.className = 'pm-form';
  const h = document.createElement('b'); h.textContent = `${display}: exceptions to ${them.name}`; host.append(h);
  const st = { ...cur };
  for (const k of R.SWITCH_NAMES) {
    const r = document.createElement('div'); r.className = 'pm-can';
    const l = document.createElement('span'); l.textContent = k; l.title = R.SWITCHES[k].text;
    const sel = document.createElement('select'); for (const [v, t] of [['', 'as the role'], ['on', 'on'], ['off', 'off']]) { const o = document.createElement('option'); o.value = v; o.textContent = t; sel.append(o); }
    sel.value = st[k] === true ? 'on' : st[k] === false ? 'off' : ''; sel.onchange = () => { if (!sel.value) delete st[k]; else st[k] = sel.value === 'on'; };
    r.append(l, sel); host.append(r);
  }
  const b = document.createElement('button'); b.type = 'button'; b.className = 'pm-go'; b.textContent = 'Save';
  // an existing entry is patched (its note and legacy fields stay); someone on the default role gets an entry naming the
  // role they have now (an exception needs an entry to live on; review 10-07)
  const has = !!wc()[`roles:${them.id}`];
  b.onclick = async () => { const value = has ? { can: st } : { role: them.role, ...(Object.keys(st).length ? { can: st } : {}) };
    const r = await run('set', { id: '@world', component: `roles:${them.id}`, value, ...(has ? { merge: true } : {}) }, `${display}'s exceptions`); if (r?.ok) { closeCard(); closeSheet(); } };
  host.append(b);
  if (surface === 'card') { closeCard(); card = document.createElement('div'); card.id = 'person-form'; const c = document.createElement('div'); c.className = 'pm-card panel'; c.append(host); card.append(c); card.addEventListener('pointerdown', (e) => { if (e.target === card) closeCard(); }); document.body.append(card); }
  else if (surface === 'sheet') { const s2 = sheet(); s2.body.innerHTML = ''; s2.body.append(host); }
  else { surface.strip.innerHTML = ''; surface.strip.append(host); }
}

// a warning is a notice you dismiss (research roles §5); the house centred card, kept until pressed
bus.on('warned', (m) => { import('./confirmcenter.js').then(({ confirmCenter }) => confirmCenter({ title: `${m.by} warned you`, body: String(m.reason ?? ''), ok: 'I understand', cancel: 'Close' })).catch((e) => report('warned', e)); });
export { closeContextMenu };
