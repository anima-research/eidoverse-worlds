// The emote menu. Emotes were number keys and a slash command — invisible
// unless you read the help. On a performance platform the gestures should be
// somewhere you can see them: six tiles, the gesture as content, its name, and
// the key that fires it. The tile this bar fired stays lit ~1.5 s (long enough to read). House .tile/.tiles rules
// only — no private layout here (live, 09-04: this file had been hand-rolled).

import { makeFrame, chromeCost } from './frames.js';
import { bus } from './base.js';
import { EMOTE_ORDER, EMOTE_ICONS } from './avatar.js';
import { getMe } from './mybody.js';
import { registerXRPanel } from './xrpanels.js';
import { myState, setPosture, sitHere, standUp, getPosture } from './controller.js';
const POSTURES = ['sit', 'stand', 'lie'];
// through the same flows the ring used: a nearby seat wins for sit, stand dismounts
function posture(k) {
  // the desktop body: sit runs the controller's seat search (a nearby seat wins, else sit where you stand),
  // stand leaves seat and posture. The xr:* events are for the VR entry (part 4) — no listener at this rung.
  if (k === 'sit') { sitHere(); bus.emit('xr:sit'); }
  else if (k === 'stand') { standUp(); bus.emit('xr:stand'); }
  else setPosture('lie');
}
let litEmote = null, litUntil = 0;   // net.js clears myState.emote on the first pose send, so the bar remembers its own

// emoji here are CONTENT (the gesture itself), not chrome — the fill-icon set
// has no gesture glyphs beyond a wave; the def-hydrated EMOTE_ICONS table wins,
// this map is the fallback for a vocabulary that ships no icon.
const GLYPH = { wave: '👋', cheer: '🙌', dance: '💃', point: '👉', salute: '🫡', clap: '👏' };

export function initEmoteBar() {
  // geometry the CSS owns too: .tiles.fixed → 68px tiles, 6px gap, 8px body pad
  const TILE = 32, GAP = 6, PAD = 7, ROW_H = 32;   // 09-05 22:00: slim buttons, real gutters — must match .tiles.fixed in index.html   // glyph-only tiles; name + key are the tooltip (live, 09-04)
  const widthFor = (cols) => cols * TILE + (cols - 1) * GAP + PAD * 2 + 2;   // +2: frame edges
  const POSTURE_TILES = 3;   // sit / stand / lie lead the grid (live, 09-05) — they count toward the rows
  const rowsFor = (cols) => Math.ceil((POSTURE_TILES + EMOTE_ORDER.length) / cols);
  // state.h is the body's CONTENT height (frames.js paints body.style.height; the body
  // pads 7px top+bottom on top of it) — so rows + gaps only, no pad term
  const heightFor = (cols) => rowsFor(cols) * ROW_H + (rowsFor(cols) - 1) * GAP;
  let snapT = null;
  const ALL = 9;   // 3 postures + 6 emotes: ONE bar (live 09-06 23:34: '9×1')
  const f = makeFrame('emotes', {
    title: 'emotes', x: 'center', y: -10, w: widthFor(ALL), h: ROW_H,   // one row of nine across the bottom by default
      // minW was widthFor(3)=124px and a REAL resize clamps at f.minW
      // (the east/west resize clamp in frames.js), so 124px admitted exactly three columns — ONE column was
      // unreachable by drag no matter what snapTo computed. R hit it at once:
      // "Emote bar still can't go 1x wide, 9x tall." My own test had called
      // onResize(48, 336) directly and sailed past the clamp: a fixture that
      // skipped the very constraint it claimed to verify.
      minW: widthFor(1), minH: ROW_H, hidden: true,   // 1..9 across — a single column is a legal shape
    // SNAP TO WHOLE TILES on release: drag the frame to any width, and when the
    // drag settles it fits itself to the tiles that row holds (live, 09-04). The
    // frame owns its size, so we write its state and repaint through the refs it
    // exposes for exactly this kind of rider.
    onResize: (w) => { clearTimeout(snapT); snapT = setTimeout(() => snapTo(w), 180); },
  });

  const snapTo = (w) => {
    // the emote list arrives async; snapping against an empty list clamped cols to the 3 postures and
    // SHRANK a saved 9×1 bar to 3×3 on every reload (two exported layouts: 352×32 → 124×108)
    if (!EMOTE_ORDER.length) return;
    // COLUMNS FROM WIDTH; ROWS FOLLOW BY WRAPPING. The tiles wrap like text —
    // narrow the frame and they flow into more rows — so HEIGHT is a
    // consequence, never an input.
    //
    // The previous version took rows from a dragged height and was wrong in the
    // PRODUCT even though the suite passed: frames.js:427 calls
    // `onResize(state.w, state.h)` ALWAYS, so the `h == null` branch I wrote
    // only ever ran in my own test. Live, every resize carried a height, so a
    // tall drag pinned the bar at nine rows and refused to wrap, and a short one
    // could not go below `need` rows for its column count. R, 2026-09-11:
    // "won't go thinner than 4x, but will forcibly go 9x down and not wrap to
    // the buttons at all."
    //
    // I designed against my own harness instead of the real caller — the same
    // mistake as the minW clamp one commit earlier.
    const cols = Math.max(1, Math.min(POSTURE_TILES + EMOTE_ORDER.length, Math.floor((w - PAD * 2 - 2 + GAP) / (TILE + GAP))));
    f._state.w = widthFor(cols); f._state.h = heightFor(cols);
    // through _fit, not _paint: a reflow to more rows can push the bar past the
    // bottom edge, and _paint alone skips every viewport clamp (#185 review).
    if (f._fit) f._fit(); else f._paint();
  };
  // a saved size from an older layout (or any drift) refits the moment the menu opens
  const show = f.show.bind(f);
  // OPEN AT A SIZE YOU CAN ACTUALLY SEE (R, 2026-09-12: "at least be at a size
  // they can be completely viewed at when open"). show() snapped to _state.w —
  // the DEFAULT 352px — so tapping the bar open on a phone put a 352px bar in a
  // 390px viewport, under the mic/ear pair. snapTo already derives columns from
  // width; it was just never handed the width that fits.
  //
  // ONLY AT DEFAULT: _placed is true once the owner has dragged or resized the bar
  // (persisted in state), so a hand-sized bar keeps its size and this clamp does
  // nothing. A saved configuration is honoured.
  // CHROME CLEARANCE, and the trap in it (antra-tess #185 B2).
  //
  // This loop takes g.right of every obstacle as "space consumed from the left",
  // which is only true of LEFT-anchored chrome. Every obstacle currently in the band
  // is left-anchored — measured #dock cssL=0 at left 0, #micbtn cssL=44, #earbtn
  // cssL=76 — so the arithmetic is correct for all of them today.
  //
  // `.capnotice` is KEPT in the list but is inert at every shipped width: the card
  // sits at top:389 (>=1068), top:64 (901-1067), top:102 (<=900), all of which fail
  // `g.top < 60`. That entry is NOT future-proofing. If the card ever returns to the
  // band this bare-g.right arithmetic is precisely what breaks — clearRight becomes
  // ~innerWidth and room goes negative (measured -6, which fed snapTo a negative
  // width and reflowed the 9-across bar to a 48x350 column).
  //
  // THE ANCHOR IS NOT RECOVERABLE from computed style, so do not try to detect it
  // here: CSSOM 9 resolves left AND right to used values for a positioned element,
  // so `.capnotice` reports cssL=930px and cssR=10px simultaneously and satisfies
  // both an `!== 'auto'` test and an edge-identity test. Re-raising the card requires
  // an anchor the obstacle DECLARES, not a test against its rendered geometry.
  const roomFor = () => {
    // the chrome that shares the bar's y-band: the rail plus the mic/ear pair.
    // ANCHOR-AWARE: chromeCost() (frames.js) reads each obstacle's DECLARED side and
    // charges it to the correct accumulator. Taking g.right from everything was true
    // only of left-anchored chrome.
    let costL = 0, costR = 0;
    // `.capnotice` IS NOT IN THIS LIST, by the owner's ordering rule (15:04): the bar
    // computes against the dock and its glyphs, and the card then lands under the bar.
    // One direction. The entry used to be here, inert because the card's three shipped
    // tops (389 / 64 / 102) all failed `g.top < 60` — and the comment above said what
    // would happen if it ever entered the band. It did, on 2026-09-12, when the card's
    // top became computed: room went negative and the 9-across bar reflowed to a 48x350
    // column on a phone. The card is transient chrome with a dismiss button; the bar is
    // a primary control. The card yields, and it is placed second so it can.
    for (const sel of ['#dock', '#micbtn', '#earbtn']) {
      const g = document.querySelector(sel)?.getBoundingClientRect();
      if (g && g.width && g.top < 60 && g.bottom > 8) {
        const c = chromeCost(sel, g, innerWidth);
        costL = Math.max(costL, c.left); costR = Math.max(costR, c.right);
      }
    }
    const clearRight = costL;
    // FLOOR AT ONE COLUMN — not a stand-down, and not a raw negative.
    //
    // WHY A FLOOR AT ALL: standing down is strictly worse, measured. At room=123 the
    // bar keeps 352 and paints 229px under #micbtn/#earbtn; at room=48, 304px under;
    // at room=-6, 358px under. Frames cap at Z_HI=25 and every element this loop
    // measures outranks them (#dock 27, #micbtn/#earbtn 45, .capnotice 60), so those
    // tiles are unpressable — the exact report this clamp exists for. A bar that
    // looks wrong is reachable; a bar under the glyphs is not.
    //
    // ONE COLUMN IS LEGAL here by prior decision: minW is widthFor(1) and snapTo
    // floors cols at 1.
    //
    // WHAT THE FLOOR DOES NOT DO: it is not a reachability guarantee. For
    // 0 < room < 48 the result is a 48px bar in <=47px of clear space — still wider
    // than its room, just less visibly. The bar fits down to iw=166 (avail exactly
    // widthFor(1)=48); at iw=156 avail is 38 and it is over.
    //
    // NON-FINITE is guarded explicitly. The previous policy handled it by accident:
    // `NaN >= n` is false, so returning null kept the width, whereas Math.max(48, NaN)
    // is NaN and snapTo(NaN) paints it. It is a FINITENESS guard, not a NaN guard —
    // Math.max(48, Infinity) is Infinity and !Number.isFinite catches that too. That
    // is derived, not measured: no fixture sets innerWidth non-finite and removing
    // the guard leaves the suite green, so nothing in-repo exercises the path.
    const room = innerWidth - 8 - Math.max(clearRight + 8, 8) - costR;   // right-anchored chrome eats from the RIGHT
    if (!Number.isFinite(room)) return null;   // keep the width rather than paint NaN
    return Math.max(widthFor(1), room);
  };
  // SIZE is honoured for a hand-placed bar; POSITION is not allowed to leave it
  // underneath fixed chrome. R, 2026-09-12: "Only resize the menu if it's at
  // default. If it's saved in another configuration, we should honor that." — and
  // then, from a real phone where every emulated viewport I tried said the tiles
  // were reachable: "Make sure the emote bar isn't under the mic or headphones."
  // Both hold if the clamp keeps its hands off a saved WIDTH and still refuses to
  // paint the bar beneath #micbtn/#earbtn/#dock. Frames cap at Z_HI=25 and that
  // chrome sits at 27 (#dock), 45 (#micbtn/#earbtn, mictoggle.js) and 60
  // (.capnotice) — the loop measures all four — so a bar left there can never win
  // by stacking. (#emenu 40 and #trayzone 28 are not in the list at all.)
  f.show = () => {
    show();
    // RE-DERIVE, DO NOT RATCHET. `Math.min(state.w, room)` can only ever shrink, and
    // state.w is restored from localStorage — so one bad width outlives the condition
    // that caused it, forever. Measured 2026-09-12: while `.capnotice` was still in
    // roomFor()'s list it drove room negative and snapTo wrote w:48 (a 9-tall column)
    // to storage; removing the card from that list fixed room (272, correct) and the
    // bar STILL opened at 48, because min(48, 272) = 48. The same shape as the frame
    // width ratchet in frames.js:fit().
    //
    // An UNPLACED bar has no claim on a stored width — its width is always a function
    // of the room available now. A PLACED one (the owner dragged it) keeps what they
    // chose, which is what `room == null` already expresses.
    const room = f._placed ? null : roomFor();
    snapTo(room == null ? f._state.w : room);
    // TODO(mobile): the general form of this lives at the persistence key in
    // frames.js (`const LS = ...`) — one saved layout serves every surface. What
    // follows is this module's instance of it, kept here because the measurements
    // and the rejected fixes are specific to the bar.
    //
    // A placed bar keeps the width its owner chose — correct, and the reason this
    // exemption exists. But `_placed` also exempts it from roomFor(), which was the
    // only thing holding it clear of the rail's glyphs. Measured 2026-09-12: drag the
    // bar to 352 at 1280x800, reload at 390x844, and it opens at [30..382] with `sit`
    // and `stand` under #micbtn/#earbtn (z-45 vs Z_HI=25) — unreachable until the owner
    // moves or resets it.
    //
    // Not patched here, deliberately. Every local fix is worse than the bug:
    //   narrow it   — discards the width the owner chose, which is what this exemption
    //                 exists to protect
    //   slide it x  — impossible: 352 in a 390 viewport leaves 22px of slack and fit()
    //                 already pins x to [8,30]; any x written is clamped straight back
    //   drop it y   — works (measured: zero blocked tiles, width kept) but the vertical
    //                 rail runs to bottom 304, so "below what it collides with" puts the
    //                 bar at y=312, mid-screen. Reachable and wrong-looking.
    //
    // The real shape is a layout saved PER SURFACE (desktop vs mobile at minimum), so a
    // deliberate desktop arrangement is never replayed onto a phone at all. R's call,
    // 2026-09-12 18:06; mobile is being picked up by someone else, so this is theirs to
    // design rather than ours to guess at. Disclosed in the PR body under "known".
    return f;
  };
  const grid = document.createElement('div');
  grid.className = 'tiles fixed';
  const tiles = new Map();
  // built from the def-hydrated vocabulary (§24l) and rebuilt when a defs
  // push re-hydrates it — icons ride the same table as the names now
  const fill = () => {
    grid.innerHTML = ''; tiles.clear();
    // postures lead the row as tiles like the rest — EMOJI, same as the emotes
    // (live, 09-05 16:41: "STILL have phosphor icons instead of emojis"); the same
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
      // when the emoji measurably does not render (live, 09-05)
      const em = EMOTE_ICONS[name] ?? GLYPH[name] ?? '✨';
      b.innerHTML = emojiRenders(em) ? `<span class="tile-glyph">${em}</span>` : `<span class="tile-word">${name}</span>`;
      b.onclick = () => { getMe()?.playEmote(name); myState.emote = name; litEmote = name; litUntil = performance.now() + 1500; paint(); };
      grid.appendChild(b);
      tiles.set(name, b);
    });
    if (f._state) snapTo(f._state.w);
  };
  const paint = () => { const lit = myState.emote ?? (performance.now() < litUntil ? litEmote : null); for (const [n, b] of tiles) b.classList.toggle('on', n.startsWith('posture:') ? (myState.clip === n.slice(8) || (n === 'posture:sit' && myState.clip === 'sitchair')) : lit === n); };
  fill();
  bus.on('emotes-updated', fill);
  // (postures are tiles in the grid above — one row, one grammar)
  setInterval(paint, 500);   // number keys set myState.emote elsewhere; the lit tile follows
  f.body.appendChild(grid);
  // the same six gestures as a VR quad — one button per emote, the same call
  registerXRPanel({
    id: 'emotes', title: 'emotes',
    // postures lead (live, 09-04 22:02: sit/lie belong to the emote menu, not the
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

// ---- the ring's emote sub-wheel (live 09-07 22:08: 'emotes should be a sub menu, same as VRC') ----
// Names, not emoji: the ring paints drawn glyphs only (canvas fillText of an emoji is the trap), so each
// slot carries its name as SVG text. Postures lead, then the emotes in bar order; every entry closes the
// ring on activation (you chose it — the ring's job is done).
const nameSvg = (t) => `<svg xmlns="http://www.w3.org/2000/svg" width="52" height="52" viewBox="0 0 26 26"><text x="13" y="16" font-family="system-ui, sans-serif" font-size="${t.length > 6 ? 5.5 : 7}" font-weight="600" text-anchor="middle" fill="#f2f7f5">${t}</text></svg>`;
export function ringEmoteEntries() {
  return [
    ...POSTURES.map((k) => ({ svg: nameSvg(k), label: k, on: () => (k === 'lie' ? getPosture() === 'lie' : k === 'sit' ? getPosture() === 'sit' : false), close: true, act: () => posture(k) })),
    ...EMOTE_ORDER.map((name) => ({ svg: nameSvg(name), label: name, close: true, act: () => { getMe()?.playEmote(name); myState.emote = name; } })),
  ];
}
