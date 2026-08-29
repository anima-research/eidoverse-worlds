// ui — everything that isn't the 3D scene and isn't the chat window.
// Toasts, the loading tray, the HUD, the hint bar, the panel frames, the dock,
// and the two overlays (help, front door).

import { bus, CONFIG, setName, setToken, setErrorSink, report, colorFor } from './core.js';
import { loadingItems } from './assets.js';
import { makeFrame, getFrame, isLocked, setLocked, resetLayout } from './frames.js';
import { defsRegistry } from './defs.js';

const $ = (id) => document.getElementById(id);
export const el = {
  hud: $('hud'), loading: $('loading'), toasts: $('toasts'), hint: $('hintbar'),
  door: $('door'), help: $('help'), dock: $('dock'), touch: $('touch'),
};

// ============================================================ toasts

const liveToasts = new Map();

export function toast(message, kind = 'info', ttl = kind === 'err' ? 9000 : 5000) {
  const key = `${kind}:${message}`;
  const existing = liveToasts.get(key);
  if (existing) { // same thing again — bump a counter instead of stacking dupes
    existing.n++;
    existing.count.textContent = ` ×${existing.n}`;
    clearTimeout(existing.timer);
    existing.timer = setTimeout(() => dismiss(key), ttl);
    return;
  }
  const node = document.createElement('div');
  node.className = `toast panel ${kind}`;
  const body = document.createElement('span');
  body.textContent = message;
  const count = document.createElement('span');
  count.className = 'ctx';
  node.append(body, count);
  node.onclick = () => dismiss(key);
  el.toasts.appendChild(node);
  liveToasts.set(key, { node, count, n: 1, timer: setTimeout(() => dismiss(key), ttl) });
  while (el.toasts.children.length > 5) el.toasts.removeChild(el.toasts.firstChild);
}
function dismiss(key) {
  const t = liveToasts.get(key);
  if (!t) return;
  liveToasts.delete(key);
  clearTimeout(t.timer);
  t.node.classList.add('out');
  setTimeout(() => t.node.remove(), 320);
}
setErrorSink((context, message) => toast(`${context}: ${message}`, 'err'));

// ============================================================ loading tray

bus.on('loading', () => {
  const items = loadingItems();
  el.loading.classList.toggle('on', items.length > 0);
  el.loading.textContent = items.map((l) =>
    l.total ? `⏳ ${l.label} ${Math.min(99, Math.round((l.done / l.total) * 100))}%` : `⏳ ${l.label}…`,
  ).join('\n');
});

// ============================================================ HUD + hints

export function setHud(parts) { el.hud.innerHTML = parts; }

export function setHint(html, { sticky = false } = {}) {
  el.hint.innerHTML = html;
  el.hint.classList.remove('gone');
  if (!sticky) setTimeout(() => el.hint.classList.add('gone'), 30000);
}

// The ambient hint is what the bar shows when nothing louder is happening —
// a standing offer from the world ("X — sit"), set and cleared by proximity.
// A flash (emote names, mode switches) borrows the bar and gives it back.
let ambientHint = null;
export function setAmbientHint(html) {
  if (html === ambientHint) return;   // don't fight setHint's boot message over nothing
  ambientHint = html;
  if (el.hint._t) return;             // a flash owns the bar; it restores us when done
  if (ambientHint) { el.hint.innerHTML = ambientHint; el.hint.classList.remove('gone'); }
  else el.hint.classList.add('gone');
}
export function flashHint(html, ms = 2600) {
  el.hint.innerHTML = html;
  el.hint.classList.remove('gone');
  clearTimeout(el.hint._t);
  el.hint._t = setTimeout(() => {
    el.hint._t = null;
    if (ambientHint) el.hint.innerHTML = ambientHint;
    else el.hint.classList.add('gone');
  }, ms);
}

// ============================================================ panel frames

let worldFrame = null;
export function panelFrame() {
  if (!worldFrame) {
    worldFrame = makeFrame('world', {
      title: 'world', x: -10, y: 52, w: 232, h: 260, minW: 200,
    });
    const stack = document.createElement('div');
    stack.className = 'stack';
    worldFrame.body.appendChild(stack);
    worldFrame.stack = stack;
  }
  return worldFrame;
}

/** Collapsible section inside the world frame. onOpen is awaited each time it
 *  opens, so rosters and catalogs re-fetch instead of going stale. */
export function makeSection(title, onOpen, { id = '' } = {}) {
  const host = panelFrame().stack;
  const box = document.createElement('div');
  box.className = 'sec';
  if (id) box.id = `sec-${id}`;
  const head = document.createElement('button');
  head.className = 'head';
  head.textContent = title;
  head.setAttribute('aria-expanded', 'false');
  const body = document.createElement('div');
  body.className = 'body';

  const api = {
    box, head, body,
    get isOpen() { return box.classList.contains('open'); },
    async toggle(force) {
      const open = force ?? !box.classList.contains('open');
      box.classList.toggle('open', open);
      head.setAttribute('aria-expanded', String(open));
      if (open) { panelFrame().show(); await onOpen?.(body); }
    },
  };
  head.onclick = () => api.toggle().catch((e) => report(title, e));
  box.append(head, body);
  host.appendChild(box);
  return api;
}

export function collapseAll() {
  for (const s of document.querySelectorAll('.sec.open')) s.classList.remove('open');
}

// ============================================================ who's here

let whoFrame = null, whoSource = () => [];
export function initRoster(source) {
  whoSource = source;
  whoFrame = makeFrame('who', {
    title: 'present', x: -10, y: 392, w: 232, h: 150, minW: 160, hidden: true,
  });
  const stack = document.createElement('div');
  stack.className = 'stack';
  whoFrame.body.appendChild(stack);
  whoFrame.list = stack;
  bus.on('roster', paintRoster);
  return whoFrame;
}
export function paintRoster() {
  if (!whoFrame?.visible) return;
  const people = whoSource();
  whoFrame.setTitle(`present · ${people.length}`);
  whoFrame.list.innerHTML = people.length
    ? people.map((p) => `<div class="who-row ${p.me ? 'self' : ''}">
        <span class="n" style="color:${colorFor(p.id)}">${escapeHtml(p.id)}${p.me ? ' (you)' : ''}</span>
        <span class="d">${p.dist == null ? '' : p.dist.toFixed(0) + 'm'}</span></div>`).join('')
    : '<div style="color:var(--dim)">nobody else yet</div>';
}
export function toggleRoster() {
  whoFrame?.toggle();
  paintRoster();
}
export const escapeHtml = (v) => String(v).replace(/[&<>"]/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// ============================================================ dock
// A closed frame has to be findable again. One row of toggles, plus the
// layout lock — the MMO convention: arrange it, then lock it so a stray drag
// can't undo an hour of fiddling.

export function initDock(entries) {
  el.dock.innerHTML = '';
  for (const { id, label } of entries) {
    const b = document.createElement('button');
    b.textContent = label;
    b.title = `toggle ${id}`;
    b.onclick = () => {
      const f = getFrame(id);
      if (!f) return;
      f.toggle();
      if (id === 'who') paintRoster();
      paintDock(entries);
    };
    b.dataset.toggles = id;   // NOT data-frame — that belongs to the window itself
    el.dock.appendChild(b);
  }
  const lock = document.createElement('button');
  lock.title = 'lock the layout';
  lock.onclick = () => { setLocked(!isLocked()); paintDock(entries); };
  lock.dataset.lock = '1';
  el.dock.appendChild(lock);
  paintDock(entries);
  bus.on('frames', () => paintDock(entries));
}
function paintDock(entries) {
  for (const b of el.dock.querySelectorAll('button[data-toggles]')) {
    b.classList.toggle('on', !!getFrame(b.dataset.toggles)?.visible);
  }
  const lock = el.dock.querySelector('button[data-lock]');
  if (lock) {
    lock.textContent = isLocked() ? '🔒' : '🔓';
    lock.classList.toggle('on', isLocked());
  }
}

// ============================================================ overlays

const sheet = (node) => node.querySelector('.sheet');
export function openOverlay(node) { node.classList.add('open'); }
export function closeOverlay(node) { node.classList.remove('open'); }
export const isOverlayOpen = () => document.querySelector('.scrim.open') !== null;

addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  const open = document.querySelector('.scrim.open');
  if (open && open.id !== 'door') closeOverlay(open); // the door must be answered
});
for (const s of [el.door, el.help]) {
  s.addEventListener('click', (e) => { if (e.target === s && s.id !== 'door') closeOverlay(s); });
}

// ---- help ------------------------------------------------------------------
// The overlay's CONTENT is a def (defs/ui/_help.json, §R4 defs round two) —
// title, subtitle, the key table, the prose sections. A world can reword its
// own welcome without forking the client. Defs are server-owned, the same
// trust domain as this file itself, so the fragments are trusted markup. The
// "Your layout" section stays code-side: it carries a live button wired to
// resetLayout. SINGLE-SOURCE — no baked-in fallback prose (the fallback would
// be the 120-line mirror this move kills); a world serving no help def gets a
// sheet that says so.

export function buildHelp() {
  const paint = () => defsRegistry().then((reg) => {
    const h = reg.uiHelp;
    const s = sheet(el.help);
    s.innerHTML = `
      <button class="close-x" aria-label="close">✕</button>
      ${!h?.keys ? '<p class="sub">this world serves no help def (defs/ui/_help.json)</p>' : `
      <h1>${h.title}</h1>
      <p class="sub">${h.sub}</p>
      <h2>Keys</h2>
      <dl class="keys">${h.keys.map(([label, k]) => `<dt>${label}</dt><dd>${k}</dd>`).join('')}</dl>
      ${(h.sections ?? []).map((x) => `<h2>${x.h}</h2><p class="sub">${x.html}</p>`).join('')}`}
      <h2>Your layout</h2>
      <p class="sub">Every panel moves and resizes, and where you put it is
        remembered. <kbd>Alt</kbd>+drag moves a panel from anywhere on it. The
        🔓 in the corner locks the layout once you like it.
        <button id="help-reset" style="margin-left:6px">reset layout</button></p>`;
    s.querySelector('.close-x').onclick = () => closeOverlay(el.help);
    s.querySelector('#help-reset').onclick = () => { resetLayout(); closeOverlay(el.help); };
  }).catch((e) => report('help def', e));
  paint();
  bus.on('defs-updated', paint);   // edited prose reaches an open client too
}
export function toggleHelp() {
  el.help.classList.contains('open') ? closeOverlay(el.help) : openOverlay(el.help);
}

// ---- the front door --------------------------------------------------------

export function openDoor({ roster = [], needsKey = false, login = null, onEnter }) {
  const s = sheet(el.door);
  s.innerHTML = `
    <h1>step in</h1>
    <p class="sub">You're arriving at <b>${escapeHtml(CONFIG.world)}</b>.</p>
    ${CONFIG.authed
      ? `<p class="sub">arriving as <b>${escapeHtml(CONFIG.name)}</b> — verified via Discord</p>`
      : `<label><span class="lbl">your name — how the world and everyone in it will know you</span>
      <input id="d-name" type="text" maxlength="48" spellcheck="false" value="${escapeHtml(CONFIG.name)}"></label>`}
    ${needsKey ? `<label><span class="lbl">door key</span>
      <input id="d-key" type="text" spellcheck="false" value="${escapeHtml(CONFIG.token)}"
        placeholder="the key from your invite"></label>` : ''}
    ${needsKey && login && !CONFIG.authed ? `<p class="sub" style="margin:4px 0 0">
      no key? <a href="${escapeHtml(login)}">sign in with Discord</a> instead —
      it comes back here with the door open</p>` : ''}
    <h2>body</h2>
    <div class="grid dense" id="d-roster"></div>
    <button class="go" id="d-go">enter the world</button>
    <p class="sub" style="margin:12px 0 0; text-align:center">
      press <kbd>?</kbd> any time for the controls</p>`;

  let chosen = localStorage.getItem('ew-avatar-name') || 'claude';
  const grid = s.querySelector('#d-roster');
  const paint = () => {
    grid.innerHTML = '';
    for (const a of roster) {
      const c = document.createElement('button');
      c.className = `card panel ${a.name === chosen ? 'on' : ''}`;
      // Bodies nobody has worn yet have no portrait — say so with a placeholder
      // rather than an empty box that reads as a broken image.
      c.innerHTML = `<img alt="" loading="lazy" src="/thumb/${encodeURIComponent(a.name)}.png"
           onerror="this.style.display='none';this.nextElementSibling.style.display='grid'">
         <div class="ph">🧍</div><span>${escapeHtml(a.name)}</span>`;
      c.onclick = () => { chosen = a.name; paint(); };
      grid.appendChild(c);
    }
  };
  paint();

  const go = () => {
    // A verified identity owns the name — the server would ignore an edit
    // anyway (home-node.md §7), so don't offer one.
    let name = CONFIG.name;
    if (!CONFIG.authed) {
      name = s.querySelector('#d-name').value.trim().slice(0, 48);
      if (!name) { s.querySelector('#d-name').focus(); return; }
      setName(name);
    }
    localStorage.setItem('ew-name-set', '1');
    if (needsKey) setToken(s.querySelector('#d-key').value.trim());
    const pick = roster.find((a) => a.name === chosen);
    if (pick) localStorage.setItem('ew-avatar-name', pick.name);
    closeOverlay(el.door);
    onEnter({ name, avatar: pick?.path, avatarName: pick?.name });
  };
  s.querySelector('#d-go').onclick = go;
  // #d-name doesn't exist for a verified arrival — the name isn't editable.
  s.querySelector('#d-name')?.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') go();
  });
  s.querySelector('#d-key')?.addEventListener('keydown', (e) => e.stopPropagation());

  openOverlay(el.door);
  setTimeout(() => (s.querySelector('#d-name') ?? s.querySelector('#d-go'))?.focus(), 30);
}
