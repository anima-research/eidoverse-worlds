// bun test/client/navgrid-rows-test.ts — routes on a world of built boxes (client/lib/colliders.js headless → shared/navgrid.js),
// and named places on scaled things (shared/places.js destinationOf). A route ends where a body can stand or is refused
// with its reason; a scaled thing scales its places' coordinates and extents, never the walking body's tolerances.
import { fileURLToPath } from "node:url";
import { plugin } from "bun";
import { stubResolve } from "../harness/stub.ts";
import { WAIT_SCALE } from "../gate/wait.ts";   // a wall-clock bound stretches with PROTOCOL_TIMEOUT_SCALE (bot #333 187, 218)
const STUB = fileURLToPath(new URL("../stubs/core-stub.mjs", import.meta.url));
plugin({ name: "core-stub", setup(b) { stubResolve(b, /^(\.\.?\/)+core\.js$/, () => ({ path: STUB })); } });
const { THREE } = await import(STUB);
const { mergeGeometries } = await import("../../client/node_modules/three/examples/jsm/utils/BufferGeometryUtils.js");
const C: any = await import("../../client/lib/colliders.js");
const { makeNavGrid, NAV_NUDGE } = await import("../../shared/navgrid.js");
const P = await import("../../shared/places.js");
const { mkCheck } = await import("../harness/harness.ts");
const { check, tally } = mkCheck();

const flat = () => 0;
const v = new THREE.Vector3();
const probe = {
  surfaceUnder: (x: number, z: number, maxY: number) => C.surfaceUnder(x, z, flat, maxY).y,
  stand: (x: number, y: number, z: number) => { v.set(x, y, z); const ground = C.resolveColliders(v, flat, 0.32, 1.9, true); return { ground, push: Math.hypot(v.x - x, v.z - z) }; },
};
/** Boxes [x0,y0,z0,x1,y1,z1] as one fitted collider, and the nav grid over it. */
function boxWorld(boxes: number[][], collide = "exact") {
  C.clearColliders();
  const geom = mergeGeometries(boxes.map(([x0, y0, z0, x1, y1, z1]) => {
    const g = new THREE.BoxGeometry(x1 - x0, y1 - y0, z1 - z0);
    g.translate((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
    return g.index ? g.toNonIndexed() : g;
  }), false);
  const m = new THREE.Mesh(geom, undefined); m.updateMatrixWorld(true);
  C.fitCollider("w", m, { collide });
  return makeNavGrid(probe);
}
/** Step each leg the way the feet would (3cm): never pushed, never more than a step up or down. */
function walks(from: any, points: any[]) {
  let { x, y, z } = from;
  for (const p of points) {
    const n = Math.max(1, Math.ceil(Math.hypot(p.x - x, p.z - z) / 0.03));
    for (let k = 1; k <= n; k++) {
      const px = x + (p.x - x) * k / n, pz = z + (p.z - z) * k / n, st = probe.stand(px, y, pz);
      if (st.push > NAV_NUDGE || Math.abs(st.ground - y) > 0.55) return `blocked near (${px.toFixed(2)}, ${pz.toFixed(2)})`;
      y = st.ground;
    }
    x = p.x; z = p.z;
  }
  return null;
}

// a place on a thing at the origin, yaw 0
const thing = (scale: number) => ({ id: `x${scale}`, pos: [0, 0, 0] as P.Vec3, yaw: 0, scale });
const LOFT = { name: "loft", kind: "region" as const, min: [-0.3, 1.0, -0.3] as P.Vec3, max: [0.3, 1.5, 0.3] as P.Vec3, source: "component" as const };
const NOOK = { name: "nook", kind: "region" as const, min: [-40, 6, -40] as P.Vec3, max: [40, 50, 40] as P.Vec3, source: "component" as const };
const THRONE = { name: "throne", kind: "seat" as const, at: [0, 1.0, 0] as P.Vec3, source: "component" as const };
const SPOT = { name: "spot", kind: "point" as const, at: [0.2, 0.5, -0.1] as P.Vec3, source: "component" as const };
const GATE = { name: "gate", kind: "door" as const, at: [-0.4, 0, 0.3] as P.Vec3, source: "component" as const };

// destinationOf over every kind × scale: coordinates scale with the thing, the body's tolerances don't
for (const scale of [0.05, 1, 20]) for (const p of [LOFT, NOOK, THRONE, SPOT, GATE]) {
  const d: any = P.destinationOf(thing(scale), p as any);
  const at = `${p.kind} ${p.name} at ${scale}×`;
  const local = p.kind === "region" ? [(p.min[0] + p.max[0]) / 2, p.min[1], (p.min[2] + p.max[2]) / 2] : (p as any).at;
  const yWant = local[1] * scale - (p.kind === "seat" ? 0.05 * Math.max(1, scale) : 0);
  check(`${at}: its coordinates scale with the thing`, Math.abs(d.x - local[0] * scale) < 1e-9 && Math.abs(d.y - yWant) < 1e-9 && Math.abs(d.z - local[2] * scale) < 1e-9, JSON.stringify([d.x, d.y, d.z]));
  const want = p.kind === "region" ? { reach: Math.max(0.6, Math.hypot((p.max[0] - p.min[0]) * scale, (p.max[2] - p.min[2]) * scale) / 2), above: P.ROOM_FLOOR_EPS, below: P.ROOM_FLOOR_EPS }
    : p.kind === "seat" ? { reach: P.SEAT_STANDOFF + P.SEAT_HALF * scale, above: 0, below: undefined }
    : { reach: 0.6, above: undefined, below: undefined };
  check(`${at}: reach ${p.kind === "seat" ? "is the standoff plus its scaled half-width" : p.kind === "region" ? "covers the scaled room" : "is the body's"}; floor tolerance is the body's, in metres`,
    Math.abs(d.reach - want.reach) < 1e-9 && (p.kind !== "seat" || scale !== 20 || d.reach < 8) && d.above === want.above && d.below === want.below, JSON.stringify({ reach: d.reach, above: d.above, below: d.below }));
}

// a ring of wall 8–8.3 m out, 25 m tall, with an optional doorway on +x
const ring = (door: boolean) => [[-8.3, 0, -8.3, 8.3, 25, -8], [-8.3, 0, 8, 8.3, 25, 8.3], [-8.3, 0, -8, -8, 25, 8],
  ...(door ? [[8, 0, -8, 8.3, 25, -1], [8, 0, 1, 8.3, 25, 8]] : [[8, 0, -8, 8.3, 25, 8]])];
const steps: number[][] = [];
for (let k = 1; k <= 37; k++) steps.push([-20 + k * 0.3, 0, -1, -20 + (k + 1) * 0.3, k * 0.5, 1]);
const CRATE = [[-0.5, 0, -0.5, 0.5, 1, 0.5]];
type Row = { name: string; boxes: number[][]; collide?: string; from: number[]; to: any;
  refused?: RegExp; withinMs?: number; arrives?: (end: any, r: any, from: any) => string | null };
const ROWS: Row[] = [
  // the gap sits between two lattice columns (x = 0.0131, 0.2131): both stand at 1 m, only the floor BETWEEN says no
  { name: "two platforms at one height with a gap between them are no path across", boxes: [[-3, 0.8, -1, 0.04, 1.0, 1], [0.19, 0.8, -1, 3, 1.0, 1]],
    from: [-2, 1.0, 0], to: { x: 2, z: 0, y: 1.0 }, refused: /./ },
  { name: "a route round a tight corner keeps the corner: every leg walkable at 3 cm steps", boxes: [[0, 0.8, 0, 5, 1.0, 0.9], [4.1, 0.8, 0, 5, 1.0, 5]],
    from: [0.45, 1.0, 0.45], to: { x: 4.55, z: 4.55, y: 1.0 }, arrives: (_e, r, from) => r.points.length >= 2 ? walks(from, r.points) : "one point" },
  { name: "a destination a hand's width inside a crate's reach ends where a body can stand, snapped", boxes: CRATE, collide: "box",
    from: [3, 0, 0], to: { x: 0.5 + 0.32 - 0.07, z: 0, y: 0 }, arrives: (e, r) => { const st = probe.stand(e.x, e.y, e.z); return st.push < NAV_NUDGE && r.snapped ? null : `push ${st.push.toFixed(3)} snapped ${r.snapped}`; } },
  { name: "a destination 100 km away is refused for its size, quickly", boxes: CRATE, collide: "box",
    from: [3, 0, 0], to: { x: 100_000, z: 0 }, refused: /too far to plan/, withinMs: 5000 },
  { name: "a 20× room whose declared floor (20 m) isn't there is refused, not reached on the platform 1.5 m beneath it", boxes: [[-8, 0, -8, 8, 18.5, 8], ...steps],
    from: [-6, 18.5, 0], to: P.destinationOf(thing(20), LOFT), refused: /on its floor/ },
  { name: "a 0.05× room whose floor is 4 cm off its declared height is still reached (the tolerance doesn't shrink to 5 mm)", boxes: [[-3, 0, -3, 3, 0.26, 3]],
    from: [-2.5, 0.26, -2.5], to: P.destinationOf(thing(0.05), NOOK), arrives: (e) => Math.abs(e.y - 0.26) < 0.02 ? null : `y ${e.y}` },
  { name: "a 20× seat walled off from the walker is refused, not 'reached' from outside the wall", boxes: [[-6, 0, -6, 6, 19.9, 6], ...ring(false)],
    from: [14, 0, 0], to: P.destinationOf(thing(20), THRONE), refused: /./ },
  { name: "the same ring with a doorway: the 20× seat is reached, beside the chair", boxes: [[-6, 0, -6, 6, 19.9, 6], ...ring(true)],
    from: [14, 0, 0], to: P.destinationOf(thing(20), THRONE), arrives: (e) => Math.max(Math.abs(e.x), Math.abs(e.z)) < 6 + 0.7 + 0.2 && Math.abs(e.y) < 0.05 ? null : JSON.stringify(e) },
];
for (const row of ROWS) {
  const g = boxWorld(row.boxes, row.collide);
  const from = { x: row.from[0], y: row.from[1], z: row.from[2] };
  const t0 = performance.now(); const r: any = g.route(from, row.to); const ms = performance.now() - t0;
  const said = "points" in r ? `arrived at ${JSON.stringify(r.points.at(-1))}` : r.refusal;
  if (row.refused) check(row.name, "refusal" in r && row.refused.test(r.refusal) && (row.withinMs === undefined || ms < row.withinMs * WAIT_SCALE), `${ms.toFixed(0)} ms: ${said}`);
  else { const why = "points" in r ? row.arrives!(r.points.at(-1), r, from) : "refused"; check(row.name, why === null, `${said} ${why ?? ""}`); }
}
console.log(`\n${tally.passed} passed, ${tally.failed} failed`);
process.exit(tally.failed ? 1 : 0);
