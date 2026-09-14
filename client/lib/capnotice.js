// capnotice — one persistent, dismissible card when this browser is on a reduced
// path. Toasts fade in seconds; a capability is for the whole visit.
import { backendName } from './core.js';
import { bus } from './base.js';
import { getFrame } from './frames.js';

const LS = 'ew-capnotice-dismissed';
export const WEBGL = {
  title: 'Running on WebGL 2',
  body: 'This browser has no WebGPU (or it is switched off), so three.js is using its WebGL 2 backend. ' +
        'The world works. Expect the sky’s cached lighting to be off, heavier scenes to run slower, and shadows to filter a little differently. ' +
        'Chrome or Edge 113+, or Firefox with WebGPU enabled, get the full version.',
};

let card = null;
let setAnchor = null;   // the matchMedia handler, live only while a card exists
let unwatch = null;     // its teardown, run when the last item is dismissed
let placeTop = null;    // the card lands UNDER the settled emote bar
let barRO = null;       // the bar reflows without firing any event
let barSeen = null;
function dismissed() { try { return new Set(JSON.parse(localStorage.getItem(LS) || '[]')); } catch { return new Set(); } }

function show(key, title, body) {
  const seen = dismissed();
  if (seen.has(key)) return;
  if (!card) {
    card = document.createElement('div'); card.className = 'panel capnotice';
    // DECLARE THE ANCHOR, driven by the SAME breakpoint the stylesheet uses. The card
    // is right-anchored (`right:10px`) above 900px and STRETCHED below it (`left:50px;
    // right:8px`), and computed style cannot tell those apart — both report used
    // pixels. matchMedia keeps ONE condition rather than a second copy of the number,
    // so index.html stays the source of truth for where the breakpoint is.
    const mq = matchMedia('(max-width: 900px)');
    // GUARD, AND A TEARDOWN. `setAnchor` closes over the module-level `card`, which
    // close() sets to null when the last item goes — so a viewport crossing after a
    // dismissal threw `Cannot read properties of null (reading 'dataset')` in the live
    // page (agent review round 1; reproduced in Chromium: show at 1280, dismiss, 700).
    // The subscription also outlived its card — every show() built a fresh one and
    // subscribed again, leaking one listener per show/dismiss cycle.
    setAnchor = () => { if (card) card.dataset.anchor = mq.matches ? 'stretch' : 'right'; };

    // ONE DIRECTION, by the owner's rule (15:04): "Compute emote bar first relative to
    // the dock. capnotice lands under the emote bar (or just over it, tbh, because you
    // can dismiss it)."
    //
    // This replaces a CYCLE. An earlier attempt computed the card's top from every
    // obstacle above it, the bar included — while emotebar.js's roomFor() computes the
    // bar's width from every obstacle in its band, the card included. Each fed the
    // other: 361 on one run, 95 on the next, no stable answer.
    //
    // emotebar.js had already written down what moving the card into that band would
    // do: "clearRight becomes ~innerWidth and room goes negative (measured -6, which
    // fed snapTo a negative width and reflowed the 9-across bar to a 48x350 column)."
    // That is exactly what reached a phone — nine tiles in one 48px column down the
    // right edge. The card is now removed from that list and placed SECOND instead.
    placeTop = () => {
      if (!card) return;
      if (!mq.matches) { card.style.top = ''; return; }   // above 900px index.html owns it
      const bar = getFrame('emotes')?.el;
      if (bar && bar !== barSeen && typeof ResizeObserver === 'function') {
        barSeen = bar; barRO?.disconnect(); barRO = new ResizeObserver(() => placeTop?.()); barRO.observe(bar);
      }
      // ONLY the rail and its glyphs, and only where they reach into the card's own
      // x-span: the VERTICAL rail at [0..42] never reaches left:50, the HORIZONTAL one
      // at [10..304] does. The BAR IS NOT CLEARED — see below.
      let bottom = 0;
      for (const sel of ['#dock', '#micbtn', '#earbtn']) {
        const g = document.querySelector(sel)?.getBoundingClientRect();
        if (g && g.width && g.right > 50 && g.top < 120) bottom = Math.max(bottom, g.bottom);
      }
      // AND THE BAR, WHICH THE CARD MUST CLEAR — not because the bar constrains the
      // card's SIZE (it does not; the bar is out of roomFor()'s list and the card is out
      // of the bar's, so the cycle is gone in both directions) but because a tile whose
      // centre is covered cannot be tapped. The card is z-60 and the bar z-25, so
      // "over it" is not a compromise the z-order can rescue: boot-check@390x844 reports
      // `"stand" covered by .capnotice` and that is Mica's #185 B2 in miniature —
      // "9 of 9 tiles unclickable ... reachable again the moment the card was dismissed".
      // Dismissibility is not reachability.
      if (bar && getComputedStyle(bar).display !== 'none') {
        const g = bar.getBoundingClientRect();
        if (g.width && g.right > 50) bottom = Math.max(bottom, g.bottom);
      }
      // ...AND EVERY OTHER CONTROL IN THE TOP HALF OF THE CARD'S SPAN. Four attempts
      // enumerated chrome by hand (#dock, #micbtn, #earbtn, the bar) and every one
      // missed the thing actually being covered: chat's tab row, which is `.frame
      // button`. boot-check@844x390+touch names them — "all" / "mentions" / "system" /
      // "chat options" — sitting at y 80..109 in landscape, BELOW the bar's 56. There
      // is no gap between the two to land in, so the card clears both.
      //
      // The top-half bound is what keeps this from chasing chat's own tabs in PORTRAIT,
      // where they sit at y 534 and the card belongs at 52. A control whose centre is
      // past the midline is not in the card's way; it is on the other side of the screen.
      for (const el of document.querySelectorAll('.frame .tile, .frame button, #dock button')) {
        const g = el.getBoundingClientRect();
        if (!g.width || !g.height || g.right <= 50) continue;
        if (g.top + g.height / 2 > innerHeight / 2) continue;
        bottom = Math.max(bottom, g.bottom);
      }
      card.style.top = Math.round(bottom + 8) + 'px';
    };

    const repaint = () => { setAnchor(); placeTop(); };
    repaint();
    mq.addEventListener('change', repaint);
    addEventListener('resize', repaint);
    addEventListener('dockmoved', repaint);
    // nothing announces the bar opening: the dock button calls the frame's show(),
    // which paints and saves and emits nothing. mictoggle.js uses the same safety net.
    const tick = setInterval(() => placeTop?.(), 2000);
    unwatch = () => {
      mq.removeEventListener('change', repaint); removeEventListener('resize', repaint);
      removeEventListener('dockmoved', repaint); clearInterval(tick);
      barRO?.disconnect(); barRO = null; barSeen = null;
      setAnchor = null; placeTop = null; unwatch = null;
    };
    document.body.appendChild(card);
  }
  if (card.querySelector(`[data-key="${CSS.escape(key)}"]`)) return;
  const item = document.createElement('div');
  item.className = 'cn-item'; item.dataset.key = key;
  item.innerHTML = '<b></b><p></p><div class="cn-btns"><button class="cn-ok">got it</button><button class="cn-never">don’t show again</button></div>';
  item.querySelector('b').textContent = title;
  item.querySelector('p').textContent = body;
  const close = () => { item.remove(); if (card && !card.childElementCount) { card.remove(); card = null; unwatch?.(); } };
  item.querySelector('.cn-ok').onclick = close;
  item.querySelector('.cn-never').onclick = () => { try { seen.add(key); localStorage.setItem(LS, JSON.stringify([...seen])); } catch {} close(); };
  card.appendChild(item);
}

export function initCapNotice() {
  if (backendName() === 'webgl') show('webgl', WEBGL.title, WEBGL.body);
  bus.on('sky-degraded', ({ msg } = {}) => { if (msg) show('sky', 'Sky simplified', msg); });
}
