// bun tools/places-scale-test.ts — a named place on a scaled thing: its
// coordinates and extents scale with the thing, the walking body's arrival
// tolerances don't (mcpl/places.ts destinationOf → mcpl/navgrid.ts route),
// on the real collider code with small built shapes:
//   - at 20×, a room whose declared floor (20m) isn't there is refused —
//     not "reached" on the floor 1.5m beneath it;
//   - at 0.05×, a room whose floor sits 4cm off its declared height (0.8
//     model units of rounding) is still reached;
//   - at 20×, a seat walled off from the walker is refused — not "reached"
//     from 15m away outside the wall.
import { plugin } from "bun";
const STUB = new URL("./core-stub.mjs", import.meta.url).pathname;
plugin({ name: "core-stub", setup(b) { b.onResolve({ filter: /^\.\/core\.js$/ }, () => ({ path: STUB })); } });
const { THREE } = await import(STUB);
const { mergeGeometries } = await import("../client/node_modules/three/examples/jsm/utils/BufferGeometryUtils.js");
const C: any = await import("../client/lib/colliders.js");
const { makeNavGrid } = await import("../mcpl/navgrid.ts");
const P = await import("../mcpl/places.ts");
const { mkCheck } = await import("./harness.ts");
const { check, tally } = mkCheck();

const flat = () => 0;
const v = new THREE.Vector3();
const probe = {
  surfaceUnder: (x: number, z: number, maxY: number) => C.surfaceUnder(x, z, flat, maxY).y,
  stand: (x: number, y: number, z: number) => { v.set(x, y, z); const ground = C.resolveColliders(v, flat, 0.32, 1.9, true); return { ground, push: Math.hypot(v.x - x, v.z - z) }; },
};
function world(boxes: number[][]) {
  C.clearColliders();
  const geom = mergeGeometries(boxes.map(([x0, y0, z0, x1, y1, z1]) => {
    const g = new THREE.BoxGeometry(x1 - x0, y1 - y0, z1 - z0);
    g.translate((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
    return g.index ? g.toNonIndexed() : g;
  }), false);
  const m = new THREE.Mesh(geom, undefined); m.updateMatrixWorld(true);
  C.fitCollider("w", m, { collide: "exact" });
  return makeNavGrid(probe);
}
const go = (g: any, from: number[], d: any) => g.route({ x: from[0], y: from[1], z: from[2] }, d);
const say = (r: any) => "points" in r ? `arrived at ${JSON.stringify(r.points.at(-1))}` : r.refusal;

{
  // a thing at 20×: its room "loft" declared with its floor at 1.0 model
  // units (20m). No floor at 20m — only a platform at 18.5m, with a ramp of
  // steps up to it from the ground.
  const steps: number[][] = [];
  for (let k = 1; k <= 37; k++) steps.push([-20 + k * 0.3, 0, -1, -20 + (k + 1) * 0.3, k * 0.5, 1]);
  const g = world([[-8, 0, -8, 8, 18.5, 8], ...steps]);
  const room = { name: "loft", kind: "region" as const, min: [-0.3, 1.0, -0.3] as P.Vec3, max: [0.3, 1.5, 0.3] as P.Vec3, source: "component" as const };
  const d = P.destinationOf({ id: "giant", pos: [0, 0, 0], yaw: 0, scale: 20 }, room);
  check("a 20× room's floor tolerance is the body's, in metres (0.1m), not 2m", d.above === 0.1 && d.below === 0.1, JSON.stringify({ above: d.above, below: d.below }));
  const r = go(g, [-6, 18.5, 0], d);
  check("a 20× room whose declared floor (20m) isn't there is refused — not reached on the platform 1.5m beneath it",
    "refusal" in r && /on its floor/.test(r.refusal), say(r));
}
{
  // a thing at 0.05×: its room's floor declared at 6 model units (0.30m);
  // the real floor is at 0.26m (0.8 units of authoring rounding)
  const g = world([[-3, 0, -3, 3, 0.26, 3]]);
  const room = { name: "nook", kind: "region" as const, min: [-40, 6, -40] as P.Vec3, max: [40, 50, 40] as P.Vec3, source: "component" as const };
  const d = P.destinationOf({ id: "tiny", pos: [0, 0, 0], yaw: 0, scale: 0.05 }, room);
  const r = go(g, [-2.5, 0.26, -2.5], d);
  check("a 0.05× room whose floor is 4cm off its declared height is still reached (the tolerance doesn't shrink to 5mm)",
    "points" in r && Math.abs(r.points.at(-1).y - 0.26) < 0.02, say(r));
}
{
  // a 20× chair (seat at 1.0 model units = 20m, the chair 12m across), and
  // a ring of wall round it at 8–8.3m with no way in (taller than the seat,
  // so its top is no floor to arrive on)
  const ring = [[-8.3, 0, -8.3, 8.3, 25, -8], [-8.3, 0, 8, 8.3, 25, 8.3], [-8.3, 0, -8, -8, 25, 8], [8, 0, -8, 8.3, 25, 8]];
  const g = world([[-6, 0, -6, 6, 19.9, 6], ...ring]);
  const seat = { name: "throne", kind: "seat" as const, at: [0, 1.0, 0] as P.Vec3, source: "component" as const };
  const d = P.destinationOf({ id: "giant", pos: [0, 0, 0], yaw: 0, scale: 20 }, seat);
  check("a 20× seat is searched for beside it (standoff 0.7m + its 6m half-width), not anywhere within 20m",
    Math.abs(d.reach - (P.SEAT_STANDOFF + P.SEAT_HALF * 20)) < 1e-9 && d.reach < 8, `reach ${d.reach}`);
  const r = go(g, [14, 0, 0], d);
  check("a 20× seat walled off from the walker is refused — not 'reached' from outside the wall",
    "refusal" in r, say(r));
  // ...and with a gap in the ring, it is reached, beside the chair
  const g2 = world([[-6, 0, -6, 6, 19.9, 6], [-8.3, 0, -8.3, 8.3, 25, -8], [-8.3, 0, 8, 8.3, 25, 8.3], [-8.3, 0, -8, -8, 25, 8], [8, 0, -8, 8.3, 25, -1], [8, 0, 1, 8.3, 25, 8]]);
  const r2 = go(g2, [14, 0, 0], d);
  const end = "points" in r2 ? r2.points.at(-1) : null;
  check("...and with a doorway in the ring it is reached, beside the chair",
    !!end && Math.max(Math.abs(end.x), Math.abs(end.z)) < 6 + 0.7 + 0.2 && Math.abs(end.y) < 0.05, say(r2));
}
console.log(`\n${tally.passed} passed, ${tally.failed} failed`);
process.exit(tally.failed ? 1 : 0);
