// The emote menu. Emotes were number keys and a slash command — invisible
// unless you read the help. On a performance platform the gestures should be
// somewhere you can see them: six tiles, the gesture as content, its name, and
// the key that fires it. The tile this bar fired stays lit ~1.5 s (long enough to read). House .tile/.tiles rules
// only — no private layout here (live, 09-04: this file had been hand-rolled).

import { makeFrame } from './frames.js';
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
      // (frames.js:155), so 124px admitted exactly three columns — ONE column was
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
  // ONLY AT DEFAULT. R was explicit: "if it's saved in another configuration, we
  // should honor that." _placed is true once the owner has dragged or resized the
  // frame (frames.js:386, persisted in state), so a hand-sized bar keeps its size
  // and this clamp does nothing.
  // B2 (antra-tess #185 rereview, 2026-09-12), RE-FIXED after the first attempt
  // failed to bind. The original defect: the loop took g.right of every obstacle as
  // "space consumed from the left", which is only true of LEFT-anchored chrome.
  // `.capnotice` was right-anchored at top:8, so its g.right was ~innerWidth and the
  // arithmetic returned innerWidth - 8 - (innerWidth - 10 + 8) = -6. Math.min(352, -6)
  // fed snapTo a negative width and the 9-across bar reflowed to a 48x350 column on
  // re-show: measured [464,10,352,46] -> [616,10,48,350], the rereview's exact flip.
  //
  // MY FIRST FIX WAS INERT AND I SHIPPED IT. It classified anchoring by
  // `getComputedStyle(el).right !== 'auto'`. Chromium resolves BOTH left and right to
  // used pixel values on any positioned element, so every obstacle scored
  // pinnedLeft && pinnedRight, no branch matched, and roomFor stopped measuring
  // anything at all. Measured at 1280: #dock/#micbtn/#earbtn each "BOTH -> NO BRANCH",
  // room = innerWidth - 16. The bar stopped collapsing only because the clamp went
  // inert, which looks identical to the clamp working. It also silently dropped the
  // #dock clearance the old code got right (room 1162 -> 1264, 102px).
  // An identity test (does g.right track innerWidth - parseFloat(cs.right)?) fails the
  // same way: .capnotice measures cssL=930px cssR=10px and satisfies BOTH. The authored
  // rule is not recoverable from computed style; do not try a third time.
  //
  // WHAT ACTUALLY HOLDS. The card no longer enters this y-band at any width: the same
  // commit moved it to top:389 (>=1068), top:64 (901-1067), top:102 (<=900) — measured
  // inBand=false at 1280, 1440 and 1904. Every obstacle that IS in the band is
  // left-anchored, measured: #dock cssL=0px at left 0, #micbtn cssL=44px at left 44,
  // #earbtn cssL=76px at left 76. So the left-consuming arithmetic is correct for all
  // of them. `.capnotice` is KEPT in the list but is inert at every shipped width
  // (top:389 >=1068, top:64 at 901-1067, top:102 <=900 — all fail `g.top < 60`).
  // Note what that entry is NOT: it is not future-proofing. If the card is ever
  // returned to the band, this bare-g.right arithmetic is precisely what breaks —
  // clearRight becomes ~innerWidth and room goes negative. Re-raising the card
  // requires restoring an anchor-aware branch, not relying on this line.
  // The one part of the failed fix worth keeping is the floor: a clamp that cannot
  // help must be inert, never destructive.
  const roomFor = () => {
    // the chrome that shares the bar's y-band: the rail plus the mic/ear pair
    let clearRight = 0;
    for (const sel of ['#dock', '#micbtn', '#earbtn', '.capnotice']) {
      const g = document.querySelector(sel)?.getBoundingClientRect();
      if (g && g.width && g.top < 60 && g.bottom > 8) clearRight = Math.max(clearRight, g.right);
    }
    // FLOOR AT ONE COLUMN — not a stand-down, and not a raw negative.
    // I shipped both wrong answers before this one. Flooring at widthFor(1) looked
    // like "the collapse" because 48x336 is the same shape as the rereview's
    // [616,10,48,350]; standing down instead looked like inertness. Measured, the
    // stand-down is strictly worse: at room=123 the bar keeps 352 and paints 229px
    // UNDER #micbtn/#earbtn, at room=48 it is 304px under, at room=-6 it is 358px
    // under. Frames cap at Z_HI=25 and every element this loop measures outranks
    // them: #dock 27 (index.html), #micbtn/#earbtn 45 (mictoggle.js:250/:254),
    // .capnotice 60 (index.html, and frames.js:656 says so too). An earlier version
    // of this comment said "27/45", which was wrong about the glyphs; the version
    // after it named three of the four and still omitted .capnotice — the one
    // element this whole finding was about. So those tiles
    // are unpressable — the exact report this clamp exists for ("Make sure the
    // emote bar isn't under the mic or headphones"). A bar that looks wrong is
    // reachable; a bar under the glyphs is not.
    // ONE column is a legal shape here by prior decision, not a degenerate one:
    // minW is widthFor(1) (line ~49) and snapTo floors cols at 1, both landed
    // after "Emote bar still can't go 1x wide, 9x tall".
    //
    // WHAT THIS FLOOR DOES NOT DO, stated because an earlier version of this
    // comment claimed it did: it does not make the bar reachable at every room.
    // For 0 < room < 48 the result is a 48px bar in <=47px of clear space — still
    // wider than its room, just less visibly. Flooring turns "much too wide" into
    // "slightly too wide"; it is not a reachability guarantee. Saying "the only
    // value that must never reach snapTo is a NEGATIVE one" was wrong: (0,48) is
    // equally unsafe. frames.js fit() shifts a default-placed frame to `shifted`
    // while that fits, and otherwise runs its OWN floor on the same arithmetic --
    // not a second mechanism. Two boundaries, computed here rather than guessed
    // (clearRight 102 -> shifted 110, bar 352):
    //   iw 1280 -> SHIFT, x=110              iw 400 -> FLOOR, avail 282, w=282  (fits)
    //   iw 200  -> FLOOR, avail  82, w= 82   iw 150 -> FLOOR, avail  32, w= 48  (over)
    // COUNTERFACTUAL GEOMETRY, stated plainly: this table holds clearRight at 102,
    // which is a 1280x720 measurement. At a 400px viewport the dock and glyph rects
    // are not at those coordinates, so this is arithmetic about WHEN THE BRANCH
    // ENGAGES (shifted + w exceeds the viewport), not a forecast about a real 400px
    // page. Read it that way.
    // The bar still FITS down to iw=166, where avail is exactly widthFor(1)=48;
    // at iw=156 avail is 38 and the bar is wider than its room. An earlier version
    // of this comment said "about 156px", which overstated the safe range by ten
    // pixels in the unsafe direction. A review put both boundaries at "~180px,
    // below any real phone"; that conflates them. frames.js:682 marks the branch
    // OPEN.
    //
    // NON-FINITE is handled explicitly because the previous policy handled it by
    // accident and this one does not: `NaN >= n` is false, so returning null kept
    // the width, whereas Math.max(48, NaN) is NaN and snapTo(NaN) writes NaN into
    // _state.w/h and paints it. A lost guard, restored deliberately.
    // It is a FINITENESS guard, not a NaN guard: it also catches +/-Infinity, since
    // Math.max(48, Infinity) is Infinity and !Number.isFinite catches it. DERIVED,
    // NOT MEASURED — an earlier version of this line said "measured", which was the
    // wrong verb: no fixture sets innerWidth non-finite and the guard is unbound
    // (removing it leaves the suite 36/0), so nothing in-repo exercises the path.
    // Earlier comments here called it NaN-only; that undersold it.
    const room = innerWidth - 8 - Math.max(clearRight + 8, 8);
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
  // chrome sits at 27 (#dock), 45 (#micbtn/#earbtn, mictoggle.js:250/:254) and 60
  // (.capnotice) — the loop measures all four — so a bar left there can never win
  // by stacking. (#emenu 40 and #trayzone 28 are not in the list at all.)
  f.show = () => {
    show();
    const room = f._placed ? null : roomFor();
    snapTo(room == null ? f._state.w : Math.min(f._state.w, room));
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
