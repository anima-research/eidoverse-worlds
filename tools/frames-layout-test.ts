// frames — layout invariants, run headless against the REAL module.
//
//   bun tools/frames-layout-test.ts
//
// frames-resize-test covers the resize drag's finish path. This suite covers what the rest of frames.js
// promises: a frame can never leave the viewport (the -8 margins, on drag AND on resize), the edge/corner
// hit-tester tells edges from corners and reaches 6px outside a frame (resizeZoneAt is ui.js's arrange-exit
// guard), a frame resting on an edge rides that edge through a window resize, z-indexes stay inside the
// [10..25] band under the dock, a LAYOUT_VERSION bump purges every stale ew-frame-* save ONCE, and Esc
// closes/restores the open set only when nothing else owns Esc (a focused field, a pop, claimEscape).
//
// The persisted-layout purge runs at module scope, so localStorage is seeded BEFORE the import; every
// assertion about it is therefore a statement about what the import did.

import { plugin } from "bun";
const here = (f: string) => new URL(f, import.meta.url).pathname;
plugin({
  name: "frames-layout-stubs",
  setup(b) {
    b.onResolve({ filter: /^\.\/base\.js$/ }, () => ({ path: here("./chat-core-stub.mjs") }));
  },
});

import { GlobalRegistrator } from "@happy-dom/global-registrator";
GlobalRegistrator.register({ width: 1000, height: 700 });

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  else { fail++; console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? ` — ${detail}` : ""}`); }
};

// ---- seed a STALE persisted layout from an older LAYOUT_VERSION, plus one non-frame key that must survive
localStorage.setItem("ew-frame-layout-ver", "1999-01-01-stale");
localStorage.setItem("ew-frame-world", JSON.stringify({ x: 1, y: 1, w: 50, h: 50, hidden: false }));
localStorage.setItem("ew-frame-zzz", JSON.stringify({ x: 2, y: 2, w: 60, h: 60, hidden: true }));
localStorage.setItem("ew-ui-locked", "0");

(Element.prototype as any).setPointerCapture = function () {};
(Element.prototype as any).releasePointerCapture = function () {};
(Element.prototype as any).hasPointerCapture = function () { return false; };
(document as any).elementFromPoint = () => null;

const { makeFrame, resizeZoneAt, setLocked, isLocked, escapeToggle, escapeIsClaimed, claimEscape, allFrames } =
  await import("../client/lib/frames.js");

// happy-dom measures nothing; report each frame's real state so the zone math and the drag clamp can see it
function measurable(f: any, chromeH = 30) {
  (f.el as any).getBoundingClientRect = () => ({
    left: f.state.x, top: f.state.y, width: f.state.w, height: f.state.h + chromeH,
    right: f.state.x + f.state.w, bottom: f.state.y + f.state.h + chromeH, x: f.state.x, y: f.state.y,
    toJSON() { return this; },
  });
  Object.defineProperty(f.el, "offsetHeight", { get: () => f.state.h + chromeH, configurable: true });
  return f;
}
const outerH = (f: any) => f.el.offsetHeight;

console.log("FRAMES — LAYOUT_VERSION purge");
check("stale ew-frame-* saves are gone after the import",
  localStorage.getItem("ew-frame-world") === null && localStorage.getItem("ew-frame-zzz") === null,
  `world=${localStorage.getItem("ew-frame-world")} zzz=${localStorage.getItem("ew-frame-zzz")}`);
const stamped = localStorage.getItem("ew-frame-layout-ver");
check("the current version is stamped", !!stamped && stamped !== "1999-01-01-stale", String(stamped));
check("a non-frame key (ew-ui-locked) survives the purge", localStorage.getItem("ew-ui-locked") === "0");
{
  const world = makeFrame("world", { title: "world", x: -10, y: 52, w: 232, h: 300 });
  check("a frame with a purged save takes the DEFAULT, not the stale x:1",
    world.state.x !== 1 && world.state.x + world.state.w <= innerWidth - 8, JSON.stringify(world.state));
}

console.log("FRAMES — viewport clamp (the -8 margins)");
const f = measurable(makeFrame("t", { title: "t", x: 100, y: 100, w: 300, h: 200, minW: 100, minH: 80 }));
f.show();
const pe = (type: string, x: number, y: number) =>
  new PointerEvent(type, { clientX: x, clientY: y, button: 0, bubbles: true, pointerId: 1 });
function dragHeadTo(x: number, y: number) {
  // grab the title bar at (state.x+50, state.y+10) and drop it wherever
  const gx = f.state.x + 50, gy = f.state.y + 10;
  f.head.dispatchEvent(pe("pointerdown", gx, gy));
  f.head.dispatchEvent(pe("pointermove", x + 50, y + 10));
  f.head.dispatchEvent(pe("pointerup", x + 50, y + 10));
}
dragHeadTo(5000, 5000);
check("a drag far off the bottom-right stops 8px inside the viewport",
  f.state.x + f.state.w === innerWidth - 8 && f.state.y + outerH(f) === innerHeight - 8, JSON.stringify(f.state));
dragHeadTo(-5000, -5000);
check("a drag far off the top-left stops at (8, 8)", f.state.x === 8 && f.state.y === 8, JSON.stringify(f.state));
dragHeadTo(300, 200);
check("an in-bounds drag lands where it was dropped", f.state.x === 300 && f.state.y === 200, JSON.stringify(f.state));
{
  // resize growth is clamped too: an east drag of 9999 stops at innerWidth - x - 8
  const rightEdge = f.state.x + f.state.w - 1, midY = f.state.y + 60;
  document.dispatchEvent(pe("pointerdown", rightEdge, midY));
  document.dispatchEvent(pe("pointermove", rightEdge + 9999, midY));
  document.dispatchEvent(pe("pointerup", rightEdge + 9999, midY));
  check("an east resize cannot push the edge past innerWidth - 8",
    f.state.x + f.state.w === innerWidth - 8, JSON.stringify(f.state));
  const s = JSON.parse(localStorage.getItem("ew-frame-t") ?? "null");
  check("the clamped geometry is what gets persisted", s && s.x + s.w === innerWidth - 8, JSON.stringify(s));
}

console.log("FRAMES — edge / corner zones");
dragHeadTo(100, 100);
const L = f.state.x, T = f.state.y, R = f.state.x + f.state.w, B = f.state.y + outerH(f);
check("resizeZoneAt: a point 3px OUTSIDE the east edge is in the grab band", resizeZoneAt(R + 3, T + 60));
check("resizeZoneAt: 7px outside is past the 6px reach", !resizeZoneAt(R + 7, T + 60));
check("resizeZoneAt: 3px outside the north edge", resizeZoneAt(L + 150, T - 3));
check("resizeZoneAt: the frame's interior is content, not a zone", !resizeZoneAt(L + 150, T + 100));
check("resizeZoneAt: 8px inside the SE corner is the corner square", resizeZoneAt(R - 8, B - 8));
const cursorAt = (x: number, y: number) => { document.dispatchEvent(pe("pointermove", x, y)); return document.body.style.cursor; };
check("hover on the east band shows ew-resize", cursorAt(R - 1, T + 100) === "ew-resize", cursorAt(R - 1, T + 100));
check("hover on the south band shows ns-resize", cursorAt(L + 150, B - 1) === "ns-resize", cursorAt(L + 150, B - 1));
check("hover 8px inside the SE corner shows nwse-resize (corner beats edge)", cursorAt(R - 8, B - 8) === "nwse-resize", cursorAt(R - 8, B - 8));
check("hover 8px inside the NE corner shows nesw-resize", cursorAt(R - 8, T + 8) === "nesw-resize", cursorAt(R - 8, T + 8));
check("hover in the interior shows no resize cursor", cursorAt(L + 150, T + 100) === "", cursorAt(L + 150, T + 100));
f.hide();
check("a hidden frame has no zones", !resizeZoneAt(R + 3, T + 60));
f.show();
setLocked(true);
check("a locked layout has no zones", isLocked() && !resizeZoneAt(R + 3, T + 60));
setLocked(false);
check("...and they return when unlocked", resizeZoneAt(R + 3, T + 60));

console.log("FRAMES — sticky edges");
const rt = measurable(makeFrame("rt", { title: "rt", x: -8, y: 8, w: 200, h: 100 }));
rt.show();
const mid = measurable(makeFrame("mid", { title: "mid", x: 300, y: 300, w: 200, h: 100 }));
mid.show();
check("a right-anchored frame is painted st-r + st-t", rt.el.classList.contains("st-r") && rt.el.classList.contains("st-t"));
check("a mid-air frame holds no sticky edge", !["st-l", "st-r", "st-t", "st-b"].some((c) => mid.el.classList.contains(c)));
{
  const rx0 = rt.state.x, mx0 = mid.state.x;
  (window as any).innerWidth = 1300;
  window.dispatchEvent(new Event("resize"));
  check("on a window resize the sticky frame rides the right edge (+300)", rt.state.x === rx0 + 300, `${rx0} -> ${rt.state.x}`);
  check("...and its gap to the edge is still 8", innerWidth - (rt.state.x + rt.state.w) === 8);
  check("the mid-air frame does not move", mid.state.x === mx0, `${mx0} -> ${mid.state.x}`);
  (window as any).innerWidth = 1000;
  window.dispatchEvent(new Event("resize"));
  check("shrinking back pulls it back inside (never stranded off-screen)",
    rt.state.x + rt.state.w <= innerWidth - 8, JSON.stringify(rt.state));
}

console.log("FRAMES — a narrow viewport (the header's 'can never leave the viewport', at phone width)");
{
  // #185 review: DEFAULT_LAYOUT bakes widths from a 1904px authoring session
  // (chat w:545) and fit() clamped only x/y — so at phone width a frame kept its
  // width, pinned x to 8, and ran off the right edge. html,body use
  // overflow:hidden, so the clipped region is NOT reachable by scrolling.
  const wide = measurable(makeFrame("narrowme", { title: "narrowme", x: 10, y: 10, w: 545, h: 200 }));
  wide.show();
  const vw0 = innerWidth;
  (window as any).innerWidth = 390;
  window.dispatchEvent(new Event("resize"));
  check("a frame WIDER than the viewport is narrowed to fit, not just pinned",
    wide.state.x + wide.state.w <= innerWidth - 8, JSON.stringify(wide.state));
  check("...and it keeps its 8px left margin (not pushed to a negative x)",
    wide.state.x >= 8, JSON.stringify(wide.state));
  // minW must yield: a 170px floor cannot be honoured inside a 160px viewport
  const tiny = measurable(makeFrame("tinyvp", { title: "tinyvp", x: 10, y: 10, w: 300, h: 100, minW: 170 }));
  tiny.show();
  (window as any).innerWidth = 160;
  window.dispatchEvent(new Event("resize"));
  check("minW yields when the viewport is narrower than minW",
    tiny.state.x + tiny.state.w <= innerWidth - 8, JSON.stringify(tiny.state));
  (window as any).innerWidth = vw0;
  window.dispatchEvent(new Event("resize"));

  // A PERSISTED oversized layout is the other half of requirement 1: fit() was
  // skipped entirely when a save existed (`if (!saved && ...)`), so a layout saved
  // on a wide screen came back at full width on a narrow one and never clamped.
  (window as any).innerWidth = 390;
  localStorage.setItem("ew-frame-savedwide", JSON.stringify({ x: 8, y: 10, w: 545, h: 200, hidden: false }));
  const restored = measurable(makeFrame("savedwide", { title: "savedwide", x: 10, y: 10, w: 300, h: 200 }));
  // Assert BEFORE show(). show() runs the second fit() call site (a frame created
  // hidden is fitted when first shown), which would clamp this for an unrelated
  // reason and make the check pass whatever the creation path does — an assertion
  // that cannot fail is not a binding.
  check("a SAVED layout wider than the viewport is clamped AT CREATION, not restored oversized",
    restored.state.x + restored.state.w <= innerWidth - 8, JSON.stringify(restored.state));
  restored.show();
  check("...and it is still inside the viewport after being shown",
    restored.state.x + restored.state.w <= innerWidth - 8, JSON.stringify(restored.state));
  (window as any).innerWidth = vw0;
  window.dispatchEvent(new Event("resize"));
}

console.log("FRAMES — z band");
const zs = () => allFrames().map((x: any) => +x.el.style.zIndex);
for (let i = 0; i < 20; i++) measurable(makeFrame(`z${i}`, { title: `z${i}`, x: 20 + i, y: 20 + i, w: 120, h: 60 })).show();
for (const x of allFrames()) x.raise();
check("every frame's z-index sits inside [10..25] (below the dock at 27)", zs().every((z) => z >= 10 && z <= 25), JSON.stringify(zs()));
{
  const last = allFrames()[allFrames().length - 1];
  last.raise();
  const top = Math.max(...zs());
  check("the last raised frame is on top", +last.el.style.zIndex === top && top <= 25, `${last.el.style.zIndex} vs max ${top}`);
  f.raise();
  check("raising another puts IT on top and still inside the band", +f.el.style.zIndex === Math.max(...zs()) && +f.el.style.zIndex <= 25, f.el.style.zIndex);
}

console.log("FRAMES — Esc close / restore");
for (const x of allFrames()) x.hide();
f.show(); mid.show();
const esc = (target: EventTarget = document.body) => target.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
const open = () => allFrames().filter((x: any) => x.visible).map((x: any) => x.id);
check("setup: two frames open", open().join() === "t,mid", open().join());
esc();
check("Esc closes every open frame", open().length === 0, open().join());
esc();
check("Esc again restores exactly that set", open().sort().join() === "mid,t", open().join());
{
  const input = document.createElement("input");
  document.body.appendChild(input);
  input.focus();
  check("escapeIsClaimed() = 'field' while an input is focused", escapeIsClaimed() === "field", String(escapeIsClaimed()));
  esc(input);
  check("Esc with an input focused leaves the frames alone", open().length === 2, open().join());
  input.blur(); input.remove();
  check("...and is unclaimed once it blurs", escapeIsClaimed() === null, String(escapeIsClaimed()));
}
{
  const pop = document.createElement("div"); pop.className = "dd-pop";
  document.body.appendChild(pop);
  check("an open dropdown pop claims Esc", escapeIsClaimed() === "pop");
  esc();
  check("Esc with a pop open leaves the frames alone", open().length === 2, open().join());
  pop.remove();
}
{
  let claim: string | null = null;
  claimEscape(() => claim);
  claim = "edit";
  check("a claimEscape() registrant claims Esc", escapeIsClaimed() === "edit");
  esc();
  check("Esc while claimed leaves the frames alone", open().length === 2, open().join());
  claim = null;
  esc();
  check("releasing the claim hands Esc back to the frames", open().length === 0, open().join());
  check("escapeToggle() reports what it did", escapeToggle() === "restored" && escapeToggle() === "closed" && escapeToggle() === "restored");
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
