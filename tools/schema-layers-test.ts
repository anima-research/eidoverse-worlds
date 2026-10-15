// tools/schema-layers-test.ts — ONE description, derived readers (review 10-14 §3.4 "component description ×4"; R: fix).
//
// The registry (shared/protocol/componentspec.js) is the one place a component's fields are described: type, default,
// limits (ranges), unit (units) and one-line doc (docs). Everything else READS it:
//   shared/protocol/descriptors.js   which fields a card shows and with what widget; limits/units/docs come from the registry
//   shared/components.js             the records' params, derived through the descriptors; only alias spellings and READS by hand
//   shared/editschema.js             the inspector's rows (hand cards included) read limits through limitsOf
//   shared/worldentity.js            @world's terrain and grass rows likewise
//   the agent                        `schema {component}` returns the registry itself (authority.js), so its docs are these
// Before this (10-14) a field's range lived in up to three of them and drifted: the Light card's floor was 1 m where the door
// takes > 0, the records' Collider offered two shapes where the registry takes three.
//   BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun tools/schema-layers-test.ts
// Mutation that MUST go red: comment out `width: "number"` in componentspec's picture.fields → the Picture descriptor
// throws at import ("Picture.width is not a field of picture"), which this suite reports as a failure of its first check.
// Mutation that MUST go red: write `min: 1` into the Light descriptor's range ui → "Light.range states min here".
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { COMPONENTS, materialize, trainingAllowed } from "../shared/protocol/componentspec.js";

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = "") => { if (ok) pass++; else fail++; console.log(`${ok ? "✓" : "✗"} ${name}${!ok && detail ? `  — ${detail}` : ""}`); };
const j = (x: any) => JSON.stringify(x);
const ROOT = join(import.meta.dir, "..");
const src = (p: string) => readFileSync(join(ROOT, p), "utf8");

// 1. the derived layers load (a registry field a reader names that isn't there throws at import)
let D: any = null, C: any = null, E: any = null, W: any = null, loadErr = "";
try { D = await import("../shared/protocol/descriptors.js"); C = await import("../shared/components.js"); E = await import("../shared/editschema.js"); W = await import("../shared/worldentity.js"); }
catch (e: any) { loadErr = String(e?.message ?? e); }
check("the derived layers (descriptors, components, editschema, worldentity) load against the registry", !!D && !!C && !!E && !!W, loadErr);
if (!D || !C || !E || !W) { console.log(`\n${pass} passed, ${fail} failed`); process.exit(1); }
const { DESCRIPTORS } = D; const { RECORDS } = C; const { inspectSchema, fieldAt, limitsOf } = E;

// the registry's limits as a row carries them: min (or gt), max; units as strings (a per-type unit picked by the card)
const regLimits = (key: string, path: string) => { const r = COMPONENTS[key]?.ranges?.[path]; if (!r || r.maxLen !== undefined || r.maxItems !== undefined) return {}; return { ...(r.min !== undefined ? { min: r.min } : r.gt !== undefined ? { min: r.gt } : {}), ...(r.max !== undefined ? { max: r.max } : {}) }; };
const regUnit = (key: string, path: string, type?: string) => { const u = COMPONENTS[key]?.units?.[path]; return u == null ? undefined : typeof u === "string" ? u : u[type ?? ""]; };

// 2. every descriptor field is a registry field (or a default the registry writes), and its limits/unit/doc are the registry's
{
  const bad: string[] = [];
  for (const [card, d] of Object.entries<any>(DESCRIPTORS)) {
    const def = COMPONENTS[d.key]; if (!def) { bad.push(`${card}: key ${d.key} unregistered`); continue; }
    for (const f of d.fields) {
      if (f.path == null) continue;
      if (!(f.path in (def.fields ?? {})) && !(!def.fields && f.path in (def.defaults ?? {})) && d.key !== "pivot") bad.push(`${card}.${f.path}: not a registry field`);
      const lim = regLimits(d.key, f.path);
      if (f.ui) { for (const k of ["min", "max"]) if (j(f.ui[k]) !== j((lim as any)[k])) bad.push(`${card}.${f.path}: row ${k} ${j(f.ui[k])} vs registry ${j((lim as any)[k])}`);
        const u = regUnit(d.key, f.path, d.type); if (!f.ui.deg && j(f.ui.unit) !== j(u)) bad.push(`${card}.${f.path}: row unit ${j(f.ui.unit)} vs registry ${j(u)}`); }
      if (j(f.doc) !== j(def.docs?.[f.path])) bad.push(`${card}.${f.path}: doc differs from the registry's`);
    }
  }
  check(`every descriptor field is a registry field, with the registry's limits, unit and doc (${Object.keys(DESCRIPTORS).length} cards)`, !bad.length, bad.slice(0, 8).join(" | "));
}

// 3. every record param that is a registry field carries the registry's type class, default, limits, unit and doc
{
  const bad: string[] = [];
  for (const [card, d] of Object.entries<any>(DESCRIPTORS)) {
    const rec = RECORDS[card]; if (!rec) { bad.push(`${card}: no record`); continue; }
    for (const f of d.fields) {
      if (f.path == null) continue;
      const p = rec.params[f.param]; if (!p) { bad.push(`${card}.${f.param}: the descriptor shows it, the record has no param`); continue; }
      const lim = regLimits(d.key, f.path);
      for (const k of ["min", "max"]) if (j(p[k]) !== j((lim as any)[k])) bad.push(`${card}.${f.param}: record ${k} ${j(p[k])} vs registry ${j((lim as any)[k])}`);
      const u = regUnit(d.key, f.path, d.type); if (j(p.unit) !== j(u)) bad.push(`${card}.${f.param}: record unit ${j(p.unit)} vs registry ${j(u)}`);
      if (j(p.hint) !== j(COMPONENTS[d.key].docs?.[f.path])) bad.push(`${card}.${f.param}: record hint differs from the registry's doc`);
      const want = D.editorDefault(card, f.k); if (want !== undefined && j(p.default) !== j(want)) bad.push(`${card}.${f.param}: record default ${j(p.default)} vs registry ${j(want)}`);
      const en = COMPONENTS[d.key].enums?.[f.path]; if (en && j(p.options) !== j(en)) bad.push(`${card}.${f.param}: record options ${j(p.options)} vs registry enum ${j(en)}`);
    }
  }
  check("every record param of a registry field is the registry's: default, limits, unit, doc, enum", !bad.length, bad.slice(0, 8).join(" | "));
  // a world record's params read the world component's types and limits
  const wbad: string[] = [];
  for (const [rec, key] of [["Terrain", "terrain"], ["Grass", "grass"], ["Sky", "sky"], ["Weather", "sky"]] as const)
    for (const [name, p] of Object.entries<any>(RECORDS[rec].params)) { const lim = regLimits(key, name); for (const k of ["min", "max"]) if (j(p[k]) !== j((lim as any)[k])) wbad.push(`${rec}.${name}: ${k} ${j(p[k])} vs ${j((lim as any)[k])}`); if (j(p.unit) !== j(regUnit(key, name))) wbad.push(`${rec}.${name}: unit`); }
  check("the world records (Sky, Weather, Terrain, Grass) carry the registry's limits and units", !wbad.length, wbad.join(" | "));
}

// 4. the inspector: one thing with every engine card; every value row a card claims is a registry field (or the card's own
//    derived row), and every numeric row of a ranged field carries the registry's limits and unit
{
  const M = (k: string, x: any = {}) => materialize(k, x).value;
  const every: any = { model: "store/x.glb", pos: [0, 0, 0], yaw: 0, light: { ...M("light"), day: false, important: true }, collider: { shape: "box" }, pivot: { pos: [0, 1, 0] },
    motion: { type: "pendulum", amp: 0.2 }, "motion:a": { type: "spin" }, "motion:b": { type: "orbit" }, "motion:c": { type: "bob" }, "motion:d": { type: "path", points: [[0, 0, 0], [1, 1, 1]], duration: 2 },
    openable: { open: true, angle: 1, slide: [1, 0, 0] }, grabbable: { fits: ["key"] }, particles: { effect: "fire" }, picture: { src: "store/a.png" }, sound: { src: "store/a.mp3" }, story: { title: "t", text: "x" },
    text: { text: "hi", background: 0x202020 }, "look-at": { target: "@viewer" }, physics: { kind: "dynamic", mass: 2 }, home: { pos: [0, 0, 0] } };
  const s = inspectSchema(every, "every", { parts: ["lid"], box: [[-1, 0, -1], [1, 2, 1]], materials: [], effects: () => null });
  const CARD_KEY: Record<string, string> = Object.fromEntries(Object.values<any>(DESCRIPTORS).map((d) => [d.card, d.key]));
  const bad: string[] = [];
  for (const sec of s.sections.list) {
    const card = sec.type === "LookAt" ? "LookAt" : sec.type; const d = DESCRIPTORS[card]; if (!d || card === "Transform" || card === "Sockets") continue;   // the two hand cards whose rows aren't claims: a pose's channels, a slot's rows
    const def = COMPONENTS[d.key];
    for (const a of sec.fields) {
      const f: any = fieldAt(s, a); if (!f || ["btn", "info", "json"].includes(f.t)) continue;
      const claim = D.claimOf(card, f.k); if (!claim) { bad.push(`${a}: a value row no descriptor claims`); continue; }
      if (claim.extra) continue;   // the card's own derived row (openable.by, text.plate, mesh size.x…)
      if (!(claim.path in (def.fields ?? {})) && !(!def.fields && claim.path in (def.defaults ?? {})) && d.key !== "pivot") bad.push(`${a}: claims ${claim.path}, not a field of ${d.key}`);
      if (f.t === "num") { const lim = regLimits(d.key, claim.path); for (const k of ["min", "max"]) if (j(f[k]) !== j((lim as any)[k])) bad.push(`${a}: row ${k} ${j(f[k])} vs registry ${j((lim as any)[k])}`);
        const u = regUnit(d.key, claim.path, d.type); if (!f.deg && j(f.unit) !== j(u)) bad.push(`${a}: row unit ${j(f.unit)} vs registry ${j(u)}`); }
    }
  }
  check(`the inspector's card rows ⊆ the registry's fields, with its limits and units (${s.sections.list.length} cards on one thing)`, !bad.length, bad.slice(0, 8).join(" | "));
  // the hand cards' own channel rows read the registry too: a mesh's size, an openable's slide, particles' at, physics' numbers
  const mesh = inspectSchema({ pos: [0, 0, 0], yaw: 0, mesh: { shape: "box", size: [1, 2, 1] } }, "m");
  const rows: [any, string, string][] = [[fieldAt(mesh, "mesh.size.x"), "mesh", "size"], [fieldAt(s, "openable.slide|0"), "openable", "slide"], [fieldAt(s, "particles.at|1"), "particles", "at"]];
  const rbad = rows.filter(([f, k, p]) => !f || j({ min: f.min, max: f.max, unit: f.unit }) !== j({ ...regLimits(k, p), unit: regUnit(k, p) })).map(([, k, p]) => `${k}.${p}`);
  check("the hand cards' channel rows (mesh.size, openable.slide, particles.at) carry the registry's limits and unit", !rbad.length, rbad.join(", "));
  check("limitsOf reads gt as the floor and skips text caps", j(limitsOf("light", "range")) === j({ min: 0, unit: "m" }) && j(limitsOf("story", "title")) === "{}" && j(limitsOf("sound", "radius")) === j({ min: 1, max: 100, unit: "m" }));
  // physics as text rows: a refusal reads the registry's range words
  const r = E.editOps(every, "every", { "physics.friction": "11" });
  check("a physics number past the registry's range is refused in the registry's words", r.errors.length === 1 && /≥ 0 and ≤ 10/.test(r.errors[0]), j(r.errors));
}

// 5. @world: the terrain and grass rows carry the registry's limits and units
{
  const st = { sky: { hours: 12 }, terrain: { seed: 7, size: 160, segments: 200, amplitude: 1, flatRadius: 16 }, grass: { species: "grass", density: 1, height: 0.3, width: 40, depth: 40 } };
  const ws = W.worldSchema(st);
  const bad: string[] = [];
  for (const [g, key] of [["terrain", "terrain"], ["grass", "grass"]] as const) for (const f of ws.groups.find((x: any) => x.group === g).fields) {
    if (f.t !== "num") continue; const lim = regLimits(key, f.k); for (const k of ["min", "max"]) if (j(f[k]) !== j((lim as any)[k])) bad.push(`${g}.${f.k}: ${k} ${j(f[k])} vs ${j((lim as any)[k])}`); if (j(f.unit) !== j(regUnit(key, f.k))) bad.push(`${g}.${f.k}: unit ${j(f.unit)}`);
  }
  check("@world's terrain and grass rows carry the registry's limits and units", !bad.length, bad.join(" | "));
}

// 6. no file but the registry declares a field's limits or unit (the grep-shaped pin): the descriptor and record tables carry
//    no `min:` / `max:` / `unit:` literal, and worldentity's terrain/grass rows none; editschema's own literal limits are
//    the Transform channels' (not a component field), a socket body's look limits (sockbody's shape) and the draft Material's
{
  const code = (p: string) => src(p).split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).map((l) => l.replace(/\/\/.*$/, ""));
  const lit = /\b(min|max|unit):\s*(?!(?:undefined|null)\b)[-'"\w.]/;
  const d = code("shared/protocol/descriptors.js").filter((l) => lit.test(l) && !/const lim = |\.\.\.lim|unit \}|\{ min: r\.min \}|\{ min: r\.gt \}|\{ max: r\.max \}/.test(l));
  check("shared/protocol/descriptors.js declares no field limit or unit of its own (min:, max:, unit:)", !d.length, d.slice(0, 4).join(" | "));
  const c = code("shared/components.js").filter((l) => lit.test(l) && !/p\.min = |p\.max = |p\.unit = |max: COMPONENTS\./.test(l));
  check("shared/components.js declares no field limit or unit of its own", !c.length, c.slice(0, 4).join(" | "));
  const w = code("shared/worldentity.js").filter((l) => /k: '(amplitude|size|segments|flatRadius|density|height|width|depth)'/.test(l) && /\b(min|max|unit):/.test(l));
  check("shared/worldentity.js's terrain and grass rows state no limit or unit of their own", !w.length, w.slice(0, 4).join(" | "));
  const e = code("shared/editschema.js").filter((l) => /\b(min|max):\s*-?\d/.test(l) && !/scale|quat|look|roughness|metalness|emissive|opacity|yaw|pitch|readLine/.test(l));
  check("shared/editschema.js states no numeric field limit of its own outside the Transform, socket-look and Material rows", !e.length, e.slice(0, 4).join(" | "));
}

// 7. the agent's schema is the registry: every registered component with a card has docs for every field its card shows
{
  const bad: string[] = [];
  for (const d of Object.values<any>(DESCRIPTORS)) for (const f of d.fields) if (f.path != null && !COMPONENTS[d.key].docs?.[f.path] && d.key !== "pivot" && d.key !== "transform") bad.push(`${d.key}.${f.path}`);
  check("every field a card shows has a one-line doc in the registry (what `schema` tells an agent)", !bad.length, bad.join(", "));
}

// training-consent (R 10-14): the world AND the person must both say yes; absent either is no. The reader is the one place the rule lives.
{ const W = { "training-consent": { allow: true }, "training-consent:ann": { allow: true }, "training-consent:bo": { allow: false } };
  check("training-consent: world yes + person yes → allowed", trainingAllowed(W, "ann") === true);
  check("training-consent: world yes + person no → not", trainingAllowed(W, "bo") === false);
  check("training-consent: world yes + person absent → not", trainingAllowed(W, "cy") === false);
  check("training-consent: world absent + person yes → not", trainingAllowed({ "training-consent:ann": { allow: true } }, "ann") === false);
  check("training-consent: no @world components at all → not", trainingAllowed(undefined, "ann") === false); }

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
