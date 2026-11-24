// confirmcenter — a yes/no question in the middle of the screen (the browser's confirm() can't be styled and doesn't
// exist in a headset).
//
//   confirmCenter({ title, body, ok = 'OK', cancel = 'Cancel' }) → Promise<boolean>
//
// OK, or Enter (unless Cancel has focus), says yes; Esc, Cancel or the backdrop says no. No press or Enter counts in a
// card's first ARM_MS (see below). One at a time: an ask made while a
// card is open waits its turn and is shown when that one is answered, never answering it (a moderator's warning arriving
// must not dismiss the speech-to-text consent question). No imports: the lite client and the boot path use this too.
//
// In a headset (a DOM card isn't drawn in an immersive session) every ask here goes to the headset's own quad instead:
// xr/xrask.js registers itself with setHeadsetAsk() when it loads, so the lite client and the boot path never load it.

let open = null;   // { root, settle, cancel }
const waiting = [];   // asks made while a card was open, in order: { go, cancel, resolve }
let headset = null;   // { active() → bool, choose(q) → Promise<v>, ask(q) → Promise<string|null> } — xr/xrask.js

/** xr/xrask.js: while `active()`, the questions below are asked on the headset's quad, not on the desk */
export function setHeadsetAsk(h) { headset = h; }
const inHeadset = () => { try { return !!headset?.active(); } catch { return false; } };
/** answer the open desk card with its cancel (a dismissal, never a yes): a headset session starting, or a question
 *  going to the headset, leaves nothing on the desk that a key meant for the headset could answer */
export function closeCenter() { for (const w of waiting.splice(0)) w.resolve(w.cancel); open?.settle(open.cancel); }
// one card at a time: `ask(resolve)` builds the card now, or when the open one (and those before it) are answered
const inTurn = (cancel, ask) => new Promise((resolve) => { if (open) waiting.push({ go: () => ask(resolve), cancel, resolve }); else ask(resolve); });
const next = () => waiting.shift()?.go();
/** A question can't be answered in its first ARM_MS: a press or an Enter that lands then was meant for what was there
 *  before it (a double-press on a card that just closed, whose buttons sat where these are; a chat line's Enter as the
 *  consent card appears). Browsers do the same for their permission prompts (Chromium's input-event activation
 *  protector, ~500 ms). Such input is dropped, not kept for later. A dismissal (Esc, the backdrop, closeCenter) is no
 *  answer and is never held back. xr/xrask.js holds the headset's quad to the same time. */
export const ARM_MS = 450;
// when an input happened: the event's own time (a key that waited behind a busy main thread still arrived early), else now
export const inputAt = (e) => { const n = performance.now(), t = e?.timeStamp; return Number.isFinite(t) && t > 0 ? Math.min(t, n) : n; };
// from now: `armed(e)` says whether input `e` may answer the card; the card wears data-armed once it can (for probes)
function arm(root) {
  const t0 = performance.now(), armed = (e) => inputAt(e) - t0 >= ARM_MS;
  const mark = () => { if (!root.isConnected) return; if (armed()) root.dataset.armed = ''; else setTimeout(mark, Math.max(1, ARM_MS - (performance.now() - t0))); };
  setTimeout(mark, ARM_MS);
  return armed;
}
// a synthetic key aimed at an element outside the card (the VR keyboard's ⏎ on the headset's text field) is not for the
// card. A real key always is: wherever focus went, Esc still answers and a walking key never reaches the body behind
const aimedElsewhere = (e, root) => !e.isTrusted && e.target?.nodeType === 1 && e.target !== document.body && e.target !== document.documentElement && !root.contains(e.target);
// focus taken off the open card (another control, the canvas) comes back to `home`: Enter out of sight must not answer it.
// Returns the release.
function holdFocus(root, home) {
  const back = (e) => { if (!root.contains(e.target)) home.focus(); };
  document.addEventListener('focusin', back, true);
  return () => document.removeEventListener('focusin', back, true);
}

export function confirmCenter({ title, body = '', ok = 'OK', cancel = 'Cancel' } = {}) {
  if (inHeadset()) { closeCenter(); return headset.choose({ title, body, choices: [{ v: 'ok', label: ok }, { v: 'cancel', label: cancel }], cancel: 'cancel', focus: 'ok' }).then((v) => v === 'ok'); }
  if (typeof document === 'undefined') return Promise.resolve(false);
  return inTurn(false, (resolve) => {
    const root = document.createElement('div');
    root.id = 'confirm-center';
    root.innerHTML = '<div class="cc-card panel" role="alertdialog" aria-modal="true" aria-labelledby="cc-title" aria-describedby="cc-body">'
      + '<b id="cc-title"></b><p id="cc-body"></p><div class="cc-btns"><button type="button" class="cc-no"></button><button type="button" class="cc-ok"></button></div></div>';
    root.querySelector('#cc-title').textContent = title;
    root.querySelector('#cc-body').textContent = body;
    if (!body) root.querySelector('#cc-body').remove();
    root.querySelector('.cc-ok').textContent = ok;
    root.querySelector('.cc-no').textContent = cancel;
    const before = document.activeElement;
    const okB = root.querySelector('.cc-ok'), noB = root.querySelector('.cc-no');
    const onKey = (e) => {
      if (aimedElsewhere(e, root)) return;
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); settle(false); }
      // Enter on a focused button presses THAT button (Cancel included) — not "yes" whatever has focus
      else if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); e.stopPropagation(); if (armed(e)) settle(!e.target?.classList?.contains('cc-no')); }
      // Tab stays between the two buttons: focus that wandered off the card would leave Enter meaning yes out of sight
      else if (e.key === 'Tab') { e.preventDefault(); e.stopPropagation(); (e.target === okB ? noB : okB).focus(); }
      else e.stopPropagation();   // typing here is never walking or a hotkey
    };
    let release = () => {};
    function settle(v) {
      if (open?.root !== root) return;
      open = null;
      removeEventListener('keydown', onKey, true); release();
      root.remove();
      try { before?.focus?.(); } catch { /* gone */ }
      resolve(v); next();
    }
    root.addEventListener('pointerdown', (e) => { if (e.target === root) settle(false); });
    okB.addEventListener('click', (e) => { if (armed(e)) settle(true); });
    noB.addEventListener('click', (e) => { if (armed(e)) settle(false); });
    addEventListener('keydown', onKey, true);
    document.body.appendChild(root);
    const armed = arm(root);
    open = { root, settle, cancel: false };   // cancel: what a dismissal (closeCenter) answers it with
    okB.focus(); release = holdFocus(root, okB);
  });
}

export const confirmOpen = () => !!open;

/** The same centre card asking for a few words (a name): {title, body, value, placeholder, ok, cancel, max (null: no limit)} → the
 *  trimmed text, or null (Esc, Cancel, the backdrop, or nothing typed). Enter in the field says OK. */
export function askCenter({ title, body = '', value = '', placeholder = '', ok = 'Save', cancel = 'Cancel', max = 80 } = {}) {
  if (inHeadset() && headset.ask) { closeCenter(); return headset.ask({ title, body, value, placeholder, ok, cancel, max }); }
  if (typeof document === 'undefined') return Promise.resolve(null);
  return inTurn(null, (resolve) => {
    const root = document.createElement('div');
    root.id = 'confirm-center';
    root.innerHTML = '<div class="cc-card panel" role="dialog" aria-modal="true" aria-labelledby="cc-title">'
      + '<b id="cc-title"></b><p id="cc-body"></p><input class="cc-input" type="text" autocomplete="off" spellcheck="false"><div class="cc-btns"><button type="button" class="cc-no"></button><button type="button" class="cc-ok"></button></div></div>';
    root.querySelector('#cc-title').textContent = title;
    root.querySelector('#cc-body').textContent = body;
    if (!body) root.querySelector('#cc-body').remove();
    const inp = root.querySelector('.cc-input'); inp.value = String(value ?? ''); inp.placeholder = placeholder;
    if (max != null) { inp.value = inp.value.slice(0, max); inp.maxLength = max; }
    const okB = root.querySelector('.cc-ok'), noB = root.querySelector('.cc-no');
    okB.textContent = ok; noB.textContent = cancel;
    const before = document.activeElement;
    const answer = () => { const v = inp.value.trim(); return v ? v : null; };
    const onKey = (e) => {
      if (aimedElsewhere(e, root)) return;
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); settle(null); }
      else if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); e.stopPropagation(); if (armed(e)) settle(e.target === noB ? null : answer()); }
      // Tab walks the field and the two buttons, never off the card
      else if (e.key === 'Tab') { e.preventDefault(); e.stopPropagation(); const ring = [inp, noB, okB], i = ring.indexOf(e.target); ring[(i + (e.shiftKey ? ring.length - 1 : 1)) % ring.length].focus(); }
      else e.stopPropagation();   // typing a name is never walking or a hotkey
    };
    let release = () => {};
    function settle(v) {
      if (open?.root !== root) return;
      open = null;
      removeEventListener('keydown', onKey, true); release();
      root.remove();
      try { before?.focus?.(); } catch { /* gone */ }
      resolve(v); next();
    }
    root.addEventListener('pointerdown', (e) => { if (e.target === root) settle(null); });
    okB.addEventListener('click', (e) => { if (armed(e)) settle(answer()); });
    noB.addEventListener('click', (e) => { if (armed(e)) settle(null); });
    addEventListener('keydown', onKey, true);
    document.body.appendChild(root);
    const armed = arm(root);
    open = { root, settle, cancel: null };
    inp.focus(); inp.select(); release = holdFocus(root, inp);
  });
}

/** The same centre card with more than two answers (the lock question: ✓ Move anyway / ✕ Cancel / 🔓 Unlock).
 *  choices: [{v, label, danger?}], in the order shown (danger: styled as destructive); `cancel` is the v that Esc and the backdrop answer (and Enter on it).
 *  The first choice has focus (the house yes) unless `focus` names another v; Tab walks the buttons. Resolves with the chosen v. Same one-at-a-time
 *  rule: asked while a card is open, it waits its turn. */
export function chooseCenter({ title, body = '', choices = [], cancel = null, focus = null } = {}) {
  if (inHeadset() && choices.length) { closeCenter(); return headset.choose({ title, body, choices, cancel, focus: focus ?? choices[0].v }); }   // focused as the desk card would
  if (typeof document === 'undefined' || !choices.length) return Promise.resolve(cancel);
  return inTurn(cancel, (resolve) => {
    const root = document.createElement('div');
    root.id = 'confirm-center';
    root.innerHTML = '<div class="cc-card panel" role="alertdialog" aria-modal="true" aria-labelledby="cc-title" aria-describedby="cc-body">'
      + '<b id="cc-title"></b><p id="cc-body"></p><div class="cc-btns cc-many"></div></div>';
    root.querySelector('#cc-title').textContent = title;
    root.querySelector('#cc-body').textContent = body;
    if (!body) root.querySelector('#cc-body').remove();
    const box = root.querySelector('.cc-btns');
    const btns = choices.map((c, i) => {
      const b = document.createElement('button'); b.type = 'button';
      b.className = c.danger ? 'cc-danger' : i === 0 ? 'cc-ok' : c.v === cancel ? 'cc-no' : 'cc-alt';
      b.textContent = c.label; b.dataset.v = String(c.v);
      b.addEventListener('click', (e) => { if (armed(e)) settle(c.v); });
      box.append(b); return b;
    });
    const before = document.activeElement;
    const onKey = (e) => {
      if (aimedElsewhere(e, root)) return;
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); settle(cancel); }
      else if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); e.stopPropagation(); const i = btns.indexOf(e.target); if (armed(e)) settle(i >= 0 ? choices[i].v : cancel); }
      else if (e.key === 'Tab') { e.preventDefault(); e.stopPropagation(); const i = btns.indexOf(e.target); btns[(i + (e.shiftKey ? btns.length - 1 : 1)) % btns.length].focus(); }
      else e.stopPropagation();   // typing here is never walking or a hotkey
    };
    let release = () => {};
    function settle(v) {
      if (open?.root !== root) return;
      open = null;
      removeEventListener('keydown', onKey, true); release();
      root.remove();
      try { before?.focus?.(); } catch { /* gone */ }
      resolve(v); next();
    }
    root.addEventListener('pointerdown', (e) => { if (e.target === root) settle(cancel); });
    addEventListener('keydown', onKey, true);
    document.body.appendChild(root);
    const armed = arm(root);
    open = { root, settle, cancel };
    // `focus`: the answer Enter gives at first — a destructive question focuses its safe answer
    const fi = focus != null ? choices.findIndex((c) => c.v === focus) : -1;
    btns[fi >= 0 ? fi : 0].focus(); release = holdFocus(root, btns[fi >= 0 ? fi : 0]);
  });
}
