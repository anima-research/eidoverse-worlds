// frames — the resize drag's finish path, run headless.
//
//   bun tools/frames-resize-test.ts
//
// The regression this exists for: the document-level resize drag tore down
// only on `pointerup`. Release the button outside the browser and `up` never
// arrives — `_resizing` stays true, the move/up listeners stay installed, and
// every future hover and resize is dead until the page reloads. There is no
// error and nothing looks broken; the frame just quietly stops resizing.
//
// So the assertion is not "does resizing work" (it visibly does) but "does it
// still work AFTER a drag that ended the wrong way", which is exactly the
// case a happy-path test cannot see.

import { plugin } from "bun";
const here = (f: string) => new URL(f, import.meta.url).pathname;
plugin({
  name: "frames-stubs",
  setup(b) {
    b.onResolve({ filter: /^\.\/core\.js$/ }, () => ({ path: here("./chat-core-stub.mjs") }));
  },
});

import { GlobalRegistrator } from "@happy-dom/global-registrator";
GlobalRegistrator.register();

// happy-dom has no pointer capture. Model it on ELEMENTS only — deliberately
// NOT on `document`, because stubbing document.releasePointerCapture is what
// masked the original bug: capture was taken on documentElement and released
// on document, which owns nothing, so the release was a silent no-op and the
// test still passed. The stub now tracks who holds what, so the assertions
// below can check that the acquirer is the releaser.
const _captured = new Set<number>();
(Element.prototype as any).setPointerCapture = function (id: number) { _captured.add(id); (this as any).__cap = id; };
(Element.prototype as any).releasePointerCapture = function (id: number) { _captured.delete(id); (this as any).__cap = undefined; };
(Element.prototype as any).hasPointerCapture = function (id: number) { return (this as any).__cap === id; };

const { makeFrame } = await import("../client/lib/frames.js");

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  else { fail++; console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? ` — ${detail}` : ""}`); }
};

const f = makeFrame("t", { title: "t", x: 100, y: 100, w: 300, h: 200, minW: 100, minH: 80 });
f.show();

// happy-dom returns an all-zero DOMRect, and the module's zone math is entirely
// getBoundingClientRect-based — so without this the pointer never lands in any
// zone and even the happy path silently fails. Report the frame's real state
// instead. (First run of this test failed its own baseline for exactly that
// reason, which is the honest way to find out your harness cannot see.)
(f.el as any).getBoundingClientRect = () => ({
  left: f.state.x, top: f.state.y, width: f.state.w, height: f.state.h,
  right: f.state.x + f.state.w, bottom: f.state.y + f.state.h, x: f.state.x, y: f.state.y,
  toJSON() { return this; },
});
// nothing interactive is under the pointer in these synthetic drags
(document as any).elementFromPoint = () => null;

// CHROME. state.h is the BODY's height; the rendered frame is taller by the
// title bar plus .fr-body's 5px top/bottom padding. Without an offsetHeight
// this suite reports chrome = 0, which makes the south clamp's viewport budget
// look exact and any assertion about it vacuous — the blindness that hid a 6px
// overflow through five review rounds. (round 6)
const CHROME = 30;
Object.defineProperty(f.el, "offsetHeight", { get: () => f.state.h + CHROME, configurable: true });

const pd = (x: number, y: number) => new PointerEvent("pointerdown",
  { clientX: x, clientY: y, button: 0, bubbles: true, pointerId: 1 });
const pm = (x: number, y: number) => new PointerEvent("pointermove",
  { clientX: x, clientY: y, bubbles: true, pointerId: 1 });

// the east edge of the frame as painted
const edgeX = () => f.state.x + f.state.w - 1;    // just inside the east band
const edgeY = () => f.state.y + 40;

function dragEast(by: number, endWith: "up" | "nothing" | "cancel" | "blur") {
  const w0 = f.state.w;
  document.dispatchEvent(pd(edgeX(), edgeY()));
  document.dispatchEvent(pm(edgeX() + by, edgeY()));
  if (endWith === "up") document.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 1 }));
  if (endWith === "cancel") document.dispatchEvent(new PointerEvent("pointercancel", { bubbles: true, pointerId: 1 }));
  if (endWith === "blur") window.dispatchEvent(new Event("blur"));
  return f.state.w - w0;
}

// --- baseline: a normal drag resizes
check("a normal drag resizes the frame", dragEast(60, "up") !== 0,
  `w now ${f.state.w}`);

// --- the regression: a drag that ends without pointerup must not wedge state
const abandoned = dragEast(40, "nothing");     // pointer left the window, no up
check("an abandoned drag still moved the edge", abandoned !== 0, String(abandoned));
// nothing cleaned it up yet — now the recovery paths
window.dispatchEvent(new Event("blur"));
const after = dragEast(50, "up");
check("a NEW drag works after one ended without pointerup", after !== 0,
  `delta ${after} — if 0, _resizing is wedged`);

// --- pointercancel is a full citizen
dragEast(30, "cancel");
const afterCancel = dragEast(30, "up");
check("a new drag works after pointercancel", afterCancel !== 0, String(afterCancel));

// --- blur alone finishes
dragEast(30, "blur");
const afterBlur = dragEast(30, "up");
check("a new drag works after window blur", afterBlur !== 0, String(afterBlur));

// --- the finish is idempotent: several endings at once must not throw
let threw = false;
try {
  document.dispatchEvent(pd(edgeX(), edgeY()));
  document.dispatchEvent(pm(edgeX() + 20, edgeY()));
  document.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 1 }));
  document.dispatchEvent(new PointerEvent("pointercancel", { bubbles: true, pointerId: 1 }));
  window.dispatchEvent(new Event("blur"));
} catch { threw = true; }
check("overlapping finish paths do not throw", !threw);
check("...and the frame still resizes afterward", dragEast(25, "up") !== 0);

// --- capture is released by the element that took it (review catch: releasing
// on `document` was a no-op, so a blur could leave the capture live forever)
_captured.clear();
document.dispatchEvent(pd(edgeX(), edgeY()));
document.dispatchEvent(pm(edgeX() + 20, edgeY()));
check("a drag acquires pointer capture", _captured.size === 1, `${_captured.size} held`);
window.dispatchEvent(new Event("blur"));
check("...and blur releases it on the acquiring element", _captured.size === 0,
  `${_captured.size} still held — capture leaked`);
check("...leaving documentElement holding nothing",
  !(document.documentElement as any).hasPointerCapture(1));

_captured.clear();
dragEast(20, "cancel");
check("pointercancel also releases the capture", _captured.size === 0, `${_captured.size} held`);

// --- corners are a real target (antra's live receipt: the corner used to be
// the intersection of two 2px bands — geometrically present, practically
// absent). 8px in from the corner point sits INSIDE the 15px corner square
// but OUTSIDE the 4px edge bands, so a diagonal here proves the corner rule
// specifically, not a lucky band overlap.
function dragFrom(px: number, py: number, dx: number, dy: number) {
  const w0 = f.state.w, h0 = f.state.h;
  document.dispatchEvent(pd(px, py));
  document.dispatchEvent(pm(px + dx, py + dy));
  document.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 1 }));
  return { dw: f.state.w - w0, dh: f.state.h - h0 };
}
const L = () => f.state.x, T = () => f.state.y,
      Rt = () => f.state.x + f.state.w, B = () => f.state.y + f.state.h;
{
  const se = dragFrom(Rt() - 8, B() - 8, 30, 30);
  check("SE corner (8px inside) resizes BOTH dimensions", se.dw > 0 && se.dh > 0, JSON.stringify(se));
  const ne = dragFrom(Rt() - 8, T() + 8, 25, -25);
  check("NE corner grows width and height together", ne.dw > 0 && ne.dh > 0, JSON.stringify(ne));
  const sw = dragFrom(L() + 8, B() - 8, -25, 25);
  check("SW corner grows width and height together", sw.dw > 0 && sw.dh > 0, JSON.stringify(sw));
  const nw = dragFrom(L() + 8, T() + 8, -20, -20);
  check("NW corner grows width and height together", nw.dw > 0 && nw.dh > 0, JSON.stringify(nw));
}
// ...and every plain edge still resizes exactly ONE dimension (midpoints are
// far from any corner square, so the corner rule must not have eaten them)
{
  const e_ = dragFrom(Rt() - 1, T() + f.state.h / 2, 20, 0);
  check("E edge still resizes width only", e_.dw > 0 && e_.dh === 0, JSON.stringify(e_));
  const w_ = dragFrom(L() + 1, T() + f.state.h / 2, -20, 0);
  check("W edge still resizes width only", w_.dw > 0 && w_.dh === 0, JSON.stringify(w_));
  const s_ = dragFrom(L() + f.state.w / 2, B() - 1, 0, 20);
  check("S edge still resizes height only", s_.dh > 0 && s_.dw === 0, JSON.stringify(s_));
  const n_ = dragFrom(L() + f.state.w / 2, T() + 1, 0, -20);
  check("N edge still resizes height only", n_.dh > 0 && n_.dw === 0, JSON.stringify(n_));
}

// --- minimums still hold (the clamp survived the refactor)
const tiny = dragEast(-9999, "up");
check("width clamps at minW", f.state.w >= 100, `w=${f.state.w} (delta ${tiny})`);

// --- the south clamp budgets in BODY space, subtracts a VIEWPORT margin ---
{ // frames.js:144 clamps state.h to `innerHeight - s0.y - 4`, then the frame
  // renders `chrome` px taller — so a resize to the legal maximum ends past the
  // bottom edge, unreachable under html,body{overflow:hidden}. fit() does not
  // share the bug (it clamps against root.offsetHeight), but the resize
  // finish() path never calls fit, so it persists until the next window resize.
  f.state.x = 100; f.state.y = 100; f.state.w = 300; f.state.h = 200;
  const sx = f.state.x + 40, sy = () => f.state.y + f.state.h - 1;   // inside the south band
  document.dispatchEvent(pd(sx, sy()));
  document.dispatchEvent(pm(sx, innerHeight + 500));                 // drag far past the bottom
  document.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 1 }));
  const bottom = f.state.y + (f.el as any).offsetHeight;
  check("a south resize to the limit leaves the RENDERED frame inside the viewport",
    bottom <= innerHeight - 4,
    `rendered bottom=${bottom} viewport=${innerHeight} state.h=${f.state.h} chrome=${CHROME}`);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
