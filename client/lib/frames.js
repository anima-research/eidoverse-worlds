// frames — movable, resizable, collapsible windows with a remembered layout.
//
// In a 3D client the scene IS the content, so where the chrome sits is a
// personal and per-task decision: someone building wants the catalog big and
// the chat small, someone performing wants the opposite, someone spectating
// wants almost nothing. A fixed rail can't serve all three.
//
// The model is the one MMO players already have in their hands: drag a frame
// by its title, drag its corner to resize, lock
// the whole layout when you're happy, and have it still be there tomorrow.

import { bus } from './base.js';

// TODO(mobile): ONE SAVED LAYOUT SERVES EVERY SURFACE, AND IT SHOULD NOT.
// This key carries the frame id and nothing else, so an arrangement made on a desktop
// is replayed verbatim onto a phone. A layout is not portable across surfaces — the
// viewport that produced it is part of what it means — and every symptom of that is a
// separate patch that fights the last one:
//   · a bar the owner widened to 352 at 1280x800 reopens at 390x844 with `sit` and
//     `stand` under #micbtn/#earbtn, unreachable (measured 2026-09-12; emotebar.js
//     show() has the detail and why no local fix is worth taking)
//   · the width and height ratchets fixed in bcbe9f7/cdca5c2 are both the same shape:
//     a value derived under one viewport outliving the condition that produced it
// The fix is to key the record by surface class (desktop / mobile at minimum) so a
// deliberate arrangement is never replayed onto a viewport that cannot hold it.
// Owner's call, 2026-09-12: mobile is being picked up separately, so the surface
// taxonomy is theirs to design rather than ours to guess at. Disclosed in PR #185.
const LS = (id) => `ew-frame-${id}`;

// Layout-version guard. DEFAULT_LAYOUT is a hand-arranged default (edge-anchored). A frame's own
// saved moves win over it — but that means when the DEFAULT changes, anyone with older per-frame saves
// stays stuck on stale positions (live 09-07: maximized and found world/settings NOT right-docked because an
// old save overrode the re-baked default). Bump this whenever DEFAULT_LAYOUT changes materially: on load,
// a mismatch discards every ew-frame-* save ONCE, so the new default actually takes, then stamps the new
// version. A user's deliberate arrangement after the bump is saved and kept as normal.
const LAYOUT_VERSION = '2026-09-12-chrome-clearance';   // bumped: tonight's intermediate builds
// wrote poisoned saves. A frame nudged aside by the buggy chrome-clearance pass was persisted with
// placed:true, so every later fix correctly HONOURED a position a bug had invented. Reproduced exactly:
// seeding ew-frame-chat {x:42, placed:true} at 360x643 gives chat [42,326,352,633], R's rect digit for
// digit; a fresh profile gives [8,326,352,633]. This is what the version key is for.
const LAYOUT_VER_KEY = 'ew-frame-layout-ver';
(() => {
  try {
    if (localStorage.getItem(LAYOUT_VER_KEY) === LAYOUT_VERSION) return;
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i);
      if (k && k.startsWith('ew-frame-') && k !== LAYOUT_VER_KEY) localStorage.removeItem(k);
    }
    localStorage.setItem(LAYOUT_VER_KEY, LAYOUT_VERSION);
  } catch { /* private mode / no storage — frames just use defaults, which is correct */ }
})();

const frames = new Map();

// ---- edge-resize: one document-level hit-tester for all frames -------------
// Grab band: 3px inside the border + 7px of free air outside it. Inside
// pixels belong to content — scrollbars and buttons always win (we test the
// real element under the pointer, not geometry alone).
const _resizables = [];
const _BAND = 4, _REACH = 6;   // band was 2, widened to 4 after a live
                               // report (edge target was ~8px total and
                               // half of that hung in the air)
const _CORNER = 15;            // the corner is the hardest 2D target on the
                               // frame and USED to be the intersection of two
                               // 2px bands — invisible in practice. It gets
                               // its own square, sized like the old SE grip.
/** Would the edge-resize hit-tester claim this point? (for ui.js's
 *  arrange-exit guard — the grab band extends _REACH px OUTSIDE frames) */
export function resizeZoneAt(x, y) {
  const fake = { clientX: x, clientY: y };
  for (const f of _resizables) {
    if (f.root.style.display === 'none' || !f.active()) continue;
    if (_zoneFor(f, fake)) return true;
  }
  return false;
}
const _CURSORS = { n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize',
  ne: 'nesw-resize', sw: 'nesw-resize', nw: 'nwse-resize', se: 'nwse-resize' };
function _zoneFor(f, e) {
  const r = f.root.getBoundingClientRect();
  const nx = e.clientX - r.left, ny = e.clientY - r.top;
  if (nx < -_REACH || ny < -_REACH || nx > r.width + _REACH || ny > r.height + _REACH) return '';
  // corners FIRST, independently of the edge bands: within 15px of a corner
  // point (in or out, the early return above already bounds the outside) the
  // grab is diagonal. _contentClaims still outranks everything at the call
  // sites, so a button or scrollbar living in that square keeps winning.
  const nearW = nx <= _CORNER, nearE = nx >= r.width - _CORNER;
  const nearN = ny <= _CORNER, nearS = ny >= r.height - _CORNER;
  if (nearN && nearW) return 'nw';
  if (nearN && nearE) return 'ne';
  if (nearS && nearW) return 'sw';
  if (nearS && nearE) return 'se';
  let z = '';
  if (ny < _BAND) z += 'n'; else if (ny > r.height - _BAND) z += 's';
  if (nx < _BAND) z += 'w'; else if (nx > r.width - _BAND) z += 'e';
  return z;
}
function _contentClaims(e) {
  // whatever really sits under the pointer: a scrollbar strip, a button, an
  // input — interactive content beats the grab; bare frame chrome does not
  for (let t = document.elementFromPoint(e.clientX, e.clientY); t instanceof HTMLElement; t = t.parentElement) {
    if (['BUTTON', 'INPUT', 'TEXTAREA', 'SELECT', 'A'].includes(t.tagName)) return true;
    if (t.scrollHeight > t.clientHeight + 1) {
      const sbw = t.offsetWidth - t.clientWidth;
      if (sbw > 0 && e.clientX >= t.getBoundingClientRect().right - sbw - 2) return true;
    }
    if (t.scrollWidth > t.clientWidth + 1) {
      const sbh = t.offsetHeight - t.clientHeight;
      if (sbh > 0 && e.clientY >= t.getBoundingClientRect().bottom - sbh - 2) return true;
    }
    if (t.classList?.contains('frame')) break;
  }
  return false;
}
/** Is this pointer over DRAGGABLE frame chrome — i.e. none of: interactive
 *  content (_contentClaims), a click-styled row (computed cursor:pointer —
 *  the house convention for every clickable), a label (clicks toggle its
 *  input), or selectable text (the chat log — a grab there would eat copy)?
 *  The SL Build-window/WoW convention: empty pane pixels move the
 *  pane; everything that DOES something keeps doing it. */
function _grabbableAt(e) {
  if (_contentClaims(e)) return false;
  for (let t = e.target; t instanceof HTMLElement; t = t.parentElement) {
    if (t.tagName === 'LABEL') return false;
    const cs = getComputedStyle(t);
    if (cs.cursor === 'pointer' || cs.cursor.endsWith('resize')) return false;   // a resize-cursor element is a HANDLE, not a grab surface (chat's pane grip moved the whole frame;)
    if ((cs.userSelect || cs.webkitUserSelect) === 'text') return false;
    if (t.classList?.contains('frame')) return true;   // reached bare chrome
  }
  return false;
}
function _hit(e) {
  const cands = _resizables.filter((f) => f.active());
  cands.sort((a, b) => (+b.root.style.zIndex || 0) - (+a.root.style.zIndex || 0));
  for (const f of cands) {
    const z = _zoneFor(f, e);
    if (z) return { f, z };
  }
  return null;
}
let _resizing = false;
document.addEventListener('pointermove', (e) => {
  if (_resizing) return;
  const h = _hit(e);
  document.body.style.cursor = (h && !_contentClaims(e)) ? _CURSORS[h.z] : '';
}, true);
document.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  const h = _hit(e);
  if (!h || _contentClaims(e)) return;
  const { f, z } = h;
  e.preventDefault(); e.stopPropagation();
  f.raise();
  _resizing = true;
  const sx = e.clientX, sy = e.clientY;
  const s0 = { x: f.state.x, y: f.state.y, w: f.state.w, h: f.state.h };
  // state.h is the BODY's height; the frame renders taller by the title bar and
  // .fr-body's padding. fit() already knows this (`const chrome = hh - state.h`)
  // and clamps against root.offsetHeight — the south clamp below did not, so it
  // budgeted in body space while subtracting a viewport margin and let a resize
  // end past the bottom edge, unreachable under html,body{overflow:hidden}.
  // Measured before the fix: budget 729, rendered bottom 794, viewport 768.
  // fit() would correct it, but finish() never calls fit. (round 6)
  const s0chrome = Math.max(0, (f.root.offsetHeight || 0) - s0.h);
  const move = (ev) => {
    const dx = ev.clientX - sx, dy = ev.clientY - sy;
    // grows are clamped so no edge ever leaves the viewport
    // (windows stay inside the active area, full stop)
    if (z.includes('e')) f.state.w = clamp(s0.w + dx, f.minW, innerWidth - s0.x - 8);
    if (z.includes('s')) f.state.h = clamp(s0.h + dy, f.minH, innerHeight - s0.y - 4 - s0chrome);   // 4 px above the bottom edge, CHROME-AWARE; a drag clamps at 8 (below) — a resize may end 4 px lower; the old −40 stopped a resize 36 px short of where a drag could go (live 09-07 23:25)
    if (z.includes('w')) {
      const maxW = s0.x + s0.w - 8;                // west edge stops at x=8
      f.state.w = clamp(s0.w - dx, f.minW, maxW);
      f.state.x = s0.x + (s0.w - f.state.w);       // east side stays planted
    }
    if (z.includes('n')) {
      const maxH = s0.y + s0.h - 8;                // north edge stops at y=8
      f.state.h = clamp(s0.h - dy, f.minH, maxH);
      f.state.y = s0.y + (s0.h - f.state.h);       // south side stays planted
    }
    f.paint();
  };
  // ONE idempotent finish, shared by every way a drag can end. `pointerup`
  // alone is not enough: release the button outside the browser and `up` never
  // arrives, so `_resizing` stays true and the move/up listeners stay
  // installed — hover detection and all future resizes are dead until reload.
  // (The title-bar drag path has always taken pointer capture; this one was
  // written without it. Found in review.)
  let captureEl = null;          // whoever ACQUIRED the capture releases it
  let done = false;
  const finish = () => {
    if (done) return;                    // idempotent: several paths may fire
    done = true;
    document.removeEventListener('pointermove', move, true);
    document.removeEventListener('pointerup', finish, true);
    document.removeEventListener('pointercancel', finish, true);
    removeEventListener('blur', finish);
    // release on the element that ACQUIRED it. document.releasePointerCapture
    // was a no-op — Document does not own the capture, documentElement does —
    // so a blur/cancel could leave the capture live. (Review catch.)
    try {
      if (captureEl?.hasPointerCapture?.(e.pointerId)) captureEl.releasePointerCapture(e.pointerId);
    } catch { /* never captured, or gone */ }
    captureEl?.removeEventListener('lostpointercapture', finish);
    document.body.style.cursor = '';
    _resizing = false;
    f.markMoved?.(); f.save();             // a resize is deliberate too

  };
  // capture keeps the stream coming while the pointer is outside the window;
  // lostpointercapture is then one more road to the same finish
  // one element owns the capture and the same one releases it; retained so
  // finish() cannot guess wrong
  try {
    document.documentElement.setPointerCapture(e.pointerId);
    captureEl = document.documentElement;
    captureEl.addEventListener('lostpointercapture', finish);
  } catch { /* no capture available — the listeners below still cover it */ }
  document.addEventListener('pointermove', move, true);
  document.addEventListener('pointerup', finish, true);
  document.addEventListener('pointercancel', finish, true);
  addEventListener('blur', finish);
}, true);
// frames live in [Z_LO..Z_HI]; chrome starts at 27 (#dock) and must stay above
const Z_LO = 10, Z_HI = 25;
let zTop = Z_LO;
let warnedZ = false;
let locked = localStorage.getItem('ew-ui-locked') === '1';

const SNAP = 11;            // px — edge and frame-to-frame snapping distance
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

export function isLocked() { return locked; }
export function setLocked(v) {
  locked = v;
  localStorage.setItem('ew-ui-locked', v ? '1' : '0');
  document.body.classList.toggle('ui-locked', locked);
  bus.emit('ui-locked', locked);
}
document.body.classList.toggle('ui-locked', locked);

/**
 * @param id       stable key for the saved layout
 * @param opts     { title, x, y, w, h, minW, minH, resizable, collapsible,
 *                   closable, hidden, onResize }
 *                 x/y accept negatives to anchor from the right/bottom edge.
 */
// The newcomer's layout is a hand-arranged one, not the panels' individual guesses: the tester's desktop
// (a 1904×844 window, 09-06) exported from a live session and anchored to edges so it holds on
// other screens. World, chat and the emote bar are open; everything else is closed but pinned to the dock.
// A frame's own saved state (its owner's moves) still wins; resetLayout returns HERE.
const DEFAULT_LAYOUT = {
  world:    { x: -8,  y: 8,   w: 407, h: 363, hidden: false },
  chat:     { x: 10,  y: -10, w: 545, h: 307, hidden: false },
  settings: { x: -8,  y: 381, w: 407, h: 443, hidden: true },
  profile:  { x: 48,  y: 46,  w: 505, h: 452, hidden: true },
  debug:    { x: -414, y: 8,  w: 342, h: 453, hidden: true },
  emotes:   { x: 'center', y: 10, h: 32, hidden: false },  // one bar across the TOP, OPEN by default — moved from y:-10 on 2026-09-11 because the hint bar and toasts live at the bottom (R: "all the helper notifications display at the bottom where it currently is"); the bar sizes its WIDTH itself (emotebar.js snapTo) and its ROWS from a dragged height, but ROW_H is fixed — carried here so fitsDefaults stops counting the bar as zero-height (round 4)
};
// Can this viewport hold the hand-arranged default at all? Derived from
// DEFAULT_LAYOUT rather than a hardcoded breakpoint, so it stays true if the
// defaults change: the arrangement needs room for its widest frame, and for its
// open frames stacked. A phone fails on width, a 1280x720 desktop on height —
// this is NOT a mobile special case (live 09-10 23:53: world, emotes and the
// world palette stacked on top of chat on a phone, every rect legally inside the
// viewport and none overlapping, because the palette is makeSection mounting
// into world's stack and no rect test can see it). CHROME is the title bar a
// body height does not include.
const EMOTE_BAR_W = 352;   // widthFor(9) in emotebar.js — the bar sizes itself, so DEFAULT_LAYOUT carries no w for it
const CHROME = 26;
// The open defaults are EDGE-ANCHORED ON OPPOSITE CORNERS — world x:-8 y:8
// (top-right), chat x:10 y:-10 (bottom-left) — so they never share a column
// and summing their heights modelled an arrangement that does not exist. That
// over-reach made 1280x720 and 800x700 report "cannot fit", closing the world
// panel and the emote bar on ordinary laptops and split windows; and because
// the LAYOUT_VERSION bump in this same PR purges saved layouts once, the
// "a saved layout always wins" escape hatch could not protect anyone on the
// upgrade. (agent review round 4; R handed me the call, 2026-09-11.)
//
// What actually has to fit: the widest open panel across, and the TALLEST open
// panel plus the bottom bar down — the bar is the one thing every panel shares
// a column with. Width alone was the other candidate and is wrong: it opens
// 844x390 (phone landscape), where a 363px world plus the bar cannot coexist.
function fitsDefaults() {
  const open = Object.values(DEFAULT_LAYOUT).filter((d) => d.hidden === false);
  const box = (d) => (d.h ?? 0) + CHROME;
  const bar = DEFAULT_LAYOUT.emotes.hidden === false ? box(DEFAULT_LAYOUT.emotes) : 0;
  // WIDTH IS A ROW, NOT A FRAME. `Math.max(...widths)` asked whether the single
  // widest panel fits — but chat is anchored LEFT (x:10) and world RIGHT (x:-8),
  // so they must sit side by side and the arrangement needs the SUM. At 800px
  // the widest frame (545) fits comfortably while 545+407=952 does not, so
  // auto-minimize left both open and the top-docked bar landed on world:
  // `emotes [224,10,576,56] x world [385,8,792,381]`, 191x46px, both axes.
  // Boot-check has been red at 800x700 since the bar moved to the top (288a5da)
  // and I did not see it because I ran only 1280x720 and 390x844 all day.
  const sideBySide = open
    .filter((d) => d !== DEFAULT_LAYOUT.emotes && typeof d.x === 'number')
    .reduce((sum, d) => sum + (d.w ?? 0), 0);
  // A CENTRED STRIP IS PART OF THE ROW TOO (2026-09-12, found because R asked
  // whether a window can even get that small). sideBySide sums only frames with a
  // NUMERIC x, so the emote bar — x:'center' — was never counted: the predicate
  // asked "do chat(545) and world(407) fit?" while a 352px bar sat across the
  // middle of the same band. Below ~968 the sum already says no and the bar is
  // hidden; above the threshold a centred bar clears a right-anchored panel on its
  // own; BETWEEN them nothing protected it.
  //
  // Geometric, not a guess: bar_right = (vw + barW)/2, world_left = vw - M - worldW,
  // so clearance needs vw >= barW + 2*(worldW + M). M=8 — the margin the clamp
  // itself uses — gives 1182 and agrees with all seven measured widths. M=16 was
  // tried and rejected: it hid world at 1200 where the arrangement measures clear
  // by 9px, trading an overlap bug for a spurious-minimise one.

  const centredW = open.filter((d) => d.x === 'center')
    .reduce((m, d) => Math.max(m, d.w ?? EMOTE_BAR_W), 0);
  const rightAnchored = Math.max(0, ...open
    .filter((d) => typeof d.x === 'number' && d.x < 0).map((d) => d.w ?? 0));
  const centredRow = centredW && rightAnchored ? centredW + 2 * (rightAnchored + 8) : 0;
  const widest = Math.max(...open.map((d) => d.w ?? 0));
  const tallest = Math.max(...open.filter((d) => d !== DEFAULT_LAYOUT.emotes).map(box), 0);
  return innerWidth - 16 >= Math.max(widest, sideBySide, centredRow) && innerHeight - 16 >= tallest + bar;
}

export function makeFrame(id, opts = {}) {
  if (frames.has(id)) return frames.get(id);
  opts = { ...opts, ...(DEFAULT_LAYOUT[id] ?? {}) };
  const {
    title = id, w = 300, h = 220, minW = 170, minH = 90,
    resizable = true, collapsible = true, closable = true,
    hidden = false, onResize = null, className = '',
  } = opts;

  const root = document.createElement('div');
  root.className = `frame panel ${className}`;
  root.dataset.frame = id;

  const head = document.createElement('div');
  head.className = 'fr-head';
  const ttl = document.createElement('span');
  ttl.className = 'fr-title';
  ttl.textContent = title;
  const btns = document.createElement('span');
  btns.className = 'fr-btns';
  head.append(ttl, btns);

  const body = document.createElement('div');
  body.className = 'fr-body';

  root.append(head, body);
  document.body.appendChild(root);

  // ---- state
  const saved = readSaved(id);
  // TRUE once the USER has placed this frame — set at the two deliberate acts
  // (drag end, resize end), never by save() itself. save() is also called by
  // show()/hide(), and latching there made `moved` mean "was persisted": opening
  // the right-docked debug panel once was enough to strand it at its old x on
  // the next maximize — verbatim the 09-07 bug these guards exist to prevent.
  // Declared HERE, above the api object and fit(), because a const in the
  // temporal dead zone throws at construction — node --check cannot see it.
    let moved = !!saved;
    // TWO QUESTIONS, ONE FLAG (agent review 2026-09-12, and my own regression).
    // `moved` answers "do not re-anchor this frame" — and !!saved is RIGHT there:
    // a frame rebuilt from a previous session must not snap back to its anchor
    // (the 09-07 bug; frames-layout-test.ts:402 binds it deliberately). But the
    // viewport-change rule asks a different question — "did the OWNER place this"
    // — and !!saved answers that wrongly, because save() is called by show()/hide()
    // so toggling any panel once exempted the frame forever. That needs its own
    // signal, persisted with state and written only at the deliberate acts.
    let placed = saved?.placed === true;
    const markMoved = () => { moved = true; placed = true; state.placed = true; };
  // R, 2026-09-11, on the bug this exists for: the emote bar "will always pop
  // sideways to the right regardless if there's room for it" — snapTo calls
  // _fit() 180ms after every drag settles, and fit() re-centred an x:'center'
  // frame each time because the guard tested `saved`, captured once at
  // construction and never refreshed by a drag.
  const state = {
    x: saved?.x ?? resolveAnchor(opts.x, w, innerWidth),
    y: saved?.y ?? resolveAnchor(opts.y, h, innerHeight),
    w: saved?.w ?? w,
    h: saved?.h ?? h,
    // A saved layout always wins — this must never override an arrangement the
    // user made. Only a FIRST load on a viewport that cannot hold the default
    // opens less: chat alone, because it is the one pane useful by itself and it
    // carries the composer. Everything else stays one dock tap away.
    hidden: saved?.hidden ?? (hidden || (id !== 'chat' && !fitsDefaults())),
    // MUST be read back, not just written. save() serialises the whole state object,
    // so `autoHidden` reached storage — but this initialiser never restored it, making
    // it write-only across a reload. Consequence, measured: auto-hide at 900 persists
    // {hidden:true, autoHidden:true}; a reload brings back `hidden` and drops
    // `autoHidden`; widening to 1920 then finds the restore guard falsy and the frame
    // is stranded hidden FOREVER. B1 traded "reopens a deliberately closed panel" for
    // "never reopens an auto-hidden one".
    autoHidden: saved?.autoHidden ?? false,
    // AND `placed`, for the same reason and by the same mistake. markMoved() sets
    // `state.placed = true` ad-hoc and save() serialises the whole object, so the flag
    // reaches storage once — but this literal had no `placed` key, so the NEXT
    // construction built a state without it and the next save() erased it. Identical
    // in shape to the autoHidden bug fixed in 2256cba, three lines above, which I
    // fixed while leaving its twin in place.
    //
    // Measured at 1280x800 on the emote bar: markMoved + save -> `_placed: true`;
    // reload -> `_placed: false`; one hide/show -> storage carries no `placed` key at
    // all. A bar the owner deliberately resized is forgotten by the next refresh and
    // goes back to being auto-managed — losing the fit() re-derive exemption
    // (`!placed && opts.w != null`), the chrome-clearance exemption
    // (`!placed && chromeSettled`) and the viewport auto-minimize exemption
    // (`id === 'chat' || !f._state || f._placed`) all at once. The exact failure
    // `placed` was introduced to prevent.
    placed: saved?.placed === true,
  };

  const api = {
    id, el: root, body, head,
    // live refs for riders that own their own sizing (the emote bar snaps itself
    // to whole tiles). _fit is here because writing _state and calling _paint
    // alone BYPASSES the viewport clamp: the bar reflowed to three rows and
    // painted itself past the bottom edge (#185 review, 800x700).
    _state: state, _paint: () => paint(), _fit: () => fit(), _markMoved: markMoved,
      // READER for the same flag (#185 B1): the api carried a SETTER only, so the
      // viewport rule below had no way to ask whether the owner placed this frame.
      // `moved` is !!saved at construction and latches on a real drag or resize.
      get _moved() { return moved; },
      get _placed() { return placed; },   // B1 exemption reads THIS, not _moved
      _save: save,
    get state() { return { ...state }; },
    show() {
      state.hidden = false; state.autoHidden = false;
      paint();
      // A hidden element measures zero, so a frame created hidden never got a
      // real position — it has to be fitted the first time it becomes visible.
      if (!fitted) { fitted = true; fit(); }
      save(); raise();
      return api;
    },
    hide() { state.hidden = true; state.autoHidden = false; paint(); save(); return api; },   // deliberate: never auto-restored
    toggle() { state.hidden ? api.show() : api.hide(); return api; },
    get visible() { return !state.hidden; },
    setTitle(t) { ttl.textContent = t; return api; },
    /** decorate the title bar (unread counts, status pips, …) */
    badge(html) {
      let b = head.querySelector('.fr-badge');
      // the title bar shows only while arranging; at rest the dock button carries the same badge
      const dk = document.querySelector(`#dock button[data-toggles="${id}"]`);
      let db = dk?.querySelector('.dk-badge');
      if (!html) { b?.remove(); db?.remove(); return api; }
      if (!b) { b = document.createElement('span'); b.className = 'fr-badge'; ttl.after(b); }
      b.innerHTML = html;
      if (dk) { if (!db) { db = document.createElement('span'); db.className = 'dk-badge'; dk.append(db); } db.innerHTML = html; }
      return api;
    },
    raise,
    resetLayout() {
      moved = false;                       // back under the anchors, or reset only half-works
      // ...and UNPLACE it. antra-tess #185 rereview addendum, B1(b): `placed` is a
      // separate latch (line ~360) set only by markMoved(), and the viewport rule
      // reads THAT — `if (id === 'chat' || !f._state || f._placed) continue`. Reset
      // cleared `moved` and left `placed` latched from whatever drag preceded it, so
      // a reset frame stayed permanently exempt from viewport management: the one
      // act that means "I am not arranging this any more" left the I-arranged-this
      // flag standing. The comment at 358 asks for a signal "written only at the
      // deliberate acts" — a reset is the deliberate act of un-placing.
      placed = false; state.placed = false;
      localStorage.removeItem(LS(id));
      Object.assign(state, {
        x: resolveAnchor(opts.x, w, innerWidth),
        y: resolveAnchor(opts.y, h, innerHeight),
        w, h,
        // The SAME rule the construction path applies (see the hidden: line
        // above). Reset removes the save first, so there is no arrangement to
        // protect — and without this, one tap of "reset layout" on a phone
        // reopened world and emotes stacked over chat: the precise state
        // auto-minimize exists to prevent, reached through this PR's own
        // reset button. (agent review round 2)
        hidden: hidden || (id !== 'chat' && !fitsDefaults()),
      });
      // ...and through fit(), not paint() alone: paint skips every viewport
      // clamp, so reset restored the authoring-viewport widths uncapped —
      // chat right=555 in a 390px viewport, 173px unreachable under
      // overflow:hidden. That is antra's original #185 finding, re-entered
      // by the reset path.
      fitted = true; fit();
      paint();
      if (!state.hidden) raise();
      return api;
    },
  };

  function raise() {
    if (zTop >= Z_HI) {
      const order = [...frames.values()].filter((f) => f.el !== root)
        .sort((a, b) => (+a.el.style.zIndex || 0) - (+b.el.style.zIndex || 0));
      zTop = Z_LO - 1;
      for (const f of order) f.el.style.zIndex = String(++zTop);
      // more frames than the band holds: the overflow ties at Z_HI rather
      // than climbing under the dock
      if (zTop > Z_HI) {
        if (!warnedZ) { warnedZ = true; console.warn(`frames: ${order.length} frames exceed the z band [${Z_LO}..${Z_HI}]; clamping`); }
        for (const f of order) f.el.style.zIndex = String(Math.min(+f.el.style.zIndex, Z_HI));
        zTop = Z_HI;
      }
    }
    root.style.zIndex = String(Math.min(++zTop, Z_HI));
  }
  // Plain persistence. It does NOT latch `moved` — that was the first design and
  // it was wrong (show()/hide() call save() too, so it came to mean "was
  // persisted"; see the note at the `moved` declaration). This comment used to
  // describe that rejected version and survived the fix. (round 4: comment rot)
  function save() {
    localStorage.setItem(LS(id), JSON.stringify(state));
  }
  function paint() {
    root.style.display = state.hidden ? 'none' : 'flex';
    root.style.left = `${state.x}px`;
    root.style.top = `${state.y}px`;
    root.style.width = `${state.w}px`;
    // PUBLISH THE FRAME'S OWN FLOOR. index.html's `.frame { min-width: 170px }`
    // is a CSS floor sitting BENEATH this JS one, and it silently won whenever a
    // frame declared a smaller minW. Measured in Chromium: the emote bar asking
    // for w=48/86/124/162 all rendered at frameW=170 with 4 columns and 3 rows —
    // which is R's report in one line, "won't go thinner than 4x, but will
    // forcibly go 9x down and not wrap to the buttons at all": the body was
    // painted 336px tall while the clipped width could only ever lay out three
    // rows of tiles. Three rounds of fixing snapTo changed nothing she could see
    // because the arithmetic was right and the render was floored.
    root.style.minWidth = `${minW}px`;
    body.style.height = `${state.h}px`;
    // arrange-mode affordances: which viewport edges hold this frame (glow),
    // and whether the floating label must sit below (frame hugs the top)
    const hgt = root.offsetHeight || state.h;
    const st = stickyEdges(state, hgt);
    root.classList.toggle('st-l', st.l); root.classList.toggle('st-r', st.r);
    root.classList.toggle('st-t', st.t); root.classList.toggle('st-b', st.b);
    root.classList.toggle('label-below', state.y < 46);
    onResize?.(state.w, state.h);
  }

  // ---- buttons: name + ✕ only. (Collapse/minimize is GONE — chip, verb, state and the dblclick that
  // still fired it; live: frames 'disappearing forever' were minimized to a title bar.)
  if (closable) {
    const b = document.createElement('button');
    b.className = 'fr-btn';
    b.title = 'close';
    b.textContent = '✕';
    b.onclick = (e) => { e.stopPropagation(); api.hide(); };
    btns.appendChild(b);
  }

  // ---- dragging
  head.addEventListener('pointerdown', (e) => {
    if (locked || e.target.closest('.fr-btn')) return;
    e.preventDefault();
    raise();
    root.classList.add('lifting');   // depth returns only while held
    const ox = e.clientX - state.x, oy = e.clientY - state.y;
    // capture can throw for a pointer id the browser doesn't know (synthetic
    // events, some touch stacks) — losing capture is survivable, aborting the
    // whole drag is not
    try { head.setPointerCapture(e.pointerId); } catch { /* no capture */ }
    const move = (ev) => {
      state.x = ev.clientX - ox;
      state.y = ev.clientY - oy;
      snapPosition(id, state, root.offsetHeight);
      paint();
    };
    const up = () => {
      head.removeEventListener('pointermove', move);
      head.removeEventListener('pointerup', up);
      root.classList.remove('lifting');
      markMoved(); save();                 // a drag IS the deliberate act
    };
    head.addEventListener('pointermove', move);
    head.addEventListener('pointerup', up);
  });
  // Alt+drag anywhere on the frame — the MMO habit, and it rescues a frame
  // whose title bar has been dragged off-screen. Without Alt, EMPTY frame
  // pixels drag too when the layout is unlocked (grab-by-empty-space)
  // — interactive content, pointer-cursor rows, labels,
  // selectable text and the edge-resize band all still win.
  root.addEventListener('pointermove', (e) => {
    if (locked || _resizing) { root.style.cursor = ''; return; }
    root.style.cursor = (!_hit(e) && _grabbableAt(e)) ? 'grab' : '';
  });
  root.addEventListener('pointerdown', (e) => {
    if (locked || !e.isTrusted) return;                // isTrusted: our own
    if (!e.altKey && (_hit(e) || !_grabbableAt(e))) return;
    // re-dispatch below bubbles back through this capture handler — without
    // the guard it recurses to stack overflow (exposed when heads went
    // display:none and alt-drag became the only rest-state move).
    e.preventDefault(); e.stopPropagation();
    head.dispatchEvent(new PointerEvent('pointerdown', e));
  }, true);

  // ---- resizing: registered with the module-level edge hit-tester (below) —
  // one document listener serves every frame, which is the only way to grab
  // OUTSIDE a frame's border without an overlay stealing its content's events
  // (the ::before halo painted over scrollbars and buttons).
  if (resizable) _resizables.push({ root, state, minW, minH, paint, save, raise, markMoved,
    active: () => !locked && !state.hidden });

  root.addEventListener('pointerdown', raise);

  frames.set(id, api);
  paint();
  // restored frames enter through raise() too, so boot order becomes z order
  // and the first click on any of them lands above the rest
  if (!state.hidden) raise();
  // The anchor was computed from the BODY height, but a frame is also a title
  // bar and whatever padding its content carries — so a bottom-anchored frame
  // hung its composer off the screen. Measure once it exists and pull it back.
  let fitted = false;
  // A SAVED layout must be fitted too. It used to be skipped — the reasoning was
  // that a save is the user's own arrangement and should be honoured verbatim — but
  // a layout saved on a wide screen is not an arrangement for THIS viewport: it came
  // back at full width on a narrow one and ran off the edge, unreachable under
  // html,body{overflow:hidden} (#185 review). fit() only ever pulls a frame inside
  // the viewport, so honouring a save and fitting it are not in conflict.
  if (!state.hidden) { fitted = true; fit(); }
  addEventListener('resize', fit);

  function fit() {
    // WIDTH FIRST, and BEFORE the measurement guard below: a frame's width does not
    // depend on its measured height, and at construction the element is not yet in a
    // measurable state (offsetHeight 0), so anything behind that guard never runs on
    // the creation path — which is exactly where a restored oversized layout lands.
    const maxW = Math.max(80, innerWidth - 16);
    // RE-DERIVE BEFORE CLAMPING, for a frame the owner has not placed. The clamp
    // below is a RATCHET — `Math.min(state.w, maxW)` can only ever shrink — so a
    // width narrowed by one viewport's chrome was carried into every later one.
    // Measured on a phone, rotating portrait -> landscape -> portrait: chat went
    // 344 -> 240 -> 240, landing at x=112 instead of 8, with `saved: null` the
    // whole time. Nothing was persisted; the live value simply never grew back.
    // The owner's rule: "if a user saves a layout on a bigger screen, shrinks it,
    // then expands it again without touching any panel, it should be identical."
    // Store intent, derive presentation — the declared size IS the intent, and a
    // frame that has never been dragged or resized has no other claim on a width.
    // WIDTH ONLY, deliberately. `emotes` is the one frame that declares a height
    // without a width ({x:'center', y:10, h:32}) — and its height is DERIVED, not
    // declared: heightFor(cols) = rowsFor(cols)*ROW_H + gaps (emotebar.js:37). The
    // 32 is a one-row seed, so re-asserting it every pass fought the bar's own row
    // computation, reflowed it wider, and slid keys 4-6 under the right-hand chrome
    // — boot-check@390x844 went red on "point/salute/clap covered". Width is a
    // standing intent; the bar's height is a computed consequence.
    if (!placed && opts.w != null) state.w = opts.w;
    state.w = Math.max(Math.min(state.w, maxW), Math.min(minW, maxW));
    const hh = root.offsetHeight;
    if (!hh) return;                       // the constructor paints right after this call
    // SIZE BEFORE POSITION. DEFAULT_LAYOUT is hand-arranged at a wide authoring
    // viewport, and a saved layout can be wider still; clamping only x/y pins the
    // frame at the left margin and lets the rest run off the right edge — which
    // html,body{overflow:hidden} makes unreachable rather than merely ugly
    // (#185 review: chat w:545 at a 390px viewport = 163px lost). minW/minH are
    // authoring floors, not guarantees: inside a viewport narrower than minW the
    // floor has to yield or the frame can never fit at all.
    const chrome = hh - state.h;                       // title bar + padding: state.h is the BODY's height
    const maxH = Math.max(40, innerHeight - 16 - chrome);
    state.h = Math.max(Math.min(state.h, maxH), Math.min(minH, maxH));
    // THE ANCHOR is gated on `moved`; the CLAMP below is NOT — that distinction is
    // the whole fix. A frame placed by hand keeps its y; an untouched one still
    // follows its edge through a resize. Gating the clamp too was tried and
    // reverted: it stranded every ordinary bottom-anchored frame (rotate 700->500
    // left an untouched bar at y=370 where 428 was wanted).
    // R, 2026-09-11: "the emote bar is a little broken now, it can't be
    // arbitrarily placed anywhere."
    if (!moved && opts.y != null && opts.y < 0) state.y = Math.max(8, innerHeight + opts.y - hh);
    state.y = clamp(state.y, 8, Math.max(8, innerHeight - hh - 8));
    // A frame created hidden gets its x from resolveAnchor at CREATION width. If it's first shown after a
    // resize/maximize, a negative-x (right-edge) anchor must re-resolve to the CURRENT width, or it strands
    // at its old absolute x (live 09-07: debug, x:-414, opened after maximizing and sat far left instead of
    // flush-left of the right-docked panels). Only when there's no saved override.
    if (!moved && typeof opts.x === 'number' && opts.x < 0) state.x = Math.max(8, innerWidth + opts.x - state.w);
      if (opts.x === 'center' && !moved) state.x = Math.round((innerWidth - state.w) / 2);
    state.x = clamp(state.x, 8, Math.max(8, innerWidth - state.w - 8));
      // EVERY DEFAULT-PLACED FRAME CLEARS THE FIXED CHROME, not just the centred
      // bar. R, 2026-09-12: "make sure the other menus stay clear of the mic,
      // headphones, and dock... If they're at default, just run a check to resize.
      // If they're moved, then honor where they're moved to."
      //
      // Frames cap at Z_HI=25 while the chrome above them is 27 (#dock), 45
      // (#micbtn/#earbtn) and 60 (.capnotice): a frame left underneath CANNOT win
      // by stacking, so it must be placed or sized clear. Measured at 360x780 with
      // the rule applied to the centred bar only: world, debug and profile all sat
      // across the rail.
      //
      // Gated on `placed`: true once the owner has dragged or resized this frame,
      // persisted in state. A hand-arranged layout is theirs to keep.
      //
      // AND ONLY CONSULT CHROME THAT IS ITSELF PLACED. At boot fit() can run while
      // #dock is still a stub and the mic/ear pair sits unplaced at its origin, so a
      // frame dodges glyphs that are about to move — and the one-shot latch freezes
      // that wrong result. chromeSettled below is the gate: the dock carries no
      // buttons until it has laid out.
      const chromeSettled = (document.querySelector('#dock')?.querySelectorAll('button[data-toggles]').length ?? 0) > 0;
      if (!placed && chromeSettled) {
        // ANCHOR-AWARE (antra-tess #185 B2). Each obstacle is charged to the side it
        // is welded to, via its DECLARED anchor — the one thing computed style cannot
        // supply. `.capnotice` is right-anchored and was being read as left-consuming,
        // which is what drove `avail` to -6 and floored a 407px frame to its 210 minW.
        let clearRight = 0, clearFromRight = 0;
        for (const sel of ['#dock', '#micbtn', '#earbtn', '.capnotice']) {
          const g = document.querySelector(sel)?.getBoundingClientRect();
          if (g && g.width && g.left < state.x + state.w && state.x < g.right
              && g.top < state.y + hh && state.y < g.bottom) {
            const c = chromeCost(sel, g, innerWidth);
            clearRight = Math.max(clearRight, c.left);
            clearFromRight = Math.max(clearFromRight, c.right);
          }
        }
        if (clearRight || clearFromRight) {
          const shifted = Math.round(clearRight + 8);
          if (!clearRight) {
            // Right-side chrome only: do NOT shift left (that slams a right-anchored
            // frame to x=8). Shrink from the frame's own right edge and re-seat it
            // against its declared side.
            // The span available to this frame is the viewport less both margins
            // less the right-side chrome. NOT `- state.x` as well: that subtracts the
            // frame's own left offset on top of the chrome, double-counting the same
            // span (at 1280 with x=865 it gave 77, flooring a 407px frame to minW).
            const avail = innerWidth - 16 - clearFromRight;
            if (avail < state.w) state.w = Math.max(Math.min(avail, maxW), Math.min(minW, maxW));
            state.x = Math.max(8, innerWidth - 8 - clearFromRight - state.w);
          } else if (shifted + state.w <= innerWidth - 8) {
            state.x = shifted;
          } else {
            // OPEN, NOT FIXED — right-anchored chrome is mis-costed here.
            //
            // This branch takes `g.right` of every obstacle as space consumed FROM
            // THE LEFT. That is true for left-anchored chrome (#dock) and false for
            // anything welded to the right edge. Consequence, measured at 1280x720
            // and 1904x844: `.capnotice` (top:389) lands inside settings' default
            // rect, clearRight becomes the card's right edge, avail comes to -6, and
            // a declared 407px frame opens at its 210px minW, x=1062.
            //
            // 210 IS minW, so a frame sitting at its floor looks like a frame at its
            // natural size — which is why a single rect reads as healthy. Measure the
            // declared width, not the rendered one.
            //
            // Both available policies are wrong, both measured:
            //   floor at minW -> 407 becomes 210
            //   stand down    -> 407 stays, UNDER the card (z 60 vs Z_HI 25)
            // The repair is a DECLARED anchor the obstacle publishes. Computed style
            // cannot supply it for a normally-constrained element: CSSOM 9 resolves
            // left AND right to used values, so `.capnotice` reports cssL=930px and
            // cssR=10px at once. (An OVER-constrained element does report authored
            // values — measured — but .capnotice is over-constrained only below
            // 900px, so detection would work in one of three states. Useless.)
            // Changing the layout contract is the owner's call, not a patch.
            const avail = innerWidth - 8 - shifted - clearFromRight;
            state.w = Math.max(Math.min(avail, maxW), Math.min(minW, maxW));
            state.x = shifted;
          }
          state.x = Math.max(8, Math.min(state.x, innerWidth - state.w - 8));
        }
      }
    paint();
  }

  return api;
}

// ── DECLARED ANCHORS ──────────────────────────────────────────────────────────
// Which side of the viewport a piece of fixed chrome is welded to. DATA, not an
// inference, because the platform will not tell us: CSSOM §9 resolves BOTH `left`
// and `right` to used pixel values for a positioned element, so the authored side
// is gone by the time getComputedStyle can be asked. Measured at 1280x800 — an
// element declaring only `right:10px` reports `left:"950px"`; `inset-inline-end`
// behaves identically. (One exemption: an OVER-constrained element, declaring both
// sides, does report the authored values. `.capnotice` is over-constrained only
// below 900px, so detection would work in one of its three states — useless.)
//
// This is what every layout system worth copying does: RectTransform.anchorMin/Max,
// Auto Layout's leadingAnchor, Qt/WPF alignment. Geometry is layout's output, never
// its input.
//
// LTR only, stated as a real limit: under `dir=rtl` a logical `inset-inline-end`
// resolves to physical `left`, so these sides would need to flip.
const CHROME_ANCHOR = {
  '#dock':      (el) => el?.dataset.edge || 'left',    // dynamic: ui.js applyDockEdge
  '#micbtn':    (el) => el?.dataset.edge || 'left',    // hangs off the rail, follows its edge
  '#earbtn':    (el) => el?.dataset.edge || 'left',
  '.capnotice': (el) => el?.dataset.anchor || 'right', // capnotice.js, from the CSS breakpoint
};

// What a piece of chrome costs a frame, per side of the horizontal axis.
//
// A LEFT-anchored obstacle consumes from the left edge inward  -> its right edge.
// A RIGHT-anchored one consumes from the right edge inward     -> width + its gap.
//   NOT `extent - g.left`: that carries `extent` into the result, so
//   room = extent - 16 - (extent - left) cancels the viewport and yields a constant.
// STRETCH declares both sides and is charged to both.
// TOP/BOTTOM is welded to a horizontal edge, which says nothing about the
//   horizontal axis — a rail at [10..304] along the top is genuinely LEFT-positioned
//   there. So it falls through to the positional test rather than costing zero.
//   Returning {0,0} for it was the bug that put an emote tile under a top-docked
//   rail at 844x390 ("sit" covered by #dock, the corpus row-33 witness).
export function chromeCost(sel, g, extent) {
  const el = document.querySelector(sel);
  let a = CHROME_ANCHOR[sel]?.(el) ?? 'left';
  if (a === 'top' || a === 'bottom') a = (g.left + g.right) / 2 < extent / 2 ? 'left' : 'right';
  if (a === 'stretch') return { left: g.right, right: g.width + Math.max(0, extent - g.right) };
  if (a === 'right')   return { left: 0,       right: g.width + Math.max(0, extent - g.right) };
  return { left: g.right, right: 0 };
}

function resolveAnchor(v, size, extent) {
  if (v == null) return 40;
  if (v === 'center') return Math.max(8, Math.round((extent - size) / 2));
  return v < 0 ? Math.max(8, extent + v - size) : v;
}

function readSaved(id) {
  try { return JSON.parse(localStorage.getItem(LS(id)) ?? 'null'); } catch { return null; }
}

/** Edge snapping, plus snapping to the other frames' edges — it's what makes a
 *  hand-arranged layout look deliberate instead of approximate. */
function snapPosition(id, state, height) {
  const edges = [{ x: 8 }, { x: innerWidth - state.w - 8 }, { y: 8 }, { y: innerHeight - height - 8 }];
  for (const o of frames.values()) {
    if (o.id === id || !o.visible) continue;
    const r = o.el.getBoundingClientRect();
    // neighbours snap EDGE TO EDGE — no 6 px gutter between panels (live 09-06 23:42: "directly stick edges together")
    edges.push({ x: r.left }, { x: r.right - state.w }, { x: r.right }, { x: r.left - state.w });
    edges.push({ y: r.top }, { y: r.bottom - height }, { y: r.bottom }, { y: r.top - height });
  }
  for (const e of edges) {
    if (e.x != null && Math.abs(state.x - e.x) < SNAP) state.x = e.x;
    if (e.y != null && Math.abs(state.y - e.y) < SNAP) state.y = e.y;
  }
  // fully inside the viewport, always (no more parking a window half off-screen)
  state.x = clamp(state.x, 8, Math.max(8, innerWidth - state.w - 8));
  state.y = clamp(state.y, 8, Math.max(8, innerHeight - height - 8));
}

// ---- viewport-edge stickiness ----------------------------------------------
// A frame resting against a pane edge belongs to that edge: when the window
// resizes, it rides the edge instead of being stranded mid-air. Sticky edges
// glow in arrangement mode so the behavior is legible before it fires.
const STICKY = 16;
function stickyEdges(state, height) {
  return {
    l: state.x <= 8 + STICKY,
    r: innerWidth - (state.x + state.w) <= 8 + STICKY,
    t: state.y <= 8 + STICKY,
    b: innerHeight - (state.y + height) <= 8 + STICKY,
  };
}
let _lastVW = innerWidth, _lastVH = innerHeight;
let _lastFits = null;   // B1: the fit verdict at the last viewport change

// Ride the edges: frames sticky to right/bottom keep their edge gap when the
// window resizes; everything is then clamped back inside regardless.
addEventListener('resize', () => {
  const dw = innerWidth - _lastVW, dh = innerHeight - _lastVH;
  for (const f of frames.values()) {
    const st = f._state; if (!st) continue;
    const hgt = f.el.offsetHeight || st.h;
    // stickiness judged against the OLD viewport (pre-resize geometry)
    const wasR = _lastVW - (st.x + st.w) <= 8 + STICKY;
    const wasB = _lastVH - (st.y + hgt) <= 8 + STICKY;
    if (wasR && !(st.x <= 8 + STICKY)) st.x += dw;
    if (wasB && !(st.y <= 8 + STICKY)) st.y += dh;
    st.x = clamp(st.x, 8, Math.max(8, innerWidth - st.w - 8));
    st.y = clamp(st.y, 8, Math.max(8, innerHeight - hgt - 8));
    f._paint?.();
  }
  // RE-ASK WHETHER THE ARRANGEMENT STILL FITS (antra-tess #185 rereview B1).
  // fitsDefaults() was consulted only at construction and in resetLayout() —
  // both one-shot — while this listener clamped each frame's rect
  // INDEPENDENTLY and never re-checked the arrangement. A session opened wide and
  // then narrowed kept all three defaults open: measured emotes x world
  // overlapping 352x46px at 390x844 and 136x46px at 844x390 after a live resize.
  // Only frames the owner has NOT moved are minimized: a deliberately arranged
  // layout is theirs, and yanking it around on a window drag would be worse than
  // the overlap. Crossing back out re-opens them, so it is reversible.
  const fits = fitsDefaults();
  if (fits !== _lastFits) {
    for (const [id, f] of frames) {
      if (id === 'chat' || !f._state || f._placed) continue;
      // WHO hid it decides whether it comes back (antra-tess #185 B1, addendum).
      // `hidden` alone cannot answer that: the owner closing World and the viewport
      // auto-hiding it produce the identical flag, so crossing the fits boundary
      // reopened a deliberately closed panel. Reproduced at 1280x720: hide World,
      // resize by 1px, it returns. `autoHidden` is the third state she asked for —
      // set only here, cleared by a deliberate hide(), and read as the sole licence
      // to auto-restore.
      if (!fits && !f._state.hidden) {
        f._state.hidden = true; f._state.autoHidden = true;
        f.el.style.display = 'none'; f._paint?.(); f._save?.();
      } else if (fits && f._state.hidden && f._state.autoHidden) {
        f._state.hidden = false; f._state.autoHidden = false;
        f.el.style.display = ''; f._paint?.(); f._save?.();
      }
    }
    _lastFits = fits;
  }
  _lastVW = innerWidth; _lastVH = innerHeight;
});

export function getFrame(id) { return frames.get(id); }
export function allFrames() { return [...frames.values()]; }
// Esc toggles the whole set of open frames closed ⇄ back (live, 09-05 16:08),
// but only when nothing more specific wants the key: an open pop, a focused
// field, a scrim, edit mode (build.js owns Esc there), a locked pointer, or
// chat's own Esc. The remembered set lives only for the session.
let escStash = null;
// anything that owns Esc registers a claim here (build.js registers edit mode) — frames imports nobody for it,
// so the module graph stays a tree (frames → build → controller → ui → frames was a cycle)
const escClaims = [];
export function claimEscape(fn) { escClaims.push(fn); }
// Esc: close every open panel, Esc again brings the same set back. Installed here, with the frames, so the
// binding and the help text that promises it ship together. Yields to anything that owns Esc already
// (escapeIsClaimed — edit mode registers its claim from build.js).
addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || e.defaultPrevented) return;
  if (escapeIsClaimed()) return;
  escapeToggle();
});
export function escapeToggle() {
  const open = [...frames.values()].filter((f) => f.visible);
  if (open.length) { escStash = open.map((f) => f.id); for (const f of open) f.hide(); return 'closed'; }
  if (escStash?.length) { for (const id of escStash) frames.get(id)?.show(); escStash = null; return 'restored'; }
  return 'nothing';
}
export function escapeIsClaimed() {
  for (const fn of escClaims) { const c = fn(); if (c) return c; }
  const a = document.activeElement;
  if (a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.isContentEditable)) return 'field';
  if (document.querySelector('.pf-pop, .dd-pop, .chat-gearpop:not([hidden]), #emenu:not([hidden])')) return 'pop';   // the gear pop lives in the DOM hidden; only a SHOWN one claims Esc
  if (document.querySelector('.scrim.open')) return 'overlay';
  if (document.pointerLockElement) return 'pointer-lock';
  return null;
}

export function resetLayout() {
  for (const f of frames.values()) f.resetLayout();
  setLocked(false);
}
