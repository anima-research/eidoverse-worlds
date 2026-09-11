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
  { id: "who", label: "👥" },          // upstream lists it; no frame stands behind it here
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
check("dock order follows the entry list", order().join() === "profile,chat,world,who,emotes,debug,edit", order().join());
check("built-ins are pinned by default: chat's button shows while its frame is closed",
  !getFrame("chat")!.visible && btn("chat")!.hidden === false);
check("an entry with no frame and no pin ('who') is hidden", btn("who")!.hidden === true);
check("a gated action entry is hidden while its gate is closed", btn("edit")!.hidden === true);
editGate = true; bus.emit("frames");
check("...and shows once the gate opens (pinned by default)", btn("edit")!.hidden === false);
btn("edit")!.click();
check("clicking the wrench fires its action and lights it", editFired === 1 && btn("edit")!.classList.contains("on"));
btn("edit")!.click();
check("...and again to unlight", editFired === 2 && !btn("edit")!.classList.contains("on"));
check("window.eido.ui.registerPanel is the exported seam", (window as any).eido?.ui?.registerPanel === registerPanel);

console.log("DOCK — EMOJI_ICON: rail chrome never rides emoji");
const RAIL: [string, string, string][] = [["chat", "💬", "chat-circle"], ["world", "🧱", "hammer"], ["emotes", "👋", "hand-waving"], ["debug", "🐞", "bug"]];
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
check("every window with a frame has a row; 'who' (no frame) has none", ["chat", "world", "emotes", "debug", "modx"].every((id) => !!row(id)) && !row("who"));
check("the wrench has a row while gated open", !!row("edit"));
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

console.log("DOCK — Tab OPENS the people pane, never closes it (ui.js togglePeople)");
{ // togglePeople reads the chat frame's side-pane markup (chat.js:815: a
  // .chat-cols that carries side-closed, and the .chat-side-tog that flips it).
  // initChat builds that; here we mirror just those two nodes onto the frame
  // this suite already made, so the REAL togglePeople runs against the real
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

  f.body.innerHTML = `<div class="mod-panel"><div class="chat-cols side-closed"><button class="chat-side-tog"></button></div></div>`
    + `<div class="chat-cols side-closed"><button class="chat-side-tog"></button></div>`;
  const inner = f.body.querySelector(".mod-panel")!;
  (inner.querySelector(".chat-side-tog") as HTMLElement).onclick = () => { decoyClicks++; };
  const cols = () => f.body.querySelector(":scope > .chat-cols")!;
  const tog = cols().querySelector(":scope > .chat-side-tog") as HTMLElement;
  let clicks = 0;
  tog.onclick = () => { clicks++; cols().classList.toggle("side-closed"); };

  f.show(); clicks = 0;
  ui.togglePeople();
  check("pane closed, chat open: Tab opens the pane", !cols().classList.contains("side-closed") && clicks === 1, `${cols().className} clicks=${clicks}`);

  clicks = 0;
  ui.togglePeople();
  check("pane already open: Tab leaves it open and does NOT toggle", !cols().classList.contains("side-closed") && clicks === 0, `${cols().className} clicks=${clicks}`);

  // review #5's case: pane saved OPEN while the chat frame is hidden —
  // showing the chat IS the open, so the toggler must not fire.
  f.hide(); clicks = 0;
  ui.togglePeople();
  check("chat hidden + pane saved open: Tab shows chat, pane stays open", f.visible && !cols().classList.contains("side-closed") && clicks === 0, `${cols().className} clicks=${clicks}`);

  // and the inverse still works from hidden+closed
  cols().classList.add("side-closed"); f.hide(); clicks = 0;
  ui.togglePeople();
  check("chat hidden + pane closed: Tab shows chat AND opens the pane", f.visible && !cols().classList.contains("side-closed"), `${cols().className} clicks=${clicks}`);

  // the decoy must never have been touched: Tab addresses the CHAT frame's pane
  check("Tab never reaches a mod panel carrying the same public classes — outside the body OR nested inside it", decoyClicks === 0
    && outer.querySelector(".chat-cols")!.classList.contains("side-closed")
    && inner.querySelector(".chat-cols")!.classList.contains("side-closed"), `decoyClicks=${decoyClicks}`);
  outer.remove(); }

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
