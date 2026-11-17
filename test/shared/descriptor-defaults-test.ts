// test/shared/descriptor-defaults-test.ts — the registry is the schema: every default the records (shared/components.js
// RECORDS), the inspector (shared/editschema.js) and the hand (shared/grab.js) state equals what the authority writes,
// materialize(key, {type}), read through the descriptor's editor translation (shared/descriptors.js).
// Refactor plan C5 (notes/eidoverse/PLAN-refactor-2026-10-12.md); STRIKES C-S2.
//   BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun test/shared/descriptor-defaults-test.ts
// Mutation: a registry pendulum period of 2.9 → 2 red.
import { DESCRIPTORS, editorDefault, materializedOf, toWire, axisLetter, axisVector } from "../../shared/descriptors.js";
import { COMPONENTS, materialize } from "../../shared/protocol/componentspec.js";
import { RECORDS, LIGHT_DEFAULTS } from "../../shared/components.js";
import { inspectSchema, fieldAt, addOps, editOps } from "../../shared/editschema.js";
import { DEFAULTS as GRAB_DEFAULTS } from "../../shared/grab.js";
import { scratchWorld } from "../harness/scratchworld.ts";

let pass = 0, fail = 0, unwritten = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  else { fail++; console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? ` — ${detail}` : ""}`); }
};
const note = (name: string) => { unwritten++; console.log(`  \x1b[33m·\x1b[0m ${name}`); };
const j = (x: any) => JSON.stringify(x);
const same = (a: any, b: any) => j(a) === j(b);
const GROUP: Record<string, string> = { "look-at": "look-at" };
// a thing carrying the descriptor's registry bag, plus what the key can't stand without
const entOf = (d: any): any => {
  const bag = materializedOf(Object.keys(DESCRIPTORS).find((c) => DESCRIPTORS[c] === d)!);
  if (!bag || typeof bag !== "object" || !d.fields.some((f: any) => f.path != null)) return null;
  const value = d.key === "sound" || d.key === "picture" ? { src: "store/x", ...bag } : d.key === "story" ? { title: "t", text: "x", ...bag } : d.key === "text" ? { text: "hi", ...bag } : d.key === "look-at" ? { target: "@viewer", ...bag } : d.key === "particles" ? { effect: "fire", ...bag } : bag;
  return { model: "store/x.glb", pos: [0, 0, 0], yaw: 0, [d.key]: value };
};

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
  const ent = entOf(d); if (!ent) continue;
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

console.log("\nthe Inspector offers only what the door takes; every axis takes the door's words, and its words are the door's:");
{
  const D = scratchWorld("descriptor-options"); let n = 0;
  const seed = (rec: any) => { const id = `t${++n}`; D.seed({ [id]: rec }); return id; };
  // every descriptor's thing, a dynamic body (physics.kind), a crate (flags.layer): each option of each field, through the
  // Inspector's own planner (editOps) and the real authority, dry
  const target = seed({ pos: [0, 0, 3] });
  // what the door needs beyond the registry bag: a mesh or light is its own thing, a path its points, a file a real link
  const NEEDS: Record<string, (v: any) => any> = { pivot: () => ({ pos: [0, 0.5, 0] }), parent: () => ({ to: target }), picture: (v) => ({ ...v, src: "https://example.com/x.png" }),
    sound: (v) => ({ ...v, src: "https://example.com/x.mp3" }), collider: (v) => ({ shape: "box", ...v }), motion: (v) => (v.type === "path" ? { ...v, points: [[0, 0, 0], [0, 0, 4]] } : v) };
  const ents = [...Object.values(DESCRIPTORS).map((d: any) => { const e = entOf(d); if (!e) return null;
    if (NEEDS[d.key]) e[d.key] = NEEDS[d.key](e[d.key]); if (d.key === "mesh" || d.key === "light") delete e.model; return e; }).filter(Boolean),
    { model: "store/x.glb", pos: [0, 0, 0], yaw: 0, physics: materialize("physics", { kind: "dynamic" }).value },
    { model: "store/x.glb", pos: [0, 0, 0], yaw: 0, "look-at": { target: "@viewer", forward: [0.6, 0, 0.8] } },   // a custom forward: its current-value option
    { model: "store/x.glb", pos: [0, 0, 0], yaw: 0, motion: { type: "spin" } }];   // a spin switched to path
  // a known gap pinned as STILL red so a fix flips it (and its entry goes); none open
  const GAPS: Record<string, string> = {};
  const gapSeen = new Set<string>();
  const row = (name: string, key: string, ok: boolean, detail: string) => {
    if (!GAPS[key]) return check(name, ok, detail);
    gapSeen.add(key); check(`gap, still open: ${key}: ${GAPS[key]}`, !ok, "it is fixed: drop its GAPS entry");
  };
  let offeredRows = 0; const offered = new Set<string>();
  for (const ent of ents) {
    const id = seed(ent), rec = D.rec(id);
    for (const g of inspectSchema(rec, id).groups) for (const f of g.fields as any[]) for (const o of Array.isArray(f.options) ? f.options : []) {
      const plan: any = editOps(rec, id, { [`${g.group}.${f.k}`]: o.v });
      const r = plan.errors.length ? { ok: false, refused: plan.errors } : D.sendAll(plan.ops, { dry: true });
      offeredRows++; offered.add(`${g.group}.${f.k} ${j(o.v)}`); row(`the Inspector offers ${g.group}.${f.k} ${j(o.v)}, and the door takes it`, `${g.group}.${f.k} ${j(o.v)}`, !!r.ok, j(r.refused ?? r));
    }
  }
  // every axis row offers x, y and z, never a signed letter (R 10-11; each sent above is taken); a STORED signed axis
  // still shows as itself (editschema.js), which these fresh entities don't carry
  for (const k of ['motion.type "path"', 'look-at.forward "[0.6,0,0.8]"', ...["motion.axis", "look-at.forward", "look-at.up", "openable.axis"].flatMap((a) => ["x", "y", "z"].map((l) => `${a} ${j(l)}`))]) check(`the Inspector's ${k} was offered and sent`, offered.has(k));
  for (const k of ["motion.axis", "look-at.forward", "look-at.up", "openable.axis"].flatMap((a) => ["-x", "-y", "-z"].map((l) => `${a} ${j(l)}`))) check(`the Inspector doesn't offer ${k} (a negative turn is a negative angle)`, !offered.has(k));
  { const la = seed({ model: "store/x.glb", pos: [0, 0, 0], yaw: 0, "look-at": { target: "@viewer", forward: [0.6, 0, 0.8] } });
    const plan: any = editOps(D.rec(la), la, { "look-at.forward": "[0.6,0,0.8]" }); const v = plan.ops.flat(9).find((o: any) => o?.args?.component === "look-at")?.args?.value;
    check("a custom forward's current-value option is sent as its vector", same(v?.forward, [0.6, 0, 0.8]), j(v)); }
  { const sp = seed({ model: "store/x.glb", pos: [0, 0, 0], yaw: 0, motion: { type: "spin" } });
    const plan: any = editOps(D.rec(sp), sp, { "motion.type": "path" }); const v = plan.ops.flat(9).find((o: any) => o?.args?.component === "motion")?.args?.value;
    check("switching motion.type spin → path writes a path with its points", v?.type === "path" && Array.isArray(v?.points) && v.points.length > 0, j(v)); }
  { const op = seed({ model: "store/x.glb", pos: [0, 0, 0], yaw: 0, openable: { open: false } }); const r = D.call("set", { id: op, component: "openable", value: { open: false, axis: "-x" } });
    check("openable.axis '-x' is refused: a negative axis is a vector", !r.ok, j(r.ok ? D.rec(op) : r)); }
  check("the Inspector offers a look-at forward row", (fieldAt(inspectSchema(entOf(DESCRIPTORS.LookAt), "x"), "look-at.forward") as any)?.options?.length > 0);
  // the door's `axis` type, on every registry field of that type: x, y, z or a vector taken; anything else refused
  const BASE: Record<string, any> = { motion: { type: "pendulum" }, openable: { open: false }, "look-at": { target } };
  // motion takes every letter (MOTION_AXES); look-at and openable take x, y, z or a vector (a negative axis is a vector)
  const SIGNED = new Set(["motion"]);
  const TAKES = (k: string) => ["x", "y", "z", ...(SIGNED.has(k) ? ["-x", "-y", "-z", "X"] : []), [0, 0, -1], [1, 0, 0]], REFUSES = (k: string) => ["w", "", "+x", 5, [0, 0], ["x"], ...(SIGNED.has(k) ? [] : ["-x"])];
  const named = (text: string) => [...new Set((text.match(/(?<![\w-])-?[xyz](?=\s*\||\s*$|\s*,|\s*\)|\s+or\b)/g) ?? []).map((x) => x.trim()))];
  const axes = Object.entries(COMPONENTS as any).flatMap(([key, c]: any) => Object.entries(c.fields ?? {}).filter(([, t]) => t === "axis").map(([field]) => [key, field]));
  check("the axis fields are found (motion.axis, openable.axis, look-at.forward and .up)", axes.length >= 4, j(axes));
  const post = seed({ pos: [0, 0, 0] });
  for (const [key, field] of axes) {
    check(`${key}.${field}: a base the door takes`, !!BASE[key], key);
    const verdict = (v: any) => { const r = D.call("set", { id: post, component: key, value: { ...BASE[key], [field]: v }, dry: true }); return { ok: !!r.ok, words: r.ok ? "" : `${r.refused?.reason ?? ""} ${r.refused?.fix ?? ""}` }; };
    for (const v of TAKES(key)) check(`${key}.${field} ${j(v)}: the door takes it`, verdict(v).ok);
    const said = new Set<string>();
    for (const v of REFUSES(key)) { const r = verdict(v); row(`${key}.${field} ${j(v)}: the door refuses it`, `refuses ${key}.${field} ${j(v)}`, !r.ok, r.words); if (!r.ok) said.add(r.words); }
    const help = new RegExp(`${field}\\?\\s*\\(([^)]*)\\)`).exec(String((COMPONENTS as any)[key].help))?.[1] ?? "";
    if (key === "look-at") check(`look-at's help has a ${field}? clause (its loop below would be vacuous without one)`, help !== "", String((COMPONENTS as any)[key].help));
    for (const l of named(help)) check(`${key}'s help names ${field} '${l}', and the door takes it`, verdict(l).ok, help);
    for (const w of said) for (const l of named(w)) check(`a ${key}.${field} refusal names '${l}', and the door takes it`, verdict(l).ok, w.trim().slice(0, 120));
  }
  for (const k of Object.keys(GAPS)) check(`the gap ${k} is still reached`, gapSeen.has(k));
  console.log(`  (${offeredRows} offered options sent)`);
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
  check("axis: an inherited name (constructor, toString) is no axis", axisLetter("constructor") === null && axisLetter("toString") === null && axisVector("constructor") === null && axisVector("__proto__") === null);
  check("the registry's pendulum axis reads as x, spin's and oscillate's as y, openable's hinge as y", editorDefault("Pendulum", "axis") === "x" && editorDefault("Spin", "axis") === "y" && editorDefault("Oscillate", "axis") === "y" && editorDefault("Openable", "axis") === "y");
  check("rate: the registry's degPerSec reads as the editor's rate; a period reads as 360/period; an rpm as ×6", editorDefault("Spin", "degPerSec") === 36 && DESCRIPTORS.Spin.fields.find((f) => f.k === "degPerSec")!.wire!.from(undefined, { period: 10 }) === 36 && DESCRIPTORS.Orbit.fields.find((f) => f.k === "degPerSec")!.wire!.from(undefined, { rpm: 2 }) === 12);
  check("light: daytime dim reads as burns-at-noon off; on writes daytime: full (the address is light.daytime, R 10-17: was light.noon) (shape audit 10-16: was day: false)", editorDefault("Light", "daytime") === false && toWire("Light", "daytime", true) === "full" && toWire("Light", "daytime", false) === "dim");
  check("a whole-value card has exactly one path-less field (Grabbable.spec, Reactions.actions, Label.text…)", ["Grabbable", "Reactions", "Label", "Lock", "Hidden", "Openable"].every((c) => DESCRIPTORS[c].fields.filter((f) => f.path == null).length === 1));
  check("every descriptor field's path is a registry field or default of its key", Object.values(DESCRIPTORS).every((d) => d.fields.every((f) => f.path == null || f.path in ((COMPONENTS as any)[d.key].fields ?? {}) || f.path in ((COMPONENTS as any)[d.key].defaults ?? {}) || d.key === "pivot")));
  check("every record param the inspector addresses by another name is named in the descriptor (burnsAtNoon → daytime, rate → degPerSec, slot → socket)", DESCRIPTORS.Light.fields.some((f) => f.k === "daytime" && f.param === "burnsAtNoon" && f.path === "daytime") && DESCRIPTORS.Spin.fields.some((f) => f.k === "degPerSec" && f.param === "rate") && DESCRIPTORS.Parent.fields.some((f) => f.k === "socket" && f.param === "slot"));
}

console.log(`\ndescriptor-defaults: ${pass} passed, ${fail} failed${unwritten ? `, ${unwritten} stated where the registry writes nothing` : ""}`);
process.exit(fail ? 1 : 0);
