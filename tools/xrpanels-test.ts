// xrpanels — the VR seam of the schema factory, run headless.
//
//   bun tools/xrpanels-test.ts
//
// renderCanvas paints fields to a 2D canvas and returns HIT REGIONS; xr.js
// turns a laser UV-hit into a region and dispatches the SAME edit() the
// desktop calls. No browser here: the 2D context is a recorder (fillText /
// fillRect / strokeRect are no-ops that count), because what this binds is
// the REGION LAYOUT and what each region dispatches — the part that, until
// tonight, had no test while two review rounds found bugs in it (VR
// steppers reporting {axis, delta} objects; list rows dispatching 'row'
// instead of the list's key).

import { GlobalRegistrator } from "@happy-dom/global-registrator";
GlobalRegistrator.register();

// a 2D context that records what was asked of it and never draws
const calls: string[] = [];
(HTMLCanvasElement.prototype as any).getContext = function () {
  const noop = (name: string) => (..._a: unknown[]) => { calls.push(name); };
  return { fillText: noop("fillText"), fillRect: noop("fillRect"), strokeRect: noop("strokeRect"),
    beginPath: noop("beginPath"), moveTo: noop("moveTo"), lineTo: noop("lineTo"), stroke: noop("stroke"),
    measureText: (t: string) => ({ width: t.length * 8 }), fillStyle: "", strokeStyle: "", font: "", lineWidth: 1 };
};

const { renderCanvas, hitRegion, resolveDelta } = await import("../client/lib/panels.js");

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  else { fail++; console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? ` — ${detail}` : ""}`); }
};
const W = 522, ROW = 44;
const paint = (fields: any[]) => { const c = document.createElement("canvas"); const regions = renderCanvas(c, fields, { width: W, rowH: ROW, title: "t" }); return { c, regions }; };
const at = (regions: any[], action: string) => regions.filter((r) => r.action === action);

console.log("\nsteppers: two regions per number, deltas on the WIRE scale:");
{
  const { regions } = paint([{ t: "num", k: "ch:light.intensity", value: 16, step: 1 }, { t: "num", k: "ch:pos.yaw", value: 0, step: 5, deg: true }]);
  const inten = at(regions, "ch:light.intensity");
  check("a num paints − and + regions", inten.length === 2 && inten[0].payload.delta < 0 && inten[1].payload.delta > 0, JSON.stringify(inten));
  check("a deg field's delta is in radians (5° = 0.0873)", Math.abs(at(regions, "ch:pos.yaw")[1].payload.delta - 5 * Math.PI / 180) < 1e-6, JSON.stringify(at(regions, "ch:pos.yaw")));
  check("…and resolveDelta turns it into the number the DOM would send", resolveDelta([{ t: "num", k: "ch:light.intensity", value: 16 }], "ch:light.intensity", inten[1].payload) === 17);
}

console.log("\ndisabled fields paint but take NO hits; driven ones keep theirs:");
{
  const { regions } = paint([{ t: "num", k: "a", value: 1, disabled: true }, { t: "num", k: "b", value: 1, driven: "motion" }, { t: "check", k: "c", value: true, disabled: true }, { t: "enum", k: "d", value: "x", options: [{ v: "x" }, { v: "y" }], disabled: true }]);
  check("disabled num: 0 regions", at(regions, "a").length === 0, JSON.stringify(at(regions, "a")));
  check("driven num: still 2 regions", at(regions, "b").length === 2);
  check("disabled check and enum: 0 regions", at(regions, "c").length === 0 && at(regions, "d").length === 0);
  check("the disabled rows were still PAINTED (labels drawn)", calls.filter((c) => c === "fillText").length > 0);
}

console.log("\nlists and trees dispatch the keys the desktop dispatches:");
{
  const { regions } = paint([
    { t: "list", k: "ed:sockets.slots", rows: [{ id: "seat", label: "seat", actions: [{ k: "ed:sockets.del", label: "✕", danger: true }] }] },
    { t: "tree", k: "sel", rows: [{ id: "truck", label: "truck", depth: 0, kids: 1, open: true, locked: false }, { id: "crate", label: "crate", depth: 1, kids: 0, locked: true }] },
  ]);
  check("a KEYED list row dispatches the list's key (not 'row')", at(regions, "ed:sockets.slots").length === 1 && at(regions, "ed:sockets.slots")[0].payload === "seat" && at(regions, "row").length === 0);
  check("…and its ✕ action carries the action key + row id", at(regions, "ed:sockets.del")[0]?.payload === "seat");
  check("tree rows dispatch the tree's key with the row id", at(regions, "sel").map((r) => r.payload).join() === "truck,crate");
  check("a row with kids gets a disclosure region → edit('open', id)", at(regions, "open").length === 1 && at(regions, "open")[0].payload === "truck");
  check("every tree row gets a lock region", at(regions, "lock").map((r) => r.payload).join() === "truck,crate");
  const disc = at(regions, "open")[0], row = at(regions, "sel")[0];
  check("the disclosure region is listed BEFORE its row (first match wins in hitRegion)", regions.indexOf(disc) < regions.indexOf(row));
}

console.log("\nfolded groups skip their rows; buttons and colours have one region each:");
{
  const { regions } = paint([{ t: "group", k: "g", label: "G", open: false }, { t: "num", k: "hidden", value: 1 }, { t: "group", k: "h", label: "H", open: true }, { t: "btn", k: "go", label: "go" }, { t: "color", k: "col", value: 0xff0000 }]);
  check("a closed group's rows are not painted (no regions)", at(regions, "hidden").length === 0);
  check("the group header itself folds → edit('fold', k)", at(regions, "fold").map((r) => r.payload).join() === "g,h");
  check("a btn is one region with no payload", at(regions, "go").length === 1 && at(regions, "go")[0].payload === undefined);
  check("a colour field offers the 8-swatch palette as regions", at(regions, "col").length === 8 && at(regions, "col").every((r) => typeof r.payload === "number"));
}

console.log("\nref field: paints a pick region on the VR quad, and a clear region when filled:");
{
  const empty = paint([{ t: "ref", k: "ed:look.target", label: "target", value: null }]);
  const clr0 = empty.regions.filter((r) => r.action === "ed:look.target" && r.payload === null);
  check("an empty ref paints ONE region (arm the pick), no clear", at(empty.regions, "ed:look.target").length === 1 && clr0.length === 0, JSON.stringify(empty.regions.filter((r) => r.action === "ed:look.target")));
  const filled = paint([{ t: "ref", k: "ed:look.target", label: "target", value: "lamp3" }]);
  const regs = filled.regions.filter((r) => r.action === "ed:look.target");
  check("a filled ref paints TWO regions: the name (arm) and a ✕ (payload null)", regs.length === 2 && regs.some((r) => r.payload === null), JSON.stringify(regs));
}
console.log("\nhitRegion: a UV maps to the region under it, top-down:");
{
  const { c, regions } = paint([{ t: "btn", k: "first", label: "first" }, { t: "btn", k: "second", label: "second" }]);
  const r1 = at(regions, "first")[0], r2 = at(regions, "second")[0];
  const uv = (r: any) => [(r.x + r.w / 2) / c.width, (r.y + r.h / 2) / c.height];
  check("the first button's centre resolves to it", hitRegion(regions, c, ...uv(r1))?.action === "first");
  check("the second's to it (v measured from the top)", hitRegion(regions, c, ...uv(r2))?.action === "second");
  check("empty space resolves to nothing", hitRegion(regions, c, 0.99, 0.99) === null);
  // main #185 (3ac0430) slimmed the title to a 30px always-on header, no longer a full row
  check("the canvas grew to fit its rows (30px title + 2 rows + pad)", c.height === 30 + ROW * 2 + 24, String(c.height));
}

console.log("\nfields added 09-23 paint on the quad without throwing, and stay display-only where they must:");
{
  const at = (regions: any[], k: string) => regions.filter((r: any) => r.action === k);
  let threw = "";
  let out: any = null;
  try {
    out = paint([
      { t: "json", k: "ed:comp.recipe", label: "recipe", value: '{\n  "wood": 3\n}' },
      { t: "log", k: "clines", lines: ["02:36:19  bell hung", "02:36:24  still here, check #1"] },
      { t: "log", k: "empty", lines: [], empty: "(console empty)" },
      { t: "btn", k: "remove", label: "remove", danger: true, vrOnly: true },
      { t: "num", k: "ed:light.intensity", label: "brightness", value: 40, def: 16, step: 1 },
    ]);
  } catch (e: any) { threw = String(e?.stack ?? e); }
  check("json + log + a vrOnly button + a num with def paint without throwing", !threw && !!out, threw.slice(0, 200));
  if (out) {
    check("json is display-only on the quad (no keyboard in a headset): no region", at(out.regions, "ed:comp.recipe").length === 0);
    check("log is display-only: no region", at(out.regions, "clines").length === 0 && at(out.regions, "empty").length === 0);
    check("the vrOnly remove button IS on the quad, with its region (desktop skips it; a headset has no Del)", at(out.regions, "remove").length === 1);
    check("a num with def keeps its two stepper regions (↺ is desktop-only for now)", at(out.regions, "ed:light.intensity").length === 2);
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
