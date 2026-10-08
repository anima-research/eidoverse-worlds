// confirmcenter — a yes/no question in the middle of the screen, for a press that would otherwise do something
// big without warning: leaving for the light version, or a VR click that has to restart the page on WebGL
// (owner, 10-01: "a pop-up confirmation in the center of the screen… that's caught me by surprise a few times").
// The browser's own confirm() hangs from the top edge, can't be styled, and doesn't exist inside a headset.
//
//   confirmCenter({ title, body, ok = 'OK', cancel = 'Cancel' }) → Promise<boolean>
//
// Enter or the OK button says yes; Esc, the Cancel button, or a press on the dim backdrop says no. One at a time:
// asking again while one is open answers the open one no and replaces it.
// No imports: the lite client and the boot path may use this without pulling the engine in.

let open = null;   // { root, settle }

export function confirmCenter({ title, body = '', ok = 'OK', cancel = 'Cancel' } = {}) {
  if (typeof document === 'undefined') return Promise.resolve(false);
  open?.settle(open.cancel ?? false);
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
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); settle(false); }
      // Enter on a focused button presses THAT button (Cancel included) — not "yes" whatever has focus (review #212)
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
    open = { root, settle };
    root.querySelector('.cc-ok').focus();
  });
}

export const confirmOpen = () => !!open;

/** The same centre card asking for a few words (a name): {title, body, value, placeholder, ok, cancel, max} → the
 *  trimmed text, or null (Esc, Cancel, the backdrop, or nothing typed). Enter in the field says OK. */
export function askCenter({ title, body = '', value = '', placeholder = '', ok = 'Save', cancel = 'Cancel', max = 80 } = {}) {
  if (typeof document === 'undefined') return Promise.resolve(null);
  open?.settle(open.cancel ?? false);
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
 *  The first choice has focus (the house yes); Tab walks the buttons. Resolves with the chosen v. Same one-at-a-time
 *  rule: asking again answers the open one with its cancel. */
export function chooseCenter({ title, body = '', choices = [], cancel = null, focus = null } = {}) {
  if (typeof document === 'undefined' || !choices.length) return Promise.resolve(cancel);
  open?.settle(open.cancel ?? false);
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
    // `focus`: the answer Enter gives at first — a destructive question focuses its safe answer (review 10-07 S1: Enter
    // on "This is locked. Delete anyway?" deleted it)
    const fi = focus != null ? choices.findIndex((c) => c.v === focus) : -1;
    btns[fi >= 0 ? fi : 0].focus();
  });
}
