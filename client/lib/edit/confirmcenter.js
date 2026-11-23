// confirmcenter — a yes/no question in the middle of the screen (the browser's confirm() can't be styled and doesn't
// exist in a headset).
//
//   confirmCenter({ title, body, ok = 'OK', cancel = 'Cancel' }) → Promise<boolean>
//
// OK, or Enter (unless Cancel has focus), says yes; Esc, Cancel or the backdrop says no. One at a time: a new ask answers the open one with its
// cancel. No imports: the lite client and the boot path use this too.
//
// In a headset (a DOM card isn't drawn in an immersive session) every ask here goes to the headset's own quad instead:
// xr/xrask.js registers itself with setHeadsetAsk() when it loads, so the lite client and the boot path never load it.

let open = null;   // { root, settle, cancel }
let headset = null;   // { active() → bool, choose(q) → Promise<v>, ask(q) → Promise<string|null> } — xr/xrask.js

/** xr/xrask.js: while `active()`, the questions below are asked on the headset's quad, not on the desk */
export function setHeadsetAsk(h) { headset = h; }
const inHeadset = () => { try { return !!headset?.active(); } catch { return false; } };
/** answer the open desk card with its cancel (a dismissal, never a yes): a headset session starting, or a question
 *  going to the headset, leaves nothing on the desk that a key meant for the headset could answer */
export function closeCenter() { open?.settle(open.cancel); }
// a key aimed at an element outside the card (the headset's text field, typed on the VR keyboard) is not for the card
const aimedElsewhere = (e, root) => e.target?.nodeType === 1 && e.target !== document.body && e.target !== document.documentElement && !root.contains(e.target);

export function confirmCenter({ title, body = '', ok = 'OK', cancel = 'Cancel' } = {}) {
  if (inHeadset()) { closeCenter(); return headset.choose({ title, body, choices: [{ v: 'ok', label: ok }, { v: 'cancel', label: cancel }], cancel: 'cancel' }).then((v) => v === 'ok'); }
  if (typeof document === 'undefined') return Promise.resolve(false);
  open?.settle(open.cancel);
  return new Promise((resolve) => {
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
      else if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); e.stopPropagation(); settle(!e.target?.classList?.contains('cc-no')); }
      // Tab stays between the two buttons: focus that wandered off the card would leave Enter meaning yes out of sight
      else if (e.key === 'Tab') { e.preventDefault(); e.stopPropagation(); (e.target === okB ? noB : okB).focus(); }
      else e.stopPropagation();   // typing here is never walking or a hotkey
    };
    function settle(v) {
      if (open?.root !== root) return;
      open = null;
      removeEventListener('keydown', onKey, true);
      root.remove();
      try { before?.focus?.(); } catch { /* gone */ }
      resolve(v);
    }
    root.addEventListener('pointerdown', (e) => { if (e.target === root) settle(false); });
    root.querySelector('.cc-ok').addEventListener('click', () => settle(true));
    root.querySelector('.cc-no').addEventListener('click', () => settle(false));
    addEventListener('keydown', onKey, true);
    document.body.appendChild(root);
    open = { root, settle, cancel: false };   // cancel: what an interrupting ask answers it with
    root.querySelector('.cc-ok').focus();
  });
}

export const confirmOpen = () => !!open;

/** The same centre card asking for a few words (a name): {title, body, value, placeholder, ok, cancel, max} → the
 *  trimmed text, or null (Esc, Cancel, the backdrop, or nothing typed). Enter in the field says OK. */
export function askCenter({ title, body = '', value = '', placeholder = '', ok = 'Save', cancel = 'Cancel', max = 80 } = {}) {
  if (inHeadset() && headset.ask) { closeCenter(); return headset.ask({ title, body, value, placeholder, ok, cancel, max }); }
  if (typeof document === 'undefined') return Promise.resolve(null);
  open?.settle(open.cancel);
  return new Promise((resolve) => {
    const root = document.createElement('div');
    root.id = 'confirm-center';
    root.innerHTML = '<div class="cc-card panel" role="dialog" aria-modal="true" aria-labelledby="cc-title">'
      + '<b id="cc-title"></b><p id="cc-body"></p><input class="cc-input" type="text" autocomplete="off" spellcheck="false"><div class="cc-btns"><button type="button" class="cc-no"></button><button type="button" class="cc-ok"></button></div></div>';
    root.querySelector('#cc-title').textContent = title;
    root.querySelector('#cc-body').textContent = body;
    if (!body) root.querySelector('#cc-body').remove();
    const inp = root.querySelector('.cc-input'); inp.value = String(value ?? '').slice(0, max); inp.placeholder = placeholder; inp.maxLength = max;
    const okB = root.querySelector('.cc-ok'), noB = root.querySelector('.cc-no');
    okB.textContent = ok; noB.textContent = cancel;
    const before = document.activeElement;
    const answer = () => { const v = inp.value.trim(); return v ? v : null; };
    const onKey = (e) => {
      if (aimedElsewhere(e, root)) return;
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); settle(null); }
      else if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); e.stopPropagation(); settle(e.target === noB ? null : answer()); }
      else e.stopPropagation();   // typing a name is never walking or a hotkey
    };
    function settle(v) {
      if (open?.root !== root) return;
      open = null;
      removeEventListener('keydown', onKey, true);
      root.remove();
      try { before?.focus?.(); } catch { /* gone */ }
      resolve(v);
    }
    root.addEventListener('pointerdown', (e) => { if (e.target === root) settle(null); });
    okB.addEventListener('click', () => settle(answer()));
    noB.addEventListener('click', () => settle(null));
    addEventListener('keydown', onKey, true);
    document.body.appendChild(root);
    open = { root, settle, cancel: null };
    inp.focus(); inp.select();
  });
}

/** The same centre card with more than two answers (the lock question: ✓ Move anyway / ✕ Cancel / 🔓 Unlock).
 *  choices: [{v, label, danger?}], in the order shown (danger: styled as destructive); `cancel` is the v that Esc and the backdrop answer (and Enter on it).
 *  The first choice has focus (the house yes) unless `focus` names another v; Tab walks the buttons. Resolves with the chosen v. Same one-at-a-time
 *  rule: asking again answers the open one with its cancel. */
export function chooseCenter({ title, body = '', choices = [], cancel = null, focus = null } = {}) {
  if (inHeadset() && choices.length) { closeCenter(); return headset.choose({ title, body, choices, cancel }); }
  if (typeof document === 'undefined' || !choices.length) return Promise.resolve(cancel);
  open?.settle(open.cancel);
  return new Promise((resolve) => {
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
      b.addEventListener('click', () => settle(c.v));
      box.append(b); return b;
    });
    const before = document.activeElement;
    const onKey = (e) => {
      if (aimedElsewhere(e, root)) return;
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); settle(cancel); }
      else if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); e.stopPropagation(); const i = btns.indexOf(e.target); settle(i >= 0 ? choices[i].v : cancel); }
      else if (e.key === 'Tab') { e.preventDefault(); e.stopPropagation(); const i = btns.indexOf(e.target); btns[(i + (e.shiftKey ? btns.length - 1 : 1)) % btns.length].focus(); }
      else e.stopPropagation();   // typing here is never walking or a hotkey
    };
    function settle(v) {
      if (open?.root !== root) return;
      open = null;
      removeEventListener('keydown', onKey, true);
      root.remove();
      try { before?.focus?.(); } catch { /* gone */ }
      resolve(v);
    }
    root.addEventListener('pointerdown', (e) => { if (e.target === root) settle(cancel); });
    addEventListener('keydown', onKey, true);
    document.body.appendChild(root);
    open = { root, settle, cancel };
    // `focus`: the answer Enter gives at first — a destructive question focuses its safe answer
    const fi = focus != null ? choices.findIndex((c) => c.v === focus) : -1;
    btns[fi >= 0 ? fi : 0].focus();
  });
}
