// tools/shove-test.ts — shared/shove.js, the walker's side of body shove, frame by frame (no browser, no server):
// walking into a crate sends one punt; standing still, none; pressed against a wall of crates, a bounded number a second;
// a locked, held, static, underfoot or out-of-rights thing, none; a crate that moved and is walked into again, another.
//   BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun tools/shove-test.ts
// @ts-nocheck
import { createShover, contactOf, footprint, shoveV, SHOVE_FEEL } from "../shared/shove.js";
import { SHOVE } from "../shared/protocol/physconst.js";

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail: unknown = "") => { if (ok) pass++; else fail++; console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : `  ${typeof detail === "string" ? detail : JSON.stringify(detail)}`}`); };
const CRATE = [[-0.3, 0, -0.3], [0.3, 0.6, 0.3]];
const thing = (pos: number[], extra: any = {}) => ({ c: { physics: { kind: "dynamic", shape: CRATE, ...(extra.physics ?? {}) }, transform: { pos, q: [0, 0, 0, 1], scale: [1, 1, 1] }, ...(extra.c ?? {}) } });
const world = (things: Record<string, any>, wc: any = {}) => ({ entities: { "@world": { c: wc }, ...things } });
const R = 0.32, DT = 1000 / 60;
// a body walking +z at `speed` from z0, stopped by the crate's face (the collider), `frames` frames; returns every punt sent
function walk(st: any, { speed = 1.55, z0 = -1.2, x = 0, frames = 120, sh = createShover(), t0 = 0, opts = {} }: any = {}) {
  const out: any[] = []; let z = z0;
  for (let i = 0; i < frames; i++) {
    z = Math.min(z + speed * DT / 1000, -0.3 - R);   // the collider stops the capsule at the face
    const now = t0 + i * DT;
    for (const p of sh.step({ st, feet: [x, 0, z], vel: [0, speed], r: R, now, ...opts })) out.push({ ...p, now });
  }
  return { out, sh };
}

{ const st = world({ crate: thing([0, 0, 0]) });
  const { out } = walk(st);
  check("walk into a crate: one punt", out.length === 1, out);
  check("…pushed away, along the ground, at gain × the walk", out[0] && out[0].v[0] === 0 && out[0].v[2] === +(1.55 * SHOVE_FEEL.gain).toFixed(3) && out[0].v[1] > 0 && out[0].v[1] <= SHOVE.lift * out[0].v[2], out[0]);
  check("…within what the authority admits", out[0] && Math.hypot(...out[0].v) <= SHOVE.maxV, out[0]); }

{ const st = world({ crate: thing([0, 0, 0]) });
  const { out } = walk(st, { speed: 0, z0: -0.62 });
  check("standing still against it: none", out.length === 0, out); }

{ const st = world({ crate: thing([0, 0, 0]) });
  const { out } = walk(st, { speed: 4.0, frames: 30 });
  check("running into it: capped at the walker's own limit", out.length === 1 && Math.hypot(out[0].v[0], out[0].v[2]) <= SHOVE_FEEL.maxV + 1e-9, out); }

{ // a wall of crates the body is pressed against: two rows of five, every one in reach of the slack would be absurd, so a
  // row side by side at the body's face plus the row behind it; pressing on for 3 s
  const things: any = {}; for (let i = 0; i < 5; i++) { things[`f${i}`] = thing([(i - 2) * 0.25, 0, 0]); things[`b${i}`] = thing([(i - 2) * 0.25, 0, 0.6]); }
  const st = world(things);
  const { out } = walk(st, { frames: 180 });
  const perSec = Math.max(...out.map((p: any) => out.filter((q: any) => q.now >= p.now && q.now - p.now < 1000).length), 0);
  check("pressed against a wall of crates: bounded punts a second", perSec <= SHOVE_FEEL.perSec, `${perSec}/s over ${out.length}`);
  check("…and no punt storm: each crate it touches once while nothing moves", out.length <= 5 && new Set(out.map((p: any) => p.id)).size === out.length, out.map((p: any) => p.id)); }

for (const [name, st, opts] of [
  ["locked", world({ crate: thing([0, 0, 0], { c: { lock: true } }) }), {}],
  ["riding a locked table", world({ table: { c: { transform: { pos: [0, 0, 0], q: [0, 0, 0, 1], scale: [1, 1, 1] }, lock: true } }, crate: thing([0, 0, 0], { c: { parent: { to: "table" } } }) }), {}],
  ["held", world({ crate: thing([0, 0, 0]) }), { opts: { holds: { crate: { by: "u-x" } } } }],
  ["static", world({ crate: thing([0, 0, 0], { physics: { kind: "static" } }) }), {}],
  ["physics.who builder, a visitor walking", world({ crate: thing([0, 0, 0], { physics: { who: "builder" } }) }), { opts: { rank: 0 } }],
  ["in flight (skipped)", world({ crate: thing([0, 0, 0]) }), { opts: { skip: () => true } }],
] as any) { const { out } = walk(st, opts); check(`${name}: none`, out.length === 0, out); }

{ const st = world({ plank: { c: { physics: { kind: "dynamic", shape: [[-0.5, 0, -0.5], [0.5, 0.05, 0.5]] }, transform: { pos: [0, 0, 0], q: [0, 0, 0, 1], scale: [1, 1, 1] } } } });
  const sh = createShover(); let n = 0; for (let i = 0; i < 60; i++) n += sh.step({ st, feet: [0, 0.05, -0.6 + i * 0.02], vel: [0, 1.55], r: R, now: i * DT }).length;
  check("a flat thing under the feet (walked over): none", n === 0, n); }

{ const st = world({ crate: thing([0, 0, 0]) });
  const { out } = walk(st, { speed: 1.55, x: 0, frames: 5, z0: -0.62, opts: {} });
  const side = createShover(); let n = 0; for (let i = 0; i < 60; i++) n += side.step({ st, feet: [0, 0, -0.62], vel: [1.55, 0], r: R, now: i * DT }).length;
  check("walking past it (along its face, not into it): none", n === 0 && out.length === 1, { n, out }); }

{ const st = world({ crate: thing([0, 0, 0]) }); const sh = createShover(); let n = 0;
  for (let i = 0; i < 90; i++) n += sh.step({ st, feet: [-1.2 + i * 1.55 * DT / 1000, 0, -0.64], vel: [1.55, 0], r: R, now: i * DT }).length;
  check("brushing its corner on the way past (contact, but not heading into it): none", n === 0, n); }

{ // a long walk along a row of 40 crates, each walked into once: never more than per10s in any ten seconds
  const things: any = {}; for (let i = 0; i < 40; i++) things[`r${i}`] = thing([i * 1.2, 0, 0]);
  const st = world(things); const sh = createShover(); const sent: number[] = [];
  for (let i = 0; i < 40; i++) for (let k = 0; k < 30; k++) { const now = i * 400 + k * 13; for (const p of sh.step({ st, feet: [i * 1.2, 0, -0.62], vel: [0, 1.55], r: R, now })) sent.push(now); }
  const per10 = Math.max(0, ...sent.map((a) => sent.filter((b) => b >= a && b - a < 10000).length));
  check(`a walk into crate after crate: at most per10s (${SHOVE_FEEL.per10s}) in any ten seconds`, per10 <= SHOVE_FEEL.per10s && sent.length >= SHOVE_FEEL.per10s, { per10, n: sent.length }); }

{ // walking on behind a crate that moved: shoved again once it has moved and againMs has passed; not before
  const st = world({ crate: thing([0, 0, 0]) });
  const sh = createShover(); const sent: number[] = [];
  const at = (z: number, t: number) => { for (const p of sh.step({ st, feet: [0, 0, z], vel: [0, 1.55], r: R, now: t })) sent.push(t); };
  at(-0.62, 0); at(-0.62, 100);
  st.entities.crate.c.transform.pos = [0, 0, 0.4]; at(-0.22, 500);
  at(-0.22, 1000);
  check("walking on behind it: once at first contact, again after it moved (not within againMs)", JSON.stringify(sent) === "[0,1000]", sent); }

{ const box = footprint(world({ c: thing([1, 0, 1], {}) }), "c");
  check("footprint: the shape in the world", box && box.min.join() === "0.7,0,0.7" && box.max.join() === "1.3,0.6,1.3", box);
  check("contact: within r + slack only", !!contactOf([1, 0, 0.7 - R - 0.03], R, 1.9, box) && !contactOf([1, 0, 0.7 - R - 0.2], R, 1.9, box));
  check("shoveV: nothing below minSpeed", shoveV([0, SHOVE_FEEL.minSpeed * 0.9], [0, 1]) === null && !!shoveV([0, SHOVE_FEEL.minSpeed * 1.1], [0, 1])); }

{ const st = world({ crate: thing([0, 0, 0]) }); const sh = createShover();
  const one = (t: number) => sh.step({ st, feet: [0, 0, -0.62], vel: [0, 1.55], r: R, now: t }).length;
  const a = one(0); sh.refused("crate", 0); const away = sh.step({ st, feet: [0, 0, -3], vel: [0, 1.55], r: R, now: 10 }).length; const b = one(20); const c = one(SHOVE_FEEL.quietMs + 50);
  check("a refused thing is quiet for quietMs, even on a new contact", a === 1 && away === 0 && b === 0 && c === 1, { a, b, c });
  const sh2 = createShover(); const two = (t: number) => sh2.step({ st, feet: [0, 0, -0.62], vel: [0, 1.55], r: R, now: t }).length;
  const d0 = two(0); sh2.refused("crate", 0, "in-flight"); sh2.step({ st, feet: [0, 0, -3], vel: [0, 1.55], r: R, now: 10 }); const d1 = two(SHOVE_FEEL.againMs + 50);
  check("…a refusal that passes by itself (in-flight) only for againMs", d0 === 1 && d1 === 1, { d0, d1 }); }

console.log(`\n[shove-test] ${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
