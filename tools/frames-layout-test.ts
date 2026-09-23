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
// The version seeded here is the REAL previous literal, not a synthetic one: R's phone carried
// ew-frame-world {hidden:false} stamped '2026-09-07-rightdock' and therefore kept the world panel
// OPEN at 390x844 even though auto-minimize was correct (live 2026-09-11 10:15, reproduced headless).
// saved?.hidden wins over the viewport rule by design, so changing what the DEFAULT means on a small
// viewport is exactly the "DEFAULT_LAYOUT changed materially" case this guard exists for.
localStorage.setItem("ew-frame-layout-ver", "2026-09-07-rightdock");
localStorage.setItem("ew-frame-world", JSON.stringify({ x: 1, y: 1, w: 50, h: 50, hidden: false }));
localStorage.setItem("ew-frame-zzz", JSON.stringify({ x: 2, y: 2, w: 60, h: 60, hidden: true }));
localStorage.setItem("ew-ui-locked", "0");

(Element.prototype as any).setPointerCapture = function () {};
(Element.prototype as any).releasePointerCapture = function () {};
(Element.prototype as any).hasPointerCapture = function () { return false; };
(document as any).elementFromPoint = () => null;

const { makeFrame, resizeZoneAt, setLocked, isLocked, escapeToggle, escapeIsClaimed, claimEscape, allFrames, chromeCost } =
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
// Vacuous until 2026-09-11: it compared against "1999-01-01-stale" after the
// fixture had switched to seeding the REAL previous literal, so no code path
// could ever produce the value it excluded. Assert the seeded one is gone.
check("the current version is stamped, replacing the seeded previous one",
  !!stamped && stamped !== "2026-09-07-rightdock", String(stamped));
check("a non-frame key (ew-ui-locked) survives the purge", localStorage.getItem("ew-ui-locked") === "0");
{
  const world = makeFrame("world", { title: "world", x: -10, y: 52, w: 232, h: 300 });
    // THE BAR DOCKS AT THE TOP. R, 2026-09-11: "let's dock it at the top by
    // default since all the helper notifications display at the bottom where it
    // currently is". DEFAULT_LAYOUT.emotes went y:-10 (a BOTTOM anchor — a
    // negative y re-resolves against innerHeight) to y:10, an absolute offset
    // from the top. A material DEFAULT_LAYOUT change, riding the LAYOUT_VERSION
    // bump this block already exercises.
    { const tbar = makeFrame("emotes", { title: "emotes", x: "center", y: -10, w: 352, h: 32 });
      check("the emote bar's DEFAULT is the TOP edge, not the bottom",
        tbar.state.y < 100, `y=${tbar.state.y} vh=${innerHeight}`); }
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

console.log("FRAMES — a viewport too small for the default arrangement opens only chat");
{
  // R's phone, 2026-09-10 23:53: world + emotes + the palette stacked on top of
  // chat, all legally inside the viewport and none overlapping by the pairwise
  // check — the palette is makeSection mounting into world's stack, not a frame
  // of its own, so no rect test can see it. The fix is not to pack them better
  // but to not open them: on a FIRST load (no saved layout) at a viewport that
  // cannot hold the default arrangement, only chat comes up.
  const vw0 = innerWidth, vh0 = innerHeight;
  for (const id of ["awee", "aweb"]) localStorage.removeItem(`ew-frame-${id}`);
  (window as any).innerWidth = 390; (window as any).innerHeight = 844;
  const small = measurable(makeFrame("awee", { title: "awee", w: 407, h: 363, hidden: false }));
  check("a hidden:false default comes up HIDDEN when the viewport cannot hold the arrangement",
    small.state.hidden === true, JSON.stringify(small.state));

  // a DELIBERATE arrangement always wins — this is not a viewport override
  localStorage.setItem("ew-frame-aweb", JSON.stringify({ x: 8, y: 8, w: 200, h: 100, hidden: false }));
  const saved = measurable(makeFrame("aweb", { title: "aweb", w: 407, h: 363, hidden: false }));
  check("...but a SAVED hidden:false stays visible: the user's own layout is never overridden",
    saved.state.hidden === false, JSON.stringify(saved.state));

  // The suite headline is "opens only chat" and nothing asserted CHAT (agent
  // review, 2026-09-11): both frames above are synthetic ids, so deleting the
  // `id !== 'chat'` exemption — shipping a world with NOTHING open on a phone —
  // left this block green. Assert the promise itself, on the real id.
  localStorage.removeItem("ew-frame-chat");
  const chat = measurable(makeFrame("chat", { title: "chat" }));
  check("...and CHAT is exempt: the one pane that carries the composer still opens",
    chat.state.hidden === false, JSON.stringify(chat.state));

  // The case the round-4 rewrite exists for: an ORDINARY laptop must NOT be
  // auto-minimized. The old predicate summed every open default's height as if
  // they stacked (world 363 + chat 307 + bar), which needed 764px and so closed
  // the world panel on 1280x720 and on any split window. world is anchored
  // top-right and chat bottom-left — they never share a column.
  (window as any).innerWidth = 1280; (window as any).innerHeight = 720;
  for (const id of ["awld", "awlc"]) localStorage.removeItem(`ew-frame-${id}`);
  const laptopWorld = measurable(makeFrame("awld", { title: "awld", w: 407, h: 363, hidden: false }));
  check("1280x720 is a viewport the arrangement FITS: a hidden:false default opens",
    laptopWorld.state.hidden === false, JSON.stringify(laptopWorld.state));

  // ...and phone LANDSCAPE must still minimize: 390px of height cannot hold a
  // 363px panel plus the bar. Width alone would have opened this.
  (window as any).innerWidth = 844; (window as any).innerHeight = 390;
  localStorage.removeItem("ew-frame-awll");
  const landscape = measurable(makeFrame("awll", { title: "awll", w: 407, h: 363, hidden: false }));
  check("844x390 (phone landscape) still minimizes — height, not width, is what fails there",
    landscape.state.hidden === true, JSON.stringify(landscape.state));

  (window as any).innerWidth = vw0; (window as any).innerHeight = vh0;
  window.dispatchEvent(new Event("resize"));
}

console.log("FRAMES — reset UNPLACES: the viewport rule reads `placed`, not `moved`");
{
  // antra-tess #185 rereview addendum B1(b): resetLayout cleared `moved` and left
  // `placed` latched, so a frame that had ever been dragged stayed exempt from
  // viewport management FOREVER after a reset — `if (... || f._placed) continue`.
  // The deliberate act of resetting is precisely the act of un-placing.
  localStorage.removeItem("ew-frame-world");
  const f = measurable(makeFrame("world", { title: "world" }));
  check("a fresh frame is not placed", f._placed === false, `placed=${f._placed}`);
  f._markMoved();
  check("a drag places it", f._placed === true && f.state.placed === true,
    `placed=${f._placed} state.placed=${f.state.placed}`);
  f.resetLayout();
  check("reset clears the latch, not just `moved`", f._placed === false,
    `placed=${f._placed}`);
  // NOT a persistence claim: resetLayout() calls localStorage.removeItem(LS(id))
  // and never save() (the save() callers are :193/:398/:401/:535, none on this
  // path), so there is no stored record to re-read — the next construction reads
  // `saved?.placed` off a null save and gets false. This asserts the in-memory
  // state object is cleared too, so a later save() from show()/hide() cannot
  // resurrect the latch. (agent review round 2 caught the earlier wording, which
  // described a mechanism the code does not have.)
  check("...and clears it in the state object, so a later save() cannot resurrect it",
    f.state.placed === false, `state.placed=${f.state.placed}`);
}

console.log("FRAMES — reset obeys the viewport rule");
{
  // Round 2: one tap of "reset layout" on a phone reopened world+emotes stacked
  // over chat, and restored authoring-viewport widths uncapped (chat right=555
  // in a 390px viewport). Reset removes the save first, so there is no
  // arrangement to protect — the viewport rule and fit() both apply.
  const vw0 = innerWidth, vh0 = innerHeight;
  (window as any).innerWidth = 390; (window as any).innerHeight = 844;
  for (const id of ["chat", "world"]) localStorage.removeItem(`ew-frame-${id}`);
  const c = measurable(makeFrame("chat", { title: "chat" }));
  const w2 = measurable(makeFrame("world", { title: "world" }));
  c.resetLayout(); w2.resetLayout();
  check("reset keeps a non-chat frame hidden where the arrangement cannot fit",
    w2.state.hidden === true, JSON.stringify(w2.state));
  check("reset keeps chat open — the pane that carries the composer",
    c.state.hidden === false, JSON.stringify(c.state));
  check("reset clamps to the viewport: every reset frame is reachable",
    c.state.x + c.state.w <= innerWidth - 8, `chat right=${c.state.x + c.state.w} limit=${innerWidth - 8}`);
  (window as any).innerWidth = vw0; (window as any).innerHeight = vh0;
  window.dispatchEvent(new Event("resize"));
}

console.log("FRAMES — a hand-placed frame is never re-anchored");
{
  // R, 2026-09-11: the emote bar "will always pop sideways to the right
  // regardless if there's room for it". x:'center' re-resolved on EVERY fit()
  // because the `!saved` guard reads a closure captured at construction, and a
  // drag writes localStorage without ever refreshing it. The emote bar calls
  // _fit() 180ms after each drag settles (snapTo), so the placement was undone
  // every time. Only `emotes` uses x:'center', which is why it was the one.
  const vw0 = innerWidth, vh0 = innerHeight;
  (window as any).innerWidth = 1000; (window as any).innerHeight = 700;
  localStorage.removeItem("ew-frame-awcx");
  const bar = measurable(makeFrame("awcx", { title: "awcx", x: "center", y: -10, w: 352, h: 32 }));
  bar.show();
  const centred = bar.state.x;
  check("an x:'center' frame opens centred", centred > 100, JSON.stringify(bar.state));

  // a REAL drag: the pointer handler writes state and saves on pointerup
  // Drag to a MIDDLE x, not the left edge: `state.x = clamp(state.x, 8, …)` pins a
  // left-dragged frame to 8 whether or not the latch ran, so the left edge cannot
  // distinguish latched from unlatched — deleting markMoved() from the drag left
  // this block green. A middle x makes re-centring observable. (round 2)
  const target = 120;
  (bar.head as HTMLElement).dispatchEvent(new PointerEvent("pointerdown", { clientX: centred + 10, clientY: bar.state.y + 5, bubbles: true }));
  (bar.head as HTMLElement).dispatchEvent(new PointerEvent("pointermove", { clientX: target + 10, clientY: bar.state.y + 5, bubbles: true }));
  (bar.head as HTMLElement).dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
  const placed = bar.state.x;
  check("...and a drag lands it at the pointer, away from centre",
    placed > 20 && placed < centred - 40, `${placed} (centred ${centred})`);

  bar._fit();
  // Compare against the centre fit() WOULD compute at the current width — fit()
  // widens the bar first, so the pre-drag `centred` is not the value the
  // unlatched path would produce, and asserting against it passed either way
  // (round 2: deleting markMoved left this green).
  const wouldCentre = Math.round((innerWidth - bar.state.w) / 2);
  // BINDS frames.js:181 ONLY — the RESIZE-finish latch, not the drag's own.
  // Measured (round 5, correcting the round-2 note that stood here): deleting
  // the drag-end markMoved() alone leaves this GREEN at 61/0; deleting the
  // resize-finish one alone turns it RED at 60/1. The reason is the capture
  // phase — the resize handler registers
  // `document.addEventListener('pointerup', finish, true)`, so a title-bar
  // drag's pointerup reaches finish() (and its f.markMoved?.()) BEFORE the
  // drag's own up() runs. So the drag-end call at frames.js:454 is the line
  // nothing binds. Left in place: it is correct, and removing a guard because
  // no test reaches it is the wrong direction.
  check("...and fit() does NOT re-centre it — the hand beats the anchor (binds the RESIZE latch, frames.js:181)",
    bar.state.x === placed && bar.state.x !== wouldCentre,
    `placed ${placed} -> ${bar.state.x}; anchor would give ${wouldCentre}`);

  // (4) reset must put the frame back UNDER the anchors — `moved = false`.
  // THE Y ANCHOR, not just x. R, 2026-09-11: the emote bar "can't be arbitrarily
  // placed anywhere". fit()'s `opts.y < 0` re-anchor was deliberately ungated —
  // round 2 gated the CLAMP as well and stranded every untouched bottom frame
  // (rotate 700->500 left a bar at y=370 where 428 was wanted), so it was
  // reverted with a note that the lifted-bar case "needs a narrower fix than a
  // blanket gate". Gating only the ANCHOR is that fix.
    // A FRESH bottom-anchored frame. Reusing `bar` made this VACUOUS: by this
    // point its closure's opts.y is undefined (instrumented: "before fit:
    // opts.y=undefined"), so fit()'s `opts.y < 0` branch never ran at all and
    // the assertion passed whether or not the anchor was gated — ungating it
    // left the suite 64/0. A binding that cannot fail is decoration.
    { localStorage.removeItem("ew-frame-ybar");
      // Assert the DIRECTION, not an exact y. fit() reads `root.offsetHeight`,
      // which in this harness is much larger than measurable()'s faked 62 — so
      // the clamp ceiling and the y:-10 anchor land about two pixels apart and
      // an equality check cannot tell which one moved the frame (that is why
      // four earlier versions of this block passed ungated). What the gate
      // actually guarantees is one-directional: the clamp may pull a hand-placed
      // frame UP to keep it on screen, but nothing may push it back DOWN toward
      // the edge it was dragged away from.
      const ybar = measurable(makeFrame("ybar", { title: "ybar", x: "center", y: -10, w: 352, h: 32 }));
      ybar.show();
      const yBefore = ybar.state.y;
      (ybar.head as HTMLElement).dispatchEvent(new PointerEvent("pointerdown", { clientX: ybar.state.x + 10, clientY: yBefore + 5, bubbles: true }));
      (ybar.head as HTMLElement).dispatchEvent(new PointerEvent("pointermove", { clientX: ybar.state.x + 10, clientY: 240, bubbles: true }));
      (ybar.head as HTMLElement).dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
      const placedY = ybar.state.y;
      check("a bottom-anchored frame can be dragged UP off its edge", placedY < yBefore - 100, `y ${yBefore} -> ${placedY}`);
      ybar._fit();
      // The CLAMP may still move it (the viewport ceiling is real); what must NOT
      // happen is the y:-10 ANCHOR re-applying, which would park it at the bottom
      // edge again. Assert distance from THAT value, not equality with placedY.
      // NOT ASSERTED, and the reason is measured rather than guessed. Five
      // versions of this check were written and every one passed with the gate
      // REMOVED (65/0). MEASURED, not theorised: after a drag to y=235 the frame
      // sat at 207, and the y:-10 anchor for the same geometry computes to ~205
      // — two pixels apart, so no assertion here can tell which line moved it.
      // An equality check fails even WITH the fix (the clamp legitimately moves
      // the frame); a direction-only check passes even WITHOUT it (the clamp
      // only ever moves it up anyway). Why the two collapse together in this
      // harness is NOT established — measurable()'s getter reports 62 as an own
      // property, which does not reconcile with the ceiling observed, and I did
      // not chase it further.
      // To bind it later: a fixture whose root.offsetHeight really is state.h +
      // chrome, so the anchor and the ceiling are far apart. The product change
      // itself (frames.js: `!moved &&` on the y anchor) is one token and is
      // disclosed in the commit.
      check("a hand-placed frame is still on screen after a fit", ybar.state.y >= 8, `y=${ybar.state.y}`);
      // the CLAMP is NOT gated: shrink the viewport under it and it must come inside
      const vhKeep = innerHeight;
      (window as any).innerHeight = 240; ybar._fit();
      check("...but the CLAMP still runs — a hand-placed frame is never left off-screen",
        ybar.state.y + ybar.el.offsetHeight <= 240, `y=${ybar.state.y} h=${ybar.el.offsetHeight} vh=240`);
      (window as any).innerHeight = vhKeep; }

  bar.resetLayout();
  bar._fit();
  const centreNow = Math.round((innerWidth - bar.state.w) / 2);
  check("...and resetLayout un-latches it, so the anchor governs again",
    bar.state.x === centreNow && bar.state.x !== placed,
    `x=${bar.state.x} centre=${centreNow} (was placed at ${placed})`);

  // The RELOAD half — `moved = !!saved` — which is the half the commit is named
  // for and which the drag above never exercises (the drag arms the latch
  // itself). A frame built from a PREVIOUS session's save must already count as
  // hand-placed, before anything touches it. (agent review, 2026-09-11)
  localStorage.setItem("ew-frame-awcy", JSON.stringify({ x: 18, y: 600, w: 352, h: 32, hidden: false }));
  const reloaded = measurable(makeFrame("awcy", { title: "awcy", x: "center", y: -10, w: 352, h: 32 }));
  reloaded.show();
  reloaded._fit();
  check("a frame restored from a previous session is hand-placed from the start",
    reloaded.state.x === 18, JSON.stringify(reloaded.state));

  (window as any).innerWidth = vw0; (window as any).innerHeight = vh0;
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

console.log("CHROME COST — the declared anchor");
{
  // BOOT-CHECK CANNOT SEE THIS. Mis-declaring `.capnotice` as left-anchored returns
  // `ok` at 1280 and 1024, because boot-check hit-tests control REACHABILITY and a
  // floored-but-reachable settings panel passes. The defect is geometric (settings
  // opens at 210 instead of its declared 407), so the binding belongs here.
  //
  // These two assertions are exactly the two arithmetic bugs written while building
  // this, and each one fails on its own mistake.
  const mk = (cls: string, ds: Record<string, string>) => {
    const d = document.createElement("div");
    if (cls.startsWith(".")) d.className = cls.slice(1); else d.id = cls.slice(1);
    Object.assign(d.dataset, ds); document.body.append(d); return d;
  };
  mk(".capnotice", { anchor: "right" });
  mk("#dock", { edge: "top" });

  // (1) AN OFF-SCREEN OBSTACLE IS CLAMPED, NOT CREDITED WITH NEGATIVE GAP.
  // RETRACTED AND RE-AIMED: this assertion first claimed `extent - g.left` was a
  // distinct bug that "carries the viewport into the result". It is not — for any
  // rect wholly on screen, `extent - left` IS `width + (extent - right)`, the same
  // expression rearranged, and the suite stayed green when the supposed bug was
  // restored. They differ in exactly one place: `Math.max(0, ...)`, when the
  // obstacle's right edge is past the viewport. That is the real contract, so that
  // is what is asserted.
  const onScreen = (chromeCost as any)(".capnotice", { left: 950, right: 1270, width: 320 }, 1280).right;
  const offScreen = (chromeCost as any)(".capnotice", { left: 930, right: 1270, width: 340 }, 1024).right;
  check("a right-anchored obstacle on screen costs width + gap",
    onScreen === 330, String(onScreen));
  check("an obstacle overflowing the right edge costs its width, never width minus overflow",
    offScreen === 340, `${offScreen} — unclamped arithmetic gives 94`);

  // (2) A TOP-DOCKED RAIL CHARGES POSITIONALLY, NOT ZERO. Welded to the top edge
  // says nothing about the horizontal axis: a rail at [10..304] in an 844 viewport
  // is genuinely LEFT-positioned there. Returning {0,0} put an emote tile under the
  // rail at 844x390 ("sit" covered by #dock) — the corpus row-33 witness.
  const rail = (chromeCost as any)("#dock", { left: 10, right: 304, width: 294 }, 844);
  check("a top-docked rail charges the side it actually occupies, not zero",
    rail.left === 304 && rail.right === 0, JSON.stringify(rail));
}

console.log("AUTO-HIDDEN — survives a reload");
{
  // A field that save() WRITES but the initialiser never READS is write-only across
  // a reload, and nothing here caught it: `autoHidden` reached storage (save()
  // serialises the whole state object) while construction rebuilt state field by
  // field and silently omitted it. Measured consequence: auto-hide at 900 persists
  // {hidden:true, autoHidden:true}; a reload restores `hidden` and drops
  // `autoHidden`; widening then finds the restore guard falsy and the frame is
  // stranded hidden FOREVER.
  localStorage.setItem("ew-frame-autotest", JSON.stringify({
    x: 100, y: 100, w: 200, h: 150, hidden: true, autoHidden: true,
  }));
  const f: any = makeFrame("autotest", { title: "autotest", x: 100, y: 100, w: 200, h: 150, hidden: true });
  check("autoHidden is read back from a saved layout, not just written to it",
    f._state.autoHidden === true, JSON.stringify(f._state));

  // THE SAME BUG, ONE FIELD OVER — and it survived the fix above by three lines.
  // `markMoved()` sets `state.placed = true` ad-hoc and save() serialises the whole
  // object, so the flag reached storage the FIRST time. But the state literal had no
  // `placed` key, so the next construction built a state without it and the next
  // save() erased it. Measured live at 1280x800 on the emote bar:
  //   markMoved + _save -> placed:true · reload -> placed:true
  //   hide/show         -> the key is GONE from storage
  //   reload again      -> _placed:false
  // Two page loads and a frame the owner deliberately placed is auto-managed again:
  // it loses the fit() re-derive exemption, the chrome-clearance exemption and the
  // viewport auto-minimize exemption at once. Exactly what `placed` exists to prevent.
  localStorage.setItem("ew-frame-placedtest", JSON.stringify({
    x: 100, y: 100, w: 200, h: 150, hidden: false, placed: true,
  }));
  const pf: any = makeFrame("placedtest", { title: "placedtest", x: 100, y: 100, w: 200, h: 150 });
  check("placed is read back from a saved layout, not just written to it",
    pf._placed === true, `_placed=${pf._placed}`);
  check("...and it SURVIVES the next save() — the state object carries it",
    (() => { pf._save(); const ls = JSON.parse(localStorage.getItem("ew-frame-placedtest") || "{}");
             return ls.placed === true; })(),
    `storage after save: ${localStorage.getItem("ew-frame-placedtest")}`);

  // ...and a frame the owner deliberately closed must NOT carry the flag, or the
  // viewport rule would reopen it. hide() clears it; that is the whole distinction.
  localStorage.setItem("ew-frame-autotest2", JSON.stringify({
    x: 100, y: 100, w: 200, h: 150, hidden: true,
  }));
  const g: any = makeFrame("autotest2", { title: "autotest2", x: 100, y: 100, w: 200, h: 150, hidden: true });
  check("a saved hide with no autoHidden flag stays user-hidden",
    g._state.autoHidden === false, JSON.stringify(g._state));
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
