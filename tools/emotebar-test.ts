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
// (frames.js:141), so a 124px floor made ONE column unreachable by drag however
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
  const mk = (sel: string, l: number, r: number, t: number, b: number) => {
    const el = document.createElement('div');
    if (sel.startsWith('#')) el.id = sel.slice(1); else el.className = sel.slice(1);
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
  // re-check. Measured at this head: floor removed -> 35/0, baseline -> 35/0.
  // The floor stays as defence in depth but earns no assertion, because an
  // assertion nothing can falsify is decoration. What IS bound is the narrow
  // window below, which no downstream clamp rescues.
  //
  // SAME STATUS, stated so it does not look tested: roomFor's
  // `if (!Number.isFinite(room)) return null` guard is also unbound. Removing it
  // leaves this suite 35/0 — measured, not assumed. It exists because the earlier
  // stand-down policy handled NaN by accident (`NaN >= n` is false) and flooring
  // does not (`Math.max(48, NaN)` is NaN, and snapTo would write NaN into
  // _state.w/h and paint it). `room` derives from innerWidth and
  // getBoundingClientRect edges, and no path I can construct makes either NaN, so
  // the guard is unreachable today and asserting it would be writing a test for a
  // state the product cannot enter.
  //
  // TWO MORE UNBOUND LINES, named rather than left looking tested (round 4):
  //   `g && g.width &&` in the obstacle loop — dropping the width guard leaves 35/0,
  //     because no fixture supplies a zero-width rect.
  //   any change to `clearRight` that only INCREASES consumption — e.g. +400 leaves
  //     35/0, because the narrow-room assertion is a `<=` bound and over-clamping
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

  // THE BAND FILTER, bound. Round-3 review: deleting `g.top < 60 && g.bottom > 8`
  // left this suite green, because every fixture rect happened to satisfy it. An
  // obstacle BELOW the bar's row must not consume its width — that is the whole
  // reason .capnotice is inert at every shipped width today (top:389).
  document.body.innerHTML = '';
  mk('#dock', 0, 42, 10, 304);
  const below = mk('.capnotice', 930, 1270, 389, 424);   // the REAL shipped position
  f._state.w = 352; f._state.h = ROW_H; (f as any)._placed = false; f.show();
  check('an obstacle below the bar row is ignored — the card at its shipped top:389 takes no width',
    f._state.w === 352, `w=${f._state.w} — a band filter that does not filter would clamp to ~922`);
  // ...and the SAME element inside the row does consume it: the entry is live, not dead code
  (below as any).getBoundingClientRect = () => ({ left: 930, right: 1270, top: 8, bottom: 43, width: 340, height: 35, x: 930, y: 8 });
  f._state.w = 352; f._state.h = ROW_H; (f as any)._placed = false; f.show();
  check('...and the same card raised into the row DOES consume it — the list entry is live',
    f._state.w < 352, `w=${f._state.w} — if .capnotice were dropped from the list this stays 352`);
  below.remove();
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

  // THE NEVER-WIDEN HALF, bound. Round-4 review: replacing `Math.min(f._state.w,
  // room)` at the show() call site with bare `room` left this suite 35/0, because
  // no fixture presented a room WIDER than the saved width. The clamp must only
  // ever narrow: a bar saved at 86px must not be inflated to fill 1162px of clear
  // space just because the chrome moved.
  document.body.innerHTML = '';
  mk('#dock', 0, 42, 10, 304);
  f._state.w = widthFor(2); f._state.h = heightFor(2); (f as any)._placed = false; f.show();
  check('a saved narrow bar is never WIDENED to fill the room available',
    f._state.w === widthFor(2), `w=${f._state.w} — bare room would give widthFor(9)=352`);
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
