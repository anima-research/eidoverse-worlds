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
  open?.settle(false);
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
