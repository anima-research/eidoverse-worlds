// tools/descriptor-defaults-test.ts — the registry is the schema: every default the records (shared/components.js
// RECORDS), the inspector (shared/editschema.js) and the hand (shared/grab.js) state equals what the authority writes,
// materialize(key, {type}), read through the descriptor's editor translation (shared/protocol/descriptors.js).
// Refactor plan C5 (notes/eidoverse/PLAN-refactor-2026-10-12.md); STRIKES C-S2.
//   BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun tools/descriptor-defaults-test.ts
// First run, at b6db5c47 (before the fixes in the same commit), 9 red: RECORDS Pendulum period 3.5 / damp 0 / maxAmp 1.1
// against the registry's 2.4 / 0.08 / 0.9; the inspector's pendulum period def 3.5 and damp def 0; its orbit radius def 1
// against 3; the Add Pendulum and Add Reactions seeds writing period 3.5; and Transform.scale (the record's uniform 1 against
// the registry's [1, 1, 1], a vocabulary, now translated). Mutation: a registry pendulum period of 2.9 → 2 red.
import { DESCRIPTORS, editorDefault, materializedOf, toWire, axisLetter } from "../shared/protocol/descriptors.js";
import { COMPONENTS, materialize } from "../shared/protocol/componentspec.js";
import { RECORDS, LIGHT_DEFAULTS } from "../shared/components.js";
import { inspectSchema, fieldAt, addOps } from "../shared/editschema.js";
import { DEFAULTS as GRAB_DEFAULTS } from "../shared/grab.js";

let pass = 0, fail = 0, unwritten = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  else { fail++; console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? ` — ${detail}` : ""}`); }
};
const note = (name: string) => { unwritten++; console.log(`  \x1b[33m·\x1b[0m ${name}`); };
const j = (x: any) => JSON.stringify(x);
const same = (a: any, b: any) => j(a) === j(b);
const GROUP: Record<string, string> = { "look-at": "look-at" };

console.log("\nevery record default is the registry's, through the translation:");
for (const [card, d] of Object.entries(DESCRIPTORS)) {
  const rec = (RECORDS as any)[card];
  check(`${card}: a record exists for the descriptor`, !!rec);
  if (!rec) continue;
  for (const f of d.fields) {
    if (f.path == null) continue;
    const p = rec.params[f.param]; if (!p || p.default === undefined) continue;
    const want = editorDefault(card, f.k);
    if (want === undefined) {
      // C8: a yellow is DECIDED on the descriptor (`absent`: the record's default is a reading of absence, prose when RECORDS
      // is generated), or it is red: a new field the registry never writes needs its decision
      if (p.default !== null) check(`${card}.${f.param}: the record says ${j(p.default)}, the registry writes nothing — decided: ${(f as any).absent ? "absent means " + j((f as any).absent).slice(0, 60) + "…" : "NOT DECIDED"}`, typeof (f as any).absent === "string" && (f as any).absent.length > 0);
      continue; }
    check(`${card}.${f.param} = ${j(want)}`, same(p.default, want), `RECORDS says ${j(p.default)}, materialize(${d.key}${d.type ? `, {type: '${d.type}'}` : ""}) says ${j(want)}`);
  }
}

console.log("\nevery inspector def is the registry's, through the translation:");
for (const [card, d] of Object.entries(DESCRIPTORS)) {
  const bag = materializedOf(card);
  if (!bag || typeof bag !== "object" || !d.fields.some((f) => f.path != null)) continue;
  const value = d.key === "sound" || d.key === "picture" ? { src: "store/x", ...bag } : d.key === "story" ? { title: "t", text: "x", ...bag } : d.key === "text" ? { text: "hi", ...bag } : d.key === "look-at" ? { target: "@viewer", ...bag } : d.key === "particles" ? { effect: "fire", ...bag } : bag;
  const ent: any = { model: "store/x.glb", pos: [0, 0, 0], yaw: 0, [d.key]: value };
  const schema = inspectSchema(ent, "x", { parts: ["lid"] });
  const group = GROUP[d.key] ?? d.key;
  for (const f of d.fields) {
    if (f.path == null) continue;
    const fld: any = fieldAt(schema, `${group}.${f.k}`);
    if (!fld || fld.def === undefined) continue;
    const want = editorDefault(card, f.k);
    if (want === undefined) { check(`${card}.${f.k}: the inspector's def is ${j(fld.def)}, the registry writes nothing — decided on the descriptor`, typeof (f as any).absent === "string"); continue; }
    check(`inspector ${group}.${f.k} def = ${j(want)}`, same(fld.def, want), `editschema says ${j(fld.def)}`);
  }
}

console.log("\nthe other restated defaults:");
{
  const L = materialize("light", {}).value;
  check("LIGHT_DEFAULTS (components.js) is the registry's light {color, intensity, range}", same(LIGHT_DEFAULTS, { color: L.color, intensity: L.intensity, range: L.range }), j(LIGHT_DEFAULTS));
  const G = materialize("grabbable", {}).value;
  const stated = Object.fromEntries(Object.entries(GRAB_DEFAULTS).filter(([, v]) => v !== null && !(typeof v === "object" && !Object.keys(v as any).length)));
  check("grab.js DEFAULTS, the written ones, are the registry's grabbable defaults", same(stated, G), `${j(stated)} vs ${j(G)}`);
  const ph = materialize("physics", { kind: "dynamic" }).value;
  const ps: any = inspectSchema({ model: "store/x.glb", pos: [0, 0, 0], yaw: 0, physics: ph }, "x");
  check("inspector physics.kind / physics.who defs are the registry's", fieldAt(ps, "physics.kind")?.def === ph.kind && fieldAt(ps, "physics.who")?.def === ph.who);
  // the inspector's Add seeds write a thing the authority then materializes: a number they restate must be the registry's
  const P = materialize("motion", { type: "pendulum" }).value;
  // (Add Reactions seeded one too while its default was a push; that kind, impulse, is reserved since the shape audit
  // 10-16, and Reactions is added empty)
  for (const [name, ent] of [["Pendulum", { model: "store/x.glb", pos: [0, 0, 0], yaw: 0 }]] as const) {
    const ops = (addOps(ent as any, "x", name, "") as any).ops.flat(9).filter((o: any) => o?.verb === "set" && o.args?.component === "motion");
    const seed = ops[0]?.args?.value;
    check(`Add ${name} seeds a pendulum whose period/damp/maxAmp, where stated, are the registry's`, !!seed && ["period", "damp", "maxAmp"].every((k) => seed[k] === undefined || seed[k] === P[k]), j(seed));
  }
}

console.log("\nthe translation itself:");
{
  check("axis: letter → vector → letter", same(toWire("Pendulum", "axis", "x"), [1, 0, 0]) && axisLetter([0, -1, 0]) === "-y" && axisLetter("Z") === "z" && axisLetter([0.5, 0, 0]) === null);
  check("the registry's pendulum axis reads as x, spin's and bob's as y, openable's hinge as y", editorDefault("Pendulum", "axis") === "x" && editorDefault("Spin", "axis") === "y" && editorDefault("Bob", "axis") === "y" && editorDefault("Openable", "axis") === "y");
  check("rate: the registry's degPerSec reads as the editor's rate; a period reads as 360/period; an rpm as ×6", editorDefault("Spin", "degPerSec") === 36 && DESCRIPTORS.Spin.fields.find((f) => f.k === "degPerSec")!.wire!.from(undefined, { period: 10 }) === 36 && DESCRIPTORS.Orbit.fields.find((f) => f.k === "degPerSec")!.wire!.from(undefined, { rpm: 2 }) === 12);
  check("light: day: true reads as noon off; noon on writes day: false", editorDefault("Light", "noon") === false && toWire("Light", "noon", true) === false);
  check("a whole-value card has exactly one path-less field (Grabbable.spec, Sockets.slots, Label.text…)", ["Grabbable", "Sockets", "Reactions", "Label", "Lock", "Hidden", "Openable"].every((c) => DESCRIPTORS[c].fields.filter((f) => f.path == null).length === 1));
  check("every descriptor field's path is a registry field or default of its key", Object.values(DESCRIPTORS).every((d) => d.fields.every((f) => f.path == null || f.path in ((COMPONENTS as any)[d.key].fields ?? {}) || f.path in ((COMPONENTS as any)[d.key].defaults ?? {}) || d.key === "pivot")));
  check("every record param the inspector addresses by another name is named in the descriptor (burnsAtNoon → noon, rate → degPerSec, slot → socket)", DESCRIPTORS.Light.fields.some((f) => f.k === "noon" && f.param === "burnsAtNoon" && f.path === "day") && DESCRIPTORS.Spin.fields.some((f) => f.k === "degPerSec" && f.param === "rate") && DESCRIPTORS.Parent.fields.some((f) => f.k === "socket" && f.param === "slot"));
}

console.log(`\ndescriptor-defaults: ${pass} passed, ${fail} failed${unwritten ? `, ${unwritten} stated where the registry writes nothing` : ""}`);
process.exit(fail ? 1 : 0);
