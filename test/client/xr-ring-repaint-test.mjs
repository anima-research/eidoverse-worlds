// The VR ring redraws only what the mic's glyph can change. xrringpaint.js (the ring's repaint and its 'mic:indicator'
// subscription, as xr.js uses them) on the real bus, with slots that count each texture drawn and disposed.
// xr.js's call into it is wiring-check.ts's row; the ring in a headset is xr-ring-probe.mjs's (a browser probe, not gated).
// Then svgimage.js, which both the ring's slots and the VR mic icon draw through, and xrmicicon.js itself on a stubbed
// camera and canvas: a glyph that loads after a later paint has taken the disc is not drawn over it.
// Run: BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun test/client/xr-ring-repaint-test.mjs
import { fileURLToPath } from "node:url";
import { mock } from "bun:test";
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
  // it fails to load (a malformed SVG): the console is told, once however many fail in the minute (base.js warnRarely)
  const told = [], realWarn = console.warn;
  console.warn = (...a) => { if (/^\[svgimage\]/.test(String(a[0]))) told.push(String(a[0])); else realWarn(...a); };
  let errThrew = '';
  try { made[1].onerror(new Event('error')); } catch (e) { errThrew = String(e); }
  check('a glyph that fails to load: the console is told, with the start of the SVG that failed, and nothing is drawn',
    !errThrew && told.length === 1 && told[0].includes(B.slice(0, 40)) && draws.length === 2, JSON.stringify({ errThrew, told, draws: draws.length }));
  svgImage(B, (img) => draws.push(['retry', img]));
  check('...and it is not kept: the next asking makes a new Image, and draws when that one loads',
    made.length === 3 && draws.length === 2 && (made[2].onload(), draws.length === 3 && draws[2][0] === 'retry'), JSON.stringify({ made: made.length, draws: draws.length }));
  const C = '<svg xmlns="http://www.w3.org/2000/svg"><path d="M2 2"/></svg>';
  svgImage(C, () => draws.push(['never']));
  try { made[3].onerror(new Event('error')); } catch (e) { errThrew = String(e); }
  check('a second failure inside the minute is not told again (a glyph asked for at frame rate cannot flood the console)',
    !errThrew && told.length === 1 && draws.length === 3, JSON.stringify({ errThrew, told: told.length, draws: draws.length }));
  console.warn = realWarn;

  // The VR mic icon (xrmicicon.js) on this same Image: each paint clears the disc and asks for its glyph, and a glyph
  // never drawn before arrives after the turn. A first-ever press asks for gold; released before gold has loaded, the
  // plain glyph (drawn before, so kept) is on the disc at once. Gold then loads: the disc belongs to the later paint.
  const PLAIN = '<svg xmlns="http://www.w3.org/2000/svg"><path d="M3 3"/></svg>', GOLD = '<svg xmlns="http://www.w3.org/2000/svg" style="filter:drop-shadow(0 0 2px gold)"><path d="M3 3"/></svg>';
  let ind = { state: 'on', svg: () => PLAIN };
  const disc = [];   // what the icon's canvas is drawn: 'clear' at the start of each paint, then the glyph's Image
  const g = { clearRect() { disc.push('clear'); }, beginPath() {}, arc() {}, fill() {}, drawImage(img) { disc.push(img); } };
  const realDoc = globalThis.document, realGcs = globalThis.getComputedStyle;
  globalThis.document = { documentElement: {}, createElement: () => ({ getContext: () => g }) };
  globalThis.getComputedStyle = () => ({ getPropertyValue: () => '' });
  class Obj { constructor() { this.position = { set() {} }; this.scale = { setScalar() {} }; } add() {} removeFromParent() {} }
  mock.module(lib("core.js"), () => ({ THREE: { CanvasTexture: class {}, SRGBColorSpace: 'srgb', PlaneGeometry: class {},
    MeshBasicMaterial: class { constructor(o) { Object.assign(this, o); } }, Mesh: class extends Obj { constructor(geo, m) { super(); this.material = m; } } },
    camera: new Obj(), renderer: {} }));
  mock.module(lib("xr/quadcolour.js"), () => ({ quadMaterial() {} }));
  mock.module(lib("audio/mictoggle.js"), () => ({ micIndicator: () => ind }));
  await import(lib("xr/xrmicicon.js"));
  const uri = (svg) => 'data:image/svg+xml;utf8,' + encodeURIComponent(svg);
  const n0 = made.length;
  bus.emit('xr:state', true);   // in VR, mic on and quiet: the plain glyph, for the first time
  made[n0]?.onload();
  const plainImg = made[n0];
  check('setup: the icon shown with the mic on asks for the plain glyph, and draws it when it loads',
    made.length === n0 + 1 && plainImg.asked === uri(PLAIN) && disc.at(-1) === plainImg, JSON.stringify({ made: made.length - n0, disc: disc.length }));
  ind = { state: 'hot', svg: () => GOLD }; bus.emit('mic:indicator', 'hot');   // the first-ever press: gold is asked for, not yet loaded
  const goldImg = made[n0 + 1];
  check('setup: the first press clears the disc and asks for the gold glyph, which has not loaded',
    made.length === n0 + 2 && goldImg?.asked === uri(GOLD) && disc.at(-1) === 'clear', JSON.stringify({ made: made.length - n0, last: disc.at(-1) === 'clear' }));
  ind = { state: 'on', svg: () => PLAIN }; bus.emit('mic:indicator', 'on');    // released in the same frame
  check('setup: the release draws the plain glyph in its turn (it was drawn before), with no new Image',
    made.length === n0 + 2 && disc.at(-1) === plainImg && disc.at(-2) === 'clear', JSON.stringify({ made: made.length - n0 }));
  goldImg.onload();   // gold loads now, after the mic has closed
  check('a gold glyph that loads after the release is not drawn over the closed mic: the disc keeps the plain glyph',
    disc.at(-1) === plainImg && !disc.includes(goldImg), JSON.stringify({ lastIsPlain: disc.at(-1) === plainImg, goldDrawn: disc.includes(goldImg) }));
  ind = { state: 'hot', svg: () => GOLD }; bus.emit('mic:indicator', 'hot');   // the next press
  check('...and that load was kept: the next press draws gold in its turn',
    made.length === n0 + 2 && disc.at(-1) === goldImg && disc.at(-2) === 'clear', JSON.stringify({ made: made.length - n0, goldLast: disc.at(-1) === goldImg }));
  bus.emit('xr:state', false);
  globalThis.document = realDoc; globalThis.getComputedStyle = realGcs;
  globalThis.Image = realImage; }
done();
