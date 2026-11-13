// ui-door — the front door: the overlay that asks your name (and a door key or a sign-in) before you enter.
import { CONFIG, setName, setToken } from '../base.js';
import { paint, escapeHtml } from './markup.js';
import { closeOverlay, el, openOverlay, sheet } from './ui.js';
const $ = (id) => document.getElementById(id);

// ---- the front door --------------------------------------------------------

export function openDoor({ roster = [], needsKey = false, login = null, onEnter }) {
  const s = sheet(el.door);
  s.innerHTML = `
    <div class="fr-head"><span class="fr-title">step in — <b>${escapeHtml(CONFIG.world)}</b></span></div>
    <div class="door-body">
    ${CONFIG.authed
      ? `<p class="sub">arriving as <b>${escapeHtml(CONFIG.name)}</b> — verified via Discord</p>`
      : `<h2>name</h2><label>
      <input id="d-name" type="text" maxlength="48" spellcheck="false" value="${escapeHtml(CONFIG.name)}" placeholder="how the world will know you"></label>`}
    ${needsKey ? `<h2>door key</h2><label>
      <input id="d-key" type="password" autocomplete="off" spellcheck="false" value="${escapeHtml(CONFIG.token)}"
        placeholder="the key from your invite"></label>` : ''}
    ${needsKey && login && !CONFIG.authed ? `<p class="sub" style="margin:4px 0 0">
      no key? <a href="${escapeHtml(login)}">sign in with Discord</a> instead —
      it comes back here with the door open</p>` : ''}
    <h2>avatar</h2>
    <div class="grid dense" id="d-roster"></div>
    <button class="go" id="d-go">enter the world</button>
    <p class="sub" style="margin:12px 0 0; text-align:center">
      press <kbd>?</kbd> any time for the controls</p>
    </div>`;

  let chosen = localStorage.getItem('ew-avatar-name') || 'claude';
  const grid = s.querySelector('#d-roster');
  // the button says what you are about to do: enter as WHO, wearing WHAT
  const goBtn = s.querySelector('#d-go');
  const sayGo = () => {
    const nm = CONFIG.authed ? CONFIG.name : (s.querySelector('#d-name')?.value.trim() || '…');
    goBtn.innerHTML = `enter as <b>${escapeHtml(nm)}</b> · ${escapeHtml(chosen)}`;
  };
  s.querySelector('#d-name')?.addEventListener('input', sayGo);
  const paint = () => {
    sayGo();
    grid.innerHTML = '';
    for (const a of roster) {
      const c = document.createElement('button');
      c.className = `card panel ${a.name === chosen ? 'on' : ''}`;
      // Bodies nobody has worn yet have no portrait — say so with a placeholder
      // rather than an empty box that reads as a broken image.
      c.innerHTML = `<img alt="" loading="lazy" src="/thumb/${encodeURIComponent(a.name)}.png">
         <div class="ph">🧍</div><span>${escapeHtml(a.name)}</span>`;
      // a JS listener, not an inline onerror= (inline handlers never run here)
      const img = c.querySelector('img');
      img.addEventListener('error', () => { img.style.display = 'none'; c.querySelector('.ph').style.display = 'grid'; });
      c.onclick = () => { chosen = a.name; paint(); };
      grid.appendChild(c);
    }
  };
  paint();

  const go = () => {
    // A verified identity owns the name — the server would ignore an edit
    // anyway, so don't offer one.
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
