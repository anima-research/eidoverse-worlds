// House dropdowns — every native <select> in the chrome becomes a button that
// opens a list in the panel's own colours. Chromium paints its OWN blue hover
// inside a native popup and nothing in CSS reaches it (live, 09-05: "that green +
// that blue"); so the popup is ours. The <select> stays in the DOM, hidden,
// as the value store: panels keep reading sel.value and listening for
// 'change' exactly as before — this is a skin, not a rewrite. A
// MutationObserver skins selects that panels build later.
import { fsvg } from './icons.js';
import { bus } from './base.js';

const SKIP = 'data-native';   // opt out: <select data-native>
let openPop = null;

function closePop() {
  if (!openPop) return;
  openPop.pop.remove(); openPop.btn.setAttribute('aria-expanded', 'false'); openPop = null;
}
const closeOutside = (e) => { if (openPop && !openPop.pop.contains(e.target) && !openPop.btn.contains(e.target)) closePop(); };
addEventListener('pointerdown', closeOutside, true);
// a VR panel's laser dispatches mouse events only (htmlmesh), never pointer events: an outside click must close there too
addEventListener('mousedown', (e) => { if (e.target?.closest?.('#xr-stage')) closeOutside(e); }, true);
addEventListener('keydown', (e) => { if (e.key === 'Escape') closePop(); });
// a list opened inside a staged VR frame (below) must not ride back to the desktop with it
bus.on('xr:state', () => closePop());

function label(sel) { return sel.selectedOptions[0]?.textContent ?? sel.options[0]?.textContent ?? ''; }

export function skinSelect(sel) {
  if (sel.dataset.skinned || sel.hasAttribute(SKIP)) return;
  sel.dataset.skinned = '1';
  const btn = document.createElement('button');
  btn.type = 'button'; btn.className = 'dd'; btn.setAttribute('aria-haspopup', 'listbox'); btn.setAttribute('aria-expanded', 'false');
  // `set` = a non-default choice is live (live 09-07 23:25: a persistent mode should read as ON at a glance — the trigger outlines in accent)
  const paint = () => { btn.innerHTML = `<span class="dd-label"></span><span class="dd-caret">▾</span>`; btn.querySelector('.dd-label').textContent = label(sel); /* textContent: option labels may one day come from names */ btn.disabled = sel.disabled; btn.classList.toggle('set', sel.hasAttribute('data-mode') && sel.selectedIndex > 0 && !/^(off|none|default)$/i.test(sel.value)); };
  paint();
  sel.classList.add('dd-native');
  sel.insertAdjacentElement('afterend', btn);
  sel.addEventListener('change', paint);
  // panels that set sel.value programmatically get repainted on the next tick
  const mo = new MutationObserver(paint); mo.observe(sel, { childList: true, attributes: true, subtree: true });
  const origDesc = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value');
  Object.defineProperty(sel, 'value', { get() { return origDesc.get.call(this); }, set(v) { origDesc.set.call(this, v); paint(); }, configurable: true });

  btn.onclick = (e) => {
    e.stopPropagation();
    if (openPop?.btn === btn) { closePop(); return; }
    closePop();
    const pop = document.createElement('div');
    pop.className = 'dd-pop panel'; pop.setAttribute('role', 'listbox');
    for (const o of sel.options) {
      const row = document.createElement('button');
      row.type = 'button'; row.className = `dd-opt${o.selected ? ' on' : ''}`; row.setAttribute('role', 'option');
      row.textContent = o.textContent; row.disabled = o.disabled;
      row.onclick = () => { if (sel.value !== o.value) { sel.value = o.value; sel.dispatchEvent(new Event('change', { bubbles: true })); } closePop(); };
      pop.appendChild(row);
    }
    // In a headset the panel is a texture rasterised from ITS OWN element (domquad stages frames under #xr-stage),
    // so a list appended to <body> is never drawn — the click landed and nothing appeared. Open it inside the
    // staged frame instead, positioned in that frame's box, so it is in the quad and the trigger reaches its rows.
    const host = btn.closest('#xr-stage .frame');
    const r = btn.getBoundingClientRect();
    pop.style.minWidth = `${Math.max(r.width, 120)}px`;   // before measuring: the clamps below read the list's real width
    if (host) {
      const hr = host.getBoundingClientRect();
      pop.style.position = 'absolute';
      pop.style.boxSizing = 'border-box';   // the max-height below is the room we measured, padding and border included
      host.appendChild(pop);
      const room = hr.bottom - r.bottom - 8, above = r.top - hr.top - 8;
      const down = room >= Math.min(pop.offsetHeight, 200) || room >= above;
      pop.style.maxHeight = `${Math.max(80, Math.floor(down ? room : above))}px`;
      pop.style.left = `${Math.max(4, Math.min(r.left - hr.left, hr.width - pop.offsetWidth - 4))}px`;
      pop.style.top = down ? `${r.bottom - hr.top + 4}px` : `${r.top - hr.top - pop.offsetHeight - 4}px`;
    } else {
      document.body.appendChild(pop);
      const below = innerHeight - r.bottom > 200 || r.top < 200;
      pop.style.left = `${Math.min(r.left, innerWidth - pop.offsetWidth - 8)}px`;
      pop.style.top = below ? `${r.bottom + 4}px` : `${r.top - pop.offsetHeight - 4}px`;
    }
    btn.setAttribute('aria-expanded', 'true');
    openPop = { btn, pop };
    (pop.querySelector('.dd-opt.on') ?? pop.firstChild)?.focus();
  };
  btn.onkeydown = (e) => {   // arrows change the value without opening — the native feel
    const i = sel.selectedIndex;
    if (e.key === 'ArrowDown' && i < sel.options.length - 1) { sel.selectedIndex = i + 1; sel.dispatchEvent(new Event('change', { bubbles: true })); paint(); e.preventDefault(); }
    if (e.key === 'ArrowUp' && i > 0) { sel.selectedIndex = i - 1; sel.dispatchEvent(new Event('change', { bubbles: true })); paint(); e.preventDefault(); }
  };
}

export function initDropdowns(root = document.body) {
  const scope = (n) => n.closest?.('.frame, .chat-gearpop, .sheet, #emenu, .capnotice');
  const sweep = (n) => { if (n.nodeType !== 1) return; if (n.tagName === 'SELECT' && scope(n)) skinSelect(n); n.querySelectorAll?.('select').forEach((s) => scope(s) && skinSelect(s)); };
  sweep(root);
  new MutationObserver((muts) => { for (const m of muts) for (const n of m.addedNodes) sweep(n); }).observe(root, { childList: true, subtree: true });
}
