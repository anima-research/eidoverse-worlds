// VR keyboard (gap list C16; porch-old :7377–7390 had one) — a FRAME, so it rides the
// same HTMLMesh quad + click-through every other panel does (domquad.js): a trigger on a
// key is a DOM click on a real <button>. Keys type into the last-focused text input
// (HTMLMesh focuses an <input> when its quad is clicked; default: the chat line), and ⏎
// is a synthetic Enter keydown on that input, so chat's own handler sends — one send
// path, one keyboard, no VR-only text plumbing. Desktop never sees it (real keyboards);
// in VR the quad shows while a text input has focus and hides when the line is sent.
import { bus } from './base.js';
import { makeFrame } from './frames.js';
import { isPresenting } from './xr.js';
import { domQuadShow } from './domquad.js';

const ROWS = [['q', 'w', 'e', 'r', 't', 'y', 'u', 'i', 'o', 'p'], ['a', 's', 'd', 'f', 'g', 'h', 'j', 'k', 'l', "'"], ['⇧', 'z', 'x', 'c', 'v', 'b', 'n', 'm', ',', '.', '⌫'], ['123', '@', '/', '␣', '?', '!', '⏎']];
const NUM = [['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'], ['-', '_', ':', ';', '(', ')', '&', '#', '%', '"'], ['⇧', '+', '=', '*', '~', '^', '$', '€', '[', ']', '⌫'], ['abc', '@', '/', '␣', '?', '!', '⏎']];
const isText = (el) => el && ((el instanceof HTMLInputElement && ['text', 'search', 'email', 'url', ''].includes(el.type)) || el instanceof HTMLTextAreaElement);

let target = null, shift = false, numeric = false, api = null, keysEl = null;
const targetEl = () => (isText(target) && target.isConnected ? target : document.getElementById('chatline'));

function type(ch) {
  const el = targetEl(); if (!el) return;
  const s = el.selectionStart ?? el.value.length, e = el.selectionEnd ?? s;
  el.setRangeText(ch, s, e, 'end');
  el.dispatchEvent(new InputEvent('input', { bubbles: true, data: ch, inputType: 'insertText' }));
}
function backspace() {
  const el = targetEl(); if (!el) return;
  const s = el.selectionStart ?? el.value.length, e = el.selectionEnd ?? s;
  if (s === e && s === 0) return;
  el.setRangeText('', s === e ? s - 1 : s, e, 'end');
  el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward' }));
}
function enter() {
  const el = targetEl(); if (!el) return;
  el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true }));
  if (isPresenting()) domQuadShow('keyboard', false);
}

function press(k) {
  if (k === '⇧') { shift = !shift; paint(); return; }
  if (k === '123' || k === 'abc') { numeric = !numeric; paint(); return; }
  if (k === '⌫') return backspace();
  if (k === '⏎') return enter();
  type(k === '␣' ? ' ' : shift ? k.toUpperCase() : k);
  if (shift) { shift = false; paint(); }
}

function paint() {
  if (!keysEl) return;
  keysEl.textContent = '';
  for (const row of (numeric ? NUM : ROWS)) {
    const r = document.createElement('div'); r.className = 'kb-row';
    for (const k of row) {
      const b = document.createElement('button'); b.type = 'button'; b.className = 'kb-key' + (k.length > 1 ? ' kb-wide' : '') + ((k === '⇧' && shift) ? ' kb-on' : '');
      b.textContent = k === '␣' ? '' : (shift && k.length === 1 ? k.toUpperCase() : k); b.dataset.k = k; b.title = k === '␣' ? 'space' : k;
      // mousedown would steal focus from the text input on desktop; the quad path never focuses buttons, but keep the two paths identical
      b.addEventListener('mousedown', (e) => e.preventDefault());
      b.addEventListener('click', () => press(k));
      r.appendChild(b);
    }
    keysEl.appendChild(r);
  }
}

export function initXRKeyboard() {
  if (api) return api;
  api = makeFrame('keyboard', { title: 'keyboard', w: 440, h: 176, minW: 300, minH: 140, hidden: true, collapsible: false, resizable: false });
  api.xr = true;   // domquad.js mounts every xr-flagged frame as a quad
  const css = document.createElement('style');
  css.textContent = `[data-frame=keyboard] .fr-body { padding: 4px; display: flex; flex-direction: column; gap: 3px; }
.kb-row { display: flex; gap: 3px; justify-content: center; }
.kb-key { flex: 1 1 0; min-width: 0; max-width: 40px; height: 34px; padding: 0; font-size: var(--fs-md, 15px); text-align: center; }
.kb-wide { max-width: 64px; flex-basis: 64px; } .kb-key[data-k="␣"] { max-width: 160px; flex-basis: 160px; }
.kb-on { background: var(--act); border-color: var(--edge-hi); }`;
  document.head.appendChild(css);
  keysEl = document.createElement('div'); keysEl.className = 'kb-keys'; api.body.appendChild(keysEl);
  paint();
  // the last text input the user touched is what the keys type into (HTMLMesh focuses an
  // <input> when its quad is clicked, so a VR click on the chat line lands here)
  document.addEventListener('focusin', (e) => { if (isText(e.target)) { target = e.target; if (isPresenting()) domQuadShow('keyboard', true); } });
  // enter VR: the quad exists in the arc but stays hidden until a text input asks for it
  bus.on('xr:domquads', () => domQuadShow('keyboard', false));
  return api;
}
export const xrKeyboardPress = (k) => press(k);   // harness / agents: the same path a trigger takes
