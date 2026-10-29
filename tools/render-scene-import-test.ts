// server/render-scene.ts isn't served (server.ts), so nothing else loads it: this keeps it linkable, and checks that a
// particles component projects through the same resolver the browser uses (shared/particle_effects.js resolveParticles).
// R1 (review L24): main's water / air / vehicle / traversal / collision, translated (translate-v1.js), project back to what main's
// native renderer read: each part in its own thing's frame, composed with that thing's transform.
import { strict as assert } from "node:assert";
const m = await import("../server/render-scene.ts");
const T = await import("./protocol/import-v1/translate-v1.js");
assert.equal(typeof m.projectComponentData, "function");
const fire = m.projectComponentData({ particles: { effect: "fire" } }, "hearth") as any;
assert.ok(fire.particles, "a known effect projects");
assert.equal(fire.particles.effect, "fire");
assert.ok(Array.isArray(fire.particles.emitters) && fire.particles.emitters.length > 0, "with its resolved emitters");
assert.equal(fire.particles.ok, undefined, "without the resolver's ok flag");
assert.equal(m.projectComponentData({ particles: { effect: "no-such-effect" } }, "x")?.particles, undefined, "an unknown effect projects nothing");

const near = (a: number[], b: number[], what: string) => assert.ok(a.length === b.length && a.every((x, i) => Math.abs(x - b[i]) < 1e-9), `${what}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`);
const at = (parts: any[], key: string) => parts.map(([, c]: any) => ({ c, d: m.projectComponentData(c) as any })).find((x) => x.d?.[key]);
// main's water on a bare host (zone+water on itself) and at an offset (a child at its centre); main's air boxes (children)
const water = { center: [0, 0, 0], size: [10, 4, 6], absorption: [0.2, 0.1, 0.05], scatter: [0.01, 0.1, 0.2] };
{ const own = T.volumePartsOf("pond", { water }, {}).own, d = m.projectComponentData(own) as any;
  near(d.water.center, water.center, "R1 a host's own water: centre"); near(d.water.size, water.size, "size"); near(d.water.absorption, water.absorption, "absorption"); near(d.water.scatter, water.scatter, "scatter"); }
{ const off = { ...water, center: [3, -1, 2] }, kid = at(T.volumePartsOf("pool", { water: off }, { model: "x.glb" }).children, "water")!;
  near(kid.c.transform.pos.map((v: number, i: number) => v + kid.d.water.center[i]), off.center, "R1 an offset water: its thing's place + the projected centre = main's centre"); near(kid.d.water.size, off.size, "size"); }
{ const b = { center: [1, 2, 3], size: [2, 2, 2], q: [0, 0.3826834323650898, 0, 0.9238795325112867] }, kid = at(T.volumePartsOf("hull", { air: { boxes: [b] } }, {}).children, "air")!;
  near(kid.c.transform.pos.map((v: number, i: number) => v + kid.d.air.boxes[0].center[i]), b.center, "R1 an air box: centre"); near(kid.d.air.boxes[0].size, b.size, "size"); near(kid.c.transform.q, b.q, "its q is its thing's"); }
// main's water level below its box's top: v4's zone + water.level
{ const d = m.projectComponentData({ zone: { shape: "box", size: [4, 4, 4] }, water: { level: 1 } }) as any; near(d.water.center, [0, -0.5, 0], "R1 water.level: the body's centre"); near(d.water.size, [4, 3, 4], "its size"); }
{ const v = T.vehiclePartsOf("boat", { helm: [0, 1, 2], speed: 6, turnRate: 0.8 }), d = m.projectComponentData({ drive: v.drive }) as any;
  assert.deepEqual([d.vehicle.speed, d.vehicle.turnRate], [6, 0.8], "R1 drive → vehicle {speed, turnRate}"); }
{ const route = { name: "ladder A", path: [[0, 0, 0], [0, 3, 0]], radius: 1, speed: 1.1 }, kid = at(T.climbPartsOf("wall", { routes: [route] }).children, "traversal")!;
  assert.deepEqual(kid.d.traversal.routes, [{ path: route.path, radius: 1, speed: 1.1, name: "ladder A" }], "R1 climb → traversal's route, in its thing's frame (identity under the host)"); }
assert.deepEqual((m.projectComponentData({ collider: { enabled: false } }) as any).collision, { enabled: false }, "R1 collider {enabled: false} → collision {enabled: false}");
assert.equal(m.projectComponentData({ collider: { shape: "box" } }), null, "R1 a collider that's on projects no collision toggle");
console.log("render-scene-import-test: 18 passed");
