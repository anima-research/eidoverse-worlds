// rows — the house row builders, one copy.
//
// Every tuning panel in this client is the same three-element row: a name span,
// a control, a readout. Before this file the slider variant alone was spelled
// SEVEN times (six inside debug.js — dials, joints, blink, limp, hair, wings —
// plus the sky panel's), each a private loop with its own accidental widths and
// its own repaint bug surface (survey §B5). The builders here are DUMB on
// purpose: they own layout and wiring, never state — state lives in the table
// the caller hands in (TUNING, HAIR_TUNING, a def bag), which is what keeps
// "reset" a one-line write-then-repaint everywhere.

const mk = (tag, className, cssText) => {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (cssText) n.style.cssText = cssText;
  return n;
};

/** The house <select> skin — build's panels spelled this cssText five times. */
export const SELECT_CSS = 'font:11px var(--font); background:rgba(4,14,20,.9); '
  + 'color:var(--fg); border:1px solid var(--edge); border-radius:5px; padding:5px;';

/** A column of labelled sliders over a mutable table.
 *
 *  fields: [key, lo, hi, step][] — a field whose current value reads undefined
 *  is skipped (the joint panel's specs differ per joint).
 *  opts:
 *    get/set   — indirection for nested tables (default: obj[key])
 *    fmt(k, v) — readout text (default String(v))
 *    label(k)  — row name (default the key itself)
 *    onSet(k)  — called after every write (live retune hooks)
 *    nmW / vW  — the two fixed column widths
 *  Returns { el, repaint } — repaint re-reads the table into fresh rows, which
 *  is the whole reset story: write the defaults, call repaint. */
export function sliderTable(fields, obj, {
  get = (k) => obj[k], set = (k, v) => { obj[k] = v; },
  fmt = (k, v) => String(v), label = (k) => k, onSet = null,
  nmW = '54px', vW = '44px',
} = {}) {
  const el = mk('div', null, 'display:flex;flex-direction:column;gap:3px');
  const repaint = () => {
    el.textContent = '';
    for (const [f, lo, hi, st] of fields) {
      if (get(f) === undefined) continue;
      const wrap = mk('div', 'row');
      const nm = mk('span', 'nm');
      nm.style.width = nmW;
      nm.textContent = label(f);
      const sl = mk('input');
      sl.type = 'range'; sl.min = lo; sl.max = hi; sl.step = st; sl.value = get(f);
      const val = mk('span', 'v');
      val.style.width = vW;
      const show = () => { val.textContent = fmt(f, get(f)); };
      sl.oninput = () => { set(f, Number(sl.value)); show(); onSet?.(f); };
      show();
      wrap.append(nm, sl, val);
      el.appendChild(wrap);
    }
  };
  repaint();
  return { el, repaint };
}

/** A labelled checkbox row. get/set keep the state in the caller's table. */
export function checkRow(labelText, get, set, { className = 'row' } = {}) {
  const wrap = mk('label', className);
  const cb = mk('input');
  cb.type = 'checkbox';
  cb.checked = !!get();
  cb.onchange = () => set(cb.checked);
  const nm = mk('span');
  nm.textContent = labelText;
  wrap.append(cb, nm);
  return wrap;
}

/** A labelled <select> row in the house skin. `options` is a key list or
 *  [value, text] pairs. Returns { row, select }. */
export function selectRow(labelText, options, value, onChange) {
  const row = mk('div', 'row');
  const nm = mk('span', 'nm');
  nm.textContent = labelText;
  const sel = mk('select', null, SELECT_CSS);
  for (const o of options) {
    const [v, t] = Array.isArray(o) ? o : [o, o];
    sel.appendChild(new Option(t, v));
  }
  if (value != null) sel.value = value;
  if (onChange) sel.onchange = () => onChange(sel.value);
  row.append(nm, sel);
  return { row, select: sel };
}

/** A button. */
export function btn(labelText, fn, cssText = '') {
  const b = mk('button', null, cssText);
  b.textContent = labelText;
  b.onclick = fn;
  return b;
}

/** A row of buttons that share the width. */
export function btnRow(...buttons) {
  const wrap = mk('div', null, 'display:flex; flex-wrap:wrap; gap:3px;');
  for (const b of buttons) { b.style.flex = '1 0 auto'; wrap.appendChild(b); }
  return wrap;
}

/** The '— section —' divider the tuning panels stack between families. */
export function sectionHead(text) {
  const h = mk('div', 'row', 'margin-top:6px;opacity:.75');
  h.textContent = `— ${text} —`;
  return h;
}
