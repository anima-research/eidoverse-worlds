// emote bar (client/lib/emotebar.js) — nine tiles, whole-tile snapping, postures that act on the desktop
// body AND announce themselves to the VR entry, and a fired tile that stays lit after net.js has already
// cleared myState.emote. Drives the REAL module against tools/emotebar-stub.mjs recorders.
//
//   BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun tools/emotebar-test.ts
//
// Each block names the product line that would silence it:
//   posture('sit') no longer calling sitHere          → "sit tile runs the controller seat search" goes red
//   lit tile following only myState.emote (old code)  → "fired tile stays lit after net.js clears" goes red
import { plugin } from 'bun';
const here = (f: string) => new URL(f, import.meta.url).pathname;
plugin({
  name: 'emotebar-stubs',
  setup(b) {
    for (const m of ['frames', 'avatar', 'controller', 'mybody', 'xrpanels', 'base']) {
      b.onResolve({ filter: new RegExp(`^\\./${m}\\.js$`) }, () => ({ path: here('./emotebar-stub.mjs') }));
    }
  },
});
import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register();

// emojiRenders paints on a scratch canvas: coloured pixels = a real glyph
HTMLCanvasElement.prototype.getContext = function () {
  return { fillText() {}, getImageData: () => ({ data: new Uint8ClampedArray(24 * 24 * 4).fill(200) }) } as any;
};
// the bar repaints on a 500 ms interval — capture the painter so the test drives it directly
const intervals: Function[] = [];
const _setInterval = globalThis.setInterval;
(globalThis as any).setInterval = (fn: Function, ms: number, ...a: any[]) => { intervals.push(fn); return _setInterval(() => {}, 1e9, ...a); };
// a controllable clock for the 1.5 s lit window
let nowMs = 10_000;
performance.now = () => nowMs;

const stub = await import('./emotebar-stub.mjs');
const { initEmoteBar, ringEmoteEntries } = await import('../client/lib/emotebar.js');
const { EMOTE_ORDER, myState, postureCalls, busLog, played, xrPanels, bus } = stub;

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = '') => {
  if (ok) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  else { fail++; console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? ` — ${detail}` : ''}`); }
};
const sleep = (ms: number) => new Promise((r) => _setInterval(r, ms));   // one-shot: never cleared, harmless
// the same column math the bar uses (a mirror, so the expectations are numbers not calls)
const TILE = 32, GAP = 6, PAD = 7, ROW_H = 32;
const widthFor = (c: number) => c * TILE + (c - 1) * GAP + PAD * 2 + 2;
const heightFor = (c: number, n = 9) => Math.ceil(n / c) * ROW_H + (Math.ceil(n / c) - 1) * GAP;

const f = initEmoteBar();
const paint = intervals.find((fn) => typeof fn === 'function')!;
const tile = (sel: string) => f.body.querySelector(sel) as HTMLButtonElement;
const tiles = () => [...f.body.querySelectorAll('.tile')] as HTMLButtonElement[];

console.log('EMOTEBAR — nine tiles, one row');
check('3 posture tiles + 6 emote tiles = 9', tiles().length === 9, `${tiles().length}`);
check('postures lead, in sit/stand/lie order', tiles().slice(0, 3).map((t) => t.dataset.posture).join() === 'sit,stand,lie');
check('emotes follow in EMOTE_ORDER with their number key', tiles().slice(3).every((t, i) => t.dataset.emote === EMOTE_ORDER[i] && t.title === `${EMOTE_ORDER[i]} — key ${i + 1}`));
// minW is widthFor(1), NOT widthFor(3). A real resize clamps at f.minW
// (frames.js:155), so a 124px floor made ONE column unreachable by drag however
// snapTo computed — R: "Emote bar still can't go 1x wide, 9x tall." The 3-column
// floor still applies on the WIDTH-ONLY path inside snapTo (see below); it just
// no longer blocks the frame itself.
check('default frame is 9×1: w=widthFor(9)=352, h=ROW_H, minW=widthFor(1) so 1 column is draggable', f.opts.w === 352 && f.opts.w === widthFor(9) && f.opts.h === ROW_H && f.opts.minW === widthFor(1), JSON.stringify(f.opts));
check('an XR panel registers with 3 postures + 6 emotes', xrPanels.length === 1 && xrPanels[0].fields().map((x: any) => x.k).join() === 'sit,stand,lie,' + EMOTE_ORDER.join());

console.log('EMOTEBAR — B2: a clamp that cannot help stands down (antra-tess #185)');
{
  // The rereview's symptom is a HEIGHT flip: [464,10,352,46] -> [616,10,48,350].
  // snapTo derives columns from width and rows follow, so the discriminator is the
  // row count, not the width — a width assertion passes either way because snapTo
  // has its own >=1-column floor downstream.
  //
  // roomFor() is a closure; its only consumer is f.show() ->
  //   snapTo(_placed ? w : Math.min(w, room)), room = roomFor()
  // so this drives that path. The stub's getBoundingClientRect returns zeros, so the
  // geometry is SUPPLIED. THREE rects are measured live in Chromium at 1280x720
  // on 2026-09-12:  #dock [0..42]  #micbtn [44..70]  #earbtn [76..102]
  //
  // The fourth is a DELIBERATE COUNTERFACTUAL, not a measurement, and calling all
  // four "measured" was wrong (agent review round 3). `.capnotice [930..1270] top 8`
  // is the card's PRE-B2 position: the same commit moved it to top:389 (>=1068),
  // top:64 (901-1067), top:102 (<=900), so at no shipped width does it satisfy this
  // band filter. It is put back in the row on purpose, to construct the historical
  // defect. The x-extent is real (right:10px at 1280); the y is not.
  // Likewise `mk('#dock', 0, 1141, ...)` further down is synthetic — no 1141px dock
  // exists; it is the cheapest way to manufacture room=123.
  const mk = (sel: string, l: number, r: number, t: number, b: number, ds?: Record<string, string>) => {
    const el = document.createElement('div');
    if (sel.startsWith('#')) el.id = sel.slice(1); else el.className = sel.slice(1);
    // chromeCost() reads the DECLARED anchor off the element; a fixture that omits it
    // falls back to 'right'. A card standing in for its STRETCHED state has to say so,
    // via the same attribute capnotice.js sets from the CSS breakpoint.
    if (ds) Object.assign(el.dataset, ds);
    (el as any).getBoundingClientRect = () => ({ left: l, right: r, top: t, bottom: b, width: r - l, height: b - t, x: l, y: t });
    document.body.append(el); return el;
  };
  const vw0 = innerWidth;
  (window as any).innerWidth = 1280;
  const made = [mk('#dock', 0, 42, 10, 304), mk('#micbtn', 44, 70, 18, 44), mk('#earbtn', 76, 102, 18, 44)];

  f._state.w = 352; f._state.h = ROW_H; (f as any)._placed = false; f.show();
  check('left-anchored chrome alone leaves the bar 9-across in ONE row',
    f._state.w === 352 && f._state.h === ROW_H, `w=${f._state.w} h=${f._state.h}`);

  // force the defect: a right-anchored element back inside the bar's y-band.
  // Raw room here is innerWidth - 8 - (1270 + 8) = -6. Flooring that to widthFor(1)
  // yields ONE column and h=336 — which IS the flip, not a repair of it.
  made.push(mk('.capnotice', 930, 1270, 8, 43));
  f._state.w = 352; f._state.h = ROW_H; (f as any)._placed = false; f.show();
  // NOT asserted here: that roomFor's Math.max(widthFor(1), room) floor produces
  // 48x336 at a destructive room. It is not separately observable — snapTo clamps
  // cols at Math.max(1, ...) regardless, so removing the floor leaves the suite
  // green. RECEIPT RETRACTED AND RE-RUN: this note previously said "leaves this
  // suite 35/0. Verified by mutation, not assumed." When that sentence was written
  // the suite had 33 assertions and the run returned 33/0; 35 was the count it
  // reached two commits later. The figure was written ahead of the run that would
  // have justified it and is now accidentally true, which is why it survived a
  // re-check. Measured at this head: floor removed -> 36/0, baseline -> 36/0.
  // The floor stays as defence in depth but earns no assertion, because an
  // assertion nothing can falsify is decoration. What IS bound is the narrow
  // window below, which no downstream clamp rescues.
  //
  // SAME STATUS, stated so it does not look tested: roomFor's
  // `if (!Number.isFinite(room)) return null` guard is also unbound. Removing it
  // leaves this suite 36/0 — measured, not assumed. It exists because the earlier
  // stand-down policy handled NaN by accident (`NaN >= n` is false) and flooring
  // does not (`Math.max(48, NaN)` is NaN, and snapTo would write NaN into
  // _state.w/h and paint it). `room` derives from innerWidth and
  // getBoundingClientRect edges, and no path I can construct makes either NaN, so
  // the guard is unreachable today and asserting it would be writing a test for a
  // state the product cannot enter.
  //
  // TWO MORE UNBOUND LINES, named rather than left looking tested (round 4):
  //   `g && g.width &&` in the obstacle loop — dropping the width guard leaves 36/0,
  //     because no fixture supplies a zero-width rect.
  //   any change to `clearRight` that only INCREASES consumption — e.g. +400 leaves
  //     36/0, because the narrow-room assertion is a `<=` bound and over-clamping
  //     satisfies it. Only under-clamping is caught.
  // Both measured at this head. They are cheap to bind and are not bound; a reader
  // should not infer coverage from this block's green.

  // THE WINDOW THE STAND-DOWN ABANDONED. Room 123 is too small for the 352px
  // default but large enough for a real bar; standing down left 352 and painted
  // 229px under #micbtn/#earbtn, whose z-index (45 both; #dock is 27, .capnotice
  // 60) beats any frame (Z_HI=25), so those tiles were unpressable. Clamping puts
  // every tile in clear space.
  document.body.innerHTML = '';
  const narrow = mk('#dock', 0, 1141, 10, 304);
  f._state.w = 352; f._state.h = ROW_H; (f as any)._placed = false; f.show();
  check('a narrow-but-usable room clamps the bar INTO it, never leaves it under chrome',
    f._state.w <= 123, `w=${f._state.w} vs room=123 — a wider bar paints under the chrome`);
  narrow.remove();
  for (const el of made) document.body.append(el);

  // THE BAND FILTER: only chrome that shares the bar's row may constrain it.
  //
  // `g.top < 60 && g.bottom > 8` asks whether an obstacle's vertical span overlaps the
  // bar's. A rail at top:389 cannot cover a bar at y:10, so it must not shrink it.
  //
  // Two things this fixture gets right that the previous one did not. It uses #dock,
  // which is LEFT-anchored and so genuinely consumes from the left — a right-anchored
  // obstacle contributes costL = 0 whether the filter keeps it or drops it, which is
  // why the old version passed with the filter deleted. And it runs at a viewport where
  // a REAL rail actually constrains a 352px bar: the clamp needs
  // vw - 16 - rail.right < 352, so a [0..304] rail binds only below vw = 672. At the
  // 1280 the previous block used, no realistic rail can bind, and the assertion would
  // have been asserting something false.
  document.body.innerHTML = '';
  (window as any).innerWidth = 640;
  const rail = mk('#dock', 0, 304, 389, 424, { edge: 'left' });
  f._state.w = 352; f._state.h = ROW_H; (f as any)._placed = false; f.show();
  check('chrome BELOW the bar row is ignored — a rail at top:389 takes no width',
    f._state.w === 352, `w=${f._state.w} — a band filter that does not filter would clamp to 320`);
  (rail as any).getBoundingClientRect = () => ({ left: 0, right: 304, top: 10, bottom: 42, width: 304, height: 32, x: 0, y: 10 });
  f._state.w = 352; f._state.h = ROW_H; (f as any)._placed = false; f.show();
  // Asserted as a CONTRACT, not a pinned pixel: the clamp yields room 640-16-304=320,
  // and snapTo then quantises to whole tiles, so the bar lands on widthFor(8)=314 rather
  // than 320. Pinning 314 would couple this check to TILE/GAP/PAD — the same brittleness
  // that made the old fixture wrong. The exact width rides in the failure message.
  check('...and the same rail INSIDE the row does consume it',
    f._state.w < 352 && f._state.w >= 48, `w=${f._state.w} — expected a snapped width under 352 (room here is 320)`);
  rail.remove();

  // THE CARD DOES NOT CONSTRAIN THE BAR. Inverted deliberately — this assertion used
  // to require the opposite ("a stretched .capnotice in the bar row DOES constrain it
  // — the list entry is live"), and it was right for the design it was written against.
  //
  // The owner's ordering rule (15:04) replaced that design: "Compute emote bar first
  // relative to the dock. capnotice lands under the emote bar (or just over it, tbh,
  // because you can dismiss it)." One direction. The bar sizes against the rail and its
  // glyphs; the card then places itself from the bar's settled rect. So `.capnotice` is
  // out of roomFor()'s obstacle list, and a stretched card in the bar's row must now
  // leave the bar at its full width.
  //
  // WHY THE OLD DESIGN HAD TO GO: the two measured each other. The card's top came from
  // every obstacle above it, the bar included; the bar's width came from every obstacle
  // in its band, the card included. It had no fixed point — the same probe measured the
  // card at 361 on one run and 95 on the next. And emotebar.js:99-104 had already
  // written down what would happen if the card entered the band: "room goes negative
  // (measured -6 ... reflowed the 9-across bar to a 48x350 column)". That shipped to a
  // phone on 2026-09-12: nine tiles in one 48px column down the right edge.
  //
  // This check is the guard against re-adding it: put `.capnotice` back in roomFor()'s
  // list and this goes red.
  document.body.innerHTML = '';
  (window as any).innerWidth = 390;
  const card = mk('.capnotice', 50, 382, 10, 45, { anchor: 'stretch' });
  f._state.w = 352; f._state.h = ROW_H; (f as any)._placed = false; f.show();
  check('a stretched .capnotice in the bar row leaves the bar alone — the card yields, not the bar',
    f._state.w === 352, `w=${f._state.w} — the card is back in roomFor()'s obstacle list; the cycle is back with it`);
  card.remove();

  // ANCHOR-AWARENESS IN roomFor(), bound by a RIGHT-DOCKED RAIL.
  //
  // Removing `.capnotice` from the obstacle list (cdca5c2) took the only right-anchored
  // obstacle out of this suite, and with it the only fixture that could tell
  // chromeCost() from the bare `g.right` arithmetic it replaced: the review found that
  // bypassing chromeCost here left the suite 39/0.
  //
  // The entry is NOT redundant — all three remaining selectors read `dataset.edge`,
  // which ui.js:499 rewrites whenever the rail is dragged, so any of them can become
  // right-anchored at runtime. What was missing was a fixture that does it. At 1280
  // with the rail at [1238..1280]:
  //     anchor-aware  {left:0, right:42}    -> room 1222   bar keeps 352
  //     bare g.right  {left:1280, right:0}  -> room  -16   bar floors to 48
  // which is the 48x350 single column the owner photographed on 2026-09-12, reached by
  // a second route.
  document.body.innerHTML = '';
  (window as any).innerWidth = 1280;
  const rightRail = mk('#dock', 1238, 1280, 10, 42, { edge: 'right' });
  f._state.w = 352; f._state.h = ROW_H; (f as any)._placed = false; f.show();
  check('a RIGHT-docked rail does not eat the bar from the left',
    f._state.w === 352, `w=${f._state.w} — charging its g.right to the left gives room -16 and floors the bar to one column`);
  rightRail.remove();
  (window as any).innerWidth = 1280;

  // ANCHOR-AWARENESS ITSELF, bound. The two fixtures above cannot see it: a LEFT-anchored
  // rail and a STRETCHED card both charge `g.right` to the left under either the old
  // arithmetic or the new one, so they agree by coincidence. Only a RIGHT-anchored
  // obstacle IN the bar's row separates them — and that is exactly antra-tess #185 B2:
  //   old (g.right as left-consumption): clearRight=1270, room=-6  -> bar floors to 48
  //   new (anchor-aware):                costL=0, costR=330, room=934 -> bar keeps 352
  document.body.innerHTML = '';
  const rightCard = mk('.capnotice', 950, 1270, 10, 45, { anchor: 'right' });
  f._state.w = 352; f._state.h = ROW_H; (f as any)._placed = false; f.show();
  check('a RIGHT-anchored card in the row does not eat the bar from the left',
    f._state.w === 352, `w=${f._state.w} — charging its g.right to the left gives room -6 and floors the bar to 48`);
  rightCard.remove();
  // Remove only what this block added. NOTE, corrected after round 4 measured it:
  // an earlier version of this comment claimed the `el !== f.el` guard prevents
  // orphaning the stub's frame element. It does not — `f.el` is ALREADY detached
  // here, orphaned by the `document.body.innerHTML = ''` calls earlier in this
  // block (instrumented: connected=true at init, false after the first one). The
  // guard is inert and the suite only passes because the stub holds `f.body` by
  // reference rather than reading the live document. Left in place as a cheap
  // correctness floor if the stub ever grows real geometry, but it is not the
  // protection the old comment advertised.
  for (const el of [...document.body.children]) if (!made.includes(el as any) && el !== f.el) el.remove();
  for (const el of made) if (!el.isConnected) document.body.append(el);

  // NEVER-WIDEN APPLIES TO A BAR THE OWNER PLACED — and only to that one.
  //
  // Round 4 bound this with `_placed = false`, and the rule it stated is right for the
  // case it had in mind: "a bar saved at 86px must not be inflated to fill 1162px of
  // clear space just because the chrome moved." But an UNPLACED bar never chose 86px.
  // Its width is a function of the room available, and a saved one is a derived value
  // that outlives the condition that produced it.
  //
  // Measured on a phone, 2026-09-12: while `.capnotice` was still in roomFor()'s list
  // it drove room negative, snapTo wrote w:48 to storage, and the bar opened as nine
  // tiles in a single 48px column down the right edge. Removing the card from that list
  // fixed room (272, correct) and the bar STILL opened at 48 — because
  // `Math.min(48, 272)` is 48. The stored value could never recover.
  //
  // The distinction already exists in the product: frames.js:193 marks a resize as
  // deliberate ("a resize is deliberate too"), so a dragged bar has `_placed = true`
  // and show() skips the clamp entirely (`f._placed ? null : roomFor()`). So this
  // fixture now asserts what it meant — a PLACED bar keeps its width — and the
  // unplaced case is asserted below it.
  document.body.innerHTML = '';
  mk('#dock', 0, 42, 10, 304);
  f._state.w = widthFor(2); f._state.h = heightFor(2); (f as any)._placed = true; f.show();
  check('a bar the owner PLACED is never widened to fill the room available',
    f._state.w === widthFor(2), `w=${f._state.w} — a deliberate 2-across was inflated`);
  f._state.w = widthFor(2); f._state.h = heightFor(2); (f as any)._placed = false; f.show();
  check('...but an UNPLACED bar re-derives, so a width a bug wrote can recover',
    f._state.w === widthFor(9), `w=${f._state.w} — min(saved, room) ratchets: the phone opened 9 tiles in a 48px column`);
  for (const el of [...document.body.children]) if (el !== f.el) el.remove();
  for (const el of made) if (!el.isConnected) document.body.append(el);

  // a hand-placed bar is never measured against chrome at all
  f._state.w = 352; f._state.h = ROW_H; (f as any)._placed = true; f.show();
  check('a hand-placed bar is exempt from the clamp with the obstacle present',
    f._state.w === 352 && f._state.h === ROW_H, `w=${f._state.w} h=${f._state.h}`);

  for (const el of made) el.remove();
  (window as any).innerWidth = vw0;
}

console.log('EMOTEBAR — snapTo / widthFor / heightFor');
f.opts.onResize(200); await sleep(230);
check('a 200px drag snaps to 5 columns: w=200, h=2 rows', f._state.w === widthFor(5) && f._state.h === heightFor(5) && f.paints > 0, `w=${f._state.w} h=${f._state.h}`);
f.opts.onResize(10); await sleep(230);
check('a 10px drag floors at ONE column, wrapping to 9 rows', f._state.w === widthFor(1) && f._state.h === heightFor(1), `w=${f._state.w} h=${f._state.h}`);
// VERTICAL. R, 2026-09-11: "can you also make it arrange vertically? I can't
// make it stack 1 wide 9 tall, for example." snapTo derived BOTH w and h from
// the column count, so the bar could only ever be as tall as its width implied.
// frames.js:427 already passes (state.w, state.h); this rider was discarding the
// second argument. The 1-column floor applies only when a height was asked for,
// so the width-only path below still clamps at 3.
// VERTICAL, BY WRAPPING. R, 2026-09-11: "1 wide 9 tall". Columns come from the
// dragged WIDTH and the rows follow — height is a consequence, never an input.
// An earlier version took rows from a dragged height and, because frames.js:427
// always passes one, the bar pinned itself at nine rows and refused to wrap:
// "forcibly go 9x down and not wrap to the buttons at all."
f.opts.onResize(48); await sleep(230);
check('a 1-column drag wraps to 9 rows (R: "1 wide 9 tall")',
  f._state.w === widthFor(1) && f._state.h === heightFor(1), `w=${f._state.w} h=${f._state.h}`);
f.opts.onResize(86); await sleep(230);
check('2 columns wrap to 5 rows', f._state.w === widthFor(2) && f._state.h === heightFor(2), `w=${f._state.w} h=${f._state.h}`);
f.opts.onResize(162); await sleep(230);
check('4 columns wrap to 3 rows — a narrow drag is never floored at nine',
  f._state.w === widthFor(4) && f._state.h === heightFor(4), `w=${f._state.w} h=${f._state.h}`);
f.opts.onResize(2000); await sleep(230);
check('never more columns than tiles: back to 9×1', f._state.w === 352 && f._state.h === 32, `w=${f._state.w} h=${f._state.h}`);
f.show();
check('show() refits the saved size (still 9×1)', f.visible && f._state.w === 352 && f._state.h === 32);
{ // the vocabulary arrives async — an empty list must not shrink a saved 9×1 bar to 3×3
  const saved = EMOTE_ORDER.splice(0);
  bus.emit('emotes-updated');
  check('empty EMOTE_ORDER rebuilds to the 3 posture tiles only', tiles().length === 3, `${tiles().length}`);
  check('…and does NOT snap the frame down (352×32 stays)', f._state.w === 352 && f._state.h === 32, `w=${f._state.w} h=${f._state.h}`);
  EMOTE_ORDER.push(...saved); bus.emit('emotes-updated');
  check('the hydrated list rebuilds nine tiles', tiles().length === 9); }

console.log('EMOTEBAR — posture tiles act on the body AND announce to VR');
postureCalls.length = 0; busLog.length = 0;
tile('[data-posture=sit]').onclick!(new Event('click'));
check('sit tile runs the controller seat search: sitHere()', postureCalls.length === 1 && postureCalls[0] === 'sitHere', JSON.stringify(postureCalls));
check('sit tile emits xr:sit', busLog.includes('xr:sit'), JSON.stringify(busLog));
postureCalls.length = 0; busLog.length = 0;
tile('[data-posture=stand]').onclick!(new Event('click'));
check('stand tile leaves seat and posture: standUp()', postureCalls.length === 1 && postureCalls[0] === 'standUp', JSON.stringify(postureCalls));
check('stand tile emits xr:stand', busLog.includes('xr:stand'), JSON.stringify(busLog));
postureCalls.length = 0; busLog.length = 0;
tile('[data-posture=lie]').onclick!(new Event('click'));
check('lie tile: setPosture("lie"), no xr event', postureCalls[0] === 'lie' && !busLog.some((t: string) => t.startsWith('xr:')), JSON.stringify({ postureCalls, busLog }));
postureCalls.length = 0;
xrPanels[0].dispatch('sit');
check('the XR quad\'s sit button takes the same path', postureCalls[0] === 'sitHere');
postureCalls.length = 0;
ringEmoteEntries().find((e: any) => e.label === 'stand')!.act();
check('the ring\'s stand entry takes the same path', postureCalls[0] === 'standUp');
myState.clip = 'sit'; paint();
check('the sit tile is lit while the body\'s clip is sit', tile('[data-posture=sit]').classList.contains('on') && !tile('[data-posture=stand]').classList.contains('on'));
myState.clip = null; paint();

console.log('EMOTEBAR — the fired tile stays lit ~1.5 s');
played.length = 0;
tile('[data-emote=wave]').onclick!(new Event('click'));
check('the tile plays the emote on my body and sets myState.emote', played[0] === 'wave' && myState.emote === 'wave');
check('the fired tile is lit', tile('[data-emote=wave]').classList.contains('on'));
myState.emote = null;   // net.js clears it on the first pose send
paint();
check('fired tile stays lit after net.js clears myState.emote (t+0)', tile('[data-emote=wave]').classList.contains('on'));
nowMs += 1400; paint();
check('still lit at t+1.4 s', tile('[data-emote=wave]').classList.contains('on'));
nowMs += 200; paint();
check('dark at t+1.6 s', !tile('[data-emote=wave]').classList.contains('on'));
check('no other tile was ever lit by it', tiles().every((t) => !t.classList.contains('on')));
myState.emote = 'clap'; paint();   // a number key set it elsewhere
check('a number-key emote (myState.emote) lights its tile', tile('[data-emote=clap]').classList.contains('on') && !tile('[data-emote=wave]').classList.contains('on'));
myState.emote = null; paint();

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
