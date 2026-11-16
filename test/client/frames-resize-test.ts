// frames: the resize drag's finish path, headless (`bun test/client/frames-resize-test.ts`).
// A drag released outside the browser never gets `pointerup`; teardown on that alone leaves `_resizing` true and the
// listeners installed (no hover cursor, and the old drag keeps following the pointer). So: does it still work AFTER a drag that ended the wrong way?

import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { suite } from "../gate/suite.ts";
GlobalRegistrator.register();

// happy-dom has no pointer capture: modelled on ELEMENTS only, never `document`, tracking who holds what so the
// acquirer can be checked as the releaser
const _captured = new Set<number>();
(Element.prototype as any).setPointerCapture = function (id: number) { _captured.add(id); (this as any).__cap = id; };
(Element.prototype as any).releasePointerCapture = function (id: number) { _captured.delete(id); (this as any).__cap = undefined; };
(Element.prototype as any).hasPointerCapture = function (id: number) { return (this as any).__cap === id; };

const { makeFrame } = await import("../../client/lib/ui/windows.js");

const S = suite("frames-resize");
const check = (name: string, ok: unknown, detail?: unknown) => S.check(name, ok, detail);

const f = makeFrame("t", { title: "t", x: 100, y: 100, w: 300, h: 200, minW: 100, minH: 80 });
f.show();

// happy-dom's DOMRect is all zero and the zone math uses getBoundingClientRect: report the frame's real state
(f.el as any).getBoundingClientRect = () => ({
  left: f.state.x, top: f.state.y, width: f.state.w, height: f.state.h,
  right: f.state.x + f.state.w, bottom: f.state.y + f.state.h, x: f.state.x, y: f.state.y,
  toJSON() { return this; },
});
// nothing interactive is under the pointer in these synthetic drags
(document as any).elementFromPoint = () => null;

// CHROME: state.h is the BODY's height; the frame is taller by the title bar and .fr-body padding (without an
// offsetHeight chrome reads 0 and the south clamp's budget looks exact)
const CHROME = 30;
Object.defineProperty(f.el, "offsetHeight", { get: () => f.state.h + CHROME, configurable: true });

const pd = (x: number, y: number) => new PointerEvent("pointerdown",
  { clientX: x, clientY: y, button: 0, bubbles: true, pointerId: 1 });
const pm = (x: number, y: number) => new PointerEvent("pointermove",
  { clientX: x, clientY: y, bubbles: true, pointerId: 1 });

const edgeX = () => f.state.x + f.state.w - 1;  // just inside the east band
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

// a bare move after a drag ended: a drag still live would follow it
function strayMove() {
  const w0 = f.state.w;
  document.dispatchEvent(pm(edgeX() + 35, edgeY()));
  return f.state.w - w0;
}

// --- baseline: a normal drag resizes
check("a normal drag resizes the frame", dragEast(60, "up") !== 0,
  `w now ${f.state.w}`);

// --- the regression: a drag that ends without pointerup must not wedge state
const abandoned = dragEast(40, "nothing");  // pointer left the window, no up
check("an abandoned drag still moved the edge", abandoned !== 0, String(abandoned));
// nothing cleaned it up yet — now the recovery paths
window.dispatchEvent(new Event("blur"));
check("...and the blur ended it: a stray move does not resize", strayMove() === 0, `w ${f.state.w}`);
const after = dragEast(50, "up");
check("a NEW drag works after one ended without pointerup", after !== 0,
  `delta ${after} — if 0, _resizing is wedged`);

// --- pointercancel is a full citizen
dragEast(30, "cancel");
check("pointercancel ends the drag: a stray move does not resize", strayMove() === 0, `w ${f.state.w}`);
const afterCancel = dragEast(30, "up");
check("a new drag works after pointercancel", afterCancel !== 0, String(afterCancel));

// --- blur alone finishes
dragEast(30, "blur");
check("blur ends the drag: a stray move does not resize", strayMove() === 0, `w ${f.state.w}`);
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

// --- capture is released by the element that took it (releasing on `document` is a no-op; a blur would leave it live)
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

// every edge and corner, its floor and its viewport margin: a table in frames-layout-test.ts

// the frame publishes its own floor: index.html's `.frame { min-width: 170px }` won for any smaller JS minW, flooring the RENDER
{ const narrow = makeFrame("floor", { title: "floor", x: 10, y: 10, w: 48, h: 32, minW: 48, minH: 32 });
  narrow.show();
  check("a frame publishes its OWN minW to the DOM, not the sheet's blanket 170",
    (narrow.el as HTMLElement).style.minWidth === "48px", `minWidth=${(narrow.el as HTMLElement).style.minWidth}`);
  const wide = makeFrame("floor2", { title: "floor2", x: 10, y: 10, w: 400, h: 200, minW: 320 });
  wide.show();
  check("...and a frame with a LARGER floor keeps it", (wide.el as HTMLElement).style.minWidth === "320px",
    `minWidth=${(wide.el as HTMLElement).style.minWidth}`); }

// --- a glyph button over the edge band keeps its press: the topmost element is the glyph's SVG <path>, not an
// HTMLElement, and the walk up to its <button> must still start. Inside a frame too, within 6px of its edge.
for (const where of ["over the band, outside the frame", "inside the frame, at its edge"]) {
  const b = document.createElement("button");
  b.innerHTML = '<svg viewBox="0 0 10 10"><path d="M0 0h10v10z"/></svg>';
  (where.startsWith("inside") ? f.el : document.body).appendChild(b);
  const path = b.querySelector("path")!;
  (document as any).elementFromPoint = () => path;
  const w0 = f.state.w;
  const ev = pd(edgeX(), edgeY());
  document.dispatchEvent(ev);
  document.dispatchEvent(pm(edgeX() + 40, edgeY()));
  document.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 1 }));
  check(`a glyph button ${where} keeps its press: no resize, default not prevented`, f.state.w === w0 && !ev.defaultPrevented, `w ${w0} → ${f.state.w}, prevented=${ev.defaultPrevented}`);
  b.remove();
}
(document as any).elementFromPoint = () => null;

S.done();
