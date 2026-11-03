// statuschips — the status strip: small pills on the ∃'s own line, beside the mic/ear glyphs, for anything that is
// true of this visit and worth knowing but not worth covering the world for ("WebGL 2 ⓘ", "reduced detail",
// "graphics reset"). A chip is the whole notice at rest; a click opens its full text and its actions in a popover
// anchored to it. Amber (--attn) is a caveat, red (--err) a failure.
//
//   statusChip({ id, level, label, title, body, actions })   add, or update in place
//     level    'attn' (a caveat) | 'err' (a failure)
//     label    the chip's few words
//     title    the popover's heading;  body: its text
//     actions  [{ label, run?, clear? }] — each button runs `run`, then collapses the popover;
//              `clear: true` also removes the chip. Default: one 'got it'.
//     open     true: open the popover now (a notice that is the only explanation for a dead canvas)
//   clearStatusChip(id)
//
// PLACEMENT: the strip continues the ∃'s status line past whatever glyphs sit on it. On a vertical rail (left/right)
// that line is the ∃'s ROW, so the chips run along it, away from the edge. On a horizontal rail (top/bottom) the row
// is the rail itself, so the line is the ∃'s COLUMN (the glyphs fold down/up from it) and the chips stack along that.
// It depends only on the ∃ and its glyphs — never on frames or the emote bar — so no placement cycle can form; the
// emote bar and default frames count it as chrome (emotebar.js roomFor, frames.js CHROME_ANCHOR '#hudstatus'), and
// the ∃ menu (z 50) opens OVER it and the glyphs, as a dropdown hanging from the ∃ (ui.js anchorBeside).
//
// No imports beyond icons: the governor and capnotice post here, and this must not pull the engine in with it.
import { rsvg } from './icons.js';

let strip = null, pop = null;
let openId = null;
const chips = new Map();   // id → { el, spec }

function ensure() {
  if (strip) return;
  strip = document.createElement('div');
  strip.id = 'hudstatus';
  strip.setAttribute('role', 'status');
  pop = document.createElement('div');
  pop.id = 'stpop'; pop.className = 'panel'; pop.hidden = true;
  pop.setAttribute('role', 'dialog');
  document.body.append(strip, pop);
  addEventListener('resize', place);
  addEventListener('dockmoved', place);
  // Esc folds an open popover and goes no further: preventDefault is what frames.js's Esc toggle yields to
  addEventListener('keydown', (e) => { if (e.key === 'Escape' && openId) { e.preventDefault(); collapse(); } });
  // a click anywhere but the popover or its chip folds it
  document.addEventListener('pointerdown', (e) => {
    if (!openId || pop.contains(e.target) || chips.get(openId)?.el.contains(e.target)) return;
    collapse();
  }, true);
  // the glyphs pin/unpin and fold without an event; mictoggle.js uses the same slow net
  setInterval(place, 2000);
}

export function statusChip({ id, level = 'attn', label, title = label, body = '', actions, open = false } = {}) {
  if (!id || !label) throw new Error('statusChip: id and label required');
  if (typeof document === 'undefined') return;
  ensure();
  let c = chips.get(id);
  if (!c) {
    const el = document.createElement('button');
    el.type = 'button'; el.className = 'stchip'; el.id = `stchip-${id}`;
    el.dataset.chip = id;
    el.setAttribute('aria-expanded', 'false');
    el.setAttribute('aria-controls', 'stpop');
    el.onclick = () => (openId === id ? collapse() : expand(id));
    strip.appendChild(el);
    c = { el, spec: null };
    chips.set(id, c);
  }
  c.spec = { id, level: level === 'err' ? 'err' : 'attn', label, title, body, actions: actions ?? [{ label: 'got it' }] };
  c.el.dataset.level = c.spec.level;
  c.el.innerHTML = `<span class="st-label"></span>${rsvg('info', 12)}`;
  c.el.querySelector('.st-label').textContent = label;
  c.el.title = '';   // the popover is the explanation; a tooltip over it would say the same thing twice
  c.el.setAttribute('aria-label', `${title} — details`);
  place();
  if (openId === id) paintPop(); else if (open) expand(id);
  requestAnimationFrame?.(place);   // the glyphs may land a frame later
}

export function clearStatusChip(id) {
  const c = chips.get(id);
  if (!c) return;
  if (openId === id) collapse();
  c.el.remove();
  chips.delete(id);
  place();
}

export const statusChipIds = () => [...chips.keys()];

function expand(id) {
  if (openId && openId !== id) chips.get(openId)?.el.setAttribute('aria-expanded', 'false');
  openId = id;
  chips.get(id).el.setAttribute('aria-expanded', 'true');
  paintPop();
  pop.hidden = false;
  placePop();
}

function collapse() {
  if (!openId) return;
  chips.get(openId)?.el.setAttribute('aria-expanded', 'false');
  openId = null;
  pop.hidden = true;
}

function paintPop() {
  const { spec } = chips.get(openId);
  pop.dataset.level = spec.level;
  pop.innerHTML = '<b></b><p></p><div class="st-btns"></div>';
  pop.querySelector('b').textContent = spec.title;
  pop.querySelector('p').textContent = spec.body;
  const btns = pop.querySelector('.st-btns');
  for (const a of spec.actions) {
    const b = document.createElement('button');
    b.type = 'button'; b.textContent = a.label;
    b.onclick = () => {
      const id = openId;
      try { a.run?.(); } catch (e) { console.error(`[statuschips] ${id}: ${a.label}`, e); }
      if (a.clear) clearStatusChip(id); else collapse();
    };
    btns.appendChild(b);
  }
}

const GAP = 8;
function visible(el) {
  if (!el) return null;
  const r = el.getBoundingClientRect();
  if (!r.width || getComputedStyle(el).display === 'none' || el.style.visibility === 'hidden') return null;
  return r;
}

function place() {
  if (!strip) return;
  strip.hidden = chips.size === 0;
  const edge = document.getElementById('dock')?.dataset.edge || 'left';
  strip.dataset.edge = edge;
  const hud = visible(document.getElementById('hud'));
  if (!hud || !chips.size) { if (openId) placePop(); return; }
  const glyphs = ['#micbtn', '#earbtn', '#xrbtn'].map((s) => visible(document.querySelector(s))).filter(Boolean);
  const vert = edge === 'left' || edge === 'right';
  if (vert) {
    // along the ∃'s row: past every glyph whose box crosses the ∃'s centre line
    const cy = hud.top + hud.height / 2;
    let lo = hud.left, hi = hud.right;
    for (const g of glyphs) if (g.top <= cy && g.bottom >= cy) { lo = Math.min(lo, g.left); hi = Math.max(hi, g.right); }
    // the room left on the row; chips that don't fit WRAP to a second line under the first (a phone with three
    // notices), rather than sliding back over the glyphs
    // (the lantern's resting line is a round button top-right on a phone: the row ends before it)
    let end = edge === 'right' ? 0 : innerWidth;
    const pill = visible(document.getElementById('lantern-pill'));
    if (pill && pill.top <= cy && pill.bottom >= cy) end = edge === 'right' ? Math.max(end, pill.right + GAP) : Math.min(end, pill.left - GAP);
    const room = Math.max(80, edge === 'right' ? lo - GAP - end : end - hi - GAP - 4);
    strip.style.maxWidth = `${Math.round(room)}px`;
    const w = strip.offsetWidth;
    const row = strip.firstElementChild?.offsetHeight || strip.offsetHeight;
    const x = edge === 'right' ? lo - GAP - w : hi + GAP;
    strip.style.left = `${Math.round(Math.max(4, Math.min(x, innerWidth - w - 4)))}px`;
    strip.style.top = `${Math.round(cy - row / 2)}px`;   // the FIRST line sits on the ∃'s centre line
  } else {
    // along the ∃'s column: past every glyph folded under (top rail) or over (bottom rail) it
    const cx = hud.left + hud.width / 2;
    let lo = hud.top, hi = hud.bottom;
    for (const g of glyphs) if (g.left <= cx && g.right >= cx) { lo = Math.min(lo, g.top); hi = Math.max(hi, g.bottom); }
    strip.style.maxWidth = '';
    const h = strip.offsetHeight;
    const y = edge === 'bottom' ? lo - GAP - h : hi + GAP;
    strip.style.left = `${Math.round(Math.max(4, hud.left))}px`;
    strip.style.top = `${Math.round(Math.max(4, Math.min(y, innerHeight - h - 4)))}px`;
  }
  if (openId) placePop();
}

// under its chip (or over it, near the bottom edge), its left edge on the chip's, kept inside the viewport
function placePop() {
  const c = chips.get(openId)?.el.getBoundingClientRect();
  if (!c) return;
  const w = pop.offsetWidth, h = pop.offsetHeight;
  const below = c.bottom + 6 + h <= innerHeight - 8 || c.top - 6 - h < 8;
  const x = Math.max(8, Math.min(c.left, innerWidth - w - 8));
  pop.style.left = `${Math.round(x)}px`;
  pop.style.top = `${Math.round(below ? c.bottom + 6 : c.top - 6 - h)}px`;
  pop.dataset.side = below ? 'below' : 'above';
}
