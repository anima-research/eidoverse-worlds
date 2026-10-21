// tools/editor-range-test.ts — the editor writes what was typed (refactor plan 2, D4).
//
//   BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun tools/editor-range-test.ts
//
// Binds, for every descriptor num row (shared/protocol/descriptors.js) the Inspector writes: a value the DOOR takes is
// written as typed, though it is outside the row's slider bounds; a value the door refuses is refused here with nothing
// sent. The door's verdict is the authority's own (schemaRefusal), never a restated range. Also: an enum row is closed
// exactly where the registry names its enum.

import { inspectSchema, editOps, fieldAt } from "../shared/editschema.js";
import { DESCRIPTORS } from "../shared/protocol/descriptors.js";
import { COMPONENTS } from "../shared/protocol/componentspec.js";
import { schemaRefusal } from "../shared/protocol/authority.js";
import { flat } from "./protocol/scratchworld.ts";

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  else { fail++; console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? ` — ${detail}` : ""}`); }
};
const R2D = 180 / Math.PI;

const MOTION = { Pendulum: { type: "pendulum", axis: [1, 0, 0], amp: 0.3, period: 2.4, damp: 0.08, maxAmp: 0.9, phase: 0 },
  Spin: { type: "spin", axis: [0, 1, 0], degPerSec: 36, phase: 0 }, Orbit: { type: "orbit", radius: 2, degPerSec: 36, phase: 0 },
  Oscillate: { type: "oscillate", axis: [0, 1, 0], amp: 0.3, period: 4, phase: 0 }, Path: { type: "path", points: [[0, 0, 0], [1, 0, 0]], speed: 1, duration: 4, loop: "loop" } };
const FIXTURE: Record<string, [string, any][]> = {
  Light: [["light", { light: { color: 0xffd9a0, intensity: 16, range: 10 } }]],
  ...Object.fromEntries(Object.entries(MOTION).map(([card, m]) => [card, [["motion", { motion: m }]]])),
  Grabbable: [["grabbable", { grabbable: {} }]],
  Openable: [["openable", { openable: { open: false, angle: Math.PI / 2, axis: [0, 1, 0], time: 1 } }]],
  Particles: [["particles", { particles: { effect: "fire" } }]],
  Picture: [["picture", { picture: { src: "https://example.org/a.png", width: 1 } }]],
  Sound: [["sound", { sound: { src: "https://example.org/a.ogg", playing: true, loop: true, volume: 0.8, radius: 12 } }]],
  Text: [["text", { text: { text: "hi" } }]],
  LookAt: [["look-at", { "look-at": { target: "other", speed: 240, range: 12 } }]],
};
FIXTURE.Path.push(["motion", { motion: { type: "path", points: [[0, 0, 0], [1, 0, 0]], duration: 4, loop: "loop" } }]);

const lowOf = (r: any) => r.gt ?? r.min;
const doorTakes = (comp: string, bag: any, path: string, x: number) => schemaRefusal(comp, { ...bag, [path]: x }) === null;

let rows = 0; const typedRed = new Set<string>();
for (const [card, d] of Object.entries(DESCRIPTORS) as [string, any][]) {
  for (const fd of d.fields) {
    const ui = fd.ui; if (!ui || ui.t !== "num" || ui.own || fd.path == null) continue;
    if (!FIXTURE[card]) { check(`${card}.${fd.k}: a fixture draws it`, false, "no fixture: add one"); continue; }
    const drawn = FIXTURE[card].map(([group, comp]) => ({ group, comp, ent: { transform: { pos: [0, 0, 0], q: [0, 0, 0, 1], scale: [1, 1, 1] }, ...comp } }))   // a plain component map (the {pos, comp} entity drew no rows)
      .map((x) => ({ ...x, key: `${x.group}.${fd.k}`, f: fieldAt(inspectSchema(x.ent, "t1", {}), `${x.group}.${fd.k}`) })).find((x) => x.f);
    // a fixture exists for this card, so the row must draw: a row that doesn't is a field nothing checks (Weft on #260, 10-21:
    // the old {pos, comp} entity shape drew no rows, and every media field passed with nothing checked)
    if (!drawn) { check(`${card}.${fd.k}: its row draws from the fixture`, false, "no row drawn"); continue; }
    const { comp, ent, key, f } = drawn;
    rows++;
    const bag = comp[d.key];
    const typed = (x: number) => { const e = fd.wire ? fd.wire.from(x, { ...bag, [fd.path]: x }) : x; return ui.deg ? e * R2D : e; };
    const written = (r: any) => flat(r.ops).find((o: any) => o.verb === "set" && o.args.component === d.key)?.args.value?.[fd.path];
    const lo = f.min, hi = f.max;
    const inside: number[] = [], outside: number[] = [];
    // wire candidates around each slider bound and past the door's: the door's own verdict sorts them
    const probe = [lo, hi].filter((b) => b != null).flatMap((b: number) => [b - 0.04, b - 0.5, b - 1, b + 0.04, b + 0.5, b + 1]);
    const dp = ui.wdp ?? d.writeDp; const q = (v: number) => (dp == null ? v : Math.round(v * 10 ** dp) / 10 ** dp);
    const rowUnit = (e: number) => (ui.deg ? e : q(e));
    const wireOf = (e: number) => (fd.wire ? fd.wire.to(rowUnit(e)) : rowUnit(e));
    for (const e of probe) {
      const x = wireOf(e); if (typeof x !== "number") continue;
      const back = rowUnit(e);
      if ((lo == null || back >= lo) && (hi == null || back <= hi)) continue;
      (doorTakes(d.key, bag, fd.path, x) ? inside : outside).push(x);
    }
    const r = COMPONENTS[d.key]?.ranges?.[fd.path];
    if (r) for (const x of [lowOf(r) != null ? lowOf(r) - 1 : null, r.max != null ? r.max + 1 : null]) if (x != null && !doorTakes(d.key, bag, fd.path, x) && !outside.includes(x)) outside.push(x);
    for (const x of inside.slice(0, 2)) {
      const res = editOps(ent, "t1", { [key]: typed(x) });
      const w = written(res);
      if (!(!res.errors.length && typeof w === "number" && Math.abs(w - x) < 1e-3)) typedRed.add(`${card}.${fd.k}`);
      check(`${card} ${key}: ${+x.toFixed(4)} (the door takes it; the row's bounds are [${lo ?? ""}, ${hi ?? ""}]) is written as typed`, !res.errors.length && typeof w === "number" && Math.abs(w - x) < 1e-3, `wrote ${JSON.stringify(w)} errors ${JSON.stringify(res.errors)}`);
    }
    for (const x of outside.slice(0, 2)) {
      const res = editOps(ent, "t1", { [key]: typed(x) });
      check(`${card} ${key}: ${+x.toFixed(4)} (the door refuses it) is refused, nothing sent`, res.errors.length > 0 && written(res) === undefined && flat(res.ops).length === 0, `wrote ${JSON.stringify(written(res))} errors ${JSON.stringify(res.errors)}`);
    }
  }
}

console.log(`  ${rows} num rows; ${typedRed.size} write something other than a value the door takes${typedRed.size ? `: ${[...typedRed].join(", ")}` : ""}`);

// the "no row yet" writes (a component being made): the same door, the same rule
{
  const bare = { pos: [0, 0, 0], yaw: 0, actor: "r", ts: 1 };
  const SRC = { "picture.src": "https://example.org/a.png", "sound.src": "https://example.org/a.ogg", "look-at.target": "other" };
  const one = (key: string, raw: any, comp: string, path: string) => { const r = editOps(bare, "t1", { [Object.keys(SRC).find((k) => k.startsWith(key.split(".")[0] + "."))!]: SRC[Object.keys(SRC).find((k) => k.startsWith(key.split(".")[0] + "."))! as keyof typeof SRC], [key]: raw }); return { r, v: flat(r.ops).find((o: any) => o.verb === "set" && o.args.component === comp)?.args.value?.[path] }; };
  let x = one("picture.width", 0.03, "picture", "width"); check("a picture being made: width 0.03 (> 0) is written as typed", x.v === 0.03 && !x.r.errors.length, JSON.stringify(x));
  x = one("picture.width", 0, "picture", "width"); check("a picture being made: width 0 is refused (its src still commits; no 0 travels)", x.r.errors.length > 0 && x.v !== 0, JSON.stringify(x));
  x = one("sound.near", 0.05, "sound", "near"); check("a sound being made: near 0.05 (> 0) is written as typed", x.v === 0.05 && !x.r.errors.length, JSON.stringify(x));
  x = one("sound.radius", 0.5, "sound", "radius"); check("a sound being made: radius 0.5 (< 1) is refused (its src still commits; no 0.5 travels)", x.r.errors.length > 0 && x.v !== 0.5, JSON.stringify(x));
}

// a mesh's size: one door range per element
{
  const cube = { pos: [0, 0, 0], yaw: 0, actor: "r", ts: 1, mesh: { shape: "box", size: [1, 1, 1] } };
  const r0 = editOps(cube, "m1", { "mesh.size.z": "0" });
  check("a mesh size of 0 is refused with the door's words, nothing sent", r0.errors.length > 0 && !flat(r0.ops).length && /must be/.test(r0.errors[0] ?? ""), JSON.stringify(r0.errors));
}

// closed rows: exactly the registry's enums
for (const [card, d] of Object.entries(DESCRIPTORS) as [string, any][]) for (const fd of d.fields) {
  if (fd.ui?.t !== "enum" || fd.ui.own) continue;
  const spec = COMPONENTS[d.key]; const has = !!spec?.enums?.[fd.path];
  check(`${card}.${fd.k}: closed ${has ? "(the registry names its enum)" : "no (the registry names no enum)"}`, !!fd.ui.closed === has, `ui.closed ${fd.ui.closed}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
