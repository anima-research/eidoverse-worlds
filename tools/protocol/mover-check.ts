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
//   W   water in the one walker (wade, swim, haul out), the mover alone
//   G   THE GROUND (10-15, holes review H2): the same strides through stepWalk AND the real authority's move, on terrain and
//       in water — a terrain hill (up, over, down at a run), wading (and into a stone a wader's box meets), swimming (and
//       standing up on a sunk rock), hauling out onto a dock 0.5 m above the surface (both accept) / 0.6 m (both refuse,
//       same stride), a dug pit's rim at the waterline (both accept) / a terrain bank 0.6 m above the water (both refuse);
//       each with the mover's y and with the bed's (the agent's permit). GP: place {at}, create {at: [x, z]} and the spawn
//       alias seat a model's bottom on the heightfield (±1 cm), y 0 on a flat world. Red first: before the fix 19 G rows
//       failed (G3 bed, G4, G5 bank, GP1-3, GP5); G1/G2-stone/G5-rim/GP4 were seen red under mutations (see the commit)
//   G6  the body's own size (holes r3 F2): 1.2 m / 2.2 m / scale 2 / scale 0.5 bodies, the same verdict from stepWalk and from
//       the authority (which is sent the height and scale with the moves); a size's bounds
//   G7  the teleport's swimmer box beside a dock, and a stride up a sloped rim judged from where it last swam (holes r3 F8:
//       each red with its branch removed)
//   GH  a heightmap whose grid isn't here: no ground committed (refused with words, nothing logged); seated once it lands (F3);
//       nothing launched (throw, drop, punt, shove) and no put {pos} judged on it (r4 F2/F3)
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
  const { waterStance, waterCost, stepWalk, walkSpeed } = await import("../../shared/mover.js");
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
  // hauling out (review 10-15 #1): afloat in 3 m water over y=0, any shelf under the surface is land (the body floats above it),
  // a bank up to 0.5 m above the water is land, 0.6 m above is a wall from the water
  const shelf = { floorAt: (x) => (x > 0.5 ? 2.6 : 0), waterAt: () => 3 };
  const onto = stepWalk({ pos: [0, 0, 0], dir: [1, 0], dt: 1 }, shelf); ok(onto.blocked === null && near(onto.pos[1], 2.6) && !onto.stance.swimming, "W3 a shelf 0.4 m under the surface: the swimmer stands up on it", onto);
  const quay = { floorAt: (x) => (x > 0.5 ? 3.5 : 0), waterAt: () => 3 };
  const outq = stepWalk({ pos: [0, 0, 0], dir: [1, 0], dt: 1 }, quay); ok(outq.blocked === null && near(outq.pos[1], 3.5), "W3 a quay 0.5 m above the water: hauled out (from the chest alone it would be 1.775 m, a wall — the trap)", outq);
  const wall = { floorAt: (x) => (x > 0.5 ? 3.6 : 0), waterAt: () => 3 };
  const noq = stepWalk({ pos: [0, 0, 0], dir: [1, 0], dt: 1 }, wall); ok(noq.blocked?.by === "ledge", "W3 0.6 m above the water is a wall from the water", noq);
  const dug = { floorAt: (x) => (x > 0.5 ? 0 : -2), waterAt: () => 0 };   // a dug pool: water at ground level, the rim AT the surface
  const rim = stepWalk({ pos: [0, -2, 0], dir: [1, 0], dt: 1 }, dug); ok(rim.blocked === null && near(rim.pos[1], 0), "W6 a dug pool's rim at the waterline: out (the reviewer's trap case)", rim);
  // the stroke never goes backwards as the stick ramps through the run threshold (review 10-15 #3). The controller hands the
  // mover run = stick past half and gain = its eased speed / walkSpeed({run}) — so at 0.51 the gain drops to ~0.4 of a RUN,
  // which with "run picks the stroke" made the swim fall 0.90 → 0.60 m/s
  const { stickSpeed } = await import("../../shared/mover.js");
  const deep = { floorAt: () => 0, waterAt: () => 3 }; let prev = -1, mono = true, dip = null;
  for (let mag = 0.05; mag <= 1.0001; mag += 0.01) { const run = mag > 0.5, gain = stickSpeed(mag) / walkSpeed({ run });
    const r = stepWalk({ pos: [0, 0, 0], dir: [1, 0], dt: 1, run, gain }, deep); if (r.moved < prev - 1e-9) { mono = false; dip ??= { mag: +mag.toFixed(2), from: prev, to: r.moved }; } prev = r.moved; }
  ok(mono && near(prev, 1.5), "W7 a VR stick ramp 0→1 swims monotonically up to 1.5 m/s (the controller's own run/gain mapping)", dip ?? { last: prev });
  ok(near(stepWalk({ pos: [0, 0, 0], dir: [1, 0], dt: 1, gain: 0.5 }, deep).moved, 0.45), "W7 half a walk asked for is half a stroke", null);
  const same = stepWalk({ pos: [0, 0, 0.95], dir: [0, 1], dt: 0.1 }, { floorAt: (x, z) => (z > 1 ? 0.9 : 0) }); ok(same.blocked?.by === "ledge", "W4 without waterAt, the ledge rule is exactly what it was", same);
  // a caller's measured stature (REPOINT-2, 10-15: main's per-avatar statureFor / bodyHeight) moves where the water reaches, never the stride
  const tall = stepWalk({ pos: [0, 0, 0], dir: [1, 0], dt: 1 }, pool(1.0)), short = stepWalk({ pos: [0, 0, 0], dir: [1, 0], dt: 1, height: 1.2 }, pool(1.0));
  const dryShort = stepWalk({ pos: [0, 0, 0], dir: [1, 0], dt: 1, height: 1.2 }, pool(null));
  ok(!tall.stance.swimming && short.stance.swimming && near(short.pos[1], 1.0 - 0.75 * 1.2) && near(short.moved, 0.9) && near(dryShort.moved, 1.55), "W5 height: a 1.2 m body swims in 1 m of water a 1.7 m one wades; dry, its stride is the mover's", { tall: tall.stance, short: short.stance, dryShort: dryShort.moved });
}
{ // G: THE GROUND (owner 22:34, holes review H2). The authority judges a body on the same ground the walker walks on: the
  // terrain heightfield (shared/terrainmath.js over @world's terrain) and the water (the mover's own water law). Every row
  // runs the SAME stride through stepWalk and through the real authority's `move`, and requires the same verdict: what the
  // mover accepts is accepted at the same millimetre; the stride the mover refuses is refused. Then placement on the hill.
  const { stepWalk, walkToward, MOVER } = await import(ENGINE + "shared/mover.js");
  const { terrainParams, makeHeightField } = await import(ENGINE + "shared/terrainmath.js");
  const { request } = await import(ENGINE + "shared/protocol/authority.js");
  const { openWorld } = await import(ENGINE + "server/filehost.ts");
  const root = scratch("ground"); let T = 1_800_000_000_000;
  const call = (world, actor, verb, args = {}, step = 100) => { T += step; process.env.PROTOCOL_NOW = String(T); return request(openWorld(root, world), actor, verb, args); };
  const r3 = (n) => Math.round(n * 1000) / 1000;
  const fieldOf = (terrain) => makeHeightField(terrainParams(terrain));
  // a box {min, max} of a mesh box placed by its bottom centre (as A0's), and the authority's own overlap rule (a touch is not a hit)
  const meshBox = (p, s) => ({ min: [p[0] - s[0] / 2, p[1], p[2] - s[2] / 2], max: [p[0] + s[0] / 2, p[1] + s[1], p[2] + s[2] / 2] });
  const hits = (a, b, eps = 0.01) => [0, 1, 2].every((i) => Math.min(a.max[i], b.max[i]) - Math.max(a.min[i], b.min[i]) > eps);
  const inXZ = (b, x, z) => x >= b.min[0] && x <= b.max[0] && z >= b.min[2] && z <= b.max[2];
  // the agent's env: the floor is the terrain, or a placed top under the body's centre (its colliders' answer); the water is
  // the world's level; what blocks is a placed solid meeting the box the MOVER hands it (its stance's box)
  const envOf = (h, level, solids) => ({
    floorAt: (x, z) => solids.reduce((f, s) => (inXZ(s.box, x, z) ? Math.max(f, s.box.max[1]) : f), h(x, z)),
    ...(level != null ? { waterAt: () => level } : {}),
    blocked: (box) => solids.find((s) => hits(box, s.box))?.id ?? null,
  });
  // walk from `from` toward `target`, one stride per authority move; claim: "mover" sends the mover's y, "bed" the ground's
  // (the agent's permit: heightAt, never the float). → {strides, accepted (all at the same mm), agree, moverRef, authRef, seen}
  // body: {height?, scale?} — the body's own stature and size, handed to the mover AND sent with every move (the clients do);
  // once: sent with the arrival only (the authority keeps it on the body's record)
  function agree(world, actor, from, target, env, { claim = "mover", run = false, max = 400, h, body = {}, once = false } = {}) {
    const B = { ...(body.height !== undefined ? { height: body.height } : {}), ...(body.scale !== undefined ? { scale: body.scale } : {}) };
    const y0 = claim === "bed" ? h(from[0], from[1]) : env.floorAt(from[0], from[1]);
    let p = [from[0], y0, from[1]];
    if (env.waterAt) { const st = stepWalk({ pos: p, dir: [1, 0], dt: 1e-9, ...B }, env).stance; if (st?.swimming && claim === "mover") p = [p[0], st.y, p[2]]; }
    const tp = call(world, actor, "move", { to: p.map(r3), teleport: true, ...B });
    if (!tp.ok) return { start: tp.refused };
    let strides = 0, mism = null, moverRef = null, authRef = null; const seen = { swim: false, wade: false, dry: false, maxY: -Infinity, minY: Infinity, ys: [] };
    for (let i = 0; i < max; i++) {
      const r = walkToward({ pos: p, target, dt: 0.1, run, ...B }, env);
      if (r.arrived) break;
      const dir = [target[0] - p[0], target[1] - p[2]], L = Math.hypot(dir[0], dir[1]);
      // the refused stride's length: the same step with the floor known only where the body stands (no ledge, no wall)
      const d = r.blocked ? stepWalk({ pos: p, dir, dt: 0.1, run, cap: L, ...B }, { ...env, blocked: undefined, floorAt: (x, z) => (x === p[0] && z === p[2] ? env.floorAt(x, z) : NaN) }).moved : r.moved;
      const nx = p[0] + dir[0] / L * d, nz = p[2] + dir[1] / L * d;
      const y = claim === "bed" ? h(nx, nz) : r.blocked ? env.floorAt(nx, nz) : r.pos[1];
      const to = [r3(nx), r3(y), r3(nz)];
      const m = call(world, actor, "move", { to, ...(once ? {} : B) }, 100);
      if (r.blocked) { moverRef = r.blocked; authRef = m.ok ? { ok: true, at: m.at } : m.refused; break; }
      strides++;
      if (!m.ok) { authRef = m.refused; mism = { stride: strides, to, refused: m.refused, stance: r.stance }; break; }
      if (!(near(m.at[0], to[0]) && near(m.at[1], to[1]) && near(m.at[2], to[2]))) { mism = { to, at: m.at }; break; }
      const st = r.stance; if (st?.swimming) seen.swim = true; else if (st && st.depth > 0.05) seen.wade = true; else seen.dry = true;
      seen.maxY = Math.max(seen.maxY, r.pos[1]); seen.minY = Math.min(seen.minY, r.pos[1]); if (!seen.ys.includes(r3(r.pos[1]))) seen.ys.push(r3(r.pos[1]));
      p = r.pos;
    }
    return { strides, accepted: !mism && !moverRef, mism, moverRef, authRef, seen, at: p.map(r3) };
  }

  // ---- G1 terrain: a hill (2.5 m, radius 6) on flat ground; up it, over its top and down the far side
  const HILL = { amplitude: 0, size: 80, features: [{ type: "hill", x: 10, z: 0, radius: 6, height: 2.5 }] };
  call("hill", "olive", "create-world", { title: "hill" });
  ok(call("hill", "olive", "set", { id: "@world", component: "terrain", value: HILL }).ok, "G0 the hill world's terrain");
  const hH = fieldOf(HILL), envH = envOf(hH, null, []);
  ok(call("hill", "ann", "move", { to: [0, 0, 0], client: "agent" }).ok, "G0 ann arrives");
  for (const claim of ["mover", "bed"]) {
    const up = agree("hill", "ann", [2, 0], [10, 0], envH, { claim, h: hH });
    ok(up.accepted && up.strides > 30 && near(up.seen.maxY, 2.5, 0.05), `G1 [${claim}] up a terrain slope to the hilltop: every stride the mover takes, the authority accepts at the same mm`, up);
    const over = agree("hill", "ann", [10, 0], [19, 0.5], envH, { claim, h: hH, run: true });
    ok(over.accepted && over.strides > 15 && over.seen.minY < 0.01, `G1 [${claim}] down the far side at a run: the same`, over);
  }
  // a terrain wall a stride can't climb: (both say no is not asked here: the mover's ledge on continuous ground depends on its
  // stride length, which the authority never sees; see the report's out-of-scope list)

  // ---- G2–G5 water: a dug pool. A bowl 3 m deep (radius 8) under level 0, a 0.5 m dock and a 0.6 m one in it, a pit with a
  // vertical rim AT the waterline, and a pond whose bank stands 0.6 m above its water
  const POOL = { amplitude: 0, size: 120, features: [{ type: "hill", x: 0, z: 0, radius: 8, height: -3 }, { type: "flatten", x: 14, z: 12, radius: 4, height: -2, edge: 0.01 }], water: { level: 0 } };
  call("pool", "olive", "create-world", { title: "pool" });
  ok(call("pool", "olive", "set", { id: "@world", component: "terrain", value: POOL }).ok, "G0 the pool world's terrain and water");
  // …and a rock under the swim (its top 0.8 m under the surface: a swimmer stands up on it) and a stone in the shallows
  // (its top 0.4 m above the water: a wader walks into it, where a swimmer's box would pass over)
  const D5 = { id: "dock5", p: [4, -3.2, 0], s: [4, 3.7, 2] }, D6 = { id: "dock6", p: [0, -3.2, 4], s: [2, 3.8, 4] };
  const ROCK = { id: "rock", p: [-3.5, -3.2, -0.5], s: [1, 2.4, 1.2] }, STONE = { id: "stone", p: [-5.5, -1, -3], s: [1, 1.4, 1] };
  for (const d of [D5, D6, ROCK, STONE]) ok(call("pool", "olive", "create", { id: d.id, components: { mesh: { shape: "box", size: d.s }, transform: { pos: d.p } } }).ok, `G0 ${d.id}: its top ${r3(d.p[1] + d.s[1])} m, the water at 0`);
  const solids = [D5, D6, ROCK, STONE].map((d) => ({ id: d.id, box: meshBox(d.p, d.s) }));
  const hP = fieldOf(POOL), envP = envOf(hP, 0, solids);
  ok(call("pool", "ann", "move", { to: [-12, 0, 0], client: "agent" }).ok, "G0 ann arrives at the pool's edge");
  for (const claim of ["mover", "bed"]) {
    const wade = agree("pool", "ann", [-12, 0], [-6.2, 0], envP, { claim, h: hP });
    ok(wade.accepted && wade.seen.wade && !wade.seen.swim, `G2 [${claim}] wading in down the bowl's side: the same verdict, stride for stride`, wade);
    const stone = agree("pool", "ann", [-5.5, -0.5], [-5.5, -3.4], envP, { claim, h: hP });
    ok(stone.moverRef?.by === "stone" && stone.authRef && !stone.authRef.ok && /stone/.test(stone.authRef.reason) && stone.mism === null && stone.seen.wade && !stone.seen.swim,
      `G2 [${claim}] wading into a stone 0.4 m above the water: a wader's box is a walker's, and both refuse the same stride`, stone);
    const swim = agree("pool", "ann", [-6.2, 0], [-1, -1], envP, { claim, h: hP });
    ok(swim.accepted && swim.seen.swim && swim.seen.ys.includes(-0.8), `G3 [${claim}] swimming out over 3 m of water, standing up on a rock 0.8 m under the surface on the way: the same`, swim);
    const out5 = agree("pool", "ann", [-1, 0], [5, 0], envP, { claim, h: hP });
    ok(out5.accepted && out5.seen.swim && near(out5.seen.maxY, 0.5, 1e-6) && out5.at[0] > 4.9, `G4 [${claim}] hauling out onto a dock 0.5 m above the surface: accepted by both (H2: the authority called it solid)`, out5);
    const out6 = agree("pool", "ann", [-1, 0], [0, 5], envP, { claim, h: hP });
    ok(out6.moverRef && out6.authRef && !out6.authRef.ok && out6.authRef.code === "solid" && /dock6/.test(out6.authRef.reason) && out6.mism === null, `G4 [${claim}] a dock 0.6 m above the surface: refused by both, at the same stride`, out6);
    const rim = agree("pool", "ann", [14, 12], [19.5, 12], envP, { claim, h: hP });
    ok(rim.accepted && rim.seen.swim && rim.at[0] > 19.4 && near(rim.seen.maxY, 0, 1e-3), `G5 [${claim}] out of a dug pit over a vertical rim AT the waterline (2 m of terrain wall): accepted by both`, rim);
  }
  // a pond whose terrain bank stands 0.6 m above its water: a wall from the water, to the mover AND the authority
  const POND = { amplitude: 0, size: 80, features: [{ type: "flatten", x: 0, z: 0, radius: 4, height: -2.6, edge: 0.01 }], water: { level: -0.6 } };
  call("pond", "olive", "create-world", { title: "pond" });
  ok(call("pond", "olive", "set", { id: "@world", component: "terrain", value: POND }).ok, "G0 the pond's terrain and water");
  const hQ = fieldOf(POND), envQ = envOf(hQ, -0.6, []);
  ok(call("pond", "ann", "move", { to: [0, -2.6, 0], client: "agent" }).ok, "G0 ann arrives in the pond");
  for (const claim of ["mover", "bed"]) {
    const bank = agree("pond", "ann", [0, 0], [6, 0], envQ, { claim, h: hQ });
    ok(bank.moverRef?.by === "ledge" && bank.authRef && !bank.authRef.ok && /ledge|terrain|bank/.test(`${bank.authRef.code} ${bank.authRef.reason}`) && bank.mism === null && bank.strides > 10,
      `G5 [${claim}] a terrain bank 0.6 m above the water: the mover refuses the stride (a ledge) and so does the authority`, bank);
  }

  // ---- G6 THE BODY'S OWN SIZE (holes r3 F2): the mover judges water by the body's stature and ledges by its scale; so does the
  // authority, from the height and scale the body sends with its moves. A 1.2 m body in 1.0 m of water by a bank 0.5 m above
  // the surface swims and hauls out (the reviewer's case: before, the authority judged a 1.7 m wader and refused every stride);
  // a 2.2 m body in 1.5 m wades and the same bank is a wall to both; a scale-2 body steps a 1.2 m terrain ledge and onto a
  // 1.2 m crate (a 1.6 m step, its box 1.6 m up), a scale-0.5 body is refused a 0.6 m ledge (a 0.4 m step)
  const SHALLOW = { amplitude: 0, size: 80, features: [{ type: "flatten", x: 0, z: 0, radius: 4, height: -1.5, edge: 0.01 }], water: { level: -0.5 } };
  const DEEP = { amplitude: 0, size: 80, features: [{ type: "flatten", x: 0, z: 0, radius: 4, height: -2.0, edge: 0.01 }], water: { level: -0.5 } };
  const SHELF = { amplitude: 0, size: 80, features: [{ type: "flatten", x: 10, z: 0, radius: 4, height: 1.2, edge: 0.01 }, { type: "flatten", x: -10, z: 0, radius: 4, height: 0.6, edge: 0.01 }, { type: "flatten", x: 0, z: 10, radius: 4, height: 2.0, edge: 0.01 }] };
  const worlds6 = { shallow: SHALLOW, deep: DEEP, shelf: SHELF };
  for (const [wn, tv] of Object.entries(worlds6)) { call(wn, "olive", "create-world", { title: wn }); ok(call(wn, "olive", "set", { id: "@world", component: "terrain", value: tv }).ok, `G0 the ${wn} world's terrain`); }
  const hS = fieldOf(SHALLOW), hD = fieldOf(DEEP), hF = fieldOf(SHELF);
  const envS = envOf(hS, -0.5, []), envD = envOf(hD, -0.5, []), envF = envOf(hF, null, []);
  const both = (r) => r.moverRef && r.authRef && !r.authRef.ok && r.mism === null;
  for (const claim of ["mover", "bed"]) {
    const s12 = agree("shallow", "bea", [0, 0], [6, 0], envS, { claim, h: hS, body: { height: 1.2 } });
    ok(s12.accepted && s12.seen.swim && s12.at[0] > 5.9 && near(s12.seen.maxY, 0, 1e-3), `G6 [${claim}] a 1.2 m body in 1.0 m of water swims and hauls out onto a bank 0.5 m above the surface: accepted by both (r3 F2: the authority judged a 1.7 m wader)`, s12);
    const s17 = agree("shallow", "cal", [0, 0], [6, 0], envS, { claim, h: hS });
    ok(both(s17) && s17.moverRef.by === "ledge" && s17.seen.wade && !s17.seen.swim, `G6 [${claim}] a 1.7 m body there wades and the bank is a 1.5 m ledge: refused by both, the same stride`, s17);
    const s12once = agree("shallow", "dee", [0, 0], [6, 0], envS, { claim, h: hS, body: { height: 1.2 }, once: true });
    ok(s12once.accepted && s12once.at[0] > 5.9, `G6 [${claim}] the height sent with the arrival only is kept on the body's record: the same haul-out`, s12once);
    const d22 = agree("deep", "eve", [0, 0], [6, 0], envD, { claim, h: hD, body: { height: 2.2 } });
    ok(both(d22) && d22.moverRef.by === "ledge" && !d22.seen.swim, `G6 [${claim}] a 2.2 m body in 1.5 m of water wades and the bank 0.5 m above the surface is a 2 m ledge: refused by both (the authority called it a swimmer and let it out)`, d22);
    const d17 = agree("deep", "fay", [0, 0], [6, 0], envD, { claim, h: hD });
    ok(d17.accepted && d17.seen.swim && d17.at[0] > 5.9, `G6 [${claim}] a 1.7 m body there swims and hauls out: accepted by both`, d17);
    const up2 = agree("shelf", "gus", [2, 0], [10, 0], envF, { claim, h: hF, body: { scale: 2 } });
    ok(up2.accepted && near(up2.seen.maxY, 1.2, 1e-3) && up2.at[0] > 9.9, `G6 [${claim}] a scale-2 body steps up a 1.2 m terrain ledge (its step is 1.6 m): accepted by both`, up2);
    const up1 = agree("shelf", "hal", [2, 0], [10, 0], envF, { claim, h: hF });
    ok(both(up1) && up1.moverRef.by === "ledge", `G6 [${claim}] a scale-1 body at the same ledge: refused by both`, up1);
    const lo5 = agree("shelf", "ivy", [-2, 0], [-10, 0], envF, { claim, h: hF, body: { scale: 0.5 } });
    ok(both(lo5) && lo5.moverRef.by === "ledge", `G6 [${claim}] a scale-0.5 body at a 0.6 m ledge (its step is 0.4 m): refused by both (the authority let a 0.8 m step through)`, lo5);
  }
  // a flat world (no terrain): a crate 1.2 m tall. A scale-2 body walks up onto it (a 1.6 m step; its box starts 1.6 m up)
  call("flat2", "olive", "create-world", { title: "flat2" });
  const CR = { id: "crate12", p: [5, 0, 0], s: [2, 1.2, 2] };
  ok(call("flat2", "olive", "create", { id: CR.id, components: { mesh: { shape: "box", size: CR.s }, transform: { pos: CR.p } } }).ok, "G0 a 1.2 m crate on a flat world");
  const envC = envOf(() => 0, null, [{ id: CR.id, box: meshBox(CR.p, CR.s) }]);
  const cr2 = agree("flat2", "jo", [0, 0], [5, 0], envC, { body: { scale: 2 } });
  ok(cr2.accepted && near(cr2.seen.maxY, 1.2, 1e-6) && cr2.at[0] > 4.9, "G6 flat world: a scale-2 body walks up onto a 1.2 m crate: accepted by both", cr2);
  const cr1 = agree("flat2", "kit", [0, 0], [5, 0], envC);
  ok(cr1.moverRef && cr1.authRef && !cr1.authRef.ok && cr1.mism === null, "G6 flat world: a scale-1 body at the same crate: refused by both", cr1);
  // the bounds: what a body may say about itself (a liar's reach is the size slider's, no further)
  const bnd = (args) => call("shelf", "lia", "move", { to: [0, 0, 0], teleport: true, ...args });
  ok(!bnd({ height: "tall" }).ok && !bnd({ scale: -1 }).ok && !bnd({ scale: NaN }).ok && !bnd({ height: 0 }).ok, "G6 a height or scale that isn't a positive number is refused (shape)", [bnd({ height: "tall" }).refused?.code, bnd({ scale: -1 }).refused?.code]);
  { const r = call("shelf", "lia", "move", { to: [0, 0, 5.5], teleport: true, scale: 50 }), up = r.ok && call("shelf", "lia", "move", { to: [0, 2, 6.3] });
    ok(r.ok && up && !up.ok && up.refused.code === "solid" && /ground/.test(up.refused.blocker ?? ""), "G6 a claimed scale of 50 is the mover's largest body (2): a 2 m terrain ledge is still a wall (its step is 1.6 m)", { r, up }); }
  { const r = call("shelf", "lia", "move", { to: [0, 0, 5.5], teleport: true, height: 0.1 }), kept = openWorld(root, "shelf").presence.bodies.lia?.size?.height;
    ok(r.ok && kept === 0.5, "G6 a claimed height of 0.1 m is kept as 0.5 m: the walker's own floor (the browser's bodyHeight and the agent's rigbones bound 0.5-4) (review r4 F7)", { r: r.refused, kept }); }

  // ---- G7 the two branches no row reached (holes r3 F8). (a) A teleport into the water beside the 0.5 m dock (where a swim
  // to its side is accepted, G4): the swimmer's box (from 0.5 m above the surface) passes; a walker's box at the claim would
  // meet the dock's side. (b) One stride from swimming up a sloped rim (a 20 cm edge, the bank 0.5 m above the water):
  // the mover takes it in one stride (a swimmer hauls out up to 0.5 m above the surface); the authority's sweep judges a
  // point part-way up (ground -1.5, wading), from which the bank is a 1.5 m ledge: judged from where it last swam, as the
  // mover's one stride is, it is accepted
  for (const [claim, y] of [["mover", -1.275], ["bed", r3(hP(1.9, 0))]]) {
    const tp = call("pool", "max", "move", { to: [1.9, y, 0], teleport: true, client: "agent" });
    ok(tp.ok, `G7 [${claim}] a teleport into the water 0.1 m from the dock's side: the swimmer's box, accepted (a walker's box meets the dock)`, tp.refused);
  }
  { const SLOPE = { amplitude: 0, size: 80, features: [{ type: "flatten", x: 0, z: 0, radius: 4, height: -3, edge: 0.2 }], water: { level: -0.5 } };
    call("slope", "olive", "create-world", { title: "slope" });
    ok(call("slope", "olive", "set", { id: "@world", component: "terrain", value: SLOPE }).ok, "G0 a pit with a sloped rim (20 cm edge), water 0.5 m below its bank");
    const hL = fieldOf(SLOPE), envL = envOf(hL, -0.5, []), from = [4.0, -0.5 - 0.75 * 1.7, 0];
    const m = stepWalk({ pos: from, dir: [1, 0], dt: 0.25, cap: 0.2 }, envL);
    ok(m.blocked === null && near(m.pos[0], 4.2) && near(m.pos[1], 0, 1e-6) && hL(4.1, 0) < -0.5 - 0.8 && hL(4.1, 0) > from[1], "G7 the mover: one stride from swimming at the rim's foot onto the bank (the sweep's mid point stands at ~-1.5, wading)", { m, mid: hL(4.1, 0) });
    for (const [claim, y] of [["mover", 0], ["bed", r3(hL(4.2, 0))]]) {
      ok(call("slope", "nia", "move", { to: from.map(r3), teleport: true, client: "agent" }).ok, `G7 [${claim}] nia afloat at the rim's foot`);
      const r = call("slope", "nia", "move", { to: [4.2, y, 0] });
      ok(r.ok, `G7 [${claim}] the authority: the same stride up the sloped rim, accepted (judged from where it last swam)`, r.refused);
    }
  }

  // ---- GH a heightmap whose grid isn't here (holes r3 F3): the height law would fall back to noise (amplitude 3 here: a
  // phantom metre and more), so the authority commits NO ground until the grid is here (terrainshape's own rule; the
  // browser and the agent keep their last ground): ground-seated placement and a walk are refused with words, nothing is
  // logged; an arrival on dry ground (no ground read) still lands. Once the grid is registered: seated on the heightmap.
  { const { registerGrid } = await import(ENGINE + "shared/terrainshape.js");
    const REF = "store/heightmaps/f3f3f3f3f3f3f3f3.json", HM = { amplitude: 3, size: 80, heightmap: { grid: REF, min: 0, max: 0.01 } };
    call("hm", "olive", "create-world", { title: "hm" });
    ok(call("hm", "olive", "set", { id: "@world", component: "terrain", value: HM }).ok, "GH0 a heightmap terrain whose grid isn't on this server");
    const yOf = (id) => openWorld(root, "hm").state().entities[id]?.c.transform?.pos?.[1];   // a crate's origin is its bottom
    const c = call("hm", "olive", "create", { id: "hc1", model: "crate", at: [12, -7] });
    ok(!c.ok && c.refused?.code === "ground-loading" && /loading/.test(c.refused.reason) && !openWorld(root, "hm").state().entities.hc1,
      "GH1 create {at: [x, z]} with the grid missing: refused (the ground is still loading), no noise height logged", { refused: c.refused, y: openWorld(root, "hm").state().entities.hc1?.c.transform?.pos?.[1] });
    ok(call("hm", "olive", "create", { id: "hc2", model: "crate", components: { transform: { pos: [5, 0.5, 5] } } }).ok, "GH1 a thing given its own [x, y, z] is not ground-seated: created");
    const pl = call("hm", "olive", "place", { id: "hc2", at: [-15, 3] });
    ok(!pl.ok && pl.refused?.code === "ground-loading" && near(openWorld(root, "hm").state().entities.hc2.c.transform.pos[1], 0.5), "GH1 place {at} with the grid missing: refused, the thing stays where it was", pl.refused);
    const arr = call("hm", "ann", "move", { to: [0, 0, 0], client: "agent" });
    ok(arr.ok, "GH2 an arrival on dry ground reads no ground: it lands", arr.refused);
    const wk = call("hm", "ann", "move", { to: [0.5, 0, 0] });
    ok(!wk.ok && wk.refused?.code === "ground-loading" && /loading/.test(wk.refused.reason), "GH2 a walk with the grid missing: refused with words (the authority won't judge it on noise)", wk.refused);
    // GH4 (review r4 F2/F3): nothing flies, and nothing is put, on a guessed height. A launch (throw, drop, punt, a walk's
    // shove) would come to rest on the noise law's ground, and that rest is logged; a put {pos} is a claim judged against
    // the ground (floating, sunk), so with no ground to judge it on it is refused, never waved through
    ok(call("hm", "olive", "set", { id: "@world", component: "physics-engine", value: { engine: "eidosim@1.0.0" } }).ok, "(GH4 setup) the world runs eidosim");
    ok(call("hm", "olive", "move", { to: [0, 0, 2], client: "agent" }).ok, "(GH4 setup) olive arrives");
    for (const [id, model, pos, extra] of [["hb", "ball", [0.5, 1, 2.4], {}], ["hk", "ball", [-0.5, 0.2, 2.4], {}], ["hp", "crate", [0.5, 0, 1.4], { grabbable: {} }]] as any)
      ok(call("hm", "olive", "create", { id, model, components: { transform: { pos }, ...(model === "ball" ? { physics: { kind: "dynamic", who: "visitor" } } : {}), ...extra } }).ok, `(GH4 setup) ${id}`);
    const n4 = openWorld(root, "hm").entries.length;
    ok(call("hm", "olive", "grab", { id: "hb" }).ok, "(GH4 setup) olive holds a ball");
    const loading = (r) => !r.ok && r.refused?.code === "ground-loading" && /still loading/.test(r.refused.reason ?? "");
    for (const [what, verb, args] of [["a throw", "throw", { id: "hb", v: [0, 2, 2] }], ["a drop (it would fall)", "drop", { id: "hb" }],
      ["a punt", "punt", { id: "hk", power: 2 }], ["a walk's shove", "punt", { id: "hk", v: [0, 0.1, -1], shove: true }]] as any) {
      const r = call("hm", "olive", verb, args);
      ok(loading(r), `GH4 ${what} with the grid missing: refused ground-loading, with the same words`, r.refused ?? r); }
    ok(call("hm", "olive", "drop", { id: "hb" }).refused?.code === "ground-loading" && openWorld(root, "hm").entries.slice(n4).every((e) => !(e.kind === "sim" && e.verb === "launch")),
      "GH4 …and nothing was launched (no sim launch logged), the ball still in the hand", openWorld(root, "hm").entries.slice(n4).filter((e) => e.kind === "sim").map((e) => e.verb));
    ok(call("hm", "olive", "grab", { id: "hp" }).ok, "(GH4 setup) olive holds a crate that doesn't fly");
    const pf = call("hm", "olive", "put", { id: "hp", pos: [0.5, 1.4, 2.4] });
    ok(loading(pf) && near(openWorld(root, "hm").state().entities.hp.c.transform.pos[1], 0), "GH4 put {pos} 1.4 m up with the grid missing: refused ground-loading (no ground to judge floating on), nothing logged", { refused: pf.refused, pos: openWorld(root, "hm").state().entities.hp.c.transform.pos });
    registerGrid(REF, { w: 2, h: 2, data: new Uint16Array([65535, 65535, 65535, 65535]) });
    const hHM = fieldOf(HM);
    const pf2 = call("hm", "olive", "put", { id: "hp", pos: [0.5, 1.4, 2.4] });
    ok(!pf2.ok && pf2.refused?.code === "implausible" && /floating/.test(pf2.refused.reason), "GH4 the grid here: the same put {pos} is judged — floating, refused implausible", pf2.refused);
    const c3 = call("hm", "olive", "create", { id: "hc3", model: "crate", at: [12, -7] });
    ok(c3.ok && near(yOf("hc3"), hHM(12, -7), 0.01) && hHM(12, -7) <= 0.0101 && hHM(12, -7) >= 0, "GH3 the grid here: create {at} seats the crate on the heightmap (0..0.01 m), not on noise", { got: yOf("hc3"), field: hHM(12, -7) });
    ok(call("hm", "ann", "move", { to: [0.5, r3(hHM(0.5, 0)), 0] }).ok, "GH3 the grid here: the walk is accepted", null);
  }

  // ---- GP placement: on the hill, place {at}, create {at: [x, z]} and the spawn alias seat a model's BOTTOM on the heightfield
  const { TOOL_ALIAS_ARGS } = await import(ENGINE + "mcpl/tools.ts");
  call("flat", "olive", "create-world", { title: "flat" });
  const bottom = (world, id) => { const e = openWorld(root, world).state().entities[id]; return e?.c.transform?.pos?.[1]; };   // a crate's origin is its bottom
  // every crate its own spot (a second one at the same x, z would land on the first: GP5): the hilltop, its sides, its foot
  const spot = (k) => [7 + (k % 4) * 1.5, -3 + Math.floor(k / 4) * 1.5];   // a 1.5 m grid over the hill; k = 10 is its top
  for (let i = 0; i < 3; i++) {
    const [px, pz] = spot(4 * i), [cx, cz] = spot(4 * i + 1), [sx, sz] = spot(4 * i + 2), [yx, yz] = spot(4 * i + 3);
    ok(call("hill", "olive", "create", { id: `pc${i}`, model: "crate" }).ok && call("hill", "olive", "place", { id: `pc${i}`, at: [px, pz] }).ok, `GP0 pc${i} placed`);
    ok(near(bottom("hill", `pc${i}`), hH(px, pz), 0.01), `GP1 place {at: [${r3(px)}, ${r3(pz)}]} on the hill: the crate's bottom is the terrain's height there (${r3(hH(px, pz))} m) ±1 cm`, { got: bottom("hill", `pc${i}`), terrain: hH(px, pz) });
    ok(call("hill", "olive", "create", { id: `cc${i}`, model: "crate", at: [cx, cz] }).ok && near(bottom("hill", `cc${i}`), hH(cx, cz), 0.01), `GP2 create {at: [${r3(cx)}, ${r3(cz)}]} on the hill: the same (${r3(hH(cx, cz))} m)`, { got: bottom("hill", `cc${i}`), terrain: hH(cx, cz) });
    const sp = TOOL_ALIAS_ARGS.spawn({ lib: "crate", x: sx, z: sz, id: `sp${i}` }), spy = TOOL_ALIAS_ARGS.spawn({ lib: "crate", x: yx, z: yz, yaw: 0.7, id: `sy${i}` });
    ok(call("hill", "olive", "create", sp).ok && near(bottom("hill", `sp${i}`), hH(sx, sz), 0.01), `GP3 the spawn alias {lib, x, z} on the hill: the same (${r3(hH(sx, sz))} m)`, { args: sp, got: bottom("hill", `sp${i}`) });
    ok(call("hill", "olive", "create", spy).ok && near(bottom("hill", `sy${i}`), hH(yx, yz), 0.01), `GP3 the spawn alias with a yaw (place {at, facing}): the same (${r3(hH(yx, yz))} m)`, { args: spy, got: bottom("hill", `sy${i}`) });
    ok(call("flat", "olive", "create", { id: `fc${i}`, model: "crate", at: [cx, cz] }).ok && bottom("flat", `fc${i}`) === 0 && call("flat", "olive", "create", TOOL_ALIAS_ARGS.spawn({ lib: "crate", x: sx, z: sz, id: `fs${i}` })).ok && bottom("flat", `fs${i}`) === 0
      && call("flat", "olive", "create", { id: `fp${i}`, model: "crate" }).ok && call("flat", "olive", "place", { id: `fp${i}`, at: [px, pz] }).ok && bottom("flat", `fp${i}`) === 0,
      `GP4 on a flat world (no terrain component) place {at}, create {at} and the alias are y 0, as they always were`, [bottom("flat", `fc${i}`), bottom("flat", `fs${i}`), bottom("flat", `fp${i}`)]);
  }
  // a crate already on the hill is what a second one lands on (a thing's top still outranks the ground under it)
  ok(call("hill", "olive", "create", { id: "stack", model: "crate", at: [10, 0] }).ok && near(bottom("hill", "stack"), hH(10, 0) + 0.6, 0.01), "GP5 create {at} where a crate already sits on the hill: on the crate's top", bottom("hill", "stack"));
}
console.log(`mover: ${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
