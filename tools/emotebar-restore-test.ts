// emote bar × the REAL frames.js: a bar the viewport auto-restores (no show()) is laid out exactly as show() lays it out.
// frames' own resize fit() already steps it clear of the glyphs either way; what the bar's onShow adds is snapTo's
// rows for the narrowed width. Without it the restored bar was two columns wide and ONE row tall (nine tiles in a
// one-row frame) until the 180 ms onResize snap caught up — watched red as `908,108,32` vs show()'s `908,108,184`.
// emotebar-test drives the bar against a stub frame; this file exists because only the real frames.js has the
// viewport rule. Every other neighbour is still tools/emotebar-stub.mjs.
//
//   BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun tools/emotebar-restore-test.ts
import { plugin } from 'bun';
const here = (f: string) => new URL(f, import.meta.url).pathname;
plugin({
  name: 'emotebar-restore-stubs',
  setup(b) {
    for (const m of ['avatar', 'emotedefs', 'controller', 'mybody', 'xrpanels', 'base']) {
      b.onResolve({ filter: new RegExp(`^\\./${m}\\.js$`) }, () => ({ path: here('./emotebar-stub.mjs') }));
    }
  },
});
import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register({ width: 1024, height: 768 });
HTMLCanvasElement.prototype.getContext = function () {
  return { fillText() {}, getImageData: () => ({ data: new Uint8ClampedArray(24 * 24 * 4).fill(200) }) } as any;
};

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = '') => {
  if (ok) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  else { fail++; console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? ` — ${detail}` : ''}`); }
};
const TILE = 32, GAP = 6, PAD = 7;
const widthFor = (c: number) => c * TILE + (c - 1) * GAP + PAD * 2 + 2;

await import('../client/lib/frames.js');   // stamps the layout version first, so the save below is not purged
// last session the viewport auto-hid the bar (never placed by hand); it comes back when the window is wide enough
localStorage.setItem('ew-frame-emotes', JSON.stringify({ x: 336, y: 10, w: widthFor(9), h: 32, hidden: true, autoHidden: true }));
const { initEmoteBar } = await import('../client/lib/emotebar.js');
const f: any = initEmoteBar();

// happy-dom measures nothing: the bar reports its real height, and the dock has laid out (frames' chrome pass
// waits for that). A left-anchored glyph spans the bar's band, 900 px of it, leaving 1024 - 8 - 908 = 108.
Object.defineProperty(f.el, 'offsetHeight', { get: () => f._state.h + 14, configurable: true });
const dock = document.createElement('div'); dock.id = 'dock';
const dockBtn = document.createElement('button'); dockBtn.dataset.toggles = 'x'; dock.append(dockBtn); document.body.append(dock);
const mic = document.createElement('div'); mic.id = 'micbtn'; document.body.append(mic);
mic.getBoundingClientRect = () => ({ left: 0, right: 900, top: 10, bottom: 40, width: 900, height: 30, x: 0, y: 10, toJSON() { return this; } }) as any;

console.log('EMOTEBAR — a viewport restore clears the chrome, like show() does');
check('setup: the bar comes up auto-hidden, nine across', !f.visible && f._state.w === widthFor(9), JSON.stringify(f._state));
window.dispatchEvent(new Event('resize'));
check('setup: the viewport restores it without show()', f.visible === true);
const restored = [f._state.x, f._state.w, f._state.h];
check('restored: an unplaced bar steps clear of the glyph, not 352 wide underneath it',
  f._state.x >= 908 && f._state.x + f._state.w <= innerWidth - 8, `x=${f._state.x} w=${f._state.w}`);
f.hide(); f.show();
const shown = [f._state.x, f._state.w, f._state.h];
check('…exactly as show() lays it out, rows included (x, w, h)', restored.join() === shown.join(), `restore ${restored} vs show ${shown}`);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
