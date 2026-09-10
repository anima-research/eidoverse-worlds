// The emote menu. Emotes were number keys and a slash command — invisible
// unless you read the help. On a performance platform the gestures should be
// somewhere you can see them: six tiles, the gesture as content, its name, and
// the key that fires it. The playing emote is lit. House .tile/.tiles rules
// only — no private layout here (R, 09-04: this file had been hand-rolled).

import { makeFrame } from './frames.js';
import { EMOTE_ORDER, EMOTE_ICONS } from './avatar.js';
import { myState } from './controller.js';
import { getMe } from './mybody.js';
import { registerXRPanel } from './xrpanels.js';
import { fsvg, svg } from './icons.js';
import { setPosture } from './controller.js';
const POSTURES = ['sit', 'stand', 'lie'];
// through the same flows the ring used: a nearby seat wins for sit, stand dismounts
function posture(k) {
  if (k === 'sit') bus.emit('xr:sit');
  else if (k === 'stand') bus.emit('xr:stand');
  else setPosture('lie');
}
import { bus } from './base.js';

// emoji here are CONTENT (the gesture itself), not chrome — the fill-icon set
// has no gesture glyphs beyond a wave; the def-hydrated EMOTE_ICONS table wins,
// this map is the fallback for a vocabulary that ships no icon.
const GLYPH = { wave: '👋', cheer: '🙌', dance: '💃', point: '👉', salute: '🫡', clap: '👏' };

export function initEmoteBar() {
  // geometry the CSS owns too: .tiles.fixed → 68px tiles, 6px gap, 8px body pad
  const TILE = 32, GAP = 6, PAD = 7, ROW_H = 32;   // 09-05 22:00: slim buttons, real gutters — must match .tiles.fixed in index.html   // glyph-only tiles; name + key are the tooltip (R, 09-04)
  const widthFor = (cols) => cols * TILE + (cols - 1) * GAP + PAD * 2 + 2;   // +2: frame edges
  const POSTURE_TILES = 3;   // sit / stand / lie lead the grid (R, 09-05) — they count toward the rows
  const rowsFor = (cols) => Math.ceil((POSTURE_TILES + EMOTE_ORDER.length) / cols);
  // state.h is the body's CONTENT height (frames.js paints body.style.height; the body
  // pads 7px top+bottom on top of it) — so rows + gaps only, no pad term
  const heightFor = (cols) => rowsFor(cols) * ROW_H + (rowsFor(cols) - 1) * GAP;
  let snapT = null;
  const ALL = 9;   // 3 postures + 6 emotes: ONE bar (R 09-06 23:34: '9×1')
  const f = makeFrame('emotes', {
    title: 'emotes', x: 'center', y: -10, w: widthFor(ALL), h: ROW_H,   // one row of nine across the bottom by default
    minW: widthFor(3), minH: ROW_H, hidden: true,   // 3..9 across
    // SNAP TO WHOLE TILES on release: drag the frame to any width, and when the
    // drag settles it fits itself to the tiles that row holds (R, 09-04). The
    // frame owns its size, so we write its state and repaint through the refs it
    // exposes for exactly this kind of rider.
    onResize: (w) => { clearTimeout(snapT); snapT = setTimeout(() => snapTo(w), 180); },
  });
  const snapTo = (w) => {
    // the emote list arrives async; snapping against an empty list clamped cols to the 3 postures and
    // SHRANK a saved 9×1 bar to 3×3 on every reload (two exported layouts: 352×32 → 124×108)
    if (!EMOTE_ORDER.length) return;
    const cols = Math.max(3, Math.min(POSTURE_TILES + EMOTE_ORDER.length, Math.floor((w - PAD * 2 - 2 + GAP) / (TILE + GAP))));   // ONE BAR is reachable: the postures count as tiles too (R 09-05 21:40: "surely more than 6")
    f._state.w = widthFor(cols); f._state.h = heightFor(cols); f._paint();
  };
  // a saved size from an older layout (or any drift) refits the moment the menu opens
  const show = f.show.bind(f);
  f.show = () => { show(); snapTo(f._state.w); return f; };
  const grid = document.createElement('div');
  grid.className = 'tiles fixed';
  const tiles = new Map();
  // built from the def-hydrated vocabulary (§24l) and rebuilt when a defs
  // push re-hydrates it — icons ride the same table as the names now
  const fill = () => {
    grid.innerHTML = ''; tiles.clear();
    // postures lead the row as tiles like the rest — EMOJI, same as the emotes
    // (R, 09-05 16:41: "STILL have phosphor icons instead of emojis"); the same
    // measured fallback: a platform without the glyph gets the word
    for (const [k, em] of [['sit', '🪑'], ['stand', '🧍'], ['lie', '🛏️']]) {
      const b = document.createElement('button');
      b.className = 'tile posture';
      b.dataset.posture = k;
      b.title = k;
      b.innerHTML = emojiRenders(em) ? `<span class="tile-glyph">${em}</span>` : `<span class="tile-word">${k}</span>`;
      b.onclick = () => { posture(k); paint(); };
      grid.appendChild(b);
      tiles.set(`posture:${k}`, b);
    }
    EMOTE_ORDER.forEach((name, i) => {
      const b = document.createElement('button');
      b.className = 'tile';
      b.dataset.emote = name;
      b.title = `${name} — key ${i + 1}`;
      // emoji are content here (the gesture itself) — but a platform missing the
      // glyph paints a tofu box or nothing, so the tile falls back to the word
      // when the emoji measurably does not render (R, 09-05)
      const em = EMOTE_ICONS[name] ?? GLYPH[name] ?? '✨';
      b.innerHTML = emojiRenders(em) ? `<span class="tile-glyph">${em}</span>` : `<span class="tile-word">${name}</span>`;
      b.onclick = () => { getMe()?.playEmote(name); myState.emote = name; paint(); };
      grid.appendChild(b);
      tiles.set(name, b);
    });
    if (f._state) snapTo(f._state.w);
  };
  const paint = () => { for (const [n, b] of tiles) b.classList.toggle('on', n.startsWith('posture:') ? myState.clip === n.slice(8) : myState.emote === n); };
  fill();
  bus.on('emotes-updated', fill);
  // (postures are tiles in the grid above — one row, one grammar)
  setInterval(paint, 500);   // number keys set myState.emote elsewhere; the lit tile follows
  f.body.appendChild(grid);
  // the same six gestures as a VR quad — one button per emote, the same call
  registerXRPanel({
    id: 'emotes', title: 'emotes',
    // postures lead (R, 09-04 22:02: sit/lie belong to the emote menu, not the
    // ring); then the emotes — names, not emoji: a canvas fillText of a
    // missing glyph paints nothing
    fields: () => [...POSTURES.map((k) => ({ t: 'btn', k, label: k })), ...EMOTE_ORDER.map((name) => ({ t: 'btn', k: name, label: name }))],
    dispatch: (k) => { if (POSTURES.includes(k)) posture(k); else if (EMOTE_ORDER.includes(k)) { getMe()?.playEmote(k); myState.emote = k; } },
  });
  return f;
}

// Does this emoji actually draw here? Paint it on a scratch canvas and look
// for COLOUR: a rendered emoji has chroma, a tofu box / missing glyph paints
// gray-on-nothing (or nothing). Cached per string; a false answer costs a
// word instead of a box.
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
    ok = ink > 0 && chroma > 4;   // some coloured pixels = a real emoji; monochrome = tofu or a text glyph
  } catch { ok = true; }
  emojiCache.set(s, ok);
  return ok;
}

// ---- the ring's emote sub-wheel (R 09-07 22:08: 'emotes should be a sub menu, same as VRC') ----
// Names, not emoji: the ring paints drawn glyphs only (canvas fillText of an emoji is the trap), so each
// slot carries its name as SVG text. Postures lead, then the emotes in bar order; every entry closes the
// ring on activation (you chose it — the ring's job is done).
const nameSvg = (t) => `<svg xmlns="http://www.w3.org/2000/svg" width="52" height="52" viewBox="0 0 26 26"><text x="13" y="16" font-family="system-ui, sans-serif" font-size="${t.length > 6 ? 5.5 : 7}" font-weight="600" text-anchor="middle" fill="#f2f7f5">${t}</text></svg>`;
export function ringEmoteEntries() {
  return [
    ...POSTURES.map((k) => ({ svg: nameSvg(k), label: k, on: () => (k === 'lie' ? myState.posture === 'lie' : k === 'sit' ? !!myState.seat : false), close: true, act: () => posture(k) })),
    ...EMOTE_ORDER.map((name) => ({ svg: nameSvg(name), label: name, close: true, act: () => { getMe()?.playEmote(name); myState.emote = name; } })),
  ];
}
