// The action bar: posture and gesture tiles (the gesture as content, its name and key as the tooltip).
// The tile this bar fired stays lit ~1.5 s. House .tile/.tiles rules only — no private layout here.

import { makeFrame, chromeCost } from './windows.js';
import { bus } from '../base.js';
import { ANIM_ORDER, ANIM_ICONS } from './animnames.js';
import { escapeHtml } from './markup.js';   // names + glyphs, no engine
import { getMe } from '../mybody.js';
import { registerXRPanel } from '../xr/xrpanels.js';
import { register as registerAction } from './actions.js';
import { myState, setPosture, sitHere, standUp, getPosture } from '../controller.js';
const POSTURES = ['sit', 'stand', 'lie'];
// sit runs the controller's seat search (a nearby seat wins, else sit where you stand); stand leaves seat and posture.
// The xr:* events let the VR entry (main.js) try a seat first.
function posture(k) {
  if (k === 'sit') { sitHere(); bus.emit('xr:sit'); }
  else if (k === 'stand') { standUp(); bus.emit('xr:stand'); }
  else setPosture('lie');
}
let litAnim = null, litUntil = 0;   // net.js clears myState.anim on the first pose send, so the bar remembers its own

// emoji here are CONTENT (the gesture itself), not chrome: ANIM_ICONS (from the defs) wins, this map is the fallback
// for a vocabulary that ships no icon.
const GLYPH = { wave: '👋', cheer: '🙌', dance: '💃', point: '👉', salute: '🫡', clap: '👏' };

export function initActionBar() {
  // must match .tiles.fixed in index.html (32px tiles, 6px gap, 7px body pad)
  const TILE = 32, GAP = 6, PAD = 7, ROW_H = 32;
  const widthFor = (cols) => cols * TILE + (cols - 1) * GAP + PAD * 2 + 2;   // +2: frame edges
  const POSTURE_TILES = 3;   // sit / stand / lie lead the grid
  const rowsFor = (cols) => Math.ceil((POSTURE_TILES + ANIM_ORDER.length) / cols);
  // state.h is the body's CONTENT height (windows.js adds the pad), so rows + gaps only
  const heightFor = (cols) => rowsFor(cols) * ROW_H + (rowsFor(cols) - 1) * GAP;
  let snapT = null;
  const ALL = 9;   // 3 postures + 6 gestures
  const f = makeFrame('actions', {
    title: 'action bar', x: 'center', y: -10, w: widthFor(ALL), h: ROW_H,   // one row of nine by default
      minW: widthFor(1), minH: ROW_H, hidden: true,   // a single column is a legal shape
    // snap to whole tiles once a drag settles
    onResize: (w) => { clearTimeout(snapT); snapT = setTimeout(() => snapTo(w), 180); },
  });

  const snapTo = (w) => {
    // the gesture list arrives async; snapping against an empty list would shrink a saved bar to the 3 postures
    if (!ANIM_ORDER.length) return;
    // columns from width; rows follow by wrapping (the height onResize passes is ignored on purpose)
    const cols = Math.max(1, Math.min(POSTURE_TILES + ANIM_ORDER.length, Math.floor((w - PAD * 2 - 2 + GAP) / (TILE + GAP))));
    f._state.w = widthFor(cols); f._state.h = heightFor(cols);
    // _fit, not _paint: a reflow to more rows can push the bar past the bottom edge, and _paint skips the viewport clamp
    if (f._fit) f._fit(); else f._paint();
  };
  // The width an UNPLACED bar opens at: what fits beside the chrome in its y-band, so a phone never opens
  // the default 352px bar under the mic/ear pair. A placed bar (_placed: dragged/resized) keeps its size.
  // Design notes: docs/research/actionbar-placement.md.
  const roomFor = () => {
    // the chrome that shares the bar's y-band; chromeCost() (windows.js) charges each to its declared side.
    // #hudstatus (statuschips.js) is placed from the ∃ and its glyphs alone, so no cycle.
    let costL = 0, costR = 0;
    for (const sel of ['#dock', '#micbtn', '#earbtn', '#hudstatus']) {
      const g = document.querySelector(sel)?.getBoundingClientRect();
      if (g && g.width && g.top < 60 && g.bottom > 8) {
        const c = chromeCost(sel, g, innerWidth);
        costL = Math.max(costL, c.left); costR = Math.max(costR, c.right);
      }
    }
    const clearRight = costL;
    // floor at one column: frames sit below this chrome in z, so a bar left under it is unpressable
    const room = innerWidth - 8 - Math.max(clearRight + 8, 8) - costR;
    if (!Number.isFinite(room)) return null;   // keep the width rather than paint NaN
    return Math.max(widthFor(1), room);
  };
  // onShow, not a wrapped show(): the viewport auto-restore brings the bar back without show()
  f.onShow(() => {
    // re-derive, never min(stored, room): one bad stored width must not outlive its cause
    const room = f._placed ? null : roomFor();
    snapTo(room == null ? f._state.w : room);
    // TODO(mobile): a PLACED bar is exempt from roomFor(), so a desktop layout replayed on a phone can open under
    // #micbtn/#earbtn. The fix is a layout saved per surface — docs/research/actionbar-placement.md.
  });
  const grid = document.createElement('div');
  grid.className = 'tiles fixed';
  const tiles = new Map();
  // a rebuild re-registers from scratch: register() merges, so writing over the old entries would keep a moved
  // gesture's old key and a removed one's row
  let unregs = [];
  // built from the def-hydrated vocabulary (animnames.js) and rebuilt on 'animnames-updated'
  const fill = () => {
    grid.innerHTML = ''; tiles.clear();
    for (const off of unregs) off();
    unregs = [];
    // postures lead the row as tiles like the rest, with the same measured fallback: no glyph → the word
    for (const [k, em] of [['sit', '🪑'], ['stand', '🧍'], ['lie', '🛏️']]) {
      const b = document.createElement('button');
      b.className = 'tile posture';
      b.dataset.posture = k;
      b.title = k;
      b.innerHTML = emojiRenders(em) ? `<span class="tile-glyph">${em}</span>` : `<span class="tile-word">${k}</span>`;
      b.onclick = () => { posture(k); paint(); };
      // the stand tile held is the seat escape, as X held is (localbody.js 'escape-hold')
      if (k === 'stand') { b.onpointerdown = () => bus.emit('escape-hold', true); b.onpointerup = b.onpointerleave = b.onpointercancel = () => bus.emit('escape-hold', false); }
      grid.appendChild(b);
      tiles.set(`posture:${k}`, b);
    }
    ANIM_ORDER.forEach((name, i) => {
      const b = document.createElement('button');
      b.className = 'tile';
      b.dataset.anim = name;
      b.title = `${name} — key ${i + 1}`;
      const em = ANIM_ICONS[name] ?? GLYPH[name] ?? '✨';
      b.innerHTML = emojiRenders(em) ? `<span class="tile-glyph">${escapeHtml(em)}</span>` : `<span class="tile-word">${escapeHtml(name)}</span>`;   // names and glyphs come from the world's defs: escape them
      b.onclick = () => { getMe()?.playOnce(name); myState.anim = name; litAnim = name; litUntil = performance.now() + 1500; paint(); };
      grid.appendChild(b);
      tiles.set(name, b);
      // the tile's own action, findable by name; number keys 1–9 follow ANIM_ORDER (main.js)
      unregs.push(registerAction({ id: `bar:${name}`, title: name, group: 'action bar', keywords: ['action', 'gesture'],
        icon: emojiRenders(em) ? em : undefined, key: i < 9 ? String(i + 1) : undefined, run: b.onclick }));
    });
    // sit and lie have keys (X, Z: controller.js registers those); standing up has only this tile
    unregs.push(registerAction({ id: 'posture:stand', title: 'stand up', group: 'body', keywords: ['posture', 'get up'], icon: 'personStanding',
      run: () => { posture('stand'); paint(); } }));
    if (f._state) snapTo(f._state.w);
  };
  const paint = () => { const lit = myState.anim ?? (performance.now() < litUntil ? litAnim : null); for (const [n, b] of tiles) b.classList.toggle('on', n.startsWith('posture:') ? (myState.clip === n.slice(8) || (n === 'posture:sit' && myState.clip === 'sitchair')) : lit === n); };
  fill();
  bus.on('animnames-updated', fill);
  setInterval(paint, 500);   // number keys set myState.anim elsewhere; the lit tile follows
  f.body.appendChild(grid);
  // the same bar as a VR quad; names, not emoji (a canvas fillText of a missing glyph paints nothing)
  registerXRPanel({
    id: 'actions', title: 'action bar',
    fields: () => [...POSTURES.map((k) => ({ t: 'btn', k, label: k })), ...ANIM_ORDER.map((name) => ({ t: 'btn', k: name, label: name }))],
    dispatch: (k) => { if (POSTURES.includes(k)) posture(k); else if (ANIM_ORDER.includes(k)) { getMe()?.playOnce(k); myState.anim = k; } },
  });
  return f;
}

// Does this emoji actually draw here? Paint it on a scratch canvas and look for COLOUR: a rendered emoji has chroma,
// a tofu box or missing glyph is monochrome. Cached per string.
const emojiCache = new Map();
function emojiRenders(s) {
  if (emojiCache.has(s)) return emojiCache.get(s);
  let ok = true;
  try {
    const cv = document.createElement('canvas'); cv.width = cv.height = 24;
    const g = cv.getContext('2d');
    g.textBaseline = 'top'; g.font = '20px system-ui, "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif';
    g.fillStyle = '#000'; g.fillText(s, 0, 0);
    const d = g.getImageData(0, 0, 24, 24).data;
    let chroma = 0, ink = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] < 40) continue; ink++;
      const mx = Math.max(d[i], d[i + 1], d[i + 2]), mn = Math.min(d[i], d[i + 1], d[i + 2]);
      if (mx - mn > 24) chroma++;
    }
    ok = ink > 0 && chroma > 4;
  } catch { ok = true; }
  emojiCache.set(s, ok);
  return ok;
}

// ---- the ring's action sub-wheel ----
// Names as SVG text, not emoji (the ring paints drawn glyphs only). Postures lead, then the gestures in bar order;
// every entry closes the ring on activation.
const nameSvg = (t) => `<svg xmlns="http://www.w3.org/2000/svg" width="52" height="52" viewBox="0 0 26 26"><text x="13" y="16" font-family="system-ui, sans-serif" font-size="${t.length > 6 ? 5.5 : 7}" font-weight="600" text-anchor="middle" fill="#f2f7f5">${t}</text></svg>`;
export function ringActionEntries() {
  return [
    ...POSTURES.map((k) => ({ svg: nameSvg(k), label: k, on: () => (k === 'lie' ? getPosture() === 'lie' : k === 'sit' ? getPosture() === 'sit' : false), close: true, act: () => posture(k) })),
    ...ANIM_ORDER.map((name) => ({ svg: nameSvg(name), label: name, close: true, act: () => { getMe()?.playOnce(name); myState.anim = name; } })),
  ];
}
