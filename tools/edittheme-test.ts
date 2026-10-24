// edittheme — edit mode's look holds its durable promises (DESIGN-SPEC 2026-09-30).
//
//   bun tools/edittheme-test.ts
//
// What this binds, all headless (a recording 2D context; three's non-GPU build via the core stub):
//   A. ONE source of tokens: the `--e-*` block in client/index.html equals client/lib/edittheme.js,
//      key for key — change one without the other and this goes red.
//   B. The VR painter (panels.js renderCanvas, theme 'edit' → editpaint.js) keeps the VR floor:
//      every hit target >= 34 canvas px tall; no line < 2 px (stroke width after the transform, and
//      no hairline fillRect); every glyph >= 17 px; no pictograph ever handed to fillText.
//   C. It dispatches what the legacy painter dispatches (same actions and payloads), and a disabled
//      field still takes no hits.
//   D. The quad's texture is sRGB (xrpanels makePanel) — measured on the real module, not grepped.
//   E. No pictograph in edit chrome's own sources (tool rail, build bar, tree toggles).
//   F. Text colours on their surfaces meet 4.5:1.
import { fileURLToPath } from "node:url";
import { plugin } from "bun";
import { readFileSync } from "node:fs";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
plugin({
  name: "edittheme-stubs",
  setup(b) {
    b.onResolve({ filter: /^\.\/core\.js$/ }, () => ({ path: here("./core-stub.mjs") }));
    b.onResolve({ filter: /^\.\/base\.js$/ }, () => ({ path: here("./core-stub.mjs") }));
    b.onResolve({ filter: /^\.\/domquad\.js$/ }, () => ({ path: here("./xrpanels-domquad-stub.mjs") }));
    // main's makePanel swaps the quad's material through quadcolour.js (a MeshBasicNodeMaterial: three's WebGPU
    // build only, absent from the headless three.module.js). D asks about the texture, which the swap keeps as
    // its map — so the swap is an identity here; its own colour is tools/xr-quad-colour-probe.mjs's to measure.
    b.onResolve({ filter: /^\.\/quadcolour\.js$/ }, () => ({ path: "quadcolour", namespace: "edittheme-stub" }));
    b.onLoad({ filter: /.*/, namespace: "edittheme-stub" }, () => ({ contents: "export const quadMaterial = () => {};", loader: "js" }));
  },
});
GlobalRegistrator.register();
(globalThis as any).Path2D ??= class Path2D { constructor(public d?: string) {} };
(globalThis as any).requestAnimationFrame ??= (f: any) => setTimeout(f, 0);

// a 2D context that records what the painter asked of it, tracking the transform so a stroke's
// width is measured in CANVAS px (icons.js strokes inside a scale)
type Rec = { texts: { s: string; px: number; color?: string }[]; strokes: number[]; hairlines: number[][]; strokeColors?: string[] };
function recorder(rec: Rec) {
  let sc = 1; const stack: number[] = [];
  const ctx: any = {
    fillStyle: "", strokeStyle: "", font: "400 17px x", lineWidth: 1, textAlign: "left", textBaseline: "alphabetic", lineCap: "", lineJoin: "",
    save() { stack.push(sc); }, restore() { sc = stack.pop() ?? 1; },
    scale(k: number) { sc *= k; }, translate() {}, setTransform() { sc = 1; },
    fillRect(_x: number, _y: number, w: number, h: number) { if (Math.min(Math.abs(w), Math.abs(h)) > 0 && Math.min(Math.abs(w), Math.abs(h)) < 2) rec.hairlines.push([_x, _y, w, h]); },
    strokeRect() { rec.strokes.push(ctx.lineWidth * sc); },
    stroke() { rec.strokes.push(ctx.lineWidth * sc); (rec.strokeColors ??= []).push(String(ctx.strokeStyle)); },
    fill() {}, beginPath() {}, closePath() {}, moveTo() {}, lineTo() {}, arcTo() {}, arc() {}, roundRect() {},
    fillText(s: string) { rec.texts.push({ s: String(s), px: parseFloat(/(\d+(?:\.\d+)?)px/.exec(ctx.font)?.[1] ?? "0") * sc, color: String(ctx.fillStyle) }); },
    measureText(t: string) { const px = parseFloat(/(\d+(?:\.\d+)?)px/.exec(ctx.font)?.[1] ?? "17"); return { width: String(t).length * px * 0.55 }; },
  };
  return ctx;
}
let REC: Rec = { texts: [], strokes: [], hairlines: [] };
(HTMLCanvasElement.prototype as any).getContext = function () { return (this.__rec ??= recorder(REC)); };

const { EDIT, EDIT_VR, cssVar } = await import("../client/lib/edittheme.js");
const { renderCanvas } = await import("../client/lib/panels.js");

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  else { fail++; console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? ` — ${detail}` : ""}`); }
};
const PICTO = /\p{Extended_Pictographic}/u;

console.log("\nA. one source of tokens (index.html's --e-* block ≡ edittheme.js):");
{
  const html = readFileSync(here("../client/index.html"), "utf8");
  const m = /body\.edit-workspace,\s*\.frame\.edit\s*\{([^}]*)\}/.exec(html);
  check("the token block exists, scoped to body.edit-workspace / .frame.edit", !!m);
  const css: Record<string, string> = {};
  for (const [, k, v] of (m?.[1] ?? "").matchAll(/(--e-[a-z0-9-]+)\s*:\s*([^;]+);/g)) css[k] = v.trim().toLowerCase().replace(/\s+/g, "");
  const want = Object.fromEntries(Object.entries(EDIT).map(([k, v]) => [cssVar(k), String(v).toLowerCase().replace(/\s+/g, "")]));
  const diff = Object.keys({ ...want, ...css }).filter((k) => css[k] !== want[k]).map((k) => `${k}: css=${css[k]} js=${want[k]}`);
  check(`every token equal, none missing or extra (${Object.keys(want).length})`, diff.length === 0, diff.join(" · "));
  check("no --e-* token is defined on :root (the HUD never sees them)", !/:root\s*\{[^}]*--e-/.test(html));
}

// an inspector's worth of fields, every kind the painter knows
const FIELDS = [
  { t: "info", label: "id", value: "benchlamp" },
  { t: "info", label: "guard", value: "🛡 guarded by ana — only they can change it" },
  { t: "text", k: "ifilter", label: "", value: "", placeholder: "filter properties ⏎" },
  { t: "group", k: "channels", label: "Channels 🔒", open: true },
  { t: "num", k: "ch:pos.x", label: "pos x", value: 1, step: 0.1, unit: "m", compact: true },
  { t: "num", k: "ch:pos.yaw", label: "sockets · seat yaw", value: 0.5, step: 5, deg: true, compact: true, driven: "motion" },
  { t: "num", k: "ch:locked", label: "locked num", value: 2, disabled: true },
  { t: "num", k: "ch:pos.z", label: "pos z", value: 1, step: 0.1, unit: "m", compact: true, driven: "motion" },   // axis AND driven at once
  { t: "vec3", k: "v", label: "pos", value: [1, 2, 3] },
  { t: "group", k: "flags", label: "Flags", open: true },
  { t: "check", k: "flags.lock", label: "locked", value: false },
  { t: "check", k: "flags.hidden", label: "hidden", value: true },
  { t: "enum", k: "motion.type", label: "type", value: "oscillate", options: ["none", "pendulum", "spin", "orbit", "oscillate", "path"].map((v) => ({ v, label: v })) },
  { t: "color", k: "light.color", label: "color", value: 0xffd9a0 },
  { t: "range", k: "r", label: "mix", value: 0.3 },
  { t: "ref", k: "look.at", label: "look at", value: "lamp2" },
  { t: "btn", k: "rest", label: "come to rest" },
  { t: "btn", k: "snew", label: "new building", icon: "plus" },
  { t: "tiles", k: "stool", value: "wall", options: [{ v: "room", label: "room", icon: "square" }, { v: "wall", label: "wall", icon: "brickWall" }, { v: "door", label: "door", icon: "doorOpen" }] },
  { t: "btn", k: "remove", label: "remove", danger: true, vrOnly: true },
  { t: "list", k: "ed:sockets.slots", label: "sockets", rows: [{ id: "seat", label: "seat", actions: [{ k: "ed:sockets.del", label: "✕", danger: true }] }] },
  { t: "tree", k: "sel", rows: [
    { id: "benchlamp", label: "benchlamp", sub: "light", badges: ["📜watch", "🛡"], depth: 0, kids: 1, open: true, locked: false, active: true },
    { id: "occupant:ana", label: "🧍 ana", depth: 1, noDrag: true },
    { id: "crate1", label: "crate1", sub: "unit quad picture", depth: 0, kids: 0, locked: true } ] },
  { t: "log", lines: ["one", "two"] },
  { t: "group", k: "closed", label: "Closed", open: false },
  { t: "num", k: "hidden:num", label: "never painted", value: 1 },
];
const paint = (theme: string | null) => {
  REC = { texts: [], strokes: [], hairlines: [] };
  const c = document.createElement("canvas");
  const regions = renderCanvas(c, FIELDS as any, { width: 522, title: "inspector", ...(theme ? { theme } : {}) });
  return { c, regions, rec: REC };
};

console.log("\nB. the VR floor, on the edit painter:");
const E = paint("edit");
{
  const short = E.regions.filter((r: any) => r.h < EDIT_VR.minHit);
  check(`every hit target >= ${EDIT_VR.minHit} px tall (${E.regions.length} targets)`, E.regions.length > 20 && short.length === 0, JSON.stringify(short.slice(0, 4)));
  const thin = E.rec.strokes.filter((w) => w < EDIT_VR.minLine - 1e-9);
  check(`every stroke >= ${EDIT_VR.minLine} canvas px (${E.rec.strokes.length} strokes, after transform)`, E.rec.strokes.length > 10 && thin.length === 0, JSON.stringify(thin.slice(0, 6)));
  check("no hairline fillRect (< 2 px on its short side)", E.rec.hairlines.length === 0, JSON.stringify(E.rec.hairlines.slice(0, 4)));
  const small = E.rec.texts.filter((t) => t.px < EDIT_VR.minText);
  check(`every glyph >= ${EDIT_VR.minText} px (${E.rec.texts.length} fillText calls)`, E.rec.texts.length > 20 && small.length === 0, JSON.stringify(small.slice(0, 4)));
  const picto = E.rec.texts.filter((t) => PICTO.test(t.s));
  check("no pictograph handed to fillText (the canvas emoji trap)", picto.length === 0, JSON.stringify(picto.slice(0, 4)));
  check("…yet the words around them still paint (guard line, badges, occupant)", ["guarded by ana", "watch", "ana"].every((w) => E.rec.texts.some((t) => t.s.includes(w))), JSON.stringify(E.rec.texts.map((t) => t.s).filter((s) => /ana|watch/.test(s))));
  check("the canvas is the quad's width, rows at the VR row height", E.c.width === 522 && E.c.height > 20 * EDIT_VR.rowH);
  // axis + driven at once (R, 09-30): the label keeps its axis colour; the FIELD carries driven (edge + ~)
  const lab = (s: string) => E.rec.texts.find((t) => t.s === s)?.color?.toLowerCase();
  check("a driven pos z label is painted in the z axis colour (not the driven amber)", lab("pos z") === EDIT.z.toLowerCase(), String(lab("pos z")));
  check("…an undriven pos x in x's", lab("pos x") === EDIT.x.toLowerCase(), String(lab("pos x")));
  check("…and the driven field paints its ~ and an amber edge", E.rec.texts.some((t) => t.s === "~" && t.color?.toLowerCase() === EDIT.driven.toLowerCase()) && (E.rec.strokeColors ?? []).some((c) => c.toLowerCase() === EDIT.drivenEdge.toLowerCase()));
  const tiles = E.regions.filter((r: any) => r.action === "stool");
  check("tiles: one full-height target per option, side by side", tiles.length === 3 && tiles.every((r: any) => r.h >= EDIT_VR.minHit) && new Set(tiles.map((r: any) => r.y)).size === 1, JSON.stringify(tiles));
}

console.log("\nC. the same dispatch as the legacy painter:");
{
  const L = paint(null);
  const key = (r: any) => `${r.action}|${JSON.stringify(r.payload ?? null)}|${r.slider ? "slider" : ""}`;
  const eset = new Set(E.regions.map(key)), lset = new Set(L.regions.map(key));
  // legacy paints a lock on EVERY tree row, occupants included (locked undefined → a lock that dispatches 'lock' on
  // 'occupant:…'); the desktop shows a lock only where the row carries `locked` — the edit painter follows the desktop
  const noLock = new Set(FIELDS.flatMap((f: any) => (f.t === "tree" ? f.rows.filter((r: any) => r.locked == null).map((r: any) => `lock|${JSON.stringify(r.id)}|`) : [])));
  const lost = [...lset].filter((k) => !eset.has(k) && !noLock.has(k)), extra = [...eset].filter((k) => !lset.has(k));
  check("every legacy target exists on the edit painter", lost.length === 0, lost.join(" · "));
  check("…and a row the desktop shows no lock for gets none (an occupant)", [...noLock].every((k) => !eset.has(k)) && noLock.size === 1);
  check("…and the only extras are enum options legacy clipped off its row", extra.every((k) => k.startsWith("motion.type|")), extra.join(" · "));
  check("every enum option is reachable on the edit painter", ["none", "pendulum", "spin", "orbit", "oscillate", "path"].every((v) => eset.has(`motion.type|"${v}"|`)));
  check("a disabled field takes no hits", !E.regions.some((r: any) => r.action === "ch:locked"));
  check("a collapsed group's rows are not painted", !E.regions.some((r: any) => r.action === "hidden:num"));
  check("tree order kept: the disclosure is the FIRST region (it wins over its row)", E.regions[0]?.action === "open" && E.regions[0]?.payload === "benchlamp", JSON.stringify(E.regions[0]));
  check("no theme → the legacy painter, untouched (its 30-px targets are still there)", L.regions.some((r: any) => r.h === 30));
  // C13: one WIDGETS table (widgets.js) for the desktop, the legacy quad and this painter. Mutation: delete one entry
  // (say `check`) → this goes red here AND in tools/panels-schema-test.ts (its DOM and legacy-quad pins), not just one.
  const want: [string, string][] = [["num", "ch:pos.x"], ["vec3", "v"], ["check", "flags.lock"], ["enum", "motion.type"], ["color", "light.color"], ["range", "r"], ["ref", "look.at"], ["btn", "rest"], ["tiles", "stool"], ["group", "fold"], ["list", "ed:sockets.del"], ["tree", "open"], ["tree", "lock"]];
  const lostE = want.filter(([, a]) => !E.regions.some((r: any) => r.action === a)), lostL = want.filter(([, a]) => !L.regions.some((r: any) => r.action === a));
  check(`every interactive field type paints its target on the edit painter (${want.length} actions)`, lostE.length === 0, lostE.map(([t, a]) => `${t}:${a}`).join(" · "));
  check("…and on the legacy painter", lostL.length === 0, lostL.map(([t, a]) => `${t}:${a}`).join(" · "));
}

console.log("\nD. the quad's texture is sRGB (xrpanels.makePanel, the real module):");
{
  const xr = await import("../client/lib/xrpanels.js");
  const { THREE } = await import("./core-stub.mjs");
  xr.registerXRPanel({ id: "insp-t", title: "Inspector", theme: "edit", fields: () => FIELDS, dispatch: () => {} });
  const got: any[] = [];
  xr.xrPanelsEnter({ add: (o: any) => got.push(o), remove() {} });
  const tex = got[0]?.material?.map;
  check("a CanvasTexture exists on the quad", !!tex?.isTexture, String(got.length));
  check("its colorSpace is SRGBColorSpace (unmarked, #1e1e21 rendered rgb(97,97,103))", tex?.colorSpace === THREE.SRGBColorSpace, String(tex?.colorSpace));
  // main paints a canvas quad when it is first SHOWN (xrpanels.js showPanel; a hidden quad is only marked stale)
  check("a hidden quad is not painted yet", xr.xrPanelsDebug().regions.find((r: any) => r.id === "insp-t")?.n === 0);
  xr.showXRPanel("insp-t", true);
  const reg = xr.xrPanelsDebug().regions.find((r: any) => r.id === "insp-t");
  check("an edit-themed registration reaches the edit painter (the quad's canvas is the edit paint's)", reg && reg.h === E.c.height, JSON.stringify(reg) + " vs " + E.c.height);
}

console.log("\nE. no pictograph in edit chrome's own sources:");
{
  const src = (p: string) => readFileSync(here(`../client/lib/${p}`), "utf8");
  const strip = (s: string) => s.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
  const layout = strip(src("editlayout.js"));
  check("editlayout.js (top bar, tool rail): no pictograph in code", !PICTO.test(layout), (layout.match(/\p{Extended_Pictographic}/gu) ?? []).join(" "));
  const sb = strip(src("structure_ui.js"));
  const tools = /const TOOLS = \[([\s\S]*?)\];/.exec(sb)?.[1] ?? "";
  check("the build bar's tool labels: no pictograph", tools.length > 0 && !PICTO.test(tools), (tools.match(/\p{Extended_Pictographic}/gu) ?? []).join(" "));
  // C13: the tree widget lives in widgets.js (WIDGETS.tree.dom), one table for every surface; the check keeps its name
  const tree = /\n  tree: \{\n([\s\S]*?)\n    row: ROW,/.exec(src("widgets.js"))?.[1] ?? "";
  check("panels.js tree rows (lock toggle): no pictograph", tree.length > 0 && !PICTO.test(strip(tree)), (strip(tree).match(/\p{Extended_Pictographic}/gu) ?? []).join(" "));
}

console.log("\nE2. every glyph edit chrome names exists (a missing icon paints NOTHING, silently):");
{
  const icons = await import("../client/lib/icons.js");
  const { PICTO_ICON } = await import("../client/lib/edittheme.js");
  const src = (p: string) => { try { return readFileSync(here(`../client/lib/${p}`), "utf8"); } catch { return ""; } };
  const names = new Set<string>(Object.values(PICTO_ICON) as string[]);
  for (const p of ["editpaint.js", "widgets.js"]) {   // C13: the edit widgets' glyphs are named in widgets.js, the surface's in editpaint.js
    for (const m of src(p).matchAll(/icon\(g, ([^,]+),/g)) for (const q of m[1].matchAll(/'([A-Za-z0-9]+)'/g)) names.add(q[1]);
    for (const m of src(p).matchAll(/(?:quietButton\([^)]*|ACTION_ICON = \{[^}]*)'([A-Za-z0-9]+)'\)?/g)) names.add(m[1]);
  }
  for (const m of src("editlayout.js").matchAll(/icon: '([A-Za-z0-9]+)'|iconSvg\('([A-Za-z0-9]+)'/g)) names.add(m[1] ?? m[2]);
  for (const m of src("structure_ui.js").matchAll(/'([A-Za-z0-9]+)'\],|, '([A-Za-z0-9]+)'\);/g)) names.add(m[1] ?? m[2]);
  for (const m of src("widgets.js").matchAll(/iconSvg\(r\.locked \? '([A-Za-z]+)' : '([A-Za-z]+)'/g)) { names.add(m[1]); names.add(m[2]); }
  // the Hierarchy's environment rows (editpanels ENV) are drawn only by the DOM tree, which takes a glyph from any of the
  // three sets; every other name can reach a canvas painter, which strokes the Lucide set alone
  const env = /const ENV = \[([\s\S]*?)\];/.exec(src("editpanels.js"))?.[1] ?? "";
  const domOnly = new Set<string>([...env.matchAll(/icon: '([A-Za-z0-9]+)'/g)].map((m) => m[1]));
  for (const m of src("editpanels.js").replace(env, "").matchAll(/icon: '([A-Za-z0-9]+)'/g)) names.add(m[1]);   // the Create panel's buttons
  for (const n of domOnly) names.add(n);
  const missing = [...names].filter((n) => domOnly.has(n) ? !(icons.has(n) || icons.hasFill(n) || icons.hasLine(n)) : !icons.has(n));
  check(`all ${names.size} named glyphs are in icons.js (the ${domOnly.size} DOM-only environment rows in any set)`, names.size >= 20 && domOnly.size >= 4 && missing.length === 0, "missing: " + missing.join(", ") + " · seen: " + [...names].join(","));
}

console.log("\nF. text on its surface meets 4.5:1:");
{
  const lum = (hex: string) => { const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
  const cr = (a: string, b: string) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
  const pairs: [string, string][] = [["text", "bg0"], ["text", "bg1"], ["text", "bg2"], ["text", "well"], ["text", "press"], ["dim", "bg1"], ["dim", "bg2"], ["dim", "well"], ["accent", "bg1"], ["danger", "bg1"], ["driven", "bg1"], ["x", "bg1"], ["y", "bg1"], ["z", "bg1"]];
  const bad = pairs.map(([f, b]) => [f, b, cr((EDIT as any)[f], (EDIT as any)[b])] as const).filter(([, , r]) => r < 4.5);
  check(`${pairs.length} text/surface pairs >= 4.5:1`, bad.length === 0, bad.map(([f, b, r]) => `${f} on ${b} = ${r.toFixed(2)}`).join(" · "));
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
