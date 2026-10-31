// An agent's support for a thing lying down — tested headless.
//
//   bun tools/lying-support-test.ts
//
// A tumbling engine (eidosim) lays things on their sides. The agent's support
// was built from the thing's position and yaw alone, so a 1×2×0.5 slab lying
// on its side stood, for an agent's body, as a 2 m column at its origin: a
// phantom deck where it no longer stood, and nothing where it lay (review of
// b398d7e3 #1). This drives the agent's own syncSupport (no server: its
// geometry fetch is stubbed) and asks the same colliders the body settles on.

import { WorldAgent } from "../mcpl/agent.ts";
import { supportHolders } from "../mcpl/physics.ts";
// registration is detached and waits for the sim to load (seconds, the first time): wait for the box itself
const registered = async (bid: string) => { for (let i = 0; i < 300 && !supportHolders()[bid]; i++) await new Promise((r) => setTimeout(r, 50)); return !!supportHolders()[bid]; };

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  else { fail++; console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? ` — ${detail}` : ""}`); }
};

const ag: any = new WorldAgent({ name: "lying-bot", world: "lying" });
ag.geomFor = async () => ({ bbox: { min: [-0.5, 0, -0.25], max: [0.5, 2, 0.25], size: [1, 2, 0.5] }, topSurfaces: [] });
const s2 = Math.SQRT1_2;
// local +y → world -x: it lies along x in [18, 20], 1 m tall (y 0..1), z in [-0.25, 0.25]
ag.entities.set("slab", { id: "slab", model: "slab.glb", pos: [20, 0.5, 0], yaw: 0, q: [0, 0, s2, s2], actor: "x" });
await ag.syncSupport("slab");
if (!(await registered("lying/slab"))) check("setup: the slab's support registered", false, JSON.stringify(supportHolders()));
const C: any = await import("../client/lib/colliders.js");
console.log("an agent's support for a slab lying on its side:");
const on = C.surfaceUnder(19, 0, () => 0);
check("its true top (y 1, over x 18..20) is support", on.onto !== null && Math.abs(on.y - 1) < 1e-6, JSON.stringify(on));
const phantom = C.surfaceUnder(20.3, 0, () => 0);
check("…and where it would stand by yaw alone (y 2 at its origin) is not", phantom.onto === null && phantom.y === 0, JSON.stringify(phantom));
// standing things are unchanged: the same slab upright reads by its yaw
ag.entities.set("up", { id: "up", model: "slab.glb", pos: [40, 0, 0], yaw: 0.3, q: [0, Math.sin(0.15), 0, Math.cos(0.15)], actor: "x" });
await ag.syncSupport("up"); await registered("lying/up");
const up = C.surfaceUnder(40, 0, () => 0);
check("a standing slab is still a 2 m deck at its origin", Math.abs(up.y - 2) < 1e-6, JSON.stringify(up));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
