// bun tools/navgrid-edge-test.ts — routing edge cases, on the real collider
// code (client/lib/colliders.js, headless) with small built shapes:
//   - two platforms at one height with a gap between them are not a path;
//   - a route round a tight corner keeps the corner (every leg walkable);
//   - a destination a hand's width inside a box ends where a body can stand;
//   - a destination 100km away is refused quickly, not planned for seconds.
import { plugin } from "bun";
const STUB = new URL("./core-stub.mjs", import.meta.url).pathname;
plugin({ name: "core-stub", setup(b) { b.onResolve({ filter: /^\.\/core\.js$/ }, () => ({ path: STUB })); } });
const { THREE } = await import(STUB);
const { mergeGeometries } = await import("../client/node_modules/three/examples/jsm/utils/BufferGeometryUtils.js");
const C: any = await import("../client/lib/colliders.js");
const { makeNavGrid, NAV_NUDGE } = await import("../mcpl/navgrid.ts");
const { mkCheck } = await import("./harness.ts");
const { check, tally } = mkCheck();

const flat = () => 0;
const v = new THREE.Vector3();
const probe = {
  surfaceUnder: (x: number, z: number, maxY: number) => C.surfaceUnder(x, z, flat, maxY).y,
  stand: (x: number, y: number, z: number) => { v.set(x, y, z); const ground = C.resolveColliders(v, flat, 0.32, 1.9, true); return { ground, push: Math.hypot(v.x - x, v.z - z) }; },
};
function world(boxes: number[][], collide = "exact") {
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

{
  // two platforms 1m up, 15cm apart, over open ground: stepping across is a
  // fall. The gap sits between two lattice columns (x = 0.0131, 0.2131), so
  // both columns stand at 1m and only the floor BETWEEN them says no.
  const g = world([[-3, 0.8, -1, 0.04, 1.0, 1], [0.19, 0.8, -1, 3, 1.0, 1]]);
  const r = g.route({ x: -2, y: 1.0, z: 0 }, { x: 2, z: 0, y: 1.0 });
  check("two platforms at one height with a gap between them are no path across", "refusal" in r, JSON.stringify(r).slice(0, 200));
}
{
  // a raised L-shaped walkway 0.9m wide: the route must go round its corner
  const g = world([[0, 0.8, 0, 5, 1.0, 0.9], [4.1, 0.8, 0, 5, 1.0, 5]]);
  const from = { x: 0.45, y: 1.0, z: 0.45 };
  const r = g.route(from, { x: 4.55, z: 4.55, y: 1.0 });
  const bad = "points" in r ? walks(from, r.points) : "refused";
  check("a route round a tight corner keeps the corner: every leg walkable", "points" in r && r.points.length >= 2 && bad === null,
    "points" in r ? `${JSON.stringify(r.points.map((p: any) => [+p.x.toFixed(2), +p.z.toFixed(2)]))} ${bad ?? ""}` : (r as any).refusal);
}
{
  // a crate on open ground; ask for a point 7cm inside the reach of its side
  const g = world([[-0.5, 0, -0.5, 0.5, 1, 0.5]], "box");
  const want = { x: 0.5 + 0.32 - 0.07, z: 0 };
  const r = g.route({ x: 3, y: 0, z: 0 }, { ...want, y: 0 });
  const end = "points" in r ? r.points[r.points.length - 1] : null;
  const st = end ? probe.stand(end.x, end.y, end.z) : null;
  check("a destination a hand's width inside a crate's reach ends where a body can stand, not there",
    !!st && st.push < NAV_NUDGE && "points" in r && r.snapped, end ? `ends at (${end.x.toFixed(2)}, ${end.z.toFixed(2)}), push ${st!.push.toFixed(3)}` : JSON.stringify(r));
}
{
  const g = world([[-0.5, 0, -0.5, 0.5, 1, 0.5]], "box");
  const t0 = performance.now();
  const r = g.route({ x: 3, y: 0, z: 0 }, { x: 100_000, z: 0 });
  const ms = performance.now() - t0;
  check("a destination 100km away is refused for its size, quickly", "refusal" in r && /too far to plan/.test((r as any).refusal) && ms < 5000, `${ms.toFixed(0)}ms ${JSON.stringify(r).slice(0, 120)}`);
}
console.log(`\n${tally.passed} passed, ${tally.failed} failed`);
process.exit(tally.failed ? 1 : 0);
