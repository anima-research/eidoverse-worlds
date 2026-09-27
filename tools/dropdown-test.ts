// dropdown — the house <select> skin, run headless against the REAL module.
//
//   bun tools/dropdown-test.ts
//
// The contract dropdown.js makes with every panel: the <select> stays the VALUE STORE (panels keep reading
// sel.value and listening for 'change' exactly as before), the button is only a skin. So the assertions are
// about that seam — a row click writes the select and dispatches ONE bubbling 'change'; arrow keys on the
// closed button step the value and dispatch too; Esc / an outside pointerdown / a second click close the pop;
// `sel.value = x` from code repaints the label synchronously (the value setter is wrapped); options rebuilt
// by a panel repaint the label on the next tick (the MutationObserver); data-native opts out; initDropdowns
// skins selects that land later inside chrome, and only inside chrome.

import { GlobalRegistrator } from "@happy-dom/global-registrator";
GlobalRegistrator.register({ width: 1000, height: 700 });

// happy-dom caches `selectedOptions` and does not refresh it after `sel.value = x` followed by
// `sel.selectedIndex = n` (options[n].selected reads true, selectedOptions[0] still names the old one).
// The module's label() reads selectedOptions[0], which is right in a browser — derive it from `options`
// here so the harness can see what the product paints. A shim of the DOM, never of the module.
Object.defineProperty(HTMLSelectElement.prototype, "selectedOptions", {
  get() { return [...this.options].filter((o: HTMLOptionElement) => o.selected); }, configurable: true,
});

const { skinSelect, initDropdowns } = await import("../client/lib/dropdown.js");

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  else { fail++; console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? ` — ${detail}` : ""}`); }
};
const tick = () => new Promise((r) => setTimeout(r, 0));
// the observer delivers on happy-dom's microtask queue, which under bun does not always drain before a
// setTimeout(0) — so positive observer assertions wait for the DELIVERY (bounded), not for a guessed tick
const settle = async (pred: () => boolean, ms = 250) => { const t0 = Date.now(); while (!pred() && Date.now() - t0 < ms) await tick(); return pred(); };

document.body.innerHTML = `<div class="frame" id="host">
  <select id="s"><option value="off">off</option><option value="a">alpha</option><option value="b" disabled>beta</option><option value="c">gamma</option></select>
</div>`;
const sel = document.getElementById("s") as HTMLSelectElement;
const btn = () => sel.nextElementSibling as HTMLButtonElement;
const label = () => btn().querySelector(".dd-label")?.textContent;
const pop = () => document.querySelector(".dd-pop") as HTMLElement | null;
const rows = () => [...(pop()?.querySelectorAll(".dd-opt") ?? [])] as HTMLButtonElement[];
const rowFor = (text: string) => rows().find((r) => r.textContent === text)!;
let changes = 0;
sel.addEventListener("change", () => changes++);
// panels listen on their FRAME, not the select — the event must bubble
let bubbled = 0;
document.getElementById("host")!.addEventListener("change", () => bubbled++);

console.log("DROPDOWN — skin");
skinSelect(sel);
check("a .dd button follows the select", btn()?.classList.contains("dd"), btn()?.outerHTML);
check("the select is hidden-by-class but still in the DOM as the store", sel.classList.contains("dd-native") && sel.isConnected);
check("the label reads the selected option", label() === "off", String(label()));
check("aria: haspopup=listbox, expanded=false", btn().getAttribute("aria-haspopup") === "listbox" && btn().getAttribute("aria-expanded") === "false");
skinSelect(sel);
check("skinning twice adds no second button", document.querySelectorAll("button.dd").length === 1, String(document.querySelectorAll("button.dd").length));

console.log("DROPDOWN — the value store");
sel.value = "a";
check("sel.value = x from code repaints the label SYNCHRONOUSLY", label() === "alpha", String(label()));
check("...and the store reads back", sel.value === "a" && sel.selectedIndex === 1, sel.value);
check("...without firing change (code writes are silent, as native)", changes === 0, String(changes));

console.log("DROPDOWN — open + row click");
btn().click();
check("clicking the button opens one .dd-pop", !!pop() && document.querySelectorAll(".dd-pop").length === 1);
check("aria-expanded flips to true", btn().getAttribute("aria-expanded") === "true");
check("one row per option, in order", rows().map((r) => r.textContent).join() === "off,alpha,beta,gamma", rows().map((r) => r.textContent).join());
check("the selected option's row is .on", rowFor("alpha").classList.contains("on") && !rowFor("off").classList.contains("on"));
check("a disabled option's row is disabled", rowFor("beta").disabled && !rowFor("gamma").disabled);
check("the .on row takes focus", document.activeElement === rowFor("alpha"), document.activeElement?.outerHTML);
changes = 0; bubbled = 0;
rowFor("gamma").click();
check("a row click writes the store", sel.value === "c", sel.value);
check("...dispatches exactly ONE change", changes === 1, String(changes));
check("...which bubbles to the frame", bubbled === 1, String(bubbled));
check("...repaints the label", label() === "gamma", String(label()));
check("...and closes the pop", !pop() && btn().getAttribute("aria-expanded") === "false");
btn().click();
changes = 0;
rowFor("gamma").click();
check("clicking the already-selected row fires NO change, still closes", changes === 0 && !pop(), `${changes} changes, pop=${!!pop()}`);

console.log("DROPDOWN — arrow keys on the closed button");
const key = (k: string) => { const e = new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }); btn().dispatchEvent(e); return e; };
sel.value = "off"; changes = 0;
let e = key("ArrowDown");
check("ArrowDown steps to the next option and fires change", sel.value === "a" && changes === 1, `${sel.value} / ${changes}`);
check("...repaints the label and swallows the key", label() === "alpha" && e.defaultPrevented, String(label()));
check("...without opening a pop", !pop());
key("ArrowUp");
check("ArrowUp steps back", sel.value === "off" && changes === 2, `${sel.value} / ${changes}`);
e = key("ArrowUp");
check("ArrowUp at the first option is a no-op (no change, key not swallowed)", sel.value === "off" && changes === 2 && !e.defaultPrevented, `${sel.value} / ${changes}`);
sel.value = "c"; changes = 0;
e = key("ArrowDown");
check("ArrowDown at the last option is a no-op", sel.value === "c" && changes === 0 && !e.defaultPrevented, `${sel.value} / ${changes}`);

console.log("DROPDOWN — closing");
btn().click();
window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
check("Esc closes the pop", !pop() && btn().getAttribute("aria-expanded") === "false");
btn().click();
document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
check("a pointerdown outside closes the pop", !pop());
btn().click();
pop()!.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
check("a pointerdown INSIDE the pop keeps it open", !!pop());
btn().click();
check("a second click on the button toggles it closed", !pop());
check("escape-claim hook: an open pop is what frames.js looks for (.dd-pop)", (btn().click(), !!document.querySelector(".dd-pop")));
btn().click();

console.log("DROPDOWN — MutationObserver repaint");
sel.innerHTML = `<option value="x">ex</option><option value="y" selected>why</option>`;
check("a rebuilt option list repaints the label once the observer delivers", await settle(() => label() === "why"), String(label()));
// (the observer also mirrors sel.disabled onto the button; the house harness's happy-dom 20.11.1 reports NO
// attribute records on a <select> — only childList — so that mirror is proven through the synchronous
// repaint below rather than asserted on a record the harness cannot deliver)
sel.disabled = true; sel.value = "y";
check("sel.disabled is mirrored onto the button at the next repaint", btn().disabled);
sel.disabled = false; sel.value = "y";
check("...and clears", !btn().disabled);
sel.value = "x";
sel.dispatchEvent(new Event("change", { bubbles: true }));
check("a native change event repaints too", label() === "ex", String(label()));

console.log("DROPDOWN — mode accent + opt-out");
{
  const m = document.createElement("select");
  m.setAttribute("data-mode", "");
  m.innerHTML = `<option value="off">off</option><option value="fast">fast</option>`;
  document.getElementById("host")!.appendChild(m);
  skinSelect(m);
  const mb = m.nextElementSibling as HTMLButtonElement;
  check("data-mode at its default wears no .set", !mb.classList.contains("set"));
  m.value = "fast";
  check("data-mode on a live choice wears .set", mb.classList.contains("set"));
  m.value = "off";
  check("...and drops it back at off", !mb.classList.contains("set"));
  const n = document.createElement("select");
  n.setAttribute("data-native", "");
  n.innerHTML = `<option>a</option>`;
  document.getElementById("host")!.appendChild(n);
  skinSelect(n);
  check("data-native opts out: no button, no dd-native class", !(n.nextElementSibling?.classList.contains("dd")) && !n.classList.contains("dd-native"));
}

console.log("DROPDOWN — initDropdowns scope");
{
  document.body.insertAdjacentHTML("beforeend", `<div id="world"><select id="bare"><option>a</option></select></div>`);
  initDropdowns();
  const bare = document.getElementById("bare") as HTMLSelectElement;
  check("a select OUTSIDE chrome is left native", !bare.dataset.skinned);
  const late = document.createElement("select");
  late.innerHTML = `<option>late</option>`;
  document.getElementById("host")!.appendChild(late);
  await tick();
  check("a select added LATER inside a .frame is skinned by the observer", late.dataset.skinned === "1" && late.nextElementSibling?.classList.contains("dd"));
  const lateOut = document.createElement("select");
  lateOut.innerHTML = `<option>x</option>`;
  document.getElementById("world")!.appendChild(lateOut);
  await tick();
  check("a select added later OUTSIDE chrome stays native", !lateOut.dataset.skinned);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
