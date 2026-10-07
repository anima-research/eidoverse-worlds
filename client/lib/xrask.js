// xrask — the centre card's questions, inside a headset. confirmcenter.js is a DOM card, and a DOM card isn't drawn in
// an immersive session: an edit to a locked thing waited on a question nobody could see, and editwrites's settled() then
// made every later undo wait behind it (top-down review 10-06, S1-3). In VR the same question rides a quad: by default
// a hidden xr-flagged DOM frame that domquad.js mirrors (as the VR keyboard does), or on the canvas path (?domquads=0) a
// schema panel in xrpanels.js; showXRPanel picks whichever is live, and either's buttons answer it. Refusals, which are toasts
// on the desk and therefore silent in a headset, show here too, with an OK.
// R, 10-06 23:39: VR edit mode comes later, but nothing should be broken in principle there.
import { renderer } from './core.js';
import { bus } from './base.js';
import { registerXRPanel, showXRPanel } from './xrpanels.js';
import { makeFrame } from './windows.js';

let pending = null;   // {title, body, choices: [{v, label}], cancel, resolve}
let api = null;       // the DOM frame the default VR path mirrors onto a quad (domquad.js mounts every xr-flagged frame)
export const xrActive = () => !!renderer?.xr?.isPresenting;
function paintFrame() {
  if (!api) return;
  api.body.textContent = '';
  const q = pending; if (!q) return;
  const h = document.createElement('div'); h.className = 'ask-title'; h.textContent = q.title; api.body.appendChild(h);
  if (q.body) { const p = document.createElement('div'); p.className = 'ask-body'; p.textContent = q.body; api.body.appendChild(p); }
  const row = document.createElement('div'); row.className = 'ask-row';
  for (const c of q.choices) { const b = document.createElement('button'); b.type = 'button'; b.textContent = c.label; b.dataset.v = c.v;
    b.addEventListener('click', () => dispatch(`c:${c.v}`)); row.appendChild(b); }
  api.body.appendChild(row);
}
const repaint = () => { paintFrame(); bus.emit('xr:repaint'); };

function fields() {
  if (!pending) return [{ t: 'info', label: '', value: 'nothing to answer' }];
  const f = [{ t: 'info', label: pending.title, value: pending.body }];
  for (const c of pending.choices) f.push({ t: 'btn', k: `c:${c.v}`, label: c.label });
  return f;
}
function settle(v) {
  const p = pending; if (!p) return;
  pending = null; showXRPanel('ask', false); repaint(); p.resolve(v);
}
function dispatch(action) { if (typeof action === 'string' && action.startsWith('c:')) settle(action.slice(2)); }
registerXRPanel({ id: 'ask', title: 'question', fields, dispatch });   // the canvas-quad path (?domquads=0)
/** the default path's frame: hidden on the desk (the centre card asks there), a quad in a headset */
export function initXRAsk() {
  if (api) return api;
  api = makeFrame('ask', { title: 'question', w: 380, h: 170, minW: 280, minH: 120, hidden: true, collapsible: false, resizable: false });
  api.xr = true;
  const css = document.createElement('style');
  css.textContent = `[data-frame=ask] .fr-body { padding: 8px; display: flex; flex-direction: column; gap: 6px; }
.ask-title { font-weight: 600; } .ask-row { display: flex; gap: 6px; flex-wrap: wrap; } .ask-row button { flex: 1 1 0; min-height: 34px; }`;
  document.head.appendChild(css);
  bus.on('xr:domquads', () => { if (!pending) showXRPanel('ask', false); });   // entering VR: present but hidden until asked
  return api;
}

/** chooseCenter's contract ({title, body, choices: [{v, label}], cancel} → the chosen v), on a VR quad. Asking again
 *  answers the open question with its cancel, as the centre card does. */
export function chooseXR({ title, body = '', choices = [], cancel = null } = {}) {
  if (!choices.length) return Promise.resolve(cancel);
  if (pending) settle(pending.cancel);
  return new Promise((resolve) => { pending = { title, body, choices, cancel, resolve }; showXRPanel('ask', true); repaint(); });
}

// a refusal in a headset: the toast's words, on the quad, until OK (never on top of an open question)
bus.on('edit-refused', ({ text }) => {
  if (!xrActive() || pending) return;
  chooseXR({ title: 'refused — nothing changed', body: text, choices: [{ v: 'ok', label: 'OK' }], cancel: 'ok' });
});

// a warning on a write that went through, likewise (the desk shows it as a toast)
bus.on('edit-warned', ({ text }) => {
  if (!xrActive() || pending) return;
  chooseXR({ title: 'done — with a warning', body: text, choices: [{ v: 'ok', label: 'OK' }], cancel: 'ok' });
});

/** for probes: the open question as a quad shows it, and the same answer a button press gives */
export const xrAskState = () => (pending ? { title: pending.title, body: pending.body, choices: pending.choices.map((c) => c.v) } : null);
export const xrAnswer = (v) => dispatch(`c:${v}`);
