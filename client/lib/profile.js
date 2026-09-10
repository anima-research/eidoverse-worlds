// profile — the PERSON noun's home (four-noun taxonomy, 08-29): who you are,
// where you are, what you're wearing, what you carry, who you know.
// DELIBERATELY A SKETCH (R, 22:01): real satchel/worlds/friends need server
// surfaces that don't exist yet; this stakes out the shape, VRChat-ish —
// a bigger panel, identity up top, destination tiles below.

import { CONFIG, bus, colorFor } from './base.js';
import { registerXRPanel } from './xrpanels.js';
import { getMyAvatarName } from './mybody.js';
import { bodiesFields, bodiesDispatch, mountBodies } from './bodies.js';
import { presence, setPresence, STATES } from './presence.js';
import { renderDOM } from './panels.js';
import { makeFrame } from './frames.js';
import { fsvg } from './icons.js';
import { toast } from './ui.js';

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
  bus.on('presence:me', () => { if (frame.visible) paint(); bus.emit('xr:repaint'); });
  return frame;
}

// ---- the body: portrait (= presence control) · header · tabs · one pane
// R, 09-05 16:06 — "try for the redesign, it was a stub anyway":
//   • the portrait circle carries the profile glyph as its placeholder and IS
//     the presence control: click → a Discord-style pop with present/away/busy
//   • tabs across the top under the header (side tabs fight 420 px; bottom
//     tabs read as a dock): avatars · satchel · worlds · friends
//   • the last tab is remembered per browser (ew-profile-tab)
//   • the bodies list is the avatars tab's content — no more folding
const TABS = [
  ['avatars', 'person-arms-spread', 'bodies you have worn'],
  ['satchel', 'push-pin', 'personal inventory'],
  ['worlds', 'planet', 'places you know'],
  ['friends', 'users', 'people you keep'],
];
const TAB_KEY = 'ew-profile-tab';
let tab = (() => { try { return localStorage.getItem(TAB_KEY) || 'avatars'; } catch { return 'avatars'; } })();
const PRESENCE_WORD = { present: 'present · here and active', away: 'away · idle or elsewhere', busy: 'busy · here, not to be disturbed' };

function paint() {
  if (!frame?.visible && frame?.body.dataset.painted) return;
  frame.body.dataset.painted = '1';
  const avatar = (CONFIG.avatar || 'default').split('/').pop().replace(/\.vrm$/i, '');
  const st = presence();
  frame.body.innerHTML = `
    <div class="pf-id">
      <button class="pf-portrait" data-presence="${st}" title="presence · ${st} — click to change" aria-haspopup="menu" aria-expanded="false"
        style="--who:${colorFor(CONFIG.name)}">${fsvg('user-circle', 20)}<span class="pf-portrait-dot"></span></button>
      <div class="pf-who">
        <b>${escape(CONFIG.name)}</b>
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
    for (const s of STATES) {
      const b = document.createElement('button');
      b.type = 'button'; b.className = `pf-pop-row${s === presence() ? ' on' : ''}`; b.dataset.presence = s; b.setAttribute('role', 'menuitemradio'); b.setAttribute('aria-checked', String(s === presence()));
      b.innerHTML = `<span class="pf-pop-dot" data-presence="${s}"></span><span>${PRESENCE_WORD[s]}</span>`;
      b.onclick = (ev) => { ev.stopPropagation(); setPresence(s); pop.remove(); paint(); };
      pop.append(b);
    }
    frame.body.querySelector('.pf-id').append(pop);
    portrait.setAttribute('aria-expanded', 'true');
    const dismiss = () => { pop.remove(); portrait.setAttribute('aria-expanded', 'false'); removeEventListener('pointerdown', close, true); removeEventListener('keydown', onKey, true); };
    const close = (ev) => { if (!pop.contains(ev.target) && ev.target !== portrait) dismiss(); };
    const onKey = (ev) => { if (ev.key === 'Escape') { ev.stopPropagation(); ev.preventDefault(); dismiss(); } };   // Esc closes the pop and goes no further (the global Esc toggle yields to an open pop)
    addEventListener('pointerdown', close, true);
    addEventListener('keydown', onKey, true);
  };

  // tabs
  frame.body.querySelectorAll('.pf-tab').forEach((b) => {
    b.onclick = () => { tab = b.dataset.tab; try { localStorage.setItem(TAB_KEY, tab); } catch {} paint(); };
  });
  paintPane(frame.body.querySelector('.pf-pane'));
}

let bodiesHost = null;   // mounted ONCE: mountBodies subscribes bus listeners, so re-mounting per repaint would leak them
function paintPane(pane) {
  if (tab === 'avatars') {
    if (!bodiesHost) { bodiesHost = document.createElement('div'); bodiesHost.className = 'pf-bodies'; mountBodies(bodiesHost); }
    pane.append(bodiesHost);
    return;
  }
  const [, icon, note] = TABS.find(([id]) => id === tab);
  pane.innerHTML = `<div class="pf-stub">${fsvg(icon, 28)}<b>${tab}</b><span>${note}</span><em>not built yet — this tab reserves the spot; shapes first, plumbing next</em></div>`;
}

const escape = (v) => String(v).replace(/[&<>"]/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
