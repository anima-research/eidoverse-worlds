/**
 * Effective-transform test (#82): where a thing ACTUALLY is, composed from its fold record and its mount chain, or a
 * refusal naming the first link that can't be vouched for. Pure module, no servers; time is an argument.
 *
 * Run: cd mcpl && bun effective-test.ts
 *
 * Expected values are worked by hand from the composition rules (three.js's rotation convention: +90° about Y takes
 * +X to -Z, +90° about X takes +Y to +Z), never read back from the code under test.
 */

import { effectiveWorldTransform, type EffectiveView } from "./effective.ts";

let failures = 0;
const check = (label: string, ok: boolean, detail?: string) => {
  console.log(ok ? `  \x1b[32m✓\x1b[0m ${label}` : `  \x1b[31m✗ ${label}${detail ? ` — ${detail}` : ""}\x1b[0m`);
  if (!ok) failures++;
};
const near = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) < eps;
const near3 = (a: number[] | undefined, b: number[], eps = 1e-6) => !!a && a.length === 3 && a.every((v, i) => near(v, b[i], eps));
const S = Math.SQRT1_2;
const qY90 = [0, S, 0, S], qX90 = [S, 0, 0, S];   // [x, y, z, w]

/** A view over plain records: things by id, mounts by id. */
function view(things: Record<string, any>, mounts: Record<string, any> = {}): EffectiveView {
  return { entity: (id) => things[id], mount: (id) => mounts[id] };
}
const at = (id: string, v: EffectiveView) => effectiveWorldTransform(id, v, 0);
const show = (r: unknown) => JSON.stringify(r);

console.log("unmounted");
{
  const r = at("a", view({ a: { pos: [1, 2, 3], yaw: Math.PI / 2, scale: 2 } }));
  check("a thing stands at its folded pos, turned by its yaw", r.ok && near3(r.pos, [1, 2, 3]) && near(r.yaw, Math.PI / 2) && r.quat.every((v, i) => near(v, qY90[i])), show(r));
  check("a uniform scale is three of itself", r.ok && r.scale === 2 && near3(r.scale3, [2, 2, 2]), show(r));
}
{
  const r = at("a", view({ a: { pos: [0, 0, 0], yaw: 0, q: qX90 } }));
  check("a stored rotation (q) is the thing's whole orientation, not its yaw alone", r.ok && r.quat.every((v, i) => near(v, qX90[i])), show(r));
}
{
  const r = at("a", view({ a: { pos: [0, 0, 0], yaw: 0, scale: 1, scale3: [2, 3, 4] } }));
  check("a stretched thing keeps its per-axis scale", r.ok && near3(r.scale3, [2, 3, 4]), show(r));
}

{
  // a part-carrying motion leaves the root where it rests (parts swing, roots stand still): its whole stored rotation too
  const r = at("a", view({ a: { pos: [0, 0, 0], yaw: 0, q: qX90, motion: { type: "pendulum", part: "door" } } }));
  check("a moving thing keeps its stored rotation as its base", r.ok && r.quat.every((v, i) => near(v, qX90[i])), show(r));
}

console.log("mounted things");
{
  // parent at (10,0,0) turned +90° about Y at scale 2; the child's offset (1,0,0) is model-frame: ×2 → (2,0,0), then
  // turned: (0,0,-2). World: (10,0,-2).
  const r = at("c", view({ p: { pos: [10, 0, 0], yaw: Math.PI / 2, scale: 2 }, c: { pos: [99, 99, 99], yaw: 0 } }, { c: { to: "p", offset: [1, 0, 0] } }));
  check("a child rides its parent's frame: offset scaled, then turned", r.ok && near3(r.pos, [10, 0, -2]), show(r));
  check("never the child's own stale folded pos", r.ok && !near3(r.pos, [99, 99, 99]), show(r));
}
{
  // parent stretched (2,3,4), unturned: the offset (1,1,1) stretches per axis → (2,3,4) from the parent's origin
  const r = at("c", view({ p: { pos: [0, 0, 0], yaw: 0, scale: 1, scale3: [2, 3, 4] }, c: { pos: [0, 0, 0], yaw: 0, scale: 0.5 } }, { c: { to: "p", offset: [1, 1, 1] } }));
  check("a stretched parent stretches the offset per axis", r.ok && near3(r.pos, [2, 3, 4]), show(r));
  check("the child's scale composes per axis", r.ok && near3(r.scale3, [1, 1.5, 2]), show(r));
}
{
  // house 6340433633: a mounted child with its own per-axis scale (scale3Of), on a uniformly scaled parent: (1,2,3) × 2
  const r = at("c", view({ p: { pos: [0, 0, 0], yaw: 0, scale: 2 }, c: { pos: [0, 0, 0], yaw: 0, scale: 1, scale3: [1, 2, 3] } }, { c: { to: "p", offset: [0, 0, 0] } }));
  check("a mounted child's own scale3 composes with its parent's", r.ok && near3(r.scale3, [2, 4, 6]), show(r));
}
{
  // house 6340433633: a quarter turn on a stretched parent (2,3,4): +90° about Y takes the child's +X to the parent's −Z
  // and its +Z to +X, so the child's own axes are stretched (4,3,2), not (2,3,4)
  const r = at("c", view({ p: { pos: [0, 0, 0], yaw: 0, scale: 1, scale3: [2, 3, 4] }, c: { pos: [0, 0, 0], yaw: 0, scale: 1 } }, { c: { to: "p", offset: [0, 0, 0], yaw: Math.PI / 2 } }));
  check("a quarter-turned mount on a stretched parent swaps the stretched axes", r.ok && near3(r.scale3, [4, 3, 2]), show(r));
  // 45° on (2,1,1) mixes x and z, stretched unequally: a shear, refused for a thing; on (2,1,2) the turn sees one stretch
  const sh = at("c", view({ p: { pos: [0, 0, 0], yaw: 0, scale: 1, scale3: [2, 1, 1] }, c: { pos: [0, 0, 0], yaw: 0, scale: 1 } }, { c: { to: "p", offset: [1, 0, 0], yaw: Math.PI / 4 } }));
  check("a turned mount on an unequally stretched parent is refused (a shear no transform holds), naming the child", !sh.ok && sh.link === "c" && /shears/.test(sh.why), show(sh));
  const even = at("c", view({ p: { pos: [0, 0, 0], yaw: 0, scale: 1, scale3: [2, 1, 2] }, c: { pos: [0, 0, 0], yaw: 0, scale: 1 } }, { c: { to: "p", offset: [1, 0, 0], yaw: Math.PI / 4 } }));
  check("…and one turned within equally stretched axes is not", even.ok && near3(even.scale3, [2, 1, 2]) && near3(even.pos, [2, 0, 0]), show(even));
  // a body there has no extent of its own: its position is exact, so it's answered
  const body = effectiveWorldTransform("b", { entity: (id) => (id === "p" ? { pos: [0, 0, 0], yaw: 0, scale: 1, scale3: [2, 1, 1] } : undefined), mount: (id) => (id === "b" ? { to: "p", offset: [1, 0, 0], yaw: Math.PI / 4 } : undefined) }, 0);
  check("…and a body seated there is still placed (its offset through the stretch)", body.ok && near3(body.pos, [2, 0, 0]), show(body));
}
{
  // parent pitched +90° about X (its stored q): the offset (0,1,0) turns to (0,0,1); by its yaw alone it stayed (0,1,0)
  const r = at("c", view({ p: { pos: [5, 0, 0], yaw: 0, q: qX90 }, c: { pos: [0, 0, 0], yaw: 0 } }, { c: { to: "p", offset: [0, 1, 0] } }));
  check("a pitched parent's rotation turns the offset", r.ok && near3(r.pos, [5, 0, 1]), show(r));
}
{
  // grandparent (0,0,0); parent 1 up; child 1 up from the parent: (0,2,0)
  const r = at("c", view({ g: { pos: [0, 0, 0], yaw: 0 }, p: { pos: [0, 0, 0], yaw: 0 }, c: { pos: [0, 0, 0], yaw: 0 } },
    { p: { to: "g", offset: [0, 1, 0] }, c: { to: "p", offset: [0, 1, 0] } }));
  check("nested mounts compose recursively", r.ok && near3(r.pos, [0, 2, 0]), show(r));
}

console.log("refusals");
{
  const r = at("a", view({ a: { pos: [0, 0, 0] }, b: { pos: [0, 0, 0] } }, { a: { to: "b" }, b: { to: "a" } }));
  check("a mount cycle is refused, not composed", !r.ok && /cycle/.test(r.why), show(r));
}
{
  const r = at("nobody", view({}));
  check("an unknown id is refused", !r.ok && r.link === "nobody", show(r));
}
{
  const r = at("s", view({ h: { pos: [0, 0, 0], yaw: 0 }, s: { pos: [0, 0, 0], socket: { name: "grip", part: "arm" } } }, { s: { to: "h" } }));
  check("a socket riding a model part is refused, naming its host", !r.ok && r.link === "h" && /part "arm"/.test(r.why), show(r));
}
{
  const r = at("c", view({ p: { pos: [NaN, 0, 0], yaw: 0 }, c: { pos: [0, 0, 0] } }, { c: { to: "p" } }));
  check("a non-finite parent refuses the whole chain at the parent", !r.ok && r.link === "p", show(r));
}

console.log("bodies");
{
  // a body (no thing record) on a socket entity, no offset: the socket's own origin; no profile, so declared approximate
  const r = at("Ann", view({ seat: { pos: [4, 0, 4], yaw: 0 } }, { Ann: { to: "seat" } }));
  check("a seated body sits at its socket's origin", r.ok && near3(r.pos, [4, 0, 4]), show(r));
  check("with no seat profile, the composition says it's approximate", r.ok && r.seat?.state === "approximate", show(r));
}

console.log(failures ? `\x1b[31m${failures} failed\x1b[0m` : "\x1b[32mall checks passed\x1b[0m");
process.exit(failures ? 1 : 0);
