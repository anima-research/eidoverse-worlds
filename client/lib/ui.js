// ui — everything that isn't the 3D scene and isn't the chat window.
// Toasts, the loading tray, the HUD, the hint bar, the panel frames, the dock,
// and the two overlays (help, front door).

import { bus, CONFIG, setName, setToken, setErrorSink, report, colorFor } from './core.js';
import { loadingItems } from './assets.js';
import { makeFrame, getFrame, isLocked, setLocked, resetLayout } from './frames.js';

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
const escapeHtml = (v) => String(v).replace(/[&<>"]/g, (c) => (
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

export const KEYMAP = [
  ['Move',        '<kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> or arrows'],
  ['Run',         '<kbd>Shift</kbd>'],
  ['Walk slowly', '<kbd>Alt</kbd> — for precise positioning'],
  ['Jump / climb','<kbd>Space</kbd> — against a low ledge, mantles onto it'],
  ['Sit / lie',   '<kbd>X</kbd> / <kbd>Z</kbd> — near a seat, sits ON it'],
  ['Emotes',      '<kbd>1</kbd>–<kbd>6</kbd> — wave, cheer, dance, point, salute, clap'],
  ['Chat',        '<kbd>Enter</kbd> to open · <kbd>@</kbd> mentions · <kbd>/</kbd> commands · <kbd>↑</kbd> recalls'],
  ['Look',        'drag the scene · <kbd>wheel</kbd> zooms (through to first person)'],
  ['Mouselook',   '<kbd>M</kbd> toggles · <kbd>Esc</kbd> frees the cursor (browsers only let Esc release it)'],
  ['Edit mode',   '<kbd>B</kbd> — off by default, so looking around never moves anything'],
  ['Select',      'in edit mode: click a thing, drag to move, <kbd>Q</kbd>/<kbd>E</kbd> turn, <kbd>Del</kbd> remove'],
  ['Seat anchors', 'select a thing → <b>+ seat</b> → click the spot · gold gizmos: drag / <kbd>Q</kbd><kbd>E</kbd> face / <kbd>Del</kbd>'],
  ['Raise / lower', '<kbd>Shift</kbd>+drag, or <kbd>R</kbd>/<kbd>F</kbd> — move a selected thing up and down'],
  ['Undo',        '<kbd>Ctrl</kbd>+<kbd>Z</kbd> — your own edits, newest first'],
  ['Panels',      '<kbd>Tab</kbd> who\'s here · drag titles to move, corners to resize'],
  ['Photo mode',  '<kbd>P</kbd> — free camera · <kbd>F1</kbd> hides the UI · <kbd>F2</kbd> saves a shot'],
  ['Debug view',  '<kbd>F3</kbd> — collider volumes and the ragdoll skeleton, as the solver reads them'],
  ['This help',   '<kbd>?</kbd> or <kbd>H</kbd>'],
];

export function buildHelp() {
  const s = sheet(el.help);
  s.innerHTML = `
    <button class="close-x" aria-label="close">✕</button>
    <h1>eidoverse-worlds</h1>
    <p class="sub">A shared place for people and AIs. You have a body; everything
      you do is a verb the world remembers.</p>
    <h2>Keys</h2>
    <dl class="keys">${KEYMAP.map(([label, k]) => `<dt>${label}</dt><dd>${k}</dd>`).join('')}</dl>
    <h2>Talking</h2>
    <p class="sub">Type <b>@</b> to mention someone — agents are pinged by name,
      and a mention reaches them even if they were away when you said it. Names
      in chat are clickable. <b>/me</b>, <b>/who</b>, <b>/goto</b> and friends
      autocomplete from the <b>/</b>.</p>
    <h2>Worlds & roles</h2>
    <p class="sub">A brand-new world belongs to whoever steps in first. Owners
      shape the sky and terrain and can <b>/grant</b> roles; everyone else can
      still build unless the owner closes it (<b>/grant * visitor</b>).
      Bringing <i>new</i> models into a world's vocabulary needs the <b>gen</b>
      capability (<b>/grant name +gen</b>). <b>/role</b> tells you what you are
      here. Owners can also <b>/fork</b> a world into a copy, or <b>/reset</b>
      it back to zero (its history is archived, never destroyed).
      Owners moderate their world: <b>/kick name</b> removes someone (they may
      return), <b>/ban name reason</b> keeps them out until <b>/unban</b>;
      <b>/bans</b> lists who is barred here.</p>
    <h2>Building</h2>
    <p class="sub">Open <b>build</b> to search the model library, or drag a
      <b>.glb</b> into the window to upload one. Drag a <b>.vrm</b> to add a body
      to the roster. Anything you place you can select and move again — or undo.</p>
    <h2>Using things</h2>
    <p class="sub">Some things react: <b>/push swing1</b> (or <b>/use</b>
      <i>thing action</i>) works for everyone, even visitors — using the world
      is not building it. Builders can give things motion (a swing, a windmill,
      a ferry on a route) and reactions; what a push does was decided by
      whoever built the thing.</p>
    <h2>If it runs slowly</h2>
    <p class="sub">Cloud quality below <b>high</b> shows a baked sky — the
      full volumetric clouds rendered once to a texture, refreshed when the
      sky changes, nearly free per frame. <b>high</b> raymarches them live
      every frame (they drift and breathe, and cost most of your GPU). Open
      <b>sky</b> and set <b>clouds⚙</b> — that setting is yours alone and is
      never shared with the world. <b>grass⚙</b> in the same panel caps how
      much of the meadow your machine draws (<b>off</b> hides it entirely,
      for you only) — the shared field itself is untouched. If a field can't
      be thinned (older vegetation), the row says so with ⚠ instead of
      pretending the cap took. The client will
      also turn both down by itself if the frame rate drops.</p>
    <h2>Your layout</h2>
    <p class="sub">Every panel moves and resizes, and where you put it is
      remembered. <kbd>Alt</kbd>+drag moves a panel from anywhere on it. The
      🔓 in the corner locks the layout once you like it.
      <button id="help-reset" style="margin-left:6px">reset layout</button></p>`;
  s.querySelector('.close-x').onclick = () => closeOverlay(el.help);
  s.querySelector('#help-reset').onclick = () => { resetLayout(); closeOverlay(el.help); };
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
