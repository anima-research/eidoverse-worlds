// test/client/colour-picker-test.ts — the Inspector's colour field is a picker made of solid cells (R 10-12), its DOM rows
// under happy-dom: edit/widgets.js WIDGETS.color.dom, the edit it commits and the recents it keeps. The page's own wiring
// (the Inspector's Light card recolouring a real light) is test/client/colour-picker-bench.ts, in headless Chromium (G4-050).
//   BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun test/client/colour-picker-test.ts
// @ts-nocheck
import path from "node:path";
import { ENGINE } from "../gate/common.ts";
import { suite } from "../gate/suite.ts";

const { GlobalRegistrator } = await import("@happy-dom/global-registrator");
GlobalRegistrator.register();
try { localStorage.removeItem("eido-recent-colours"); } catch { /* none */ }
const W = await import(path.join(ENGINE, "client/lib/edit/widgets.js"));
const SU = suite("colour-picker");
const edits: [string, number][] = [];
const field = (value: number) => ({ t: "color", k: "light.color", label: "colour", value });
const build = (value: number) => { const row = document.createElement("div"); document.body.append(row);
  W.WIDGETS.color.dom(field(value), { row, setLabel: () => {}, edit: (k: string, v: number) => edits.push([k, v]), el: W.el }); return row; };
const $ = (row: Element, sel: string) => row.querySelector(sel) as any, cells = (row: Element) => [...row.querySelectorAll(".sp-pick-grid .sp-pick-cell")] as any[];

let row = build(0xffd9a0);
SU.ok($(row, ".sp-picker").hidden && !$(row, "input[type=color]") && $(row, ".sp-color-sw").style.background === "#ffd9a0", "CP1 closed at first: a swatch in the lamp's colour, no native input", $(row, ".sp-color-sw").style.background);
$(row, ".sp-color-sw").click();
SU.ok(!$(row, ".sp-picker").hidden && cells(row).length === 72 && !!$(row, ".sp-pick-hex"), "CP2 the swatch opens 72 solid cells (a grey ramp + 12 hues × 5 tones) and a hex field", cells(row).length);
const greys = cells(row).slice(0, 12).map((c) => +c.dataset.c);
SU.ok(greys[0] === 0xffffff && greys[11] === 0, "CP3 the first row runs white to black", greys);
const c = cells(row)[12 + 12 * 2 + 4], pick = +c.dataset.c, before = edits.length; c.click();
SU.ok(edits.length === before + 1 && JSON.stringify(edits.at(-1)) === JSON.stringify(["light.color", pick]), "CP4 a cell click commits that cell's colour, once", [edits.length - before, edits.at(-1)]);
// the Inspector repaints from the folded state: an update with the new value, and a rebuilt row for the same field
row.update(field(pick)); const rebuilt = build(pick);
const marked = (r: Element) => +$(r, ".sp-pick-grid .sp-pick-cell.on")?.dataset.c, recent0 = (r: Element) => +$(r, ".sp-pick-recent .sp-pick-cell")?.dataset.c;
SU.ok(!$(row, ".sp-picker").hidden && marked(row) === pick && recent0(row) === pick && !$(rebuilt, ".sp-picker").hidden && marked(rebuilt) === pick,
  "CP5 …the picker stays open through the repaint (and a rebuild), marks the cell, and the colour leads the recents", [marked(row), recent0(row), marked(rebuilt)]);
rebuilt.remove();
const type = (v: string) => { const h = $(row, ".sp-pick-hex"); h.value = v; h.dispatchEvent(new Event("change")); };
type("#123456"); const a = edits.at(-1)?.[1];
type("#abc"); const b = edits.at(-1)?.[1];
SU.ok(a === 0x123456 && b === 0xaabbcc, "CP6 a typed hex commits it; a three-digit hex is the CSS shorthand", [a, b]);
const n = edits.length; type("banana");
SU.ok(edits.length === n && $(row, ".sp-pick-hex").value === "#aabbcc", "CP7 nonsense in the hex field commits nothing, and the field shows the colour again", [edits.length - n, $(row, ".sp-pick-hex").value]);
cells(row)[12 + 12 * 2 + 4].click();   // the first pick again: it moves to the front, not a second copy
const recents = [...row.querySelectorAll(".sp-pick-recent .sp-pick-cell")].map((x: any) => +x.dataset.c);
SU.ok(JSON.stringify(recents.slice(0, 3)) === JSON.stringify([pick, 0xaabbcc, 0x123456]) && new Set(recents).size === recents.length, "CP8 recents are newest first, no repeats", recents);
SU.ok(JSON.parse(localStorage.getItem("eido-recent-colours") ?? "[]")[0] === pick, "CP9 …and kept for this viewer", localStorage.getItem("eido-recent-colours"));
$(row, ".sp-color-sw").click();
SU.ok($(row, ".sp-picker").hidden, "CP10 the swatch closes it again");
row.update({ ...field(pick), disabled: true }); $(row, ".sp-color-sw").click(); const m = edits.length; cells(row)[0].click();
SU.ok($(row, ".sp-picker").hidden && edits.length === m, "CP11 a disabled field doesn't open, and commits nothing", [$(row, ".sp-picker").hidden, edits.length - m]);
SU.done();
