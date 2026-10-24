// server/render-scene.ts isn't served (server.ts), so nothing else loads it: this keeps it linkable, and checks that a
// particles component projects through the same resolver the browser uses (shared/particle_effects.js resolveParticles).
import { strict as assert } from "node:assert";
const m = await import("../server/render-scene.ts");
assert.equal(typeof m.projectComponentData, "function");
const fire = m.projectComponentData({ particles: { effect: "fire" } }, "hearth") as any;
assert.ok(fire.particles, "a known effect projects");
assert.equal(fire.particles.effect, "fire");
assert.ok(Array.isArray(fire.particles.emitters) && fire.particles.emitters.length > 0, "with its resolved emitters");
assert.equal(fire.particles.ok, undefined, "without the resolver's ok flag");
assert.equal(m.projectComponentData({ particles: { effect: "no-such-effect" } }, "x")?.particles, undefined, "an unknown effect projects nothing");
console.log("render-scene-import-test: 6 passed");
