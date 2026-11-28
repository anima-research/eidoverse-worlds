// The VR ring redraws only what the mic's glyph can change. xrringpaint.js (the ring's repaint and its 'mic:indicator'
// subscription, as xr.js uses them) on the real bus, with slots that count each texture drawn and disposed.
// xr.js's call into it is wiring-check.ts's row; the ring in a headset is xr-ring-probe.mjs's (a browser probe, not gated).
// Run: BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun test/client/xr-ring-repaint-test.mjs
import { fileURLToPath } from "node:url";
import { suite } from "../gate/suite.ts";
const lib = (p) => fileURLToPath(new URL(`../../client/lib/${p}`, import.meta.url));
const { bus } = await import(lib("base.js"));
const { repaintSlots, followMicIndicator, liveGlyph } = await import(lib("xr/xrringpaint.js"));
const { check, done } = suite("xr-ring-repaint");

let drawn = [], disposed = [];
const texture = (e, focused) => { drawn.push(e.label); return { label: e.label, focused, dispose() { disposed.push(e.label); } }; };
const ringOf = (entries, sel = -1) => ({ entries, sel, slots: entries.map((e) => ({ material: { map: texture(e, false), needsUpdate: false } })) });
// the root wheel's shapes (xr.js radialEntries): static art as a string or an icon name, live glyphs as functions
const root = () => [{ svg: '<svg/>', label: 'panels' }, { icon: 'hand-waving', label: 'actions' }, { svg: '<svg/>', label: 'leave VR' },
  { svg: '<svg/>', label: 'recentre' }, { svg: () => '<svg ear/>', label: 'headphones' }, { svg: () => '<svg mic/>', label: 'mic' }];
const actions = () => [{ icon: 'wave', label: 'wave' }, { svg: '<svg/>', label: 'back' }, { icon: 'sit', label: 'sit' }, { spacer: true, label: '' }];

let open = null;
const off = followMicIndicator(bus, () => open, texture);

open = ringOf(root(), 5); drawn = []; disposed = [];
bus.emit('mic:indicator', 'hot');
check('the mic glyph changes with the root wheel open: only the live-glyph slots are redrawn (mic, headphones), each old texture disposed once',
  drawn.sort().join() === 'headphones,mic' && disposed.sort().join() === 'headphones,mic', JSON.stringify({ drawn, disposed }));
check('...and the mic slot is redrawn focused when it is the selection, with its material marked for upload',
  open.slots[5].material.map.focused === true && open.slots[5].material.needsUpdate === true && open.slots[0].material.needsUpdate === false);

open = ringOf(actions()); drawn = []; disposed = [];
bus.emit('mic:indicator', 'on'); bus.emit('mic:indicator', 'hot');
check('the actions wheel has no live glyph: two changes of the mic glyph draw and dispose nothing', drawn.length === 0 && disposed.length === 0, JSON.stringify({ drawn, disposed }));

open = null; drawn = [];
let threw = '';
try { bus.emit('mic:indicator', 'muted'); } catch (e) { threw = String(e); }
check('the ring closed: nothing is drawn, and nothing throws', drawn.length === 0 && !threw, threw);

// a selection or an act still redraws the whole wheel (xr.js repaintRing)
open = ringOf(root(), 0); drawn = [];
repaintSlots(open, texture);
check('a full repaint (a selection, an act) still redraws every slot', drawn.length === 6, drawn.join());
open = ringOf(actions()); drawn = []; disposed = [];
repaintSlots(open, texture);
check('...on a wheel with no live glyph too: all four drawn, all four old textures disposed', drawn.length === 4 && disposed.length === 4, JSON.stringify({ drawn, disposed }));
check('liveGlyph: a function svg is live; a string svg, an icon and a spacer are not',
  liveGlyph({ svg: () => '' }) && !liveGlyph({ svg: '<svg/>' }) && !liveGlyph({ icon: 'x' }) && !liveGlyph({ spacer: true }) && !liveGlyph(undefined));
off();

// the slots' art (and the VR mic icon's) goes through svgimage.js: an Image loads after the turn that set its src, so a
// glyph is kept once loaded and drawn in the turn from then on. An Image here loads when the row says so.
{ const made = [];
  const realImage = globalThis.Image;
  globalThis.Image = class { constructor() { made.push(this); } set src(v) { this.asked = v; } };
  const { svgImage } = await import(lib("xr/svgimage.js"));
  const draws = [];
  const A = '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0"/></svg>', B = '<svg xmlns="http://www.w3.org/2000/svg"><path d="M1 1"/></svg>';
  const first = svgImage(A, (img) => draws.push(['first', img]));
  check('a glyph asked for the first time: an Image is made with the SVG as its data URI, and nothing is drawn before it loads',
    first === false && made.length === 1 && made[0].asked === 'data:image/svg+xml;utf8,' + encodeURIComponent(A) && draws.length === 0, JSON.stringify({ first, made: made.length, draws: draws.length }));
  made[0].onload();
  check('...it loads: drawn once, with that Image', draws.length === 1 && draws[0][1] === made[0], String(draws.length));
  const again = svgImage(A, (img) => draws.push(['again', img]));
  check('the same glyph asked for again: drawn in the turn, with the kept Image, and no new Image is made',
    again === true && draws.length === 2 && draws[1][0] === 'again' && draws[1][1] === made[0] && made.length === 1, JSON.stringify({ again, made: made.length, draws: draws.length }));
  svgImage(B, (img) => draws.push(['other', img]));
  check('another glyph is its own Image, not drawn until it loads', made.length === 2 && draws.length === 2, JSON.stringify({ made: made.length, draws: draws.length }));
  made[1].onerror?.();   // it fails to load
  svgImage(B, (img) => draws.push(['retry', img]));
  check('a glyph that failed to load is not kept: the next asking makes a new Image, and draws when that one loads',
    made.length === 3 && draws.length === 2 && (made[2].onload(), draws.length === 3 && draws[2][0] === 'retry'), JSON.stringify({ made: made.length, draws: draws.length }));
  globalThis.Image = realImage; }
done();
