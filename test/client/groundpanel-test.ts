// groundpanel-test — the 🌿 ground panel under happy-dom with its writes, defs and world mocked (333-cm bugs a6, a7).
//   BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun test/client/groundpanel-test.ts
// Mutations (must go red): in client/lib/edit/groundpanel.js drop grassHeight/grassDensity from the palette guard; send
// ground('grass', grassArgs(...)) without checking it for null.
import { GlobalRegistrator } from "@happy-dom/global-registrator";
GlobalRegistrator.register({ width: 800, height: 600 });
(globalThis as any).Option ??= function (text = "", value?: string, defSel = false, sel = false) {   // happy-dom has no Option constructor (rows.js selectRow)
  const o = document.createElement("option"); o.text = text; o.value = value ?? text; o.defaultSelected = defSel; o.selected = sel; return o; };
import { mock } from "bun:test";
let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = "") => { if (ok) pass++; else fail++; console.log(`${ok ? "✓" : "✗"} ${name}${!ok && detail ? `  — ${detail}` : ""}`); };
const L = "../../client/lib/";
const sent: any[] = [], hints: string[] = [], reports: any[] = [];
let reg: any = {};
mock.module(L + "base.js", () => ({ bus: { on() {}, emit() {} }, report: (...a: any[]) => reports.push(a), CONFIG: { world: "w" } }));
mock.module(L + "world.js", () => ({ currentTerrainArgs: () => null, terrainEditBase: () => null, noteTerrainSent: (x: any) => x }));
mock.module(L + "defs.js", () => ({ defsRegistry: async () => reg }));
mock.module(L + "edit/writes.js", () => ({ send: async (r: any) => { sent.push(r); return { ok: true }; } }));
mock.module(L + "ui/ui.js", () => ({ flashHint: (s: string) => hints.push(s) }));
mock.module(L + "state.js", () => ({ state: { st: { entities: {} } }, onWorldChange: () => () => {} }));
mock.module(L + "terrain.js", () => ({ getGrassQuality: () => "high", getGrassShed: () => 0, getGrassDensity: () => 1 }));
(globalThis as any).fetch = async () => new Response("null", { status: 404 });
const { paintGround } = await import(L + "edit/groundpanel.js");
const settle = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); await new Promise((r) => setTimeout(r, 0)); };
const mount = async (pal: any) => { reg = { groundPalette: pal }; reports.length = 0; const b = document.createElement("div"); document.body.append(b); paintGround(b); await settle(); return b; };
const PAL = { tints: { meadow: { layer: "#557744" } }, shapes: { hills: 4 }, grassHeight: { meadow: 0.4 }, grassDensity: { normal: 1 }, plantings: { meadow: { args: { kind: "blades" }, blade: true } } };

// a7: a palette without the grass dials says so, rather than throwing inside paint and leaving the section blank
for (const drop of ["grassHeight", "grassDensity"]) {
  const { [drop]: _, ...pal } = PAL as any;
  const b = await mount(pal);
  check(`a7 a palette without ${drop} paints the no-palette line, no throw`, /serves no ground palette/.test(b.textContent ?? "") && !reports.length, JSON.stringify({ text: b.textContent?.slice(0, 80), reports: reports.map((r) => String(r[1])) }));
  b.remove();
}
// a6: grow with no planting to grow never sends a delete (mow is the only delete)
{
  const b = await mount({ ...PAL, plantings: {} }); sent.length = 0;
  const grow = [...b.querySelectorAll("button")].find((x) => /grow/.test(x.textContent ?? "")) as any;
  check("setup: the grow button is painted", !!grow, JSON.stringify({ buttons: [...b.querySelectorAll("button")].map((x) => x.textContent), reports: reports.map((r) => String(r[1])) }));
  grow?.click(); await settle();
  check("a6 grow with no planting sends nothing (never a delete)", !sent.some((r) => r.verb === "delete"), JSON.stringify(sent));
  b.remove();
}
// control: the real palette grows a grass set
{
  const b = await mount(PAL); sent.length = 0;
  ([...b.querySelectorAll("button")].find((x) => /grow/.test(x.textContent ?? "")) as any)?.click(); await settle();
  check("control: grow with a planting sends set @world grass", sent.length === 1 && sent[0].verb === "set" && sent[0].args.component === "grass", JSON.stringify(sent));
  b.remove();
}
console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
