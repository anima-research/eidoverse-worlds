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
