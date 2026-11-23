// xrask — the centre card's questions (edit/confirmcenter.js), inside a headset. A DOM card isn't drawn in an immersive
// session, and an unanswered question holds every later undo (edit/writes.js settled()). In VR the question rides a quad:
// by default a hidden xr-flagged DOM frame that domquad.js mirrors, or on the canvas path (?canvasquads=1) a schema panel
// in xrpanels.js; showXRPanel picks whichever is live. Refusals (toasts on the desk) and warnings (the desk's status bar)
// show here too.
import { renderer } from '../core.js';
import { bus } from '../base.js';
import { registerXRPanel, showXRPanel } from './xrpanels.js';
import { domQuadMesh } from './domquad.js';
import { makeFrame } from '../ui/windows.js';
import { setHeadsetAsk, closeCenter } from '../edit/confirmcenter.js';

let pending = null;   // {title, body, choices: [{v, label}], cancel, resolve, input?: {value, placeholder, max}, onShow?}
const waiting = [];   // questions asked while one was open: each is asked in turn, none replaces another
let api = null;       // the DOM frame the default VR path mirrors onto a quad (domquad.js mounts every xr-flagged frame)
export const xrActive = () => !!renderer?.xr?.isPresenting;
function paintFrame() {
  if (!api) return;
  api.body.textContent = '';
  const q = pending; if (!q) return;
  const h = document.createElement('div'); h.className = 'ask-title'; h.textContent = q.title; api.body.appendChild(h);
  if (q.body) { const p = document.createElement('div'); p.className = 'ask-body'; p.textContent = q.body; api.body.appendChild(p); }
  if (q.input) {
    // a few words: the VR keyboard (xrkeyboard.js) types into the last-focused text input and its ⏎ is an Enter keydown here
    const inp = document.createElement('input'); inp.type = 'text'; inp.className = 'ask-input'; inp.autocomplete = 'off'; inp.spellcheck = false;
    inp.maxLength = q.input.max; inp.placeholder = q.input.placeholder; inp.value = q.input.value;
    inp.addEventListener('input', () => { q.input.value = inp.value; });
    inp.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); dispatch('c:ok'); } });
    api.body.appendChild(inp);
  }
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
function show(q) {
  if (pending) { waiting.push(q); return; }
  pending = q; showXRPanel('ask', true); repaint(); q.onShow?.();
}
function settle(v) {
  const p = pending; if (!p) return;
  pending = null; keyboardBack(); showXRPanel('ask', false); repaint(); p.resolve(v);
  const next = waiting.shift(); if (next) show(next);
}
function dispatch(action) { if (typeof action === 'string' && action.startsWith('c:')) settle(action.slice(2)); }
registerXRPanel({ id: 'ask', title: 'question', fields, dispatch });   // the canvas-quad path (?canvasquads=1)
// the house centre card (edit/confirmcenter.js) asks here whenever a headset is presenting: confirmCenter, chooseCenter
// and askCenter callers need no headset branch of their own
setHeadsetAsk({ active: xrActive, choose: (q) => chooseXR(q), ask: (q) => askXR(q) });
// entering: a desk card still open is dismissed (nobody can see it now, and it must not take a key meant for the headset);
// leaving: the open question is answered with its cancel, likewise
bus.on('xr:state', (on) => {
  if (on) { closeCenter(); return; }
  for (const q of waiting.splice(0)) q.resolve(q.cancel);   // the ones waiting too: nobody will see them now
  if (pending) settle(pending.cancel);
});
/** the default path's frame: hidden on the desk (the centre card asks there), a quad in a headset */
export function initXRAsk() {
  if (api) return api;
  api = makeFrame('ask', { title: 'question', w: 380, h: 170, minW: 280, minH: 120, hidden: true, collapsible: false, resizable: false });
  api.xr = true;
  const css = document.createElement('style');
  css.textContent = `[data-frame=ask] .fr-body { padding: 8px; display: flex; flex-direction: column; gap: 6px; }
.ask-title { font-weight: 600; flex: none; } .ask-input { flex: none; min-height: 30px; } .ask-body { flex: 1; min-height: 0; overflow: auto; } .ask-row { flex: none; display: flex; gap: 6px; flex-wrap: wrap; } .ask-row button { flex: 1 1 0; min-height: 34px; }`;
  document.head.appendChild(css);
  bus.on('xr:domquads', () => { if (!pending) showXRPanel('ask', false); });   // entering VR: present but hidden until asked
  return api;
}

/** chooseCenter's contract ({title, body, choices: [{v, label}], cancel} → the chosen v), on a VR quad. Asked while
 *  another question is open, it waits its turn: replacing the open one would answer it with its cancel, and a consent
 *  question (audio/voiceconsent.js) must be answered by a person, not by a moderator's warning arriving. */
export function chooseXR({ title, body = '', choices = [], cancel = null } = {}) {
  if (!choices.length) return Promise.resolve(cancel);
  return new Promise((resolve) => show({ title, body, choices, cancel, resolve }));
}

/** askCenter's contract ({title, body, value, placeholder, ok, cancel, max} → the trimmed text, or null), on the VR quad:
 *  a text field the VR keyboard types into, OK / ⏎ to answer. On the canvas-quad path (no text field) OK answers `value`. */
export function askXR({ title, body = '', value = '', placeholder = '', ok = 'Save', cancel = 'Cancel', max = 80 } = {}) {
  return new Promise((resolve) => {
    const input = { value: String(value ?? '').slice(0, max), placeholder, max };
    const q = { title, body, choices: [{ v: 'cancel', label: cancel }, { v: 'ok', label: ok }], cancel: 'cancel', input,
      resolve: (v) => { const t = input.value.trim(); resolve(v === 'ok' && t ? t : null); },
      // when it is asked (now, or when its turn comes): focus the field at once, so the VR keyboard comes up with the
      // question (its focusin listener shows it)…
      onShow: () => setTimeout(() => { const el = api?.body.querySelector('.ask-input'); if (pending === q && el) { try { el.focus(); el.select(); } catch { /* not drawn */ } keyboardBelow(); } }, 0) };
    show(q);
  });
}

// …and just under the question: on the arc the two are neighbours and overlap (0.58 m quads, 0.55 rad apart at 0.85 m),
// so the question covered the keyboard's ⌫ and ⏎. Moved for this ask only: keyboardBack() puts it where it was when the
// question is settled (the mesh outlives the question and the session), unless the person dragged it meanwhile.
let kbWas = null;   // {mesh, pos, quat, placed}: the keyboard's own pose, and where keyboardBelow put it
function keyboardBelow() {
  const a = domQuadMesh('ask'), k = domQuadMesh('keyboard');
  if (!a?.visible || !k?.visible || a.parent !== k.parent) return;
  if (kbWas?.mesh !== k) kbWas = { mesh: k, pos: k.position.clone(), quat: k.quaternion.clone(), placed: null };
  const h = (m) => (m.geometry.parameters?.height ?? 0) * m.scale.y;
  k.position.copy(a.position); k.position.y -= (h(a) + h(k)) / 2 + 0.05;   // the gap clears the ask quad's grab handle (~4 cm under it)
  k.quaternion.copy(a.quaternion); k.updateMatrixWorld(true);
  kbWas.placed = k.position.clone();
}
function keyboardBack() {
  const w = kbWas; kbWas = null;
  if (!w || domQuadMesh('keyboard') !== w.mesh || !w.placed || w.mesh.position.distanceTo(w.placed) > 1e-6) return;   // rebuilt, or dragged: theirs now
  w.mesh.position.copy(w.pos); w.mesh.quaternion.copy(w.quat); w.mesh.updateMatrixWorld(true);
}

// a refusal in a headset: the toast's words, on the quad, until OK (never on top of an open question)
bus.on('edit-refused', ({ text }) => {
  if (!xrActive() || pending) return;
  chooseXR({ title: 'refused — nothing changed', body: text, choices: [{ v: 'ok', label: 'OK' }], cancel: 'ok' });
});

// a physics act refused (grab, put, throw…): the desk says it in chat, which a headset person seldom has open. The card goes by
// itself after PLAY_CARD_MS; OK only puts it away sooner. A timed-out or offline request may yet land, and says so.
const PLAY_CARD_MS = 4000;
bus.on('thingphysics-refused', ({ text, refused: x }) => {
  if (!xrActive() || pending || !text) return;
  const lost = x?.code === 'timeout' || x?.code === 'offline';
  chooseXR({ title: x?.mayHaveLanded ? 'no answer — it may still have landed' : lost ? "didn't go through" : 'refused — nothing changed', body: text, choices: [{ v: 'ok', label: 'OK' }], cancel: 'ok' });
  const mine = pending; setTimeout(() => { if (pending === mine) settle('ok'); }, PLAY_CARD_MS);
});

// a warning on a write that went through, likewise (the desk shows it on the status bar: writes.js showWarnings)
bus.on('edit-warned', ({ text }) => {
  if (!xrActive() || pending) return;
  chooseXR({ title: 'done — with a warning', body: text, choices: [{ v: 'ok', label: 'OK' }], cancel: 'ok' });
});

/** for probes: the open question as a quad shows it, and the same answer a button press gives */
export const xrAskState = () => (pending ? { title: pending.title, body: pending.body, choices: pending.choices.map((c) => c.v) } : null);
export const xrAnswer = (v) => dispatch(`c:${v}`);
