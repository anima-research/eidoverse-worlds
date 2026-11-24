// The physics crash-test dummy: a headless body that stands there and takes
// it. Push it, blast it, drag it, nail it up — it tumbles under the real
// Verlet (mcpl/physics.ts) like anybody else, and a while after it has been
// left lying with nobody's hand on it and no nails through it, it quietly
// gets back up, ready for the next one.
//
//   WORLD_URL=ws://127.0.0.1:8940/ws WORLD_TOKEN=<join token> \
//   AGENT_NAME=phys-dummy WORLD_NAME=commons bun run test/harness/dummy.ts
//
// Ran as eidoverse-dummy.service on the show VPS as tools/dummy.ts (9ddc16c3a); the unit is not in deploy/, so a
// live one may still name the old path.

import { WorldAgent } from "../../mcpl/agent.ts";

const ag = new WorldAgent({
  name: process.env.AGENT_NAME ?? "phys-dummy",
  world: process.env.WORLD_NAME ?? "commons",
});

(ag as any).onEvent = (e: any) => {
  if (e?.text && e.text.startsWith("(")) console.log(`[dummy] ${e.who}: ${e.text}`);
};

await ag.connect();
console.log(`[dummy] ${ag.name} standing in ${ag.world} — push me`);

// Getting back up is the toy's reset spring: settled, unheld, un-nailed, and
// nobody has touched it for a beat → stand. Never while dragged or hung.
let downSince = 0;
setInterval(() => {
  const down = ag.clip === "ragdoll" && !ag.draggedBy && ag.pins.size === 0 && !(ag as any).body?.active;
  if (!down) { downSince = 0; return; }
  if (!downSince) { downSince = Date.now(); return; }
  if (Date.now() - downSince > 15_000) {
    downSince = 0;
    ag.setPose(null);
    console.log("[dummy] getting back up");
  }
}, 2_000);
