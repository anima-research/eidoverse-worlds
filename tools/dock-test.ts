// ui.js — the dock rail, the ∃ menu, pins, and the registerPanel mod seam, run headless against the REAL
// module (frames.js, icons.js and dropdown.js real underneath it; see dock-stub.mjs for what is not).
//
//   bun tools/dock-test.ts
//
// What the rail promises (ui.js's own comment): an icon rides the rail while its window is OPEN or while it
// is PINNED; otherwise it hides. Pinning lives in the ∃ menu, and so does the layout lock. A mod that calls
// registerPanel() gets the same door as a built-in — a frame, a rail button, a menu row, a pin — and a
// duplicate id is refused, not doubled. And rail chrome never rides emoji: the four upstream rail labels
// (💬 🧱 👋 🐞) must resolve through EMOJI_ICON to Phosphor FILL glyphs — never the raw emoji, never the
// puzzle-piece fallback that means "unknown icon".

import { plugin } from "bun";
const here = (f: string) => new URL(f, import.meta.url).pathname;
plugin({
  name: "dock-stubs",
  setup(b) {
    for (const m of ["base", "mictoggle", "xrpanels", "assets", "defs", "profile", "stylepanel", "videopanel", "capnotice"])
      b.onResolve({ filter: new RegExp(`^\\./${m}\\.js$`) }, () => ({ path: here("./dock-stub.mjs") }));
  },
});

import { GlobalRegistrator } from "@happy-dom/global-registrator";
GlobalRegistrator.register({ width: 1000, height: 700 });

// the chrome ui.js reaches for at import (index.html's ids)
document.body.innerHTML = `
  <button id="hud" class="emark">∃</button>
  <div id="dock" class="panel"></div>
  <div id="emenu" class="panel" hidden></div>
  <div id="loading" class="panel"></div><div id="toasts"></div><div id="hintbar" class="panel"></div>
  <div id="touch"></div>
  <div id="door" class="scrim"><div class="sheet panel"></div></div>
  <div id="help" class="scrim"><div class="sheet panel"></div></div>`;

const { bus } = await import("./dock-stub.mjs");
const { fsvg } = await import("../client/lib/icons.js");
const { makeFrame, getFrame, isLocked } = await import("../client/lib/frames.js");
const ui = await import("../client/lib/ui.js");
const { initDock, registerPanel, dockPins, toggleEMenu, makeSection, settingsFrame, paintPresence } = ui;

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  else { fail++; console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? ` — ${detail}` : ""}`); }
};
const tick = () => new Promise((r) => setTimeout(r, 0));
const dock = () => document.getElementById("dock")!;
const menu = () => document.getElementById("emenu")!;
const btn = (id: string) => dock().querySelector(`button[data-toggles="${id}"]`) as HTMLButtonElement | null;
const row = (id: string) => menu().querySelector(`.mrow[data-row="${id}"]`) as HTMLButtonElement | null;
const pin = (id: string) => menu().querySelector(`.mpin[data-pin="${id}"]`) as HTMLButtonElement | null;
const order = () => [...dock().querySelectorAll("button[data-toggles]")].map((b) => (b as HTMLElement).dataset.toggles);
const savedPins = () => JSON.parse(localStorage.getItem("ew-dock-pins") ?? "null");
// compare glyphs by their path data: happy-dom re-serializes attribute whitespace, so markup equality lies
const paths = (name: string) => [...fsvg(name, 15).matchAll(/ d="([^"]+)"/g)].map((m) => m[1]);
const wears = (html: string, name: string) => paths(name).every((d) => html.includes(d));
const PUZZLE = "puzzle-piece";

// the built-in frames the rail lists (main.js makes these before initDock)
for (const id of ["chat", "world", "emotes", "debug"]) makeFrame(id, { title: id });
let editOn = false, editGate = false, editFired = 0;

console.log("DOCK — initDock");
initDock([
  { id: "chat", label: "💬" },
  { id: "world", label: "🧱" },
  { id: "nofrx", label: "👥" },        // synthetic: a declared entry with NO frame and NO pin
  { id: "emotes", label: "👋" },
  { id: "debug", label: "🐞" },
  { id: "edit", label: "🔧", icon: "wrench", last: true, action: () => { editFired++; editOn = !editOn; }, active: () => editOn, gate: () => editGate },
]);
await tick();   // initPanels' dynamic imports land and repaint
// DEFAULT_LAYOUT opens world/chat/emotes at birth; every rail assertion below starts from CLOSED
for (const id of ["chat", "world", "emotes", "debug"]) getFrame(id)!.hide();
bus.emit("frames");
check("∃ leads the rail", dock().firstElementChild?.id === "hud");
check("profile leads the buttons; the wrench closes the list; the grip is last",
  order()[0] === "profile" && order()[order().length - 1] === "edit" && dock().lastElementChild?.classList.contains("dock-grip"), order().join());
check("dock order follows the entry list", order().join() === "profile,chat,world,nofrx,emotes,debug,edit", order().join());
check("built-ins are pinned by default: chat's button shows while its frame is closed",
  !getFrame("chat")!.visible && btn("chat")!.hidden === false);
check("an entry with no frame and no pin is hidden", btn("nofrx")!.hidden === true);
// GREY, NOT GONE (R, 2026-09-11). A hidden affordance teaches nobody it
// exists — which is how the wrench went missing from the rail for days.
check("a gated action entry is PRESENT but dead while its gate is closed",
  btn("edit")!.hidden === false && btn("edit")!.classList.contains("dead") && btn("edit")!.disabled === true,
  `hidden=${btn("edit")!.hidden} dead=${btn("edit")!.classList.contains("dead")} disabled=${btn("edit")!.disabled}`);
check("...and its title says why it is dead",
  /build rights/.test(btn("edit")!.title), btn("edit")!.title);
editGate = true; bus.emit("frames");
check("...and comes alive once the gate opens (pinned by default)",
  btn("edit")!.hidden === false && !btn("edit")!.classList.contains("dead") && btn("edit")!.disabled === false);
btn("edit")!.click();
check("clicking the wrench fires its action and lights it", editFired === 1 && btn("edit")!.classList.contains("on"));
btn("edit")!.click();
check("...and again to unlight", editFired === 2 && !btn("edit")!.classList.contains("on"));
check("window.eido.ui.registerPanel is the exported seam", (window as any).eido?.ui?.registerPanel === registerPanel);

console.log("DOCK — EMOJI_ICON: rail chrome never rides emoji");
// world is upstream-labelled '🧱' (main.js), but 🧱 means BUILD — palette.js's
// build section wears the hammer correctly. The world PANEL is a planet, so the
// entry id overrides the emoji (ui.js ID_ICON). Live report, #185.
const RAIL: [string, string, string][] = [["chat", "💬", "chat-circle"], ["world", "🧱", "planet"], ["emotes", "👋", "hand-waving"], ["debug", "🐞", "bug"]];
for (const [id, emoji, icon] of RAIL) {
  const b = btn(id)!;
  check(`rail button '${id}' (${emoji}) wears the ${icon} FILL glyph — not the emoji, not puzzle-piece`,
    wears(b.innerHTML, icon) && !b.textContent!.includes(emoji) && !wears(b.innerHTML, PUZZLE), `innerHTML=${b.innerHTML.slice(0, 60)}`);
}
toggleEMenu(true);
for (const [id, , icon] of RAIL) {
  const r = row(id)!;
  check(`∃ row '${id}' wears ${icon}, never puzzle-piece`,
    !!r && wears(r.innerHTML, icon) && !wears(r.innerHTML, PUZZLE), wears(r?.innerHTML ?? "", PUZZLE) ? "puzzle-piece" : r?.innerHTML.slice(0, 60));
}
toggleEMenu(false);
{
  const s = makeSection("💬 chat", null, { id: "sec-chat" });
  check("makeSection('💬 …') head wears the chat-circle fill glyph + the bare name",
    wears(s.head.innerHTML, "chat-circle") && !wears(s.head.innerHTML, PUZZLE) && s.head.querySelector("span")?.textContent === "chat" && !s.head.textContent!.includes("💬"), s.head.innerHTML.slice(0, 80));
  const s2 = makeSection("🐞 debug", null, { id: "sec-debug" });
  check("makeSection('🐞 …') head wears the bug fill glyph", wears(s2.head.innerHTML, "bug") && !s2.head.textContent!.includes("🐞"));
  const s4 = makeSection("🧱 build", null, { id: "sec-build" });
  const s5 = makeSection("👋 emotes", null, { id: "sec-emotes" });
  check("makeSection: 🧱 → hammer, 👋 → hand-waving", wears(s4.head.innerHTML, "hammer") && wears(s5.head.innerHTML, "hand-waving"));
  const s3 = makeSection("🦄 unmapped", null, { id: "sec-unk" });
  check("an UNMAPPED emoji keeps its text (no silent puzzle-piece)", s3.head.textContent === "🦄 unmapped" && !s3.head.querySelector("svg"));
}

console.log("DOCK — the rail clears the joystick (mobile landscape)");
{
  // R, 2026-09-11: "it doesn't currently take into account the space needed for
  // the mobile joystick". #stick is left:18 bottom:18, 116px square -> it owns
  // the bottom 134px of the left column. The rail is taller than what is left
  // above it at 844x390, so a LEFT edge runs through the thumb.
  const { dockEdgeFitsLeft } = ui as any;
  const vw0 = innerWidth, vh0 = innerHeight;
  const setVp = (w: number, h: number) => { (window as any).innerWidth = w; (window as any).innerHeight = h; };

  document.body.classList.remove("touch");
  setVp(844, 390);
  check("no touch controls: the left rail is never displaced", dockEdgeFitsLeft() === true);

  document.body.classList.add("touch");
  setVp(390, 844);
  check("touch, portrait: the rail still clears the stick, so it stays left", dockEdgeFitsLeft() === true);

  setVp(844, 390);
  check("touch, landscape: the rail cannot clear the stick -> not left", dockEdgeFitsLeft() === false);

  // This assertion used to read back its own localStorage.setItem and would have
  // passed with ui.js deleted (agent review, 2026-09-11). Drive the real path:
  // initDock -> loadDockEdge -> applyDockEdge, and read the edge off the DOM.
  localStorage.setItem("ew-dock-pos", JSON.stringify({ edge: "right", along: 40 }));
  window.dispatchEvent(new Event("resize"));          // initDock's own listener re-applies the edge
  check("a DELIBERATE drag still wins: a stored ew-dock-pos beats the joystick rule",
    dock().dataset.edge === "right", `dataset.edge=${dock().dataset.edge}`);
  localStorage.removeItem("ew-dock-pos");
  window.dispatchEvent(new Event("resize"));
  check("...and with no stored edge, the rule applies again: landscape -> top",
    dock().dataset.edge === "top", `dataset.edge=${dock().dataset.edge}`);

  document.body.classList.remove("touch");
  setVp(vw0, vh0);
}

console.log("DOCK — registerPanel (the mod seam)");
let mounted: any = null;
const modF = registerPanel({ id: "modx", title: "mod x", mount: (body: HTMLElement, f: any) => { mounted = { body, f }; } });
check("returns the frame; mount ran with its body", !!modF && mounted?.f === modF && mounted.body === modF.body);
check("the frame is born hidden", modF.visible === false);
check("a rail button exists for it", !!btn("modx"));
check("...inserted BEFORE the wrench, which keeps the end", order().indexOf("modx") < order().indexOf("edit"), order().join());
check("unpinned + closed: its button is hidden", btn("modx")!.hidden === true);
check("the default icon is puzzle-piece (a mod that names none)", wears(btn("modx")!.innerHTML, PUZZLE));
const dup = registerPanel({ id: "modx", title: "again" });
check("a duplicate id is refused (null)", dup === null, String(dup));
check("...and the rail holds ONE button for it", dock().querySelectorAll('button[data-toggles="modx"]').length === 1);
check("registerPanel without an id is refused", registerPanel({} as any) === null);
check("a mounting mod that throws does not take the seam down",
  (() => { const errs = console.error; console.error = () => {}; try { return !!registerPanel({ id: "mody", mount: () => { throw new Error("boom"); } }); } finally { console.error = errs; } })());

console.log("DOCK — open ∪ pinned");
btn("modx")!.click();
check("clicking its (hidden) button opens the frame and shows the button lit", modF.visible && btn("modx")!.hidden === false && btn("modx")!.classList.contains("on"));
check("dockPins() lists it now that it is open", dockPins().some((p: any) => p.id === "modx" && p.open === true));
check("dockPins() never lists action entries", !dockPins().some((p: any) => p.id === "edit"));
btn("modx")!.click();
check("closing it hides the button again (not pinned)", !modF.visible && btn("modx")!.hidden === true && !btn("modx")!.classList.contains("on"));
check("...and dockPins() drops it", !dockPins().some((p: any) => p.id === "modx"));
btn("chat")!.click();
check("a pinned panel's button stays through open", getFrame("chat")!.visible && btn("chat")!.hidden === false && btn("chat")!.classList.contains("on"));
btn("chat")!.click();
check("...and through close", !getFrame("chat")!.visible && btn("chat")!.hidden === false && !btn("chat")!.classList.contains("on"));

console.log("DOCK — the ∃ menu");
check("closed at rest", menu().hidden === true && !document.body.classList.contains("arranging"));
document.getElementById("hud")!.click();
check("∃ click opens it and marks the body arranging", menu().hidden === false && document.body.classList.contains("arranging"));
check("voice rows lead: mic, ears, VR", ["glyph:mic", "glyph:ear", "glyph:xr"].every((k) => !!row(k)));
check("VR row is dead when no headset is sensed (disabled row + disabled pin)", row("glyph:xr")!.disabled && pin("glyph:xr")!.disabled);
check("every window with a frame has a row; a frameless entry has none", ["chat", "world", "emotes", "debug", "modx"].every((id) => !!row(id)) && !row("nofrx"));
check("the wrench has a row while gated open", !!row("edit"));
{ // ...and a row while gated CLOSED too — dead, not absent (R: "It SHOULD be
  // in the reverse-E menu regardless"). paintEMenu used to `continue` past a
  // closed gate, so the only way to learn edit mode existed was to already
  // have build rights.
  const was = editGate;
  editGate = false; bus.emit("frames");
  const r = row("edit");
  check("the wrench keeps its ∃ row while gated CLOSED, rendered dead",
    !!r && r.classList.contains("dead") && r.disabled === true,
    r ? `dead=${r.classList.contains("dead")} disabled=${r.disabled}` : "NO ROW");
  editGate = was; bus.emit("frames");
}
{ // AUTO-PIN ON THE GRANT, edge-triggered. R asked for the wrench to pin
  // itself when build rights arrive, with a manual unpin still winning — so it
  // must fire on closed->open, never on every repaint.
  const wasGate = editGate;
  // OBSERVE WHAT THE PRODUCT OBSERVES. savedPins() reads localStorage, which is
  // null until something calls savePins() — but `pins` already contains 'edit'
  // from DEFAULT_PINS at block start. So a storage-based probe reports
  // "unpinned" while the product considers it pinned, the opening unpin is
  // skipped, and the grant finds nothing to do. The rail is the honest seam:
  // paintDock hides an action button iff `!active && !pins.has(id)`
  // (ui.js:553), so with the gate open and the mode off, visible == pinned.
  // (Three instrumented runs to find this; the storage probe was mine.)
  const isPinned = () => { editGate = true; bus.emit("frames"); return btn("edit")!.hidden === false; };
  // Re-QUERY the pin button every time: emenuKey() omits a gated-closed action
  // entry, so flipping editGate changes the key and buildEMenu rebuilds every
  // row — a captured element goes stale across exactly the emits driven here.
  const pinNow = () => menu().querySelector(`.mpin[data-pin="edit"]`) as HTMLButtonElement | null;

  editGate = true; bus.emit("your-rights");            // settle: granted, remembered
  if (isPinned()) { pinNow()!.click(); }               // start from UNPINNED, whatever the default was
  check("...starting unpinned", !isPinned(), JSON.stringify(savedPins()));

  editGate = false; bus.emit("your-rights");           // REVOKE
  editGate = true; bus.emit("your-rights");            // THE GRANT
  check("a rights grant auto-pins the wrench", isPinned(), JSON.stringify(savedPins()));

  // R asked for BOTH verbs: "gray out AND UNPIN ... and it activates and pins
  // automatically when you do get it". Shipping only the pin left a demoted
  // user with a dead wrench welded to a GLOBAL pin list. (round 5)
  editGate = false; bus.emit("your-rights");
  check("...and losing the rights unpins it again", !isPinned(), JSON.stringify(savedPins()));

  // the override: re-grant, unpin by hand, repaint at the SAME level
  editGate = true; bus.emit("your-rights");
  pinNow()!.click();
  check("...and a manual unpin actually unpins it", !isPinned(), JSON.stringify(savedPins()));
  bus.emit("your-rights");
  check("...and the next repaint does NOT undo the manual unpin (edge, not level)",
    !isPinned(), JSON.stringify(savedPins()));

  // and a dead row's pin must be dead too — the VR row's own treatment
  editGate = false; bus.emit("your-rights");
  check("a gated-closed row's pin is disabled, not merely un-hoverable",
    pinNow()?.disabled === true, `disabled=${pinNow()?.disabled}`);

  // NEVER `on` AND `dead`. .on's brand ink and 2px edge-bar come later in the
  // sheet at equal specificity, so a dead+on button rendered as "active but
  // broken": 42% opacity in full brand colour. Reachable in the product —
  // setEditMode has no rights check and KeyB is ungated, so a builder can
  // enter edit mode and then lose rights mid-session. (round 5)
  editOn = true; bus.emit("frames");
  check("a dead action button never also paints as active",
    btn("edit")!.classList.contains("dead") && !btn("edit")!.classList.contains("on"),
    `dead=${btn("edit")!.classList.contains("dead")} on=${btn("edit")!.classList.contains("on")}`);
  editOn = false; bus.emit("frames");

  editGate = wasGate; bus.emit("frames");
}

check("the lock row and reset row close the menu", !!menu().querySelector(".mrow[data-lock]") && /reset layout/.test(menu().textContent!));
row("chat")!.click();
check("a row click opens that window and lights the row", getFrame("chat")!.visible && row("chat")!.classList.contains("open"));
row("chat")!.click();
check("...and again closes it", !getFrame("chat")!.visible && !row("chat")!.classList.contains("open"));
check("modx's pin is off", !!pin("modx") && !pin("modx")!.classList.contains("on") && pin("modx")!.title === "pin to rail");
pin("modx")?.click();
check("pinning modx: pin lights, its closed button now shows on the rail", pin("modx")!.classList.contains("on") && btn("modx")!.hidden === false);
check("...and the pin set is persisted", Array.isArray(savedPins()) && savedPins().includes("modx"), JSON.stringify(savedPins()));
check("...and dockPins() lists it closed", dockPins().some((p: any) => p.id === "modx" && p.open === false));
pin("modx")!.click();
check("unpinning hides the closed button again and persists", btn("modx")!.hidden === true && !savedPins().includes("modx"));
pin("chat")!.click();
check("unpinning a built-in hides its closed button", btn("chat")!.hidden === true && !savedPins().includes("chat"));
pin("chat")!.click();
check("...pin it back", btn("chat")!.hidden === false && savedPins().includes("chat"));
{
  const lock = menu().querySelector(".mrow[data-lock]") as HTMLButtonElement;
  lock.click();
  check("the lock row locks the layout and says so", isLocked() && /layout locked/.test(lock.textContent!) && lock.classList.contains("open"));
  lock.click();
  check("...and unlocks", !isLocked() && /layout unlocked/.test(lock.textContent!));
}
{
  const micRow = row("glyph:mic")!;
  check("mic row starts unlit", !micRow.classList.contains("open"));
  micRow.click(); await tick();
  check("mic row click flips the mic and relights", micRow.classList.contains("open"));
  micRow.click(); await tick();
}

console.log("DOCK — leaving arrange mode");
getFrame("chat")!.show();
window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
check("Esc closes the menu", menu().hidden === true && !document.body.classList.contains("arranging"));
check("...and does NOT close the open frames (the menu owned Esc)", getFrame("chat")!.visible);
toggleEMenu(true);
getFrame("chat")!.el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
check("a pointerdown on a frame keeps arranging", menu().hidden === false);
dock().dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
check("a pointerdown on the rail keeps arranging", menu().hidden === false);
document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, clientX: 500, clientY: 500 }));
check("a pointerdown out in the world ends it", menu().hidden === true);

console.log("DOCK — late tenants");
settingsFrame();
check("settingsFrame() registers its own rail entry wearing gear-six", !!btn("settings") && wears(btn("settings")!.innerHTML, "gear-six"));
paintPresence("away");
check("paintPresence stamps the profile button", btn("profile")!.dataset.presence === "away" && btn("profile")!.title === "profile · away");
bus.emit("presence:me", "here");
check("...and presence:me on the bus drives it", btn("profile")!.dataset.presence === "here");


console.log("DOCK — the badge the dock button carries (the title bar is hidden at rest)");
{ const f = getFrame("chat")!;
  f.badge("3");
  const db = document.querySelector('#dock button[data-toggles="chat"] .dk-badge');
  check("badge() mirrors onto the DOCK button, not only the title bar", !!db && db!.innerHTML === "3", db?.innerHTML ?? "(no .dk-badge)");
  check("...and the title bar carries it too", f.el.querySelector(".fr-badge")?.innerHTML === "3");
  f.badge("7");
  check("a re-badge updates in place (one node, new text)", document.querySelectorAll('#dock button[data-toggles="chat"] .dk-badge').length === 1 && document.querySelector('#dock button[data-toggles="chat"] .dk-badge')!.innerHTML === "7");
  f.badge("");
  check("clearing the badge removes BOTH", !document.querySelector('#dock button[data-toggles="chat"] .dk-badge') && !f.el.querySelector(".fr-badge")); }

console.log("DOCK — Tab OPENS the people pane, never closes it (ui.js togglePeopleHere)");
{ // togglePeopleHere reads the chat frame's side-pane markup (chat.js:696: a
  // .chat-cols that carries side-closed, and the .chat-side-tog that flips it).
  // initChat builds that; here we mirror just those two nodes onto the frame
  // this suite already made, so the REAL togglePeopleHere runs against the real
  // class contract instead of a recorder.
  const f = getFrame("chat")!;
  // TWO decoys, because there are two ways to get this wrong and a decoy only
  // binds the scope it sits outside of:
  //   outer — elsewhere in the document (catches a document-wide lookup)
  //   inner — INSIDE this frame's body, BEFORE the real cols (catches any
  //           unbounded-depth lookup from the body, which is what registerPanel
  //           actually enables: mount(body, frame) puts a mod's markup in here).
  // chat.js writes .chat-cols as a DIRECT child of the body and the toggler as
  // its child, so only a `:scope >` pair addresses the real pane.
  const outer = document.createElement("div");
  outer.innerHTML = `<div class="chat-cols side-closed"><button class="chat-side-tog"></button></div>`;
  document.body.prepend(outer);
  let decoyClicks = 0;
  (outer.querySelector(".chat-side-tog") as HTMLElement).onclick = () => { decoyClicks++; };

  // THREE decoys. The third is the one rounds 7-9 kept missing: chat.js nests
  // the toggler INSIDE .chat-cols, so a mod's toggler can sit inside the REAL
  // cols — and then an unbounded `cols.querySelector('.chat-side-tog')` finds
  // the mod's before the chat's. Only `:scope >` on BOTH hops addresses the
  // real pane; a decoy that is merely a sibling cannot see that mistake.
  // Decoy ORDER — corrected by the ELEVENTH review, which falsified what this
  // comment used to claim. I had written that a mod can only mount as a LATER
  // sibling because initChat writes the chat's cols first. FALSE: mods.js:88
  // hands a mod `makeFrame`, and frames.js:234 returns an EXISTING frame by
  // bare id — so `makeFrame('chat')` returns the LIVE chat frame, and a local
  // mod is an in-page ES module with the whole document (mods.js:5-8). It can
  // PREPEND. So a decoy before the real cols is not a bent fixture; it is the
  // product's reachable DOM, and it is what binds the first hop.
  f.body.innerHTML = `<div class="chat-cols side-closed">`
    +   `<div class="mod-inside"><button class="chat-side-tog"></button></div>`
    +   `<button class="chat-side-tog"></button>`
    + `</div>`;
  const late = document.createElement("div");   // a LATER direct-child sibling, as a mod would mount
  late.className = "chat-cols side-closed";
  late.innerHTML = `<button class="chat-side-tog"></button>`;
  f.body.append(late);
  (late.querySelector(".chat-side-tog") as HTMLElement).onclick = () => { decoyClicks++; };
  // Capture the node initChat built BEFORE any decoy exists. Anchoring on a
  // re-query would find the prepended decoy (also a direct child, and first) —
  // the fixture would then measure the same wrong node the mutant picks, and
  // the mutation survives. This is what let M-A through until round 11.
  const real = f.body.querySelector(":scope > .chat-cols") as HTMLElement;
  // Mirror initChat's MECHANISM, not just its markup: chat.js captures the
  // nodes as it writes them and hangs the accessor on the frame it built
  // (chat.js, right after sideEls). togglePeopleHere reads that. Handing it `real`
  // is legitimate here precisely because `real` was captured before any decoy
  // exists — the same discipline this block already uses above.
  // This suite never imports chat.js — makeFrame/getFrame come from frames.js
  // and the markup above is hand-mirrored — so this stand-in can bind WHICH
  // node togglePeopleHere addresses (ownership/order) but NOT the lifetime guard
  // on chat.js's own read path: a ?.isConnected here would only test this
  // closure against itself. Lifetime is bound in chat-markdown, which drives
  // real initChat / sideEl / paintSide.
  (f as any).sidePane = (k: string) => (k === "cols" ? real
    : k === "tog" ? real.querySelector(":scope > .chat-side-tog") : null);
  const pre = document.createElement("div");   // a mod PREPENDING via makeFrame('chat')
  pre.className = "chat-cols side-closed";
  pre.innerHTML = `<button class="chat-side-tog"></button>`;
  f.body.prepend(pre);
  (pre.querySelector(".chat-side-tog") as HTMLElement).onclick = () => { decoyClicks++; };
  const modWrap = document.createElement("div"); modWrap.className = "mod-panel";
  modWrap.innerHTML = `<div class="chat-cols side-closed"><button class="chat-side-tog"></button></div>`;
  f.body.append(modWrap);
  const inner = modWrap;
  (inner.querySelector(".chat-side-tog") as HTMLElement).onclick = () => { decoyClicks++; };
  const nested = f.body.querySelector(".mod-inside")!;
  (nested.querySelector(".chat-side-tog") as HTMLElement).onclick = () => { decoyClicks++; };
  const cols = () => real;                     // the node initChat built, not a re-query
  const tog = real.querySelector(":scope > .chat-side-tog") as HTMLElement;
  let clicks = 0;
  tog.onclick = () => { clicks++; cols().classList.toggle("side-closed"); };

  f.show(); clicks = 0;
  ui.togglePeopleHere();
  check("pane closed, chat open: Tab opens the pane", !cols().classList.contains("side-closed") && clicks === 1, `${cols().className} clicks=${clicks}`);

  clicks = 0;
  ui.togglePeopleHere();
  check("pane already open: Tab leaves it open and does NOT toggle", !cols().classList.contains("side-closed") && clicks === 0, `${cols().className} clicks=${clicks}`);

  // review #5's case: pane saved OPEN while the chat frame is hidden —
  // showing the chat IS the open, so the toggler must not fire.
  f.hide(); clicks = 0;
  ui.togglePeopleHere();
  check("chat hidden + pane saved open: Tab shows chat, pane stays open", f.visible && !cols().classList.contains("side-closed") && clicks === 0, `${cols().className} clicks=${clicks}`);

  // and the inverse still works from hidden+closed
  cols().classList.add("side-closed"); f.hide(); clicks = 0;
  ui.togglePeopleHere();
  check("chat hidden + pane closed: Tab shows chat AND opens the pane", f.visible && !cols().classList.contains("side-closed"), `${cols().className} clicks=${clicks}`);

  // the decoy must never have been touched: Tab addresses the CHAT frame's pane
  check("Tab never reaches a mod panel carrying the same public classes — outside the body OR nested inside it", decoyClicks === 0
    && outer.querySelector(".chat-cols")!.classList.contains("side-closed")
    && inner.querySelector(".chat-cols")!.classList.contains("side-closed"), `decoyClicks=${decoyClicks}`);
  check("...including a mod toggler nested INSIDE the real cols (chat.js nests it there)", decoyClicks === 0, `decoyClicks=${decoyClicks}`);

  outer.remove(); }

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
