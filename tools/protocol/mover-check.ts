// tools/protocol/mover-check.ts — ONE walker (shared/mover.js) for the agent, the human client and the authority.
// usage: bun tools/protocol/mover-check.ts
//   D   drift guard: no caller carries locomotion numbers or stride math of its own; each reads shared/mover.js.
//       Before the port this was red with three answers to "is a 0.7 m ledge a floor?": the agent had no floors at all
//       (terrain only), the authority said yes (TRACK.step 0.8), the client said no (colliders STEP 0.55) — and three
//       radii/heights (none / 0.2 × 1.7 / 0.32 × 1.9).
//   M   the mover alone: a stride's length (walk, run, a cap), the floor rule (onto 0.7, onto 0.8, not 0.9), a wall
//       (env.blocked refuses the step and the body stays put), arrival (tolerance, its bounds, no overshoot)
//   A   agreement: every spot the mover walks an agent-shaped body to is a `move` the real authority accepts at the
//       same millimetre; the ledge and the wall the mover refuses are the ones the authority refuses; the client's
//       capsule and mantle are the mover's body
// @ts-nocheck
import fs from "node:fs";
import path from "node:path";
import { ENGINE, scratch } from "./common.ts";

let pass = 0, fail = 0;
const ok = (cond, what, detail?) => { if (cond) pass++; else { fail++; console.log(`  FAIL ${what}${detail !== undefined ? ` — ${JSON.stringify(detail).slice(0, 600)}` : ""}`); } };
const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;
const src = (p) => fs.readFileSync(path.join(ENGINE, p), "utf8");

// ---- D: the drift guard ----
{
  const agent = src("mcpl/agent.ts"), auth = src("shared/protocol/authority.js"), ctrl = src("client/lib/controller.js"),
    coll = src("client/lib/colliders.js"), scale = src("client/lib/bodyscale.js"), thing = src("client/lib/thingphysics.js");
  const own = {
    agent: agent.match(/^const WALK\s*=.*$/m)?.[0] ?? null,
    authority: auth.match(/^const TRACK\s*=.*$/m)?.[0] ?? null,
    colliders: [coll.match(/^const STEP\s*=.*$/m)?.[0], coll.match(/^const TALL\s*=.*$/m)?.[0]].filter(Boolean),
    bodyscale: scale.match(/COLLIDER_R\s*=\s*[\d.]+/)?.[0] ?? null,
    controller: ctrl.match(/running \? 4\.0 : 1\.55|addScaledVector\(_dir, myState\.speed \* dt\)/)?.[0] ?? null,
  };
  const stepOf = { agent: own.agent ? "none (terrain only: no floors)" : "mover", authority: auth.match(/step:\s*([\d.]+)/)?.[1] ?? "mover", client: coll.match(/^const STEP\s*=\s*([\d.]+)/m)?.[1] ?? "mover" };
  const same = Object.values(own).every((v) => v === null || (Array.isArray(v) && v.length === 0));
  ok(same, "D1 no walker carries its own locomotion numbers or stride (agent WALK/RUN/ARRIVE, authority TRACK, colliders STEP/TALL, bodyscale COLLIDER_R, controller's speed table and stride)", { own, "is a 0.7 m ledge a floor? step =": stepOf });
  for (const [f, s] of [["mcpl/agent.ts", agent], ["shared/protocol/authority.js", auth], ["client/lib/controller.js", ctrl], ["client/lib/colliders.js", coll], ["client/lib/bodyscale.js", scale], ["client/lib/thingphysics.js", thing]])
    ok(/from ["'](\.\.\/)+(shared\/)?mover\.js["']|from ["']\.\.\/mover\.js["']/.test(s), `D2 ${f} reads shared/mover.js`);
}

const M = await import(ENGINE + "shared/mover.js").catch((e) => { ok(false, "shared/mover.js imports", String(e)); return null; });
if (M) {
  const { MOVER, TRACK, stepWalk, walkToward, bodyBox, capsule, canMantle, toleranceOf, tokensAfter, sweep, walkSpeed, easeSpeed, stickSpeed, MODES } = M;
  // ---- M: the mover alone ----
  ok(MODES.includes("walk") && MOVER.modes.includes("fly") && MOVER.modes.includes("swim") && MOVER.modes.includes("drive"), "M0 modes: walk steps here; fly/swim/drive are names that join without renaming");
  ok(TRACK.step === MOVER.body.step && TRACK.radius === MOVER.body.radius && TRACK.height === MOVER.body.height && TRACK.speed === MOVER.track.speed && TRACK.cap === MOVER.track.cap && TRACK.spawnR === MOVER.track.spawnR, "M0 TRACK is MOVER under the authority's names");
  { const r = stepWalk({ pos: [0, 0, 0], dir: [1, 0], dt: 0.1 });
    ok(near(r.pos[0], 0.155) && r.pos[1] === 0 && r.pos[2] === 0 && near(r.moved, 0.155) && r.blocked === null, "M1 a walk's stride is 1.55 m/s × dt", r);
    const run = stepWalk({ pos: [0, 0, 0], dir: [0, 1], dt: 0.1, run: true }); ok(near(run.pos[2], 0.4), "M1 a run's is 4 m/s × dt", run);
    const diag = stepWalk({ pos: [0, 0, 0], dir: [3, 4], dt: 1 }); ok(near(Math.hypot(diag.pos[0], diag.pos[2]), 1.55) && near(diag.pos[0], 1.55 * 0.6), "M1 the direction is normalised", diag);
    const cap = stepWalk({ pos: [0, 0, 0], dir: [1, 0], dt: 1, run: true, cap: 0.3 }); ok(near(cap.pos[0], 0.3) && near(cap.moved, 0.3), "M1 a cap bounds the stride (a permit, the distance left)", cap);
    const still = stepWalk({ pos: [1, 2, 3], dir: [0, 0], dt: 1 }); ok(still.pos.join() === "1,2,3" && still.moved === 0, "M1 no direction, no move");
    const big = stepWalk({ pos: [0, 0, 0], dir: [1, 0], dt: 0.1, scale: 2 }); ok(near(big.pos[0], 0.31), "M1 a 200% body strides 200%", big);
    const gain = stepWalk({ pos: [0, 0, 0], dir: [1, 0], dt: 0.1, gain: 0.5 }); ok(near(gain.pos[0], 0.0775), "M1 gain scales the stride (a client's eased speed)", gain);
    const pos = [0, 0, 0]; stepWalk({ pos, dir: [1, 0], dt: 1 }); ok(pos.join() === "0,0,0", "M1 inputs are never mutated");
    ok(near(walkSpeed({ run: true, creep: true }), 4) && near(walkSpeed({ creep: true }), 0.55) && near(stickSpeed(0.5), 1.55) && near(stickSpeed(1), 4) && near(stickSpeed(0.25), 0.775), "M1 run outranks creep; the stick ramps walk→run");
    ok(near(easeSpeed(0, 1.55, 0.1), 1.55 * (1 - Math.exp(-1))) && easeSpeed(0.01, 0, 1) === 0, "M1 easeSpeed is the client's ramp (10/s) and snaps to 0 under 0.02");
  }
  { const flat = { floorAt: () => 0 }, ledge = (top) => ({ floorAt: (x, z) => (z > 1 ? top : 0) });
    const on7 = stepWalk({ pos: [0, 0, 0.95], dir: [0, 1], dt: 0.1 }, ledge(0.7)); ok(on7.blocked === null && near(on7.pos[1], 0.7) && near(on7.pos[2], 1.105), "M2 a 0.7 m ledge is stepped onto (y follows the floor)", on7);
    const on8 = stepWalk({ pos: [0, 0, 0.95], dir: [0, 1], dt: 0.1 }, ledge(0.8)); ok(on8.blocked === null && near(on8.pos[1], 0.8), "M2 so is one exactly a step (0.8 m) high", on8);
    const no9 = stepWalk({ pos: [0, 0, 0.95], dir: [0, 1], dt: 0.1 }, ledge(0.9)); ok(no9.blocked?.by === "ledge" && near(no9.blocked.top, 0.9) && no9.pos.join() === "0,0,0.95" && no9.moved === 0, "M2 a 0.9 m ledge is a wall: the body stays put and the step says why", no9);
    const down = stepWalk({ pos: [0, 0.7, 1.5], dir: [0, -1], dt: 1 }, ledge(0.7)); ok(down.blocked === null && near(down.pos[1], 0), "M2 stepping off it is free (any drop)", down);
    const small = stepWalk({ pos: [0, 0, 0.95], dir: [0, 1], dt: 0.1, scale: 0.5 }, ledge(0.5)); ok(small.blocked?.by === "ledge", "M2 a 50% body's step is 0.4 m: 0.5 m is a wall to it", small);
    const keep = stepWalk({ pos: [0, 2.5, 0], dir: [1, 0], dt: 0.1 }, {}); ok(near(keep.pos[1], 2.5), "M2 no floorAt: y is kept (the client's collider pass owns it)");
    const unk = stepWalk({ pos: [0, 2.5, 0], dir: [1, 0], dt: 0.1 }, { floorAt: () => NaN }); ok(near(unk.pos[1], 2.5), "M2 an unknown floor keeps y too");
    void flat;
  }
  { let seen = null; const wall = { blocked: (box, step) => { seen = { box, step }; return box.max[0] > 1 ? "wall-1" : null; } };
    const hit = stepWalk({ pos: [0.9, 0, 0], dir: [1, 0], dt: 0.1 }, wall);
    ok(hit.blocked?.by === "wall-1" && hit.pos.join() === "0.9,0,0" && hit.moved === 0, "M3 a wall refuses the step: the body stays where it was", hit);
    ok(seen && near(seen.box.min[1], 0.8) && near(seen.box.max[1], 1.7) && near(seen.box.max[0] - seen.box.min[0], 0.4) && near(seen.step.to[0], 1.055) && seen.step.from.join() === "0.9,0,0", "M3 it was asked with the body's box at the new spot (0.8–1.7 m up, 0.2 m either side) and the step", seen);
    const free = stepWalk({ pos: [0, 0, 0], dir: [1, 0], dt: 0.1 }, wall); ok(free.blocked === null && near(free.pos[0], 0.155), "M3 …and lets a step that meets nothing through");
    const b = bodyBox([1, 2, 3]); ok(b.min.join() === `0.8,2.8,2.8` && b.max.join() === `1.2,3.7,3.2`, "M3 bodyBox is the authority's box", b);
    const b2 = bodyBox([0, 0, 0], 2); ok(near(b2.min[1], 1.6) && near(b2.max[1], 3.4) && near(b2.max[0], 0.4), "M3 …and grows with the body", b2);
    ok(sweep([0, 0, 0], [0, 0, 0.12]).length === 3 && sweep([0, 0, 0], [0, 0, 0.12]).at(-1)[2] === 0.12 && sweep([0, 0, 0], [0, 0, 0.01]).length === 1, "M3 sweep: a point every 5 cm, the last at the destination, never the start");
    ok(near(tokensAfter(undefined, 0), 4) && near(tokensAfter(0, 500), 3) && near(tokensAfter(3, 1000), 4), "M3 the track's bucket: full at first, 6 m/s refill, 4 m cap");
  }
  { const at = walkToward({ pos: [0, 0, 0], target: [0.005, 0], dt: 0.1 }); ok(at.arrived && at.moved === 0 && at.pos.join() === "0,0,0", "M4 within 0.01 m is arrived (no move)", at);
    const wide = walkToward({ pos: [0, 0, 0], target: [0.3, 0], dt: 0.1, tolerance: 0.4 }); ok(wide.arrived, "M4 a 0.4 m tolerance arrives at 0.3 m");
    const not = walkToward({ pos: [0, 0, 0], target: [0.3, 0], dt: 0.1 }); ok(!not.arrived && near(not.pos[0], 0.155) && near(not.yaw, Math.PI / 2), "M4 …and the default doesn't: a stride toward it, heading atan2(dx, dz)", not);
    let p = [0, 0, 0], n = 0, last = null; while (n++ < 100) { last = walkToward({ pos: p, target: [1, 1], dt: 0.1 }); if (last.arrived) break; p = last.pos; }
    ok(last.arrived && near(p[0], 1) && near(p[2], 1) && n === 11, "M4 a walk lands exactly on its target (the last stride is the distance left), 10 strides for 1.41 m", { p, n });
    const room = walkToward({ pos: [0, 0, 0], target: [5, 0], dt: 1, run: true, room: 0.25 }); ok(near(room.pos[0], 0.25), "M4 a permit's room caps the stride", room);
    ok(toleranceOf(undefined) === 0.01 && toleranceOf(0.4) === 0.4 && toleranceOf(0.41) === null && toleranceOf(-1) === null && toleranceOf("x") === null, "M4 toleranceOf: 0–0.4, default 0.01, else refused");
  }

  // ---- A: agreement with the real authority, and with the client's body ----
  { const { request } = await import(ENGINE + "shared/protocol/authority.js");
    const { openWorld } = await import(ENGINE + "server/filehost.ts");
    const root = scratch("mover"); let T = 1_700_000_000_000;
    const call = (actor, verb, args = {}, step = 100) => { T += step; process.env.PROTOCOL_NOW = String(T); return request(openWorld(root, "walk"), actor, verb, args); };
    call("olive", "create-world", { title: "walk" });
    // a 0.7 m ledge ahead (+z), a 0.9 m one to the side (+x), a wall behind (−z)
    ok(call("olive", "create", { id: "ledge7", components: { mesh: { shape: "box", size: [2, 0.7, 2] }, transform: { pos: [0, 0, 5] } } }).ok, "A0 a 0.7 m ledge");
    ok(call("olive", "create", { id: "ledge9", components: { mesh: { shape: "box", size: [2, 0.9, 2] }, transform: { pos: [5, 0, 0] } } }).ok, "A0 a 0.9 m ledge");
    ok(call("olive", "create", { id: "wall", components: { mesh: { shape: "box", size: [4, 2.6, 0.2] }, transform: { pos: [0, 0, -5] } } }).ok, "A0 a wall");
    const st = openWorld(root, "walk").state();
    const boxOf = (id) => { const e = st.entities[id]; const p = e.c.transform.pos, s = e.c.mesh.size; return { min: [p[0] - s[0] / 2, p[1], p[2] - s[2] / 2], max: [p[0] + s[0] / 2, p[1] + s[1], p[2] + s[2] / 2] }; };
    const inXZ = (b, x, z) => x >= b.min[0] && x <= b.max[0] && z >= b.min[2] && z <= b.max[2];
    const meets = (a, b) => a.min[0] <= b.max[0] && a.max[0] >= b.min[0] && a.min[1] <= b.max[1] && a.max[1] >= b.min[1] && a.min[2] <= b.max[2] && a.max[2] >= b.min[2];
    const L7 = boxOf("ledge7"), L9 = boxOf("ledge9"), W = boxOf("wall");
    // the agent's env: a floor map (the client's collider pass answers the same question from the drawn geometry)
    const env = { floorAt: (x, z) => (inXZ(L7, x, z) ? L7.max[1] : inXZ(L9, x, z) ? L9.max[1] : 0), blocked: (box) => (meets(box, W) ? "wall" : meets(box, L9) ? "ledge9" : null) };
    const arrive = call("ann", "move", { to: [0, 0, 0], client: "agent" }); ok(arrive.ok, "A1 the body arrives at the origin", arrive.refused);
    // walk +z onto the 0.7 m ledge: every stride the mover takes is a move the authority accepts, at the same spot
    let p = [0, 0, 0], strides = 0, mism = null, refusedAt = null, climbed = false;
    for (let i = 0; i < 60 && !mism && !refusedAt; i++) { const r = walkToward({ pos: p, target: [0, 5], dt: 0.1 }, env); if (r.arrived) break; strides++;
      const r3 = (n) => Math.round(n * 1000) / 1000; const to = r.pos.map(r3);
      const m = call("ann", "move", { to }, 100); if (!m.ok) { refusedAt = { to, refused: m.refused }; break; }
      if (!(near(m.at[0], to[0]) && near(m.at[1], to[1]) && near(m.at[2], to[2]))) mism = { to, at: m.at };
      p = r.pos; if (p[1] > 0.69) climbed = true; }
    ok(!mism && !refusedAt && climbed && strides >= 30, "A1 every stride the mover walks (onto the 0.7 m ledge included) the authority accepts at the same millimetre", { mism, refusedAt, strides, p });
    // the 0.9 m ledge: the mover calls it a wall, and so does the authority for the same step
    const back = call("ann", "move", { to: [0, 0, 0], teleport: true }); ok(back.ok, "A2 back to the origin (a teleport)", back.refused);
    let q = [0, 0, 0], moverRef = null, authRef = null;
    for (let i = 0; i < 80 && !moverRef; i++) { const r = walkToward({ pos: q, target: [5, 0], dt: 0.1 }, env); if (r.arrived) break;
      if (r.blocked) { moverRef = r.blocked; const r3 = (n) => Math.round(n * 1000) / 1000; const ahead = stepWalk({ pos: q, dir: [1, 0], dt: 0.1 }, {}).pos.map(r3); // the same stride with no floor: the authority's view of it
        const m = call("ann", "move", { to: ahead }, 100); authRef = m.ok ? { ok: true, at: m.at } : m.refused; break; }
      const m = call("ann", "move", { to: r.pos.map((n) => Math.round(n * 1000) / 1000) }, 100); if (!m.ok) { authRef = { early: m.refused }; break; } q = r.pos; }
    ok(moverRef && (moverRef.by === "ledge" || moverRef.by === "ledge9") && authRef?.code === "solid" && /ledge9/.test(authRef.reason), "A2 the 0.9 m ledge: the mover refuses the stride (a wall), and the authority refuses the same move as solid", { moverRef, authRef, q });
    // the wall: the same
    const back2 = call("ann", "move", { to: [0, 0, 0], teleport: true }); ok(back2.ok, "A3 back to the origin", back2.refused);
    let s = [0, 0, 0], mRef = null, aRef = null;
    for (let i = 0; i < 80 && !mRef; i++) { const r = walkToward({ pos: s, target: [0, -6], dt: 0.1, run: true }, env); if (r.arrived) break;
      const r3 = (n) => Math.round(n * 1000) / 1000;
      if (r.blocked) { mRef = r.blocked; const ahead = stepWalk({ pos: s, dir: [0, -1], dt: 0.1, run: true }, {}).pos.map(r3); const m = call("ann", "move", { to: ahead }, 100); aRef = m.ok ? { ok: true, at: m.at } : m.refused; break; }
      const m = call("ann", "move", { to: r.pos.map(r3) }, 100); if (!m.ok) { aRef = { early: m.refused }; break; } s = r.pos; }
    ok(mRef?.by === "wall" && aRef?.code === "solid" && /wall/.test(aRef.reason) && s[2] < -4 && s[2] > -4.9, "A3 the wall: the mover refuses the stride and the authority refuses the same move as solid, at the same spot", { mRef, aRef, s });
    // too fast: the mover's bucket is the authority's
    const far = call("ann", "move", { to: [0, 0, 0], teleport: true }); ok(far.ok, "A4 back");
    const leap = call("ann", "move", { to: [0, 0, 4.2] }, 100); ok(leap.refused?.code === "too-fast" && near(tokensAfter(4, 100), 4), "A4 a 4.2 m step is over the bucket's cap (4 m): too-fast", leap.refused);
    const hop = call("ann", "move", { to: [0, 0, 3.9] }, 100); ok(hop.ok, "A4 3.9 m is within it", hop.refused);
    const again = call("ann", "move", { to: [0, 0, 3.9 + 0.8] }, 100); ok(again.refused?.code === "too-fast" && near(Number(again.refused.reason.match(/cover ([\d.]+)/)?.[1]), tokensAfter(0.1, 100), 1e-3), "A4 …and the metres it says are left (0.8 asked) are the mover's bucket (0.1 + 0.6 = 0.7)", again.refused);
    // the client's body is the mover's
    const BS = await import(ENGINE + "client/lib/bodyscale.js");
    const c1 = BS.colliderFor(1), c2 = BS.colliderFor(2), m1 = capsule(1), m2 = capsule(2);
    ok(near(c1.r, m1.r) && near(c1.tall, m1.tall) && near(c2.r, m2.r) && near(c2.tall, m2.tall) && near(c1.r, 0.2) && near(c1.tall, 1.7), "A5 the client's walking capsule is the mover's body (0.2 × 1.7, scaled)", { c1, m1 });
    ok(BS.canMantle === canMantle && canMantle(0.8, 1) === false && canMantle(0.81, 1) === true && canMantle(1.7, 1) === true && canMantle(1.71, 1) === false, "A5 the client's mantle starts where the mover's step ends (0.8 m) and reaches its height (1.7 m)");
  }
}
{ // W: water in the one walker (upstream #242's law, mover-hosted 10-15)
  const { waterStance, waterCost, stepWalk } = await import("../../shared/mover.js");
  const dry = waterStance(null, 0); ok(dry.speedFactor === 1 && !dry.swimming && dry.y === 0, "W1 no water: dry, full pace");
  const knee = waterStance(0.5, 0), waist = waterStance(0.85, 0), chest = waterStance(1.3, 0);
  ok(near(knee.speedFactor, 1 - 0.5 * (() => { const t = (0.5 / 1.7 - 0.08) / 0.67; return t * t * (3 - 2 * t); })()) && knee.speedFactor > 0.8 && knee.speedFactor < 0.9, "W1 knee-deep (0.5 m) wades at ~0.86", knee);
  ok(waist.speedFactor > 0.6 && waist.speedFactor < 0.7 && !waist.swimming && waterStance(1.25, 0).speedFactor < 0.52, "W1 waist-deep (0.85 m) wades at ~0.66; ~0.5 by 1.25 m (main's curve, not a round number)", waist);
  ok(chest.swimming && near(chest.y, 1.3 - 0.75 * 1.7) && chest.speedFactor === null, "W1 deeper than the chest floats the body at level − 0.75·height and swims", chest);
  ok(near(waterCost(null, 0), 1) && near(waterCost(1.3, 0), 1.55 / 0.9) && waterCost(0.85, 0) > 1.4 && waterCost(0.85, 0) < 1.6 && waterCost(1.25, 0) > 1.9, "W1 waterCost: 1 dry, 1.72 swimming, ~1.5 waist-deep, ~2 chest-deep", { swim: waterCost(1.3, 0), waist: waterCost(0.85, 0) });
  const pool = (level) => ({ floorAt: () => 0, waterAt: () => level });
  const d0 = stepWalk({ pos: [0, 0, 0], dir: [1, 0], dt: 1 }, pool(null)); ok(near(d0.moved, 1.55) && d0.stance?.speedFactor === 1, "W2 waterAt null: a dry walk, full pace, stance dry", d0);
  const w = stepWalk({ pos: [0, 0, 0], dir: [1, 0], dt: 1 }, pool(0.85)); ok(near(w.moved, 1.55 * waist.speedFactor) && near(w.pos[1], 0) && !w.stance.swimming, "W2 waist-deep: the stride is dragged, feet on the ground", w);
  const sw = stepWalk({ pos: [0, 0, 0], dir: [1, 0], dt: 1 }, pool(1.3)); ok(near(sw.moved, 0.9) && near(sw.pos[1], 1.3 - 0.75 * 1.7) && sw.stance.swimming, "W2 chest-deep: a 0.9 m/s stroke, afloat at the chest", sw);
  const swr = stepWalk({ pos: [0, 0, 0], dir: [1, 0], dt: 1, run: true }, pool(1.3)); ok(near(swr.moved, 1.5), "W2 swimming hard is 1.5 m/s, not a 4 m/s run", swr);
  const drop = { floorAt: (x) => (x > 0.5 ? -3 : 0), waterAt: () => 1.3 };
  const off = stepWalk({ pos: [0, 0, 0], dir: [1, 0], dt: 1 }, drop); ok(off.blocked === null && near(off.pos[1], 1.3 - 0.75 * 1.7), "W3 swimming over a 3 m drop: no ledge, still afloat at the chest", off);
  const cliff = { floorAt: (x) => (x > 0.5 ? 2 : 0), waterAt: () => 1.3 };
  const up = stepWalk({ pos: [0, 0, 0], dir: [1, 0], dt: 1 }, cliff); ok(up.blocked?.by === "ledge", "W3 a 2 m wall under the water is still a wall (the body would have to climb out)", up);
  // afloat in 3 m water over y=0 the body hangs at y = 3 − 0.75·1.7 = 1.725: a step up from THERE reaches 2.525, so a 2.4 m shelf is land
  // (from the bottom it would be a 2.4 m wall) and a 2.6 m one is not
  const shore = { floorAt: (x) => (x > 0.5 ? 2.4 : 0), waterAt: () => 3 };
  const out = stepWalk({ pos: [0, 0, 0], dir: [1, 0], dt: 1 }, shore); ok(out.blocked === null && near(out.pos[1], 2.4) && !out.stance.swimming, "W3 a shelf within a step of where it floats: the swimmer stands up on it (its y is the shelf)", out);
  const high = { floorAt: (x) => (x > 0.5 ? 2.6 : 0), waterAt: () => 3 };
  const no = stepWalk({ pos: [0, 0, 0], dir: [1, 0], dt: 1 }, high); ok(no.blocked?.by === "ledge", "W3 one step higher than the float is a ledge", no);
  const same = stepWalk({ pos: [0, 0, 0.95], dir: [0, 1], dt: 0.1 }, { floorAt: (x, z) => (z > 1 ? 0.9 : 0) }); ok(same.blocked?.by === "ledge", "W4 without waterAt, the ledge rule is exactly what it was", same);
}
console.log(`mover: ${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
