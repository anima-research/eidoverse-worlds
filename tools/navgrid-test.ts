// bun tools/navgrid-test.ts — walk_to routes through placed models.
//
// mcpl/navgrid.ts plans against the same colliders the feet are moved by
// (agent-mesh-collision-test covers the feet). Here a real WorldAgent, on an
// isolated sequencer, is given ONE walk_to per destination and has to find
// its own way: in through the door, up the stair, along the upper floor, down
// again, out and round the building; to stay on its own storey unless told
// otherwise; to be refused — with a reason — where there is no way or nowhere
// to stand; and to keep the single straight leg it always had on open ground.
process.env.AGENT_BODY_ENGINE = "verlet";
process.env.WORLD_TOKEN = "";
const { FLOOR, UPPER, RISE, GOING, STAIR_FOOT, boxes, buildGlb } = await import("./two-storey-fixture.ts");
const { scratchSequencer, mkCheck, sleep } = await import("./harness.ts");
const { check, tally } = mkCheck();

const h = await scratchSequencer("navgrid", { serverEnv: { SKIP_OPT_SWEEP: "1" }, portFrom: 9460 });
const { WorldAgent } = await import("../mcpl/agent.ts");
const a: any = new WorldAgent({ name: "router", world: "navgrid", url: h.BASE.replace("http", "ws") + "/ws" });
const near = (v: number, want: number, tol = 0.05) => Math.abs(v - want) <= tol;
const at = () => `(${a.pos.x.toFixed(2)}, ${a.pos.y.toFixed(3)}, ${a.pos.z.toFixed(2)})`;
try {
  await a.connect();
  const upload = async (name: string, list: any[]) =>
    ((await (await fetch(`${h.BASE}/upload?name=${name}`, { method: "POST", body: await buildGlb(list) })).json()) as { path: string }).path;
  const gy = a.heightAt(0, 0);
  a.verb("spawn", { id: "tower", lib: await upload("two-storey", boxes), pos: [0, gy, 0], yaw: 0 });
  // a sealed room 12m west: four walls, no door
  const SX = -12;
  a.verb("spawn", { id: "vault", lib: await upload("vault", [
    [-2.5, 0, -2.5, 2.5, 0.2, 2.5],
    [-2.5, 0.2, -2.5, -2.3, 3, 2.5], [2.3, 0.2, -2.5, 2.5, 3, 2.5],
    [-2.3, 0.2, -2.5, 2.3, 3, -2.3], [-2.3, 0.2, 2.3, 2.3, 3, 2.5],
  ]), pos: [SX, a.heightAt(SX, 0), 0], yaw: 0 });
  for (let i = 0; i < 100 && !(a.supportIds?.get("tower") && a.supportIds?.get("vault")); i++) await sleep(50);
  await a.supportReady();
  await sleep(300);

  // each destination is ONE walk_to; the planner finds the way
  const go = async (x: number, z: number, y?: number) => {
    const ok = await a.walkTo(x, z, true, 60_000, 0.01, y);
    return { ok, refusal: a.walkRefusal, stall: a.walkStall };
  };

  await a.walkTo(0, 6, true);
  {
    const r = await go(-1.5, -2.2, UPPER);
    check("from outside, one walk_to with y reaches the upper floor — in at the door, up the stair",
      r.ok && near(a.pos.y, gy + UPPER) && Math.hypot(a.pos.x + 1.5, a.pos.z + 2.2) < 0.05, `${at()} ${r.refusal ?? r.stall ?? ""}`);
  }
  {
    const r = await go(-2.0, 2.0);
    check("a walk across the upper floor without y stays upstairs (the body's own storey)",
      r.ok && near(a.pos.y, gy + UPPER), `${at()} ${r.refusal ?? r.stall ?? ""}`);
  }
  {
    // (2.2, 0.1) is over the stair, mid-tread: that tread is where a body
    // can stand there — reached by the stair, not by the drop from above
    const tread = Math.ceil((STAIR_FOOT - 0.1) / GOING);
    const r = await go(2.2, 0.1);
    check("a point over the stairwell is reached on the stair's tread there, by the stair — never off the edge",
      r.ok && near(a.pos.y, gy + FLOOR + tread * RISE), `${at()} want y ${(gy + FLOOR + tread * RISE).toFixed(3)} ${r.refusal ?? r.stall ?? ""}`);
  }
  {
    // from upstairs to a point with no upper storey: the lowest floor there
    const r = await go(0, 5);
    check("from upstairs, a point outside without y is reached on the ground (no floor there at the body's height)",
      r.ok && near(a.pos.y, a.heightAt(0, 5)), `${at()} ${r.refusal ?? r.stall ?? ""}`);
    await go(-1.5, -2.2, UPPER);
  }
  {
    const r = await go(-2.0, 2.0, 0);
    check("y picks the ground floor at a point with two storeys over it",
      r.ok && near(a.pos.y, gy + FLOOR), `${at()} ${r.refusal ?? r.stall ?? ""}`);
  }
  {
    const r = await go(-6, 0);
    check("from inside, a point outside the far wall is reached out the door and round the building",
      r.ok && near(a.pos.y, a.heightAt(-6, 0)) && Math.hypot(a.pos.x + 6, a.pos.z) < 0.05, `${at()} ${r.refusal ?? r.stall ?? ""}`);
  }
  {
    // from outside, (-2.9, 0) is inside the west wall: a body can stand just
    // outside it (two steps away) or just inside (round by the door)
    const r = await go(-2.9, 0);
    check("a destination inside a wall is reached on the side the body is on — not round by the door",
      r.ok && a.pos.x < -3.2 && Math.hypot(a.pos.x + 2.9, a.pos.z) < 0.7 && near(a.pos.y, a.heightAt(a.pos.x, a.pos.z)), `${at()} ${r.refusal ?? r.stall ?? ""}`);
  }
  {
    const before = at();
    const r = await go(SX, 0);
    check("a sealed room is refused, with the reason, and the body does not move",
      !r.ok && /no walkable way/.test(r.refusal ?? "") && at() === before, `${r.refusal} — ${at()}`);
  }
  {
    const r = await go(0, 0, 10);
    // y=10 is above everything: the surface at or below it is the upper floor
    check("y above the building picks its highest standing surface (the upper floor), not the roofless air",
      r.ok && near(a.pos.y, gy + UPPER), `${at()} ${r.refusal ?? r.stall ?? ""}`);
  }
  {
    await go(0, 6, 0);
    const t0 = performance.now();
    const p = a.walkTo(6, 10, true);
    const legs = [a.target, ...a.legs].filter(Boolean);
    const planMs = performance.now() - t0;
    check("open ground keeps the single straight leg walk_to always walked", legs.length === 1, JSON.stringify(legs));
    check("...and planning it is cheap", planMs < 150, `${planMs.toFixed(0)}ms`);
    await p;
  }
  {
    await go(0, 6, 0);
    const t0 = performance.now();
    const p = a.walkTo(-1.5, -2.2, true, 60_000, 0.01, UPPER);
    const planMs = performance.now() - t0;
    // a bound on how long one plan can hold the process's event loop (every
    // agent in it waits), generous enough for a loaded machine: unloaded it
    // is ~0.2s once the columns around the route are known
    check("planning the longest route here (outside → door → stair → upper floor) holds the loop under 1.5s",
      planMs < 1500, `${planMs.toFixed(0)}ms`);
    const legs = [a.target, ...a.legs].filter(Boolean);
    check("...and is a handful of legs, not a cell-by-cell staircase", legs.length >= 3 && legs.length <= 12, `${legs.length} legs`);
    await p;
  }
} finally {
  try { a.close(); } catch { /* gone */ }
  await h.cleanup(tally.failed || process.exitCode ? 1 : 0);
}
console.log(`${tally.passed} passed, ${tally.failed} failed`);
process.exit(tally.failed ? 1 : 0);
