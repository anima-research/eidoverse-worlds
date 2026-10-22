// Physics checks (design 20). Every scenario is built through the authority's ordinary tools, at pinned clock times.
// Ported from the protocol lab's phys-check.js @ 11db981; only paths changed. usage: bun tools/protocol/phys-check.ts
// @ts-nocheck — lab code, kept as written
import "./fixture-ids.ts";   // fixtures seed the ids they read (R 10-17: writers never choose ids)
import fs from "node:fs";
import { pathToFileURL } from "node:url";
import { request, settle, forkCopy } from "../../shared/protocol/authority.js";
import { openWorld } from "../../server/filehost.ts";
import { fold, readLog, digest, purgesIn, PURGED } from "../../shared/protocol/fold.js";
import { simFold, simFolder, simCutOf, restsOf, ENGINES } from "../../shared/protocol/simlayer.js";
import { ENGINE, scratch } from "./common.ts";
import { worldT, yawQ, qrot } from "../../shared/protocol/authority/math.js";
import { supportBelow } from "../../shared/protocol/authority/spatial.js";

const root = scratch("phys");
let T = 1800000000000, fails = 0, passes = 0;
const fresh = (name) => { for (const f of [`${name}.jsonl`, `${name}.presence.json`]) fs.rmSync(`${root}worlds/${f}`, { force: true }); return name; };
const at = (ms) => { T += ms; process.env.PROTOCOL_NOW = String(T); };
function call(world, actor, verb, args = {}, step = 100) { at(step); return request(openWorld(root, world), actor, verb, args); }
function ok(cond, what, detail) { if (cond) passes++; else { fails++; console.log("FAIL", what, detail !== undefined ? JSON.stringify(detail).slice(0, 400) : ""); } }
const log = (world) => openWorld(root, world).entries;
const view = (world) => { const w = openWorld(root, world); return simFold(w.entries, w.now()); };
// a tampered copy of a log, re-read from text as any reader would (positions are seqs; a copy has no stored seq)
const copyOf = (L) => readLog(L.map((e) => JSON.stringify(e)).join("\n") + "\n");
// insert an entry at position i: later entries move up one, and every cause at or after i follows them
const insertAt = (L, i, e) => { const C = copyOf(L).map((x) => (typeof x.cause === "number" && x.cause >= i ? { ...x, cause: x.cause + 1 } : x)); C.splice(i, 0, e); return copyOf(C); };
const rests = (L) => restsOf(L);
const ENG = { engine: process.env.PHYS_ENGINE ?? "eidosim" };   // no version named: stamped by the authority (so a deploy may restamp it, R)
// a rigid-body engine rests things inside its contact slop (eidosim: 5 mm) and a box doesn't slide far (the first eidosim
// slid things like pucks and stood them exactly on their support; these bars were exact for it)
const RIGID = true, ON = 0.005;

function playground(name) {
  fresh(name);
  call(name, "rowan", "create-world", { title: name });
  call(name, "rowan", "set", { id: "@world", component: "physics-engine", value: ENG });
  call(name, "rowan", "set", { id: "@world", component: "default-role", value: { role: "inhabitant" } });   // kit and friends are inhabitants here (R 10-21: a new world's newcomers build)
  call(name, "rowan", "create", { id: "table-1", model: "table", place: { at: [0, 4] } });
  call(name, "rowan", "create", { id: "ball", model: "ball", components: { physics: { kind: "dynamic", who: "inhabitant" } }, place: { at: [0, 0] } });
  call(name, "rowan", "create", { id: "crate-1", model: "crate", components: { physics: { kind: "dynamic", who: "builder" } }, place: { at: [2, 0] } });
  call(name, "rowan", "move", { to: [0, 0, -0.5] });
  return name;
}

// A — a throw, its rest result, and the three readers: a carrier, a non-carrier, a second carrier run.
{
  const W = playground("pc-a");
  const g = call(W, "rowan", "grab", { id: "ball" });
  ok(g.ok && g.inHandAt[1] === 1.1, "A grab puts it in the hand", g);
  const t = call(W, "rowan", "throw", { id: "ball", v: [0, 2, 3] });
  ok(t.ok, "A throw accepted", t);
  const mid = call(W, "rowan", "look", {}, 300).things.find((x) => x.id === "ball");
  ok(mid.moving && mid.at[2] === 0, "A mid-flight: reads show motion; the log still says where it was", mid);
  call(W, "rowan", "wait", {}, 6000);
  const L = log(W); const rest = rests(L);
  ok(rest.length === 1 && L[rest[0].seq].actor === "sim" && L[rest[0].cause].verb === "launch", "A exactly one rest result, caused by the launch", rest);
  const v = view(W);
  ok(v.restTicks[rest[0].seq] < 150, "A rest tick (the engine's, re-derived by a carrier) is when it stopped, not when the authority noticed", v.restTicks);
  ok(v.checks.agree >= 1 && !v.checks.disagree.length, "A a carrier re-folding the log agrees (digest + resting place)", v.checks);
  const blind = fold(L); // a reader with no engine at all
  const bz = blind.entities.ball.c.transform.pos[2];   // table at z 4, 0.8 deep: its near edge is z 3.6; the thrower stands at z -0.5
  ok(!blind.entities.ball.c.parent && Math.abs(blind.entities.ball.c.transform.pos[1]) < ON && (RIGID ? bz > 0.5 && bz < 3.6 : bz > 3),
    "A non-carrier: short of the table, on the ground, from the log alone", blind.entities.ball.c.transform);
  call(W, "rowan", "move", { to: [0, 0, 2.6] }); call(W, "rowan", "grab", { id: "ball" });
  call(W, "rowan", "move", { to: [0, 0, 3.9] }); const d = call(W, "rowan", "drop", { id: "ball" });
  ok(d.ok, "A drop over the table", d); call(W, "rowan", "wait", {}, 3000);
  const b2 = fold(log(W)).entities.ball.c;
  ok(b2.parent?.to === "table-1", "A a dropped ball rests on the table, and the log says so (parent: it rides with it)", b2);
  const r2 = rests(log(W)).at(-1);
  ok(Math.abs(r2.at[1] - 0.75) < ON && r2.onto === "table-1", "A on the table top (0.75); the authority's attach is its own entry", r2);
  const f1 = view(W), f2 = view(W); ok(JSON.stringify(f1.sim) === JSON.stringify(f2.sim) && f1.checks.agree === 2, "A folding the same log twice: same sim state, both rests verified", f1.checks);

}

// B — a tampered rest result: the carrier must notice; a non-carrier can't (and the design says so).
{
  const W = "pc-a"; const L = log(W); const i = rests(L)[0].seq;
  const bad = copyOf(L); (bad[i].body.ops ?? [bad[i].body]).find((o) => o.comp === "transform").value.pos[2] += 0.5;
  const w = openWorld(root, W); const v = simFold(bad, w.now());
  ok(v.checks.disagree.length === 1, "B a lying rest result is caught by any carrier", v.checks);
  const bad2 = copyOf(L); const launch = bad2.find((e) => e.verb === "launch"); launch.body.v[2] += 0.01;
  const v2 = simFold(bad2, w.now());
  ok(v2.checks.disagree.length >= 1, "B a tampered launch is caught too (the logged result no longer follows)", v2.checks);
}

// C — L6 (as revised; 33 F1): a launched thing is the engine's until it rests. No authored write touches it in flight,
// not even a label (the lab used to let an authored transform win over the sim, P7: the law now says otherwise).
{
  const W = playground("pc-c");
  call(W, "rowan", "grab", { id: "ball" }); call(W, "rowan", "throw", { id: "ball", v: [0, 4, 1] });
  const lab = call(W, "rowan", "set", { id: "ball", component: "label", value: "red ball" }, 200);
  ok(!lab.ok && lab.refused.code === "in-flight", "C a label change in flight is refused", lab);
  ok(view(W).sim.bodies.ball && !view(W).sim.bodies.ball.resting, "C …and it is still flying");
  const s = call(W, "rowan", "set", { id: "ball", component: "transform", value: { pos: [3, 0, 3] } }, 100);
  ok(!s.ok && s.refused.code === "in-flight", "C even the owner can't set a flying thing's transform", s);
  call(W, "rowan", "wait", {}, 6000);
  const rs = rests(log(W));
  ok(rs.length === 1 && rs[0].id === "ball", "C the engine's word stands: its rest is logged", rs);
  const after = call(W, "rowan", "set", { id: "ball", component: "transform", value: { pos: [3, 0, 3] } });
  ok(after.ok && JSON.stringify(fold(log(W)).entities.ball.c.transform.pos) === "[3,0,3]", "C at rest it's an ordinary thing again", after);
  const L = log(W); const i = rs[0].seq; const throwAct = L[rs[0].cause].cause; // a reader catches a write that slipped past the authority mid-flight
  const forged = insertAt(L, rs[0].cause + 1, { world: L[1].world, kind: "change", ts: L[rs[0].cause].ts + 200, actor: "rowan", cause: throwAct, verb: "set", body: { id: "ball", comp: "label", value: "mid-air" } });
  ok(simFold(forged, openWorld(root, W).now()).checks.disagree.some((d) => /in flight/.test(d.why ?? "")), "C a carrier flags any write that touched it in flight", simFold(forged, openWorld(root, W).now()).checks);
}

// D — P6 barrier: turning physics off mid-flight waits (with an ETA), or freezes on force.
{
  const W = playground("pc-d");
  call(W, "rowan", "grab", { id: "ball" }); call(W, "rowan", "throw", { id: "ball", v: [0, 6, 0] });
  const busy = call(W, "rowan", "delete", { id: "@world", component: "physics-engine" }, 200);
  ok(!busy.ok && busy.refused.code === "busy" && /about [\d.]+ s/.test(busy.refused.reason), "D cut refused while in flight, with an ETA", busy.refused);
  const forced = call(W, "rowan", "delete", { id: "@world", component: "physics-engine", force: true }, 50);
  ok(forced.ok && forced.warnings?.some((x) => x.kind === "floating" && x.id === "ball"), "D forced cut freezes it mid-air, and says it floats", forced);
  const v = view(W); ok(!v.sim, "D no epoch after the cut");
  const after = call(W, "rowan", "look", {}, 3000).things.find((x) => x.id === "ball");
  ok(!after.moving && after.at[1] > 0.5, "D frozen where it was: logged as a plain result", after);
  if (RIGID) { // review of 49d4fb0d #3: a rigid engine's origin is only where it was WITH its own turn; frozen pre-launch q floats it
    const W3 = playground("pc-d3");
    call(W3, "rowan", "move", { to: [2, 0, -0.5] });
    const g3 = call(W3, "rowan", "grab", { id: "crate-1" }), t3 = call(W3, "rowan", "throw", { id: "crate-1", v: [0, 5, 0], w: [0, 0, 6] });
    ok(g3.ok && t3.ok, "D3 setup: the crate is in hand and thrown", { g3: g3.refused, t3: t3.refused });
    const f3 = call(W3, "rowan", "delete", { id: "@world", component: "physics-engine", force: true }, 400);
    const L3 = log(W3), cut = [...L3].reverse().find((e) => e.kind === "change" && JSON.stringify(e).includes('"crate-1"') && JSON.stringify(e).includes('"transform"'));
    const op = (cut?.body?.ops ?? [cut?.body]).find((o) => o?.id === "crate-1" && o.comp === "transform");
    const q = op?.value?.q ?? [0, 0, 0, 1];
    ok(f3.ok && Math.abs(q[3]) < 0.9999, "D3 a forced cut logs a tumbling crate as the engine had it turned, not as it was thrown", { q, ok: f3.ok });
  }
  if (RIGID) { // review of 49d4fb0d #6: a thing with a shape and no model has no collider in a rotating engine: refused, not silent
    const W6 = playground("pc-d6");
    const c6 = call(W6, "rowan", "create", { id: "ghost", components: { transform: { pos: [0, 0, 0.3], q: [0, 0, 0, 1], scale: [1, 1, 1] }, physics: { kind: "dynamic", who: "inhabitant", shape: [[-0.2, 0, -0.2], [0.2, 0.4, 0.2]] } } });
    const p6 = c6.ok ? call(W6, "rowan", "punt", { id: "ghost", power: 2 }) : null;   // punt first: a held thing is refused as "held"
    const g6 = c6.ok ? call(W6, "rowan", "grab", { id: "ghost" }) : null, t6 = g6?.ok ? call(W6, "rowan", "throw", { id: "ghost", v: [0, 2, 1] }) : null;
    ok(!c6.ok || ((!t6 || t6.refused?.code === "no-shape") && (!p6 || p6.refused?.code === "no-shape")),
      "D6 a shaped thing with no model is refused at the throw and the punt (or can't be made at all)", { made: c6.ok, made_refused: c6.refused, grab: g6?.ok ?? g6?.refused, throw: t6?.ok ?? t6?.refused, punt: p6?.ok ?? p6?.refused });
  }
  { // collider {shape: "sphere"} asks the authority for a sphere: it stamps one fitted to the model (the asker's shape
    // is never taken, Covenant III); under eidosim it flies as a sphere: thrown, it rolls, and rests turned on the ground
    const W7 = playground("pc-d7");
    const c7 = call(W7, "rowan", "create", { id: "rb", model: "ball", components: { collider: { shape: "sphere" }, physics: { kind: "dynamic", who: "inhabitant" } }, place: { at: [0, 0] } });
    const ph7 = fold(log(W7)).entities.rb?.c.physics?.shape;
    ok(c7.ok && JSON.stringify(ph7) === JSON.stringify({ type: "sphere", radius: 0.11, pos: [0, 0.11, 0] }), "D7 collider sphere: the authority stamps a sphere fitted to the ball's box", { shape: ph7, refused: c7.refused });
    const box7 = call(W7, "rowan", "set", { id: "rb", component: "collider", value: { shape: "box" } }), back7 = fold(log(W7)).entities.rb?.c.physics?.shape;
    const sph7 = call(W7, "rowan", "set", { id: "rb", component: "collider", value: { shape: "sphere" } });
    ok(box7.ok && sph7.ok && JSON.stringify(back7) === JSON.stringify([[-0.11, 0, -0.11], [0.11, 0.22, 0.11]]), "D7 …asking for a box again re-stamps the box", { back7 });
  }
  { // Antra's review of f91840e5 (P2): a forced cut writes the engine's WORLD pose; a thrown ball still carrying its logged
    // parent (a table at x 10) must lose it there, as an ordinary rest does, or the parent's offset is applied twice (x 10 → 20)
    const W9 = playground("pc-d9");
    const c9 = call(W9, "rowan", "create", { id: "pad", model: "table", place: { at: [10, 0] } });
    const b9 = call(W9, "rowan", "create", { id: "kid", model: "ball", components: { physics: { kind: "dynamic", who: "inhabitant" }, parent: { to: "pad" }, transform: { pos: [0, 0.75, 0], q: [0, 0, 0, 1], scale: [1, 1, 1] } } });
    const m9 = call(W9, "rowan", "move", { to: [10, 0, -0.5], teleport: true }); if (!m9.ok) console.log("D9 move", JSON.stringify(m9.refused));
    const x0 = worldT(fold(log(W9)), "kid").pos[0];
    const g9 = call(W9, "rowan", "grab", { id: "kid" }), t9 = call(W9, "rowan", "throw", { id: "kid", v: [0, 6, 0] });
    const f9 = call(W9, "rowan", "delete", { id: "@world", component: "physics-engine", force: true }, 200);
    const st9 = fold(log(W9)), x9 = worldT(st9, "kid").pos[0];
    ok(c9.ok && b9.ok && g9.ok && t9.ok && f9.ok && Math.abs(x0 - 10) < 0.01, "D9 setup: a ball on a table at x 10, thrown up, physics forced off", { c: c9.refused, b: b9.refused, g: g9.refused, t: t9.refused, f: f9.refused, x0 });
    ok(Math.abs(x9 - 10) < 0.05 && !st9.entities.kid.c.parent, "D9 a forced cut freezes a parented thrown ball where it was (x 10, not 20) and clears its parent", { x: x9, parent: st9.entities.kid.c.parent ?? null });
  }
  if (RIGID) {
    const W7 = playground("pc-d7r");
    const c7 = call(W7, "rowan", "create", { id: "rb", model: "ball", components: { collider: { shape: "sphere" }, physics: { kind: "dynamic", who: "inhabitant" } }, place: { at: [0, 0] } });
    const g7 = call(W7, "rowan", "grab", { id: "rb" }), t7 = call(W7, "rowan", "throw", { id: "rb", v: [0, 1, 3] });
    ok(c7.ok && g7.ok && t7.ok, "D7 setup: a ball stamped as a sphere is made, picked up and thrown", { c: c7.refused, g: g7.refused, t: t7.refused });
    call(W7, "rowan", "wait", {}, 15000);

    const r7 = rests(log(W7)).find((r) => r.id === "rb"), st7 = fold(log(W7)).entities.rb.c.transform;
    // a rolled ball's origin (its bottom, as modelled) has turned with it: the claim is about its CENTRE, origin + q·(0, r, 0)
    const [qx, qy, qz, qw] = st7.q, cy = st7.pos[1] + 0.11 * (1 - 2 * (qx * qx + qz * qz));
    ok(!!r7 && Math.abs(cy - 0.11) < ON && Math.abs(st7.q[3]) < 0.99 && st7.pos[2] > 2,
      "D7 …it rolled: its centre rests at its radius on the ground, well past where it landed, turned", { rest: !!r7, pos: st7.pos, q: st7.q, centreY: cy });
  }
  if (RIGID) { // stage 2: a thrown crate knocks a resting dynamic crate; both rests are logged under the throw, a carrier agrees,
    // and a locked crate and the (static) table don't move
    const W8 = playground("pc-d8");
    call(W8, "rowan", "create", { id: "tgt", model: "crate", components: { physics: { kind: "dynamic", who: "inhabitant" } }, place: { at: [0, 2.2] } });
    call(W8, "rowan", "create", { id: "fix", model: "crate", components: { physics: { kind: "dynamic", who: "inhabitant" }, lock: true }, place: { at: [1.4, 2.2] } });
    const before = fold(log(W8)).entities; const tgt0 = before.tgt.c.transform.pos, fix0 = before.fix.c.transform.pos, tab0 = before["table-1"].c.transform.pos;
    call(W8, "rowan", "move", { to: [2, 0, -0.5] }); const g8 = call(W8, "rowan", "grab", { id: "crate-1" });
    call(W8, "rowan", "move", { to: [0, 0, 0.4] });
    const t8 = call(W8, "rowan", "throw", { id: "crate-1", v: [0, 1.5, 5] });
    ok(g8.ok && t8.ok, "D8 setup: crate in hand and thrown at the target", { g: g8.refused, t: t8.refused });
    call(W8, "rowan", "wait", {}, 20000);
    const L8 = log(W8), R8 = rests(L8), E8 = fold(L8).entities, v8 = view(W8);
    const rt = R8.find((r) => r.id === "tgt"), rc = R8.find((r) => r.id === "crate-1");
    ok(!!rt && !!rc && rt.cause === rc.cause && L8[rt.cause].verb === "launch" && L8[rt.cause].body.id === "crate-1" && JSON.stringify(E8.tgt.c.transform.pos) !== JSON.stringify(tgt0),
      "D8 the target was knocked: its rest is logged under the throw's launch, beside the thrown crate's", { rests: R8.map((r) => [r.id, r.cause]), tgt: E8.tgt.c.transform.pos });
    ok(v8.checks.agree >= 2 && !v8.checks.disagree.length, "D8 …and a carrier re-folding the log agrees with both rests", v8.checks);
    ok(JSON.stringify(E8.fix.c.transform.pos) === JSON.stringify(fix0) && JSON.stringify(E8["table-1"].c.transform.pos) === JSON.stringify(tab0), "D8 a locked crate and the table stay put", { fix: E8.fix.c.transform.pos, table: E8["table-1"].c.transform.pos });
  }
  const W2 = playground("pc-d2");
  call(W2, "rowan", "grab", { id: "ball" }); call(W2, "rowan", "throw", { id: "ball", v: [0, 2, 0] }); call(W2, "rowan", "wait", {}, 5000);
  const calm = call(W2, "rowan", "set", { id: "@world", component: "physics-engine", value: { engine: "eidosim@1.0.0", tickMs: 16 } }, 100);
  ok(calm.ok && !calm.notes?.some((n) => n.frozen), "D at rest, the cut is free (nothing to freeze)", calm);
}

// E — P3 settlements are claims: lies are refused, honest ones logged with who handled it.
{
  const W = playground("pc-e");
  call(W, "rowan", "move", { to: [0, 0, 3.2] }); call(W, "rowan", "grab", { id: "crate-1" }, 50);
  const g = call(W, "rowan", "grab", { id: "crate-1" });
  ok(!g.ok && g.refused.code === "out-of-reach", "E grab beyond reach refused", g.refused);
  call(W, "rowan", "move", { to: [1.6, 0, 0.5] }, 1000); const g2 = call(W, "rowan", "grab", { id: "crate-1" }); // a body walks (the authority's track, L6): it takes time
  ok(g2.ok, "E grab in reach", g2);
  call(W, "rowan", "move", { to: [0.5, 0, 3.2] }, 1000);
  const inside = call(W, "rowan", "put", { id: "crate-1", pos: [0, 0.3, 4] });
  ok(!inside.ok && inside.refused.code === "implausible", "E a claim that puts it inside the table is refused", inside.refused);
  const hover = call(W, "rowan", "put", { id: "crate-1", pos: [-0.3, 1.0, 3.2] });
  ok(!hover.ok && /floating/.test(hover.refused.reason), "E a claim that leaves it hovering is refused", hover.refused);
  const far = call(W, "rowan", "put", { id: "crate-1", pos: [5, 0, 5] });
  ok(!far.ok && far.refused.code === "out-of-reach", "E a claim beyond reach is refused", far.refused);
  const top = call(W, "rowan", "put", { id: "crate-1", pos: [0, 0.75, 4] });
  ok(top.ok, "E an honest claim (on the table top) is logged", top);
  const act = log(W).at(-2); ok(act.kind === "act" && act.verb === "put" && act.body.handled?.includes("rowan"), "E the act records who handled it", act.body);
}

// F — rights per component: an inhabitant may pick up the ball (physics.who) but not the crate.
{
  const W = playground("pc-f");
  call(W, "rowan", "set", { id: "@world", component: "roles:rowan", value: { role: "owner" } });
  call(W, "kit", "move", { to: [0, 0, 0.5] }); call(W, "kit", "move", { to: [1.8, 0, 0.5] });
  const c = call(W, "kit", "grab", { id: "crate-1" });
  ok(!c.ok && c.refused.code === "rights", "F an inhabitant can't pick up a builder-only crate", c.refused);
  call(W, "kit", "move", { to: [0, 0, 0.5] }); const b = call(W, "kit", "grab", { id: "ball" });
  ok(b.ok, "F a visitor may pick up the ball", b);
  const t = call(W, "kit", "throw", { id: "ball", v: [1, 2, 0] }); ok(t.ok, "F and throw it", t);
  call(W, "kit", "wait", {}, 6000);
  const r = rests(log(W)).at(-1);
  ok(r && r.handled.includes("kit"), "F the rest result is attributed to who handled it (its launch says so)", r);
  const set = call(W, "kit", "set", { id: "ball", component: "transform", value: { pos: [0, 0, 0] } });
  ok(!set.ok && set.refused.code === "rights", "F …but an inhabitant still can't author its transform directly", set.refused);
}

// G — a catch: grabbing a flying thing goes through the log; no rest result follows.
{
  const W = playground("pc-g");
  call(W, "rowan", "grab", { id: "ball" }); call(W, "rowan", "throw", { id: "ball", v: [0, 4, 0.5] });
  const p = call(W, "rowan", "look", {}, 400).things.find((x) => x.id === "ball").moving.pos;
  call(W, "jo", "move", { to: [p[0], 0, p[2]] }, 1);
  const c = call(W, "jo", "grab", { id: "ball" }, 1);
  ok(c.ok && c.recorded, "G caught mid-air, and that was logged", c);
  call(W, "jo", "wait", {}, 6000);
  ok(!rests(log(W)).length, "G nothing came to rest: jo holds it");
  ok(view(W).checks.disagree.length === 0, "G carriers still agree");
}

// H — an orphan: leaving while holding drops it into the sim, attributed to whoever left.
{
  const W = playground("pc-h");
  call(W, "rowan", "move", { to: [0, 0, 1.6] }, 1000); call(W, "rowan", "move", { to: [0, 0, 3.6] }, 1000); call(W, "rowan", "grab", { id: "table-1" });
  call(W, "rowan", "move", { to: [0, 0, 0.3] }, 1000); call(W, "rowan", "grab", { id: "ball" });
  const l = call(W, "rowan", "leave", {});
  ok(l.ok && l.dropped.length === 1 && l.dropped[0].ok, "H leaving drops what was held", l);
  call(W, "jo", "wait", {}, 4000);
  const r = rests(log(W)).at(-1);
  ok(r && Math.abs(r.at[1]) < ON, "H it fell to the ground and that's logged", r);
}

// I — determinism of the whole pipeline: the same requests at the same times give the same log, byte for byte.
{
  const run = (name) => { T = 1800000000000; const W = playground(name);
    call(W, "rowan", "grab", { id: "ball" }); call(W, "rowan", "throw", { id: "ball", v: [1.3, 2.7, 3.1] });
    call(W, "rowan", "move", { to: [1.6, 0, 0.5] }); call(W, "rowan", "grab", { id: "crate-1" }); call(W, "rowan", "throw", { id: "crate-1", v: [-2, 3, 3] });
    call(W, "rowan", "wait", {}, 8000);
    // §3d C1: two worlds' geneses differ in their nonce by design (so do their world ids); everything after is the same
    const [g, ...rest] = fs.readFileSync(`${root}worlds/${W}.jsonl`, "utf8").split("\n"); const gb = JSON.parse(g); const wid = JSON.parse(rest[0]).world;
    return { nonce: gb.body.nonce, genesis: JSON.stringify({ ...gb, body: { ...gb.body, nonce: "N" } }), rest: rest.filter(Boolean).map((l) => { const { head, sig, ...e } = JSON.parse(l); return JSON.stringify(e).replace(/"salt":"[A-Za-z0-9_-]+"/g, '"salt":"S"'); }).join("\n").replaceAll(wid, "W").replaceAll(name, "X") }; }; // §2.4: salts are random, so heads and sigs differ too
  const a = run("pc-i1"), b = run("pc-i2");
  ok(a.rest === b.rest && a.genesis === b.genesis && a.nonce !== b.nonce, "I same requests, same times → identical logs (but for genesis's nonce and so the world id)");
  const v = view("pc-i1"); ok(v.checks.agree === 2 && !v.checks.disagree.length, "I two rests, both verified", v.checks);
}

// K — a foreign engine: this server can't run it, so nothing flies; the world is still fully readable.
{ // review of b398d7e3 #3: an epoch the engine would never start is refused, not accepted to fly nowhere
  const W = fresh("pc-tick"); call(W, "rowan", "create-world", { title: W });
  const bad = [5, 15, 1001, 33.5].map((t) => call(W, "rowan", "set", { id: "@world", component: "physics-engine", value: { engine: "eidosim@1.0.0", tickMs: t } }));
  const good = [16, 1000].map((t) => call(W, "rowan", "set", { id: "@world", component: "physics-engine", value: { engine: "eidosim@1.0.0", tickMs: t } }));
  ok(bad.every((r) => r.refused?.code === "bounds") && good.every((r) => r.ok), "K a tickMs outside the engine's range (16..1000 whole ms) is refused; its ends are fine", [...bad, ...good].map((r) => r.ok ?? r.refused?.code));
}
{
  const W = fresh("pc-k"); call(W, "rowan", "create-world", { title: W });
  // an owner may name a version this server doesn't carry (house, #260 10-21): accepted with a note; what only the engine computes is refused
  const s = call(W, "rowan", "set", { id: "@world", component: "physics-engine", value: { engine: "eidosim@2.0.0" } });
  ok(s.ok && s.notes?.some((n) => /isn't carried/.test(n.why)), "K a version this server doesn't carry is accepted with a note", s);
  call(W, "rowan", "create", { id: "ball", model: "ball", components: { physics: { kind: "dynamic" } }, place: { at: [0, 0] } });
  call(W, "rowan", "move", { to: [0, 0, 0.5] }); call(W, "rowan", "grab", { id: "ball" });
  const t = call(W, "rowan", "throw", { id: "ball", v: [0, 1, 1] });
  ok(!t.ok && t.refused.code === "foreign-engine", "K throwing is refused, honestly", t.refused);
  const d = call(W, "rowan", "put", { id: "ball" }); ok(d.ok, "K putting it down still works (a settlement needs no engine)", d);
}

// EV — an engine is named by its version; the authority stamps one when the owner names none (house answer, #260 10-21)
{
  const W = fresh("pc-v"); call(W, "rowan", "create-world", { title: W });
  const pe = () => fold(log(W)).entities["@world"].c["physics-engine"];
  const s1 = call(W, "rowan", "set", { id: "@world", component: "physics-engine", value: { engine: "eidosim" } });
  ok(s1.ok && pe().engine === "eidosim@1.0.0" && s1.notes?.some((n) => /stamped/.test(n.why ?? "")), "EV1 no version named: the authority stamps the one it carries, and says so", { s1, pe: pe() });
  ok(!("build" in pe()), "EV1b the stored value names no build: a version is the engine's identity", pe());
  const s2 = call(W, "rowan", "set", { id: "@world", component: "physics-engine", value: { engine: "eidosim@1.0.0" } });
  ok(s2.ok && pe().engine === "eidosim@1.0.0" && !s2.notes?.some((n) => /stamped/.test(n.why ?? "")), "EV2 a version named is kept as named, with no stamp note", { s2, pe: pe() });
  const s3 = call(W, "rowan", "set", { id: "@world", component: "physics-engine", value: { engine: "nosuchphys" } });
  ok(!s3.ok && s3.refused?.code === "unknown-engine", "EV3 an engine name this server has never heard of is refused (a typo shouldn't set a world's physics)", s3);
  const s4 = call(W, "rowan", "set", { id: "@world", component: "physics-engine", value: { engine: "eidosim", build: "deadbeefdeadbeef" } });
  ok(!s4.ok, "EV4 build is no longer a field: a value naming one is refused at the door", s4);
}

// L — playtest 22 fixes
{
  const ghost = fresh("pc-l-none");
  const said = call(ghost, "sage", "say", { text: "hello?" });
  ok(!said.ok && said.refused.code === "no-world" && /create-world \{title/.test(said.refused.fix), "L a world that doesn't exist refuses everything but create-world/help, and teaches create-world", said.refused);
  ok(!fs.existsSync(`${root}worlds/${ghost}.jsonl`), "L …and nothing was written");
  const dry = call(ghost, "sage", "create-world", { title: "x", dry: true }); ok(dry.ok && dry.dry && !fs.existsSync(`${root}worlds/${ghost}.jsonl`), "L new honours dry", dry);
  const W = playground("pc-l");
  call(W, "rowan", "create", { id: "crate-2", model: "crate", components: { physics: { kind: "dynamic" } }, place: { at: [2, 0] } });
  const b2 = call(W, "rowan", "inspect", { id: "crate-2" });
  const stacked = b2.ok && b2.world.pos[1] > 0.5; // placed `at` the same spot lands on top of crate-1
  ok(stacked, "L crate-2 stands on crate-1", b2.world);
  call(W, "rowan", "move", { to: [1.6, 0, 0.6] });
  const g = call(W, "rowan", "grab", { id: "crate-1" });
  ok(g.ok && (g.notes ?? []).some((n) => n.fell?.includes("crate-2")), "L picking up the bottom crate lets the top one fall", g);
  call(W, "rowan", "wait", {}, 3000);
  const top = call(W, "rowan", "wait", {});
  ok(top.cameToRest?.some((r) => r.id === "crate-2" && Math.abs(r.at[1]) < 1e-6), "L wait says where it came to rest (the ground)", top);
  const far = call(W, "rowan", "move", { to: [50, 0, 50] }); ok(!far.ok && far.refused.code === "out-of-bounds", "L you can't walk out of the world", far.refused);
  for (const x of [5, 9, 13, 17, 19]) { const m = call(W, "rowan", "move", { to: [x, 0, 0] }, 1000); ok(m.ok, `L walked to x=${x} carrying it`, m); }
  call(W, "rowan", "put", { id: "crate-1" }); call(W, "rowan", "grab", { id: "crate-1" });
  const before = call(W, "rowan", "inspect", { id: "crate-1" }).world.pos;
  call(W, "rowan", "throw", { id: "crate-1", v: [20, 2, 0] }); call(W, "rowan", "wait", {}, 8000);
  const after = call(W, "rowan", "wait", {});
  const lostOne = after.cameToRest?.find((r) => r.id === "crate-1");
  ok(lostOne?.lost, "L a throw out of the world is reported lost", after);
  ok(JSON.stringify(call(W, "rowan", "inspect", { id: "crate-1" }).world.pos) === JSON.stringify(before), "L …and it's back where it was picked up");
  ok(view(W).checks.disagree.length === 0, "L carriers still agree (lost rests included)", view(W).checks);
  const sch = call(W, "rowan", "schema", { component: "physics" }); ok(/knocks over dynamic things it hits unless a lock holds them/.test(JSON.stringify(sch)), "L the schema says what a throw does to what it hits, and what a lock keeps");
  const c = call(W, "rowan", "create", { id: "ball-2", model: "ball", components: { physics: { kind: "dynamic" } }, place: { at: [3, 3] } });
  ok(c.ok && !(c.notes ?? []).some((n) => /isn't a component/.test(n.why ?? "")), "L physics is a known component now (no false note)", c.notes);
}

// M — Mica's hostile case: rethrow before the first rest. The first launch must never get a rest; the rest that is
// logged must name the SECOND launch as its cause, and carriers must agree. Plus a matched receipt: two separate
// processes fold the same log and read the terminal transform independently.
{
  const W = playground("pc-m");
  call(W, "rowan", "grab", { id: "ball" });
  const t1 = call(W, "rowan", "throw", { id: "ball", v: [0, 5, 0.3] });
  const p = call(W, "rowan", "look", {}, 250).things.find((x) => x.id === "ball").moving.pos;
  call(W, "jo", "move", { to: [p[0], 0, p[2]] }, 1);
  const c = call(W, "jo", "grab", { id: "ball" }, 1); ok(c.ok && c.recorded, "M jo catches it mid-flight", c);
  const t2 = call(W, "jo", "throw", { id: "ball", v: [1.5, 2, 0] }, 1); ok(t2.ok, "M and rethrows it before it ever rested", t2);
  call(W, "jo", "wait", {}, 6000);
  const L = log(W); const rs = rests(L).filter((r) => r.id === "ball");
  ok(rs.length === 1, "M exactly one rest for the ball", rs.length);
  ok(rs[0]?.cause === t2.seq && rs[0]?.cause !== t1.seq, "M its cause is the second launch, never the first", { cause: rs[0]?.cause, t1: t1.seq, t2: t2.seq });
  ok(JSON.stringify(rs[0]?.handled) === JSON.stringify(["jo"]), "M attributed to who threw it last", rs[0]?.handled);
  ok(view(W).checks.disagree.length === 0 && view(W).checks.agree >= 1, "M carriers agree", view(W).checks);
  const L2 = copyOf(L); L2[t2.seq].body.v[0] += 0.001;
  const w = openWorld(root, W); ok(simFold(L2, w.now()).checks.disagree.length >= 1, "M tampering with the SECOND launch is caught (it is authority, not decoration)");
  const L3 = copyOf(L); L3[t1.seq].body.v[0] += 0.5;
  ok(simFold(L3, w.now()).checks.disagree.length === 0, "M …while the caught first launch can't change the result (the catch cut it)");
  // a forged rest(A): appended right after the catch, claiming A came to rest where it was caught
  const catchSeq = L.findIndex((e) => e.kind === "sim" && e.verb === "catch");
  const forged = insertAt(L, catchSeq + 1, { world: L[1].world, kind: "change", ts: L[catchSeq].ts, actor: "sim", cause: t1.seq, verb: "set", body: { id: "ball", comp: "transform", value: { pos: [0, 0, 1], q: [0, 0, 0, 1], scale: [1, 1, 1] } } });
  const fv = simFold(forged, w.now());
  ok(fv.checks.disagree.some((d) => d.id === "ball"), "M a forged rest(A) after the catch is rejected by carriers", fv.checks);
  const read = () => { const r = Bun.spawnSync(["bun", "-e", `import fs from "node:fs"; import {simFold} from ${JSON.stringify(pathToFileURL(ENGINE + "shared/protocol/simlayer.js").href)}; import {fold, readLog} from ${JSON.stringify(pathToFileURL(ENGINE + "shared/protocol/fold.js").href)};
    const L = readLog(fs.readFileSync("worlds/${W}.jsonl")); const sf = simFold(L, ${T});
    console.log(JSON.stringify({ blind: fold(L).entities.ball.c.transform.pos, sim: sf.sim.bodies.ball?.p ?? null, checks: sf.checks }));`], { cwd: root, env: { ...process.env, PROTOCOL_NOW: String(T) } });
    return r.stdout.toString().trim(); };
  const r1 = read(), r2 = read(); const j = JSON.parse(r1);
  ok(r1 === r2 && JSON.stringify(j.blind) === JSON.stringify(rs[0]?.at) && j.checks.agree === 1 && !j.checks.disagree.length, "M matched receipt: two processes read the same terminal transform, equal to the logged rest, which the carrier checked against the engine", { r1, r2 });
}

// N — 25d H2: forged rests (P1a–d). L3: a change entry caused by a sim entry IS a rest, and its value must be the
// engine's. There is no second copy (args.sim) left to edit, so every forgery is a forgery of the value itself.
{
  const W = "pc-a"; const L = log(W); const w = openWorld(root, W); const r0 = rests(L)[0]; const i = r0.seq;
  const honest = simFold(L, w.now()); ok(honest.checks.disagree.length === 0 && honest.checks.agree === 2, "N the honest log: both rests verified", honest.checks);
  ok(!L.some((e) => e.kind === "change" && "sim" in e.body), "N no change entry carries an engine annotation (L2: args.sim is gone)");
  const forge = (f) => { const C = copyOf(L); C[i] = f(C[i]); return simFold(C, w.now()).checks; };
  const tval = (e) => (e.body.ops ?? [e.body]).find((o) => o.comp === "transform").value;
  const P1a = forge((e) => { tval(e).pos = [15, 0, -15]; return e; });
  ok(P1a.disagree.some((d) => d.seq === i), "N P1a/P1d: the rest's value edited (there is no other copy to keep honest) → caught", P1a);
  const P1b = forge((e) => ({ world: e.world, kind: "change", ts: e.ts, actor: "sim", cause: e.cause, verb: "set", body: { id: "ball", comp: "transform", value: { ...tval(e), pos: [15, 0, -15] } } }));
  ok(P1b.disagree.some((d) => d.seq === i), "N P1b: a plain set caused by the launch is a rest by definition, and checked → caught", P1b);
  const throwAct = L[r0.cause].cause;
  const P1c = forge((e) => ({ world: e.world, kind: "change", ts: e.ts, actor: "rowan", cause: throwAct, verb: "set", body: { id: "ball", comp: "transform", value: { ...tval(e), pos: [15, 0, -15] } } }));
  ok(P1c.disagree.some((d) => d.seq === i && /not after the launch/.test(d.why)), "N P1c: the thrower's own 'result' of the throw act, while the ball flies → caught", P1c);
  const P1x = forge((e) => ({ ...e, verb: "batch", body: { ops: [{ verb: "set", ...e.body }, { verb: "set", id: "table-1", comp: "transform", value: { pos: [9, 0, 9], q: [0, 0, 0, 1], scale: [1, 1, 1] } }] } }));
  ok(P1x.disagree.some((d) => d.id === "table-1"), "N a rest that also moves something the launch didn't throw → caught", P1x);
  const lift = L.findIndex((e) => e.kind === "sim" && e.verb === "lift");
  const P1y = forge((e) => ({ ...e, cause: lift }));
  ok(lift > 0 && P1y.disagree.some((d) => /starts no motion/.test(d.why ?? "")), "N a 'rest' caused by a lift (which starts no motion) → caught", P1y);
  const C = copyOf(L); tval(C[i]).pos = [9, 9, 9]; // P4 edited only the annotation the view read; now the view reads the value
  const seen = rests(C)[0].at, folded = fold(C, { until: i }).entities.ball.c.transform.pos;
  ok(JSON.stringify(seen) === "[9,9,9]" && JSON.stringify(folded) === "[9,9,9]", "N P4 is gone: the rest view and the fold read the same one value (so a forgery shows in both, and carriers flag it)", { seen, folded });
}

// R — a deploy changes the engine's build (REVIEW-design-2026-10-15 "Deploying switches physics off"). A world the old
// server stamped names the old build, so the new server holds it foreign and nothing flies. The authority restamps it
// itself, as system, once: when the engine is one it carries, the build was stamped by an authority (not named by the
// owner), and nothing is in flight (P6: the cut is then free). A "deploy" here is ENGINES' build swapped under the world.
{
  // a deploy is the carried set changing: the old server carried eidosim@0.9.0, this one carries eidosim@1.0.0
  const OLD = "eidosim@0.9.0", NEW = "eidosim@1.0.0", E = ENGINES[NEW];
  const deployed = (fn) => { delete ENGINES[NEW]; ENGINES[OLD] = E; try { return fn(); } finally { delete ENGINES[OLD]; ENGINES[NEW] = E; } };   // the old server
  const restamps = (W) => log(W).filter((e) => e.kind === "act" && e.actor === "system" && e.verb === "restamp-engine");
  const specOf = (W) => fold(log(W)).entities["@world"].c["physics-engine"];
  const E2rest = (e, L) => { const c = L[e.cause]; return !!c && c.kind === "sim" && c.verb === "launch"; };
  // R1 — stamped by the old server, nothing in flight: restamped at the first act after load, and physics runs
  const W = deployed(() => playground("pc-r1"));
  ok(specOf(W).engine === OLD, "R1 setup: the old server stamped its own build", specOf(W));
  call(W, "rowan", "look", {});
  const rs = restamps(W), L = log(W), ai = L.findIndex((e) => e.kind === "act" && e.verb === "restamp-engine"), ch = L.findIndex((e) => e.kind === "change" && e.cause === ai);
  ok(rs.length === 1 && specOf(W).engine === NEW && specOf(W).tickMs === 33,
    "R1 the authority restamped @world.physics-engine with the build it carries, same engine and tickMs", { rs, spec: specOf(W) });
  ok(ch > 0 && L[ch].actor === "system" && L[ch].body.id === "@world" && L[ch].body.comp === "physics-engine", "R1 …as a system change on @world.physics-engine", L[ch]);
  ok(rs[0]?.body?.why === `engine ${OLD} → ${NEW}: restamped by the server; bodies at rest`, "R1 …and the log keeps why", rs[0]?.body);
  call(W, "rowan", "look", {}); ok(restamps(W).length === 1, "R1 once: the next act writes nothing more", restamps(W).length);
  call(W, "rowan", "grab", { id: "ball" }); const d = call(W, "rowan", "drop", { id: "ball" });
  ok(d.ok, "R1 a drop is accepted (the world isn't foreign any more)", d); call(W, "rowan", "wait", {}, 3000);
  const r = rests(log(W)).filter((x) => x.id === "ball").at(-1);
  ok(r && Math.abs(r.at[1]) < ON && !view(W).checks.disagree.length, "R1 …and the dropped ball falls and rests on the ground, carriers agreeing", { r, checks: view(W).checks });
  // R1c — the next checkpoint carries the new build
  at(25000); settle(openWorld(root, W));
  const ck = log(W).filter((e) => e.kind === "sim" && e.verb === "checkpoint").at(-1);
  ok(ck?.body?.engine?.engine === NEW, "R1c the next checkpoint names the restamped build", ck?.body?.engine);
  // R2 — a body in flight when the deploy came (house answer, #260 10-21): this server can't compute that flight, so a cut
  // that waited for its rest would never come. The cut ends it, leaving it where the fold has it: the cut's change, not a rest
  const W2 = deployed(() => { const n = playground("pc-r2"); call(n, "rowan", "grab", { id: "ball" }); call(n, "rowan", "throw", { id: "ball", v: [0, 6, 0] }); return n; });
  const before2 = JSON.stringify(fold(log(W2)).entities.ball.c.transform);
  call(W2, "rowan", "look", {});
  const r2 = restamps(W2);
  ok(r2.length === 1 && specOf(W2).engine === NEW && JSON.stringify(r2[0]?.body?.ended) === '["ball"]', "R2 a launch with no rest on the record: the cut doesn't wait; it's restamped, and the act names the flight it ended", { r2: r2.map((e) => e.body), spec: specOf(W2) });
  ok(JSON.stringify(fold(log(W2)).entities.ball.c.transform) === before2 && !log(W2).some((e) => e.kind === "change" && E2rest(e, log(W2))), "R2 …the ball stays where the fold had it, and no rest is written for it", { before2, after: fold(log(W2)).entities.ball.c.transform });
  call(W2, "rowan", "move", { to: [2, 0, -0.5] }); call(W2, "rowan", "grab", { id: "crate-1" });
  const t2 = call(W2, "rowan", "throw", { id: "crate-1", v: [0, 1, 1] });
  ok(t2.ok, "R2 …and the world flies again under the version this server carries", t2.refused);
  // R2e — a launch whose body was purged (readback null): its body is unknown, so the cut can't name it; it counts it, and goes ahead
  const W2e = deployed(() => { const n = playground("pc-r2e"); call(n, "rowan", "grab", { id: "ball" }); call(n, "rowan", "throw", { id: "ball", v: [0, 6, 0] }); return n; });
  { const w = openWorld(root, W2e); const ls = w.entries.findLastIndex((e) => e.kind === "sim" && e.verb === "launch"); at(100);
    w.append({ kind: "purge", actor: "system", verb: "purge", body: { values: [{ seq: ls }] } }); }
  call(W2e, "rowan", "look", {});
  const r2e = restamps(W2e);
  ok(r2e.length === 1 && specOf(W2e).engine === NEW && r2e[0]?.body?.endedUnknown === 1 && !r2e[0]?.body?.ended, "R2e a purged launch doesn't hold the cut back: counted as ended, unnamed", r2e.map((e) => e.body));
  // R2b — something held (lifted out of the engine, not put back): no restamp either
  const W2b = deployed(() => { const n = playground("pc-r2b"); call(n, "rowan", "grab", { id: "ball" }); return n; });
  call(W2b, "rowan", "look", {});
  ok(!restamps(W2b).length && specOf(W2b).engine === OLD, "R2b a thing held when the deploy came: no restamp", specOf(W2b));
  // R2c — the hold is gone from presence (a host that keeps it in memory restarted) but the log's lift was never put back:
  // a lift outlives an epoch (the sim layer keeps it across the cut), so it doesn't hold the cut back
  const W2c = deployed(() => { const n = playground("pc-r2c"); call(n, "rowan", "grab", { id: "ball" }); return n; });
  const pp = `${root}worlds/${W2c}.presence.json`; const pres = JSON.parse(fs.readFileSync(pp, "utf8")); const realHold = pres.holds.ball; pres.holds = {}; fs.writeFileSync(pp, JSON.stringify(pres));
  call(W2c, "rowan", "look", {});
  ok(restamps(W2c).length === 1 && specOf(W2c).engine === NEW, "R2c a lift on the record with nothing after it doesn't block the cut (it outlives the epoch)", specOf(W2c));
  // R2d — held in presence only (no lift on the record): no restamp while the hold lasts
  const W2d = deployed(() => playground("pc-r2d"));
  const pd = `${root}worlds/${W2d}.presence.json`; const pr2 = fs.existsSync(pd) ? JSON.parse(fs.readFileSync(pd, "utf8")) : { bodies: {}, holds: {} };
  (pr2.holds ??= {}).ball = realHold; fs.writeFileSync(pd, JSON.stringify(pr2));
  call(W2d, "rowan", "look", {});
  ok(!restamps(W2d).length && specOf(W2d).engine === OLD, "R2d a hold in presence: no restamp", specOf(W2d));
  // R3 — an engine this server doesn't carry at all: no restamp
  ENGINES["oldsim@0.9.0"] = { ...E };
  let W3; try { W3 = fresh("pc-r3"); call(W3, "rowan", "create-world", { title: W3 }); call(W3, "rowan", "set", { id: "@world", component: "physics-engine", value: { engine: "oldsim@0.9.0" } }); }
  finally { delete ENGINES["oldsim@0.9.0"]; }
  call(W3, "rowan", "look", {});
  ok(specOf(W3).engine === "oldsim@0.9.0" && !restamps(W3).length, "R3 an engine this server doesn't carry: no restamp", specOf(W3));
  // R4 — the version this server carries: nothing written
  const W4 = playground("pc-r4"); const n4 = log(W4).length; call(W4, "rowan", "look", {});
  ok(!restamps(W4).length && log(W4).length === n4, "R4 a world on the carried version: no entry written", log(W4).length - n4);
  // R5 — a version the OWNER named (pc-k's choice, kept): never overridden by the server
  const W5 = fresh("pc-r5"); call(W5, "rowan", "create-world", { title: W5 });
  call(W5, "rowan", "set", { id: "@world", component: "physics-engine", value: { engine: OLD } }); call(W5, "rowan", "look", {});
  ok(!restamps(W5).length && specOf(W5).engine === OLD, "R5 an owner-named version is the owner's: no restamp", specOf(W5));
  // R6 — a fork of a physics world (review r2 F4): the copy's fork-copy act carries the source's stamped spec, build and all.
  // That's inherited, not chosen, so after a deploy the fork is restamped like its source (forkWorld writes exactly this act)
  const W6 = fresh("pc-r6"); call(W6, "rowan", "create-world", { title: W6 }); at(100);
  const fc = forkCopy(openWorld(root, W6), "rowan", { ops: [{ verb: "set", args: { id: "@world", component: "physics-engine", value: { engine: OLD, tickMs: 33 } } }], throughLock: true });
  ok(fc.ok && specOf(W6).engine === OLD && log(W6).some((e) => e.kind === "act" && e.verb === "fork-copy"), "R6 setup: a fork-copy carried the old server's stamped build", [fc.refused, specOf(W6)]);
  call(W6, "rowan", "look", {});
  ok(restamps(W6).length === 1 && specOf(W6).engine === NEW, "R6 a forked physics world is restamped at its first act (an inherited build isn't the owner's choice)", specOf(W6));
  // R7 — the owner names a build, then changes only tickMs by merge (review r2 F7): the build is still the one they named
  const W7 = fresh("pc-r7"); call(W7, "rowan", "create-world", { title: W7 });
  call(W7, "rowan", "set", { id: "@world", component: "physics-engine", value: { engine: OLD } });
  const m7 = call(W7, "rowan", "set", { id: "@world", component: "physics-engine", value: { tickMs: 20 }, merge: true });
  call(W7, "rowan", "look", {});
  ok(m7.ok && specOf(W7).tickMs === 20 && !restamps(W7).length && specOf(W7).engine === OLD, "R7 an owner-named build survives a later merge of tickMs: no restamp", [m7.refused, specOf(W7)]);
  // R7b — …but a stamped build stays stamped through a merge: the old server stamped it, the owner merged tickMs, a deploy restamps
  const W7b = deployed(() => { const n = fresh("pc-r7b"); call(n, "rowan", "create-world", { title: n });
    call(n, "rowan", "set", { id: "@world", component: "physics-engine", value: { engine: "eidosim" } });
    call(n, "rowan", "set", { id: "@world", component: "physics-engine", value: { tickMs: 20 }, merge: true }); return n; });
  call(W7b, "rowan", "look", {});
  ok(restamps(W7b).length === 1 && specOf(W7b).engine === NEW && specOf(W7b).tickMs === 20, "R7b a stamped build merged over (tickMs) is still stamped: restamped, tickMs kept", specOf(W7b));
  // R7c — an older named build doesn't outlive a later stamp: the owner named one, then re-set the engine without a build
  // (the old server stamped its own), a deploy restamps (the walk stops at the change that brought the stamped build in)
  const W7c = deployed(() => { const n = fresh("pc-r7c"); call(n, "rowan", "create-world", { title: n });
    call(n, "rowan", "set", { id: "@world", component: "physics-engine", value: { engine: OLD } });
    call(n, "rowan", "set", { id: "@world", component: "physics-engine", value: { engine: "eidosim" } }); return n; });
  call(W7c, "rowan", "look", {});
  ok(restamps(W7c).length === 1 && specOf(W7c).engine === NEW, "R7c a build named before a later stamped set doesn't count: restamped", specOf(W7c));
}

// review of #260: an engine name that is an inherited property of the engine table
// (toString) is no engine this server carries, so it's refused, never written with build null
{ const W = fresh("unknown-inherited-engine"); call(W, "rowan", "create-world", { title: W });
  const r = call(W, "rowan", "set", { id: "@world", component: "physics-engine", value: { engine: "toString" } });
  ok(!r.ok && r.refused?.code === "unknown-engine" && !fold(log(W)).entities["@world"].c["physics-engine"], "U1 an inherited name of the engine table is refused as an unknown engine", r.refused ?? r); }

// review of #260: the hand's lift marker ends with every hold, physics on or off, and a delete re-reads what may be knocked
{ const W = playground("lift-off"); const g = call(W, "rowan", "grab", { id: "ball" });
  const off = call(W, "rowan", "delete", { id: "@world", component: "physics-engine" });
  const put = call(W, "rowan", "put", { id: "ball", pos: [0, 0, 0.5] });
  const on = call(W, "rowan", "set", { id: "@world", component: "physics-engine", value: ENG });
  const v = view(W);
  ok(g.ok && off.ok && put.ok && on.ok && !v.lifted.has("ball") && !!(v.sim?.bodies.ball || v.sim?.statics?.ball),
    "U2 a thing put down while physics is off is back in the engine's world when physics returns", { g: g.ok, off: off.ok ?? off.refused, put: put.ok ?? put.refused, on: on.ok, lifted: [...v.lifted], body: !!v.sim?.bodies.ball, st: !!v.sim?.statics?.ball }); }
{ const W = playground("lift-under"); call(W, "rowan", "create", { id: "tray", model: "crate", place: { at: [0, 0] } });
  const par = call(W, "rowan", "set", { id: "ball", component: "parent", value: { to: "tray" } });
  const g = call(W, "rowan", "grab", { id: "ball" });
  const d1 = call(W, "rowan", "set", { id: "tray", component: "disabled", value: true }), d0 = call(W, "rowan", "set", { id: "tray", component: "disabled", value: false });
  const v = view(W);
  ok(par.ok && g.ok && d1.ok && d0.ok && !v.lifted.has("ball") && !!(v.sim?.bodies.ball || v.sim?.statics?.ball),
    "U3 switching off what a held thing hangs under ends its hold in the engine too: switched back on, the thing is there", { par: par.ok ?? par.refused, g: g.ok ?? g.refused, d1: d1.ok, d0: d0.ok, lifted: [...v.lifted], body: !!v.sim?.bodies.ball, st: !!v.sim?.statics?.ball }); }
{ const W = playground("lock-gone"); call(W, "rowan", "create", { id: "pin", model: "ball", place: { at: [2, 1] } });
  const par = call(W, "rowan", "set", { id: "pin", component: "parent", value: { to: "crate-1" } }), lk = call(W, "rowan", "set", { id: "pin", component: "lock", value: true });
  const before = view(W).sim?.statics?.["crate-1"]?.dyn;
  const del = call(W, "rowan", "delete", { id: "pin", throughLock: true });
  const after = view(W).sim?.statics?.["crate-1"]?.dyn;
  ok(par.ok && lk.ok && del.ok && !before && after === true, "U4 deleting the locked thing on a dynamic one makes that one knockable again", { par: par.ok ?? par.refused, lk: lk.ok ?? lk.refused, del: del.ok || del.refused, before, after }); }

// review of #260: a thing already in a hand when physics starts stays in the hand, out of the engine's world, on replay too
{ const W = fresh("held-at-start"); call(W, "rowan", "create-world", { title: W });
  call(W, "rowan", "create", { id: "ball", model: "ball", components: { physics: { kind: "dynamic", who: "inhabitant" } }, place: { at: [0, 0] } });
  call(W, "rowan", "move", { to: [0, 0, -0.5] }); const g = call(W, "rowan", "grab", { id: "ball" });
  const on = call(W, "rowan", "set", { id: "@world", component: "physics-engine", value: ENG });
  const v = view(W);
  ok(g.ok && on.ok && v.lifted.has("ball") && !v.sim?.bodies.ball && !v.sim?.statics?.ball,
    "U5 a thing held when physics starts is out of the engine's world (logged as lifted), not seated where it was picked up", { g: g.ok, on: on.ok, lifted: [...v.lifted], body: !!v.sim?.bodies.ball, st: !!v.sim?.statics?.ball });
  const put = call(W, "rowan", "put", { id: "ball", pos: [0, 0, 0.5] }); const v2 = view(W);
  ok(put.ok && !v2.lifted.has("ball") && !!(v2.sim?.bodies.ball || v2.sim?.statics?.ball), "U5 …and put down, it's back in the engine's world", { put: put.ok, lifted: [...v2.lifted] }); }
{ const W = fresh("held-by-other"); call(W, "rowan", "create-world", { title: W });
  call(W, "rowan", "create", { id: "ball", model: "ball", components: { physics: { kind: "dynamic", who: "inhabitant" } }, place: { at: [0, 0] } });
  call(W, "sam", "move", { to: [0, 0, -0.5] }); const g = call(W, "sam", "grab", { id: "ball" });
  const on = call(W, "rowan", "set", { id: "@world", component: "physics-engine", value: ENG });
  const lift = log(W).find((e: any) => e?.kind === "sim" && e.verb === "lift" && e.body?.id === "ball");
  ok(g.ok && on.ok && lift?.actor === "sam", "U5b the lift an engine's start logs names the holder, not whoever started the engine", { g: g.ok ?? g.refused, on: on.ok, actor: lift?.actor }); }
{ const W = playground("held-released-at-epoch");
  call(W, "rowan", "grab", { id: "ball" }); const held = view(W).lifted.has("ball");
  const b = call(W, "rowan", "batch", { ops: [{ verb: "set", args: { id: "@world", component: "physics-engine", value: { ...ENG, tickMs: 16 } } },
    { verb: "set", args: { id: "ball", component: "transform", value: { pos: [1, 0, 1], q: [0, 0, 0, 1], scale: [1, 1, 1] } } }] });
  const v = view(W); const w = openWorld(root, W);
  ok(held && b.ok && !!w.presence.holds && !w.presence.holds.ball && !v.lifted.has("ball") && !!v.sim && !!(v.sim.bodies.ball || v.sim.statics?.ball),
    "U5d a write that changes the engine's epoch and moves a held thing lets go of it in the engine too, as the authority's hold does", { held, b: b.ok ?? b.refused, hold: !!w.presence.holds?.ball, lifted: [...v.lifted], body: !!v.sim?.bodies.ball, st: !!v.sim?.statics?.ball }); }
{ const W = fresh("held-at-batch-start"); call(W, "rowan", "create-world", { title: W });
  call(W, "rowan", "create", { id: "ball", model: "ball", components: { physics: { kind: "dynamic", who: "inhabitant" } }, place: { at: [0, 0] } });
  call(W, "sam", "move", { to: [0, 0, -0.5] }); const g = call(W, "sam", "grab", { id: "ball" });
  // two engine sets in one batch, by someone who isn't holding it: one lift, naming the holder
  const on = call(W, "rowan", "batch", { ops: [{ verb: "set", args: { id: "@world", component: "physics-engine", value: { ...ENG, tickMs: 16 } } }, { verb: "set", args: { id: "@world", component: "physics-engine", value: ENG } }] });
  const lifts = log(W).filter((e: any) => e?.kind === "sim" && e.verb === "lift" && e.body?.id === "ball"); const v = view(W);
  ok(g.ok && on.ok && lifts.length === 1 && lifts[0].actor === "sam" && v.lifted.has("ball") && !!v.sim && !!v.sim.statics && !v.sim.bodies.ball && !v.sim.statics.ball,
    "U5c an engine started inside a batch, twice over, logs one lift for a thing in a hand, naming its holder, so the thing stays out of the engine's world", { g: g.ok, on: on.ok ?? on.refused, lifts: lifts.map((e: any) => e.actor), lifted: [...v.lifted], sim: !!v.sim, body: !!v.sim?.bodies.ball, st: !!v.sim?.statics?.ball }); }
// U5e: a dry run of that start says what it would lift, and logs nothing
{ const W = fresh("held-dry"); call(W, "rowan", "create-world", { title: W });
  call(W, "rowan", "create", { id: "ball", model: "ball", components: { physics: { kind: "dynamic", who: "inhabitant" } }, place: { at: [0, 0] } });
  call(W, "sam", "move", { to: [0, 0, -0.5] }); const g = call(W, "sam", "grab", { id: "ball" }); const n = log(W).length;
  const on = call(W, "rowan", "set", { id: "@world", component: "physics-engine", value: ENG, dry: true });
  ok(g.ok && on.ok && on.dry && JSON.stringify(on.lifts) === '["ball"]' && log(W).length === n, "U5e a dry run of an engine's start names what it would lift out of a hand, and logs nothing", { g: g.ok ?? g.refused, on, logged: log(W).length - n }); }
// U5f: a batch that starts the engine and moves a held thing takes it out of the hand, so it logs no lift for it: the thing
// is seated in the new engine's world where the edit put it. Its dry run says the same: the release, and no lift
{ const W = fresh("held-moved-at-start"); call(W, "rowan", "create-world", { title: W });
  call(W, "rowan", "create", { id: "ball", model: "ball", components: { physics: { kind: "dynamic", who: "inhabitant" } }, place: { at: [0, 0] } });
  call(W, "sam", "move", { to: [0, 0, -0.5] }); const g = call(W, "sam", "grab", { id: "ball" });
  const ops = [{ verb: "set", args: { id: "@world", component: "physics-engine", value: ENG } },
    { verb: "set", args: { id: "ball", component: "transform", value: { pos: [1, 0, 1], q: [0, 0, 0, 1], scale: [1, 1, 1] } } }];
  const dry = call(W, "rowan", "batch", { ops, dry: true }); const n = log(W).length;
  const b = call(W, "rowan", "batch", { ops });
  const lift = log(W).slice(n).find((e: any) => e?.kind === "sim" && e.verb === "lift" && e.body?.id === "ball"); const v = view(W); const w = openWorld(root, W);
  ok(g.ok && b.ok && !lift && !w.presence.holds?.ball && !v.lifted.has("ball") && !!(v.sim?.bodies.ball || v.sim?.statics?.ball),
    "U5f a batch that starts the engine and moves a held thing logs no lift for it: it leaves the hand and is in the engine's world where the edit put it", { g: g.ok ?? g.refused, b: b.ok ?? b.refused, lift: !!lift, hold: !!w.presence.holds?.ball, lifted: [...v.lifted], body: !!v.sim?.bodies.ball, st: !!v.sim?.statics?.ball });
  ok(dry.ok && dry.dry && !dry.lifts && (dry.notes ?? []).filter((x: any) => x.id === "ball" && x.tookFromHand === "sam").length === 1,
    "U5f …and its dry run says the thing leaves the hand, and names no lift for it", { lifts: dry.lifts, notes: dry.notes }); }
// U5g: with two things in hand, a batch that starts the engine and moves one lifts the other alone (dry and live)
{ const W = fresh("held-two-at-start"); call(W, "rowan", "create-world", { title: W });
  for (const [id, x] of [["ball", 0], ["cup", 0.4]] as const) call(W, "rowan", "create", { id, model: "ball", components: { physics: { kind: "dynamic", who: "inhabitant" } }, place: { at: [x, 0] } });
  call(W, "sam", "move", { to: [0, 0, -0.5] }); const g = [call(W, "sam", "grab", { id: "ball" }), call(W, "sam", "grab", { id: "cup" })];
  const ops = [{ verb: "set", args: { id: "@world", component: "physics-engine", value: ENG } },
    { verb: "set", args: { id: "ball", component: "transform", value: { pos: [1, 0, 1], q: [0, 0, 0, 1], scale: [1, 1, 1] } } }];
  const dry = call(W, "rowan", "batch", { ops, dry: true }); const n = log(W).length;
  const b = call(W, "rowan", "batch", { ops });
  const lifts = log(W).slice(n).filter((e: any) => e?.kind === "sim" && e.verb === "lift").map((e: any) => `${e.body?.id}:${e.actor}`); const v = view(W);
  ok(g.every((x) => x.ok) && b.ok && JSON.stringify(lifts) === '["cup:sam"]' && JSON.stringify(dry.lifts) === '["cup"]' && v.lifted.has("cup") && !v.lifted.has("ball"),
    "U5g with two things in hand, a batch that starts the engine and moves one lifts the other alone, dry and live", { g: g.map((x) => x.ok ?? x.refused?.code), b: b.ok ?? b.refused, lifts, dryLifts: dry.lifts, lifted: [...v.lifted] }); }

// review of #260: the purges a replay applies are exactly the fold's (a purge line the fold refuses, here for a ts that steps
// back, purges nothing in either)
{ const W = playground("purge-bad-ts"); const t = openWorld(root, W).state().entities["crate-1"].c.transform;
  call(W, "rowan", "set", { id: "crate-1", component: "transform", value: { ...t, pos: [3, 0, 0] } });
  const L = log(W); const seq = L.findLastIndex((e: any) => e?.kind === "change" && e.verb === "set" && e.body?.id === "crate-1");
  const last = L[L.length - 1]; const bad = copyOf([...L, { ...last, kind: "purge", actor: "system", verb: "purge", body: { values: [{ seq }] }, ts: last.ts - 1, cause: undefined }]);
  const blind = fold(bad), v = simFold(bad, last.ts + 1000);
  ok(blind.entities["crate-1"].c.transform !== PURGED && !!v.sim?.statics?.["crate-1"], "U6 a purge line the fold refuses (its ts steps back) purges nothing on replay either", { foldPurged: blind.entities["crate-1"].c.transform === PURGED, collider: !!v.sim?.statics?.["crate-1"] }); }

// review of #260: a sim body a purge took whole is unknown to a replay, never a disagreement or a crash (the authority's
// readback reads it so too)
{ const W = playground("purge-sim");
  call(W, "rowan", "grab", { id: "ball" }); call(W, "rowan", "throw", { id: "ball", v: [0, 2, 3] }); call(W, "rowan", "wait", {}, 6000);
  const L = log(W); const last = L[L.length - 1];
  const dg = L.findLastIndex((e: any) => e?.kind === "sim" && e.verb === "digest"), ln = L.findLastIndex((e: any) => e?.kind === "sim" && e.verb === "launch");
  // as a purged log stands on disk: each body the purge took is its {commit} stub (§12)
  const stub = { commit: "0".repeat(64) };
  const P = copyOf([...L.map((e: any, i: number) => (i === dg || i === ln ? { ...e, body: stub } : e)), { world: last.world, kind: "purge", actor: "system", verb: "purge", body: { values: [{ seq: dg }, { seq: ln }] }, ts: last.ts + 100 }]);
  let v: any, rs: any, err = null; try { v = simFold(P, last.ts + 1000); rs = restsOf(P); } catch (x: any) { err = String(x?.message).slice(0, 120); }
  ok(dg > 0 && ln > 0 && fold(P).status === "ok" && !err && v.checks.disagree.length === 0, "U7 a purged digest and launch read as unknown on replay: no disagreement, no crash", { dg, ln, status: fold(P).status, err, disagree: v?.checks?.disagree?.slice(0, 2), rests: rs?.length }); }
{ const W = playground("purge-launch-only");
  call(W, "rowan", "grab", { id: "ball" }); call(W, "rowan", "throw", { id: "ball", v: [0, 2, 3] }); call(W, "rowan", "wait", {}, 6000);
  const L = log(W); const last = L[L.length - 1]; const ln = L.findLastIndex((e: any) => e?.kind === "sim" && e.verb === "launch");
  const P = copyOf([...L.map((e: any, i: number) => (i === ln ? { ...e, body: { commit: "0".repeat(64) } } : e)), { world: last.world, kind: "purge", actor: "system", verb: "purge", body: { values: [{ seq: ln }] }, ts: last.ts + 100 }]);
  const v = simFold(P, last.ts + 1000); const digests = P.filter((e: any) => e?.kind === "sim" && e.verb === "digest").length;
  ok(ln > 0 && digests > 0 && v.checks.disagree.length === 0, "U7b a purged launch makes the digests logged during its flight unknown, not disagreements", { ln, digests, disagree: v.checks.disagree.slice(0, 2) }); }

// review of #260: a rest whose transform a purge took is unknown to a replay: the folder reads it as the strict fold does
// (absent, purged), and it neither crashes nor is called a disagreement, and the log's other rests still read
{ const W = playground("purge-rest");
  call(W, "rowan", "grab", { id: "ball" }); call(W, "rowan", "throw", { id: "ball", v: [0, 2, 3] }); call(W, "rowan", "wait", {}, 6000);
  const L = log(W); const last = L[L.length - 1];
  const rest = L.findIndex((e: any) => e?.kind === "change" && typeof e.cause === "number" && L[e.cause]?.kind === "sim" && L[e.cause].verb === "launch");
  const { value: _v, salt: _s, ...skel } = L[rest]?.body ?? {};
  const P = copyOf([...L.map((e: any, i: number) => (i === rest ? { ...e, body: { ...skel, commit: "0".repeat(64) } } : e)), { world: last.world, kind: "purge", actor: "system", verb: "purge", body: { values: [{ seq: rest }] }, ts: last.ts + 100 }]);
  let v: any, rs: any, err = null; try { v = simFold(P, last.ts + 1000); rs = restsOf(P); } catch (x: any) { err = `${x?.code ?? ""} ${String(x?.message)}`.slice(0, 160); }
  ok(rest > 0 && L[rest].verb === "set" && fold(P).status === "ok" && !err && v.checks.disagree.length === 0 && digest(v.st) === digest(fold(P)) && v.st.entities.ball.c.transform === PURGED && rs?.some((r: any) => r.seq === rest),
    "U7c a purged rest (its launch kept) reads as unknown on replay: no crash, no disagreement, the replayed state the strict fold's (the rest's transform PURGED), and restsOf still lists it", { rest, verb: L[rest]?.verb, status: fold(P).status, err, disagree: v?.checks?.disagree?.slice(0, 2), same: v && digest(v.st) === digest(fold(P)), rests: rs?.length }); }
// review of #260: a purged launch leaves the rest of its epoch unknown to a replay: the flights after it, even once its own
// rest is logged, fly in an engine that skipped one body, so their digests and rests are applied, not judged
{ const W = playground("purge-launch-then-more");
  const fly = (id: string) => { const p = openWorld(root, W).state().entities[id].c.transform.pos; call(W, "rowan", "move", { to: [p[0], 0, p[2] - 0.5] });
    call(W, "rowan", "grab", { id }); call(W, "rowan", "throw", { id, v: [0.3, 2, 2] }); call(W, "rowan", "wait", {}, 6000); };
  for (const id of ["ball", "crate-1", "ball"]) fly(id);
  // then a cut (a new tickMs starts a new epoch), and a fourth flight in it
  call(W, "rowan", "set", { id: "@world", component: "physics-engine", value: { ...ENG, tickMs: 16 } }); const cut = log(W).length - 1; fly("crate-1");
  const L = log(W); const last = L[L.length - 1]; const launches = L.map((e: any, i: number) => (e?.kind === "sim" && e.verb === "launch" ? i : -1)).filter((i: number) => i >= 0);
  const base = simFold(L, last.ts + 1000); const ln = launches[0];
  const P = copyOf([...L.map((e: any, i: number) => (i === ln ? { ...e, body: { commit: "0".repeat(64) } } : e)), { world: last.world, kind: "purge", actor: "system", verb: "purge", body: { values: [{ seq: ln }] }, ts: last.ts + 100 }]);
  const v = simFold(P, last.ts + 1000); const after = L.filter((e: any, i: number) => i > cut && e?.kind === "sim" && e.verb === "digest").length;
  ok(launches.length === 4 && base.checks.disagree.length === 0 && base.checks.agree > 0 && v.checks.disagree.length === 0 && after > 0 && v.checks.agree === after && digest(v.st) === digest(fold(P)),
    "U7d a purged first launch, with two more flights after its rest: the replay calls none of that epoch's digests or rests a disagreement, judges the next epoch's again, and its state is the strict fold's", { launches, base: base.checks.disagree.length, agree: v.checks.agree, after, disagree: v.checks.disagree.slice(0, 3), same: digest(v.st) === digest(fold(P)) }); }
// review of #260: a rest whose transform a purge took leaves the rest of its epoch unknown too: the fold reads that body as
// gone, where the engine that wrote the log kept it, so a later flight's digests aren't judged against it
{ const W = playground("purge-rest-then-more");
  for (const id of ["ball", "crate-1"]) { const p = openWorld(root, W).state().entities[id].c.transform.pos; call(W, "rowan", "move", { to: [p[0], 0, p[2] - 0.5] });
    call(W, "rowan", "grab", { id }); call(W, "rowan", "throw", { id, v: [0.3, 2, 2] }); call(W, "rowan", "wait", {}, 6000); }
  const L = log(W); const last = L[L.length - 1];
  const rest = L.findIndex((e: any) => e?.kind === "change" && typeof e.cause === "number" && L[e.cause]?.kind === "sim" && L[e.cause].verb === "launch" && L[e.cause].body?.id === "ball");
  const { value: _v, salt: _s, ...skel } = L[rest]?.body ?? {};
  const P = copyOf([...L.map((e: any, i: number) => (i === rest ? { ...e, body: { ...skel, commit: "0".repeat(64) } } : e)), { world: last.world, kind: "purge", actor: "system", verb: "purge", body: { values: [{ seq: rest }] }, ts: last.ts + 100 }]);
  const base = simFold(L, last.ts + 1000), v = simFold(P, last.ts + 1000);
  ok(rest > 0 && L[rest].verb === "set" && base.checks.disagree.length === 0 && v.checks.disagree.length === 0 && digest(v.st) === digest(fold(P)),
    "U7e a purged rest, then another flight: the replay calls none of the later digests a disagreement, and its state is the strict fold's", { rest, base: base.checks.disagree.length, disagree: v.checks.disagree.slice(0, 3) }); }
// review of #260: a rest batch whose transform op a purge names by index replays as unknown, as the strict fold reads it
{ const W = fresh("purge-rest-op"); call(W, "rowan", "create-world", { title: W }); call(W, "rowan", "set", { id: "@world", component: "physics-engine", value: ENG });
  call(W, "rowan", "create", { id: "table-1", model: "table", place: { at: [0, 1] } });
  call(W, "rowan", "create", { id: "ball", model: "ball", components: { physics: { kind: "dynamic", who: "inhabitant" } }, place: { on: "table-1" } });
  call(W, "rowan", "move", { to: [0, 0, 0.3] }); call(W, "rowan", "grab", { id: "ball" }); call(W, "rowan", "throw", { id: "ball", v: [0.3, 2, -2] }); call(W, "rowan", "wait", {}, 6000);
  const L = log(W); const last = L[L.length - 1];
  const rest = L.findIndex((e: any) => e?.kind === "change" && e.verb === "batch" && typeof e.cause === "number" && L[e.cause]?.kind === "sim" && L[e.cause].verb === "launch");
  const k = rest >= 0 ? L[rest].body.ops.findIndex((o: any) => o.comp === "transform") : -1;
  const P = rest < 0 || k < 0 ? null : copyOf([...L.map((e: any, i: number) => { if (i !== rest) return e; const ops = e.body.ops.map((o: any, j: number) => { if (j !== k) return o; const { value: _v, salt: _s, ...rest2 } = o; return { ...rest2, commit: "0".repeat(64) }; }); return { ...e, body: { ...e.body, ops } }; }),
    { world: last.world, kind: "purge", actor: "system", verb: "purge", body: { values: [{ seq: rest, op: k }] }, ts: last.ts + 100 }]);
  let v: any = null, err = null; try { v = P && simFold(P, last.ts + 1000); } catch (x: any) { err = `${x?.code ?? ""} ${String(x?.message)}`.slice(0, 160); }
  ok(!!P && fold(P).status === "ok" && fold(P).entities.ball.c.transform === PURGED && !err && v.checks.disagree.length === 0 && digest(v.st) === digest(fold(P)),
    "U7f a rest batch whose transform op a purge names by index reads as unknown on replay: no crash, no disagreement, the strict fold's state", { rest, k, err, status: P && fold(P).status, disagree: v?.checks?.disagree?.slice(0, 2) }); }
// review of #260: a purged lift hides what is held past an epoch's cut: the next epoch's digests aren't judged either
{ const W = playground("purge-lift-across-cut");
  call(W, "rowan", "grab", { id: "ball" }); const L0 = log(W); const lift = L0.findLastIndex((e: any) => e?.kind === "sim" && (e.verb === "lift" || e.verb === "catch"));
  call(W, "rowan", "set", { id: "@world", component: "physics-engine", value: { ...ENG, tickMs: 16 } });
  const p = openWorld(root, W).state().entities["crate-1"].c.transform.pos; call(W, "rowan", "move", { to: [p[0], 0, p[2] - 0.5] }); call(W, "rowan", "grab", { id: "crate-1" });
  call(W, "rowan", "throw", { id: "crate-1", v: [0.3, 2, 2] }); call(W, "rowan", "wait", {}, 6000);
  const L = log(W); const last = L[L.length - 1];
  const P = copyOf([...L.map((e: any, i: number) => (i === lift ? { ...e, body: { commit: "0".repeat(64) } } : e)), { world: last.world, kind: "purge", actor: "system", verb: "purge", body: { values: [{ seq: lift }] }, ts: last.ts + 100 }]);
  const base = simFold(L, last.ts + 1000), v = simFold(P, last.ts + 1000);
  ok(lift > 0 && base.checks.disagree.length === 0 && base.checks.agree > 0 && v.checks.disagree.length === 0 && v.checks.agree === 0,
    "U7g a purged lift, then a cut while the thing is held and a flight in the new epoch: the replay judges none of its digests, since which thing is held is unknown", { lift, base: base.checks.disagree.length, agree: v.checks.agree, disagree: v.checks.disagree.slice(0, 3) }); }
// review of #260: a cut leaves the epoch unknown while a body the fold reads as gone to a purge still stands: the new
// epoch's engine lacks it too, where the engine that wrote the log had it
{ const W = playground("purge-rest-across-cut");
  call(W, "rowan", "grab", { id: "ball" }); call(W, "rowan", "throw", { id: "ball", v: [0.3, 2, 2] }); call(W, "rowan", "wait", {}, 6000);
  call(W, "rowan", "set", { id: "@world", component: "physics-engine", value: { ...ENG, tickMs: 16 } }); const cut = log(W).length - 1;
  const p = openWorld(root, W).state().entities["crate-1"].c.transform.pos; call(W, "rowan", "move", { to: [p[0], 0, p[2] - 0.5] });
  call(W, "rowan", "grab", { id: "crate-1" }); call(W, "rowan", "throw", { id: "crate-1", v: [0.3, 2, 2] }); call(W, "rowan", "wait", {}, 6000);
  const L = log(W); const last = L[L.length - 1];
  const rest = L.findIndex((e: any) => e?.kind === "change" && typeof e.cause === "number" && L[e.cause]?.kind === "sim" && L[e.cause].verb === "launch" && L[e.cause].body?.id === "ball");
  const { value: _v, salt: _s, ...skel } = L[rest]?.body ?? {};
  const P = copyOf([...L.map((e: any, i: number) => (i === rest ? { ...e, body: { ...skel, commit: "0".repeat(64) } } : e)), { world: last.world, kind: "purge", actor: "system", verb: "purge", body: { values: [{ seq: rest }] }, ts: last.ts + 100 }]);
  const base = simFold(L, last.ts + 1000), v = simFold(P, last.ts + 1000); const after = L.filter((e: any, i: number) => i > cut && e?.kind === "sim" && e.verb === "digest").length;
  ok(rest > 0 && rest < cut && after > 0 && base.checks.disagree.length === 0 && base.checks.agree > 0 && v.checks.disagree.length === 0,
    "U7h a purged rest, then a cut while that body still reads as purged, then a flight: the new epoch's digests aren't judged either", { rest, cut, after, base: base.checks.disagree.length, disagree: v.checks.disagree.slice(0, 3) }); }
// …and once the thing is written again, the next cut is known: a wrong digest in the new epoch is reported
{ const W = playground("purge-rest-replaced-cut");
  call(W, "rowan", "grab", { id: "ball" }); call(W, "rowan", "throw", { id: "ball", v: [0.3, 2, 2] }); call(W, "rowan", "wait", {}, 6000);
  call(W, "rowan", "set", { id: "ball", component: "transform", value: { pos: [1, 0, 1], q: [0, 0, 0, 1], scale: [1, 1, 1] } });
  call(W, "rowan", "set", { id: "@world", component: "physics-engine", value: { ...ENG, tickMs: 16 } }); const cut = log(W).length - 1;
  const p = openWorld(root, W).state().entities["crate-1"].c.transform.pos; call(W, "rowan", "move", { to: [p[0], 0, p[2] - 0.5] });
  call(W, "rowan", "grab", { id: "crate-1" }); call(W, "rowan", "throw", { id: "crate-1", v: [0.3, 2, 2] }); call(W, "rowan", "wait", {}, 6000);
  const L = log(W); const last = L[L.length - 1];
  const rest = L.findIndex((e: any) => e?.kind === "change" && typeof e.cause === "number" && L[e.cause]?.kind === "sim" && L[e.cause].verb === "launch" && L[e.cause].body?.id === "ball");
  const dg = L.findLastIndex((e: any) => e?.kind === "sim" && e.verb === "digest");
  const { value: _v, salt: _s, ...skel } = L[rest]?.body ?? {};
  const purge = (M: any[]) => copyOf([...M.map((e: any, i: number) => (i === rest ? { ...e, body: { ...skel, commit: "0".repeat(64) } } : e)), { world: last.world, kind: "purge", actor: "system", verb: "purge", body: { values: [{ seq: rest }] }, ts: last.ts + 100 }]);
  const P = purge(L), Q = purge(L.map((e: any, i: number) => (i === dg ? { ...e, body: { ...e.body, digest: "0".repeat(16) } } : e)));
  const base = simFold(L, last.ts + 1000), v = simFold(P, last.ts + 1000), vq = simFold(Q, last.ts + 1000);
  ok(rest > 0 && dg > cut && base.checks.disagree.length === 0 && v.checks.disagree.length === 0 && v.checks.agree > 0 && vq.checks.disagree.some((d: any) => d.seq === dg),
    "U7i a purged rest, the thing written again, then a cut: the new epoch is judged again, and a wrong digest in it is reported", { rest, cut, dg, base: base.checks.disagree.length, agree: v.checks.agree, disagree: v.checks.disagree.slice(0, 2), q: vq.checks.disagree.slice(0, 2) }); }
// review of #260: a purged catch hides what is held, as a purged lift does: nothing after it is judged, across a cut too
{ const W = playground("purge-catch-across-cut");
  call(W, "rowan", "grab", { id: "ball" }); call(W, "rowan", "throw", { id: "ball", v: [0, 5, 0.3] });
  const p = call(W, "rowan", "look", {}, 250).things.find((x: any) => x.id === "ball").moving.pos;
  call(W, "jo", "move", { to: [p[0], 0, p[2]] }, 1); const c = call(W, "jo", "grab", { id: "ball" }, 1);
  const L0 = log(W); const ct = L0.findLastIndex((e: any) => e?.kind === "sim" && e.verb === "catch");
  call(W, "rowan", "set", { id: "@world", component: "physics-engine", value: { ...ENG, tickMs: 16 } }); const cut = log(W).length - 1;
  const q = openWorld(root, W).state().entities["crate-1"].c.transform.pos; call(W, "rowan", "move", { to: [q[0], 0, q[2] - 0.5] });
  call(W, "rowan", "grab", { id: "crate-1" }); call(W, "rowan", "throw", { id: "crate-1", v: [0.3, 2, 2] }); call(W, "rowan", "wait", {}, 6000);
  const L = log(W); const last = L[L.length - 1]; const after = L.filter((e: any, i: number) => i > cut && e?.kind === "sim" && e.verb === "digest").length;
  const P = copyOf([...L.map((e: any, i: number) => (i === ct ? { ...e, body: { commit: "0".repeat(64) } } : e)), { world: last.world, kind: "purge", actor: "system", verb: "purge", body: { values: [{ seq: ct }] }, ts: last.ts + 100 }]);
  const base = simFold(L, last.ts + 1000), v = simFold(P, last.ts + 1000);
  const judgedAfter = (sf: any) => sf.checks.agree - simFold(copyOf(L.slice(0, ct)), L[ct - 1].ts).checks.agree;
  ok(c.ok && ct > 0 && after > 0 && base.checks.disagree.length === 0 && judgedAfter(base) > 0 && v.checks.disagree.length === 0 && judgedAfter(v) === 0,
    "U7j a purged catch, then a cut while the thing is held and a flight in the new epoch: nothing after the catch is judged", { c: c.ok, ct, after, base: base.checks.disagree.length, judged: judgedAfter(base), v: judgedAfter(v), disagree: v.checks.disagree.slice(0, 3) }); }
// review of #260: while the world is unknown, a write that touches a body in flight isn't judged either (L6); known, it is
{ const W = playground("purge-launch-inflight");
  const p = openWorld(root, W).state().entities["crate-1"].c.transform.pos; call(W, "rowan", "move", { to: [p[0], 0, p[2] - 0.5] });
  call(W, "rowan", "grab", { id: "crate-1" }); call(W, "rowan", "throw", { id: "crate-1", v: [0.3, 2, 2] }); call(W, "rowan", "wait", {}, 6000);
  call(W, "rowan", "move", { to: [0, 0, -0.5] }); call(W, "rowan", "grab", { id: "ball" }); call(W, "rowan", "throw", { id: "ball", v: [0, 2, 3] }); call(W, "rowan", "wait", {}, 6000);
  const L = log(W); const launches = L.map((e: any, i: number) => (e?.kind === "sim" && e.verb === "launch" ? i : -1)).filter((i: number) => i >= 0);
  const [lc, lb] = launches; const last = L[L.length - 1];
  const forged = insertAt(L, lb + 1, { world: L[1].world, kind: "change", ts: L[lb].ts + 200, actor: "rowan", cause: L[lb].cause, verb: "set", body: { id: "ball", comp: "label", value: "mid-air" } });
  const P = copyOf([...forged.map((e: any, i: number) => (i === lc ? { ...e, body: { commit: "0".repeat(64) } } : e)), { world: last.world, kind: "purge", actor: "system", verb: "purge", body: { values: [{ seq: lc }] }, ts: last.ts + 100 }]);
  const known = simFold(forged, last.ts + 1000), v = simFold(P, last.ts + 1000);
  ok(launches.length === 2 && lc < lb && known.checks.disagree.some((d: any) => /in flight/.test(d.why ?? "")) && v.checks.disagree.length === 0,
    "U7k a write touching a body in flight is reported in a known world, and isn't judged after a purged launch in its epoch", { launches, known: known.checks.disagree.slice(0, 2), disagree: v.checks.disagree.slice(0, 2) }); }
// review of #260: a folder resumed from a cut (a checkpoint, a joiner) judges what an uninterrupted one does: the cut
// carries what the replay can't judge from there
{ const W = playground("purge-lift-resumed");
  call(W, "rowan", "grab", { id: "ball" }); const L0 = log(W); const lift = L0.findLastIndex((e: any) => e?.kind === "sim" && (e.verb === "lift" || e.verb === "catch"));
  call(W, "rowan", "say", { text: "a quiet moment" }); const k = log(W).length - 1;
  call(W, "rowan", "set", { id: "@world", component: "physics-engine", value: { ...ENG, tickMs: 16 } });
  const p = openWorld(root, W).state().entities["crate-1"].c.transform.pos; call(W, "rowan", "move", { to: [p[0], 0, p[2] - 0.5] }); call(W, "rowan", "grab", { id: "crate-1" });
  call(W, "rowan", "throw", { id: "crate-1", v: [0.3, 2, 2] }); call(W, "rowan", "wait", {}, 6000);
  const L = log(W); const last = L[L.length - 1];
  const P = copyOf([...L.map((e: any, i: number) => (i === lift ? { ...e, body: { commit: "0".repeat(64) } } : e)), { world: last.world, kind: "purge", actor: "system", verb: "purge", body: { values: [{ seq: lift }] }, ts: last.ts + 100 }]);
  const purged = purgesIn(P), bad = new Set(fold(P).diagnostics.filter(([, c]: any) => String(c).startsWith("malformed")).map(([q]: any) => q));
  const f1 = simFolder(P, { purged }); for (let s = 0; s <= k; s++) if (!bad.has(s)) f1.feed(s);
  const cut = simCutOf(f1.view(P[k].ts), P);
  const f2 = simFolder(P, { purged, from: { ...JSON.parse(JSON.stringify(cut)), st: fold(P, { until: k }) } }); for (let s = k + 1; s < P.length; s++) if (!bad.has(s)) f2.feed(s);
  const whole = simFold(P, last.ts + 1000), v = f2.view(last.ts + 1000);
  ok(lift > 0 && lift < k && cut.unknownHold === true && v.checks.disagree.length === 0 && v.checks.agree === 0 && whole.checks.disagree.length === 0,
    "U7l a folder resumed from a cut taken after a purged lift judges nothing after it, as the uninterrupted replay doesn't", { lift, k, hold: cut.unknownHold, agree: v.checks.agree, disagree: v.checks.disagree.slice(0, 3), whole: whole.checks.disagree.length }); }
// review of #260: a turned table supports things over its own top, not over the box of its corners
{ const W = playground("turned-table"); const t = openWorld(root, W).state().entities["table-1"].c.transform;   // 1.2 × 0.8 m, at (0, 4)
  const turn = call(W, "rowan", "set", { id: "table-1", component: "transform", value: { ...t, q: yawQ(Math.PI / 4) } });
  const st = openWorld(root, W).state(); const top = 0.75;
  const u3 = qrot(st.entities["table-1"].c.transform.q, [1, 0, 0]), u = [u3[0], u3[2]], v = [-u[1], u[0]];   // the top's own axes on the ground
  const inTop = (x: number, z: number, m = 0) => { const d = [x, z - 4]; return Math.abs(d[0] * u[0] + d[1] * u[1]) <= 0.6 - m + 1e-6 && Math.abs(d[0] * v[0] + d[1] * v[1]) <= 0.4 - m + 1e-6; };
  // (0.65, 0): inside the box of its corners (half 0.707), off its top; 0.5 m along its long axis: on its top
  const corner = supportBelow(st, 0.65, 4, 2), along = supportBelow(st, 0.5 * u[0], 4 + 0.5 * u[1], 2);
  ok(turn.ok && !inTop(0.65, 4) && inTop(0.5 * u[0], 4 + 0.5 * u[1]) && corner.id === "ground" && along.id === "table-1" && Math.abs(along.y - top) < 1e-6,
    "U8 a table turned 45 degrees supports at a point over its top, not at a corner of its bounding box", { turn: turn.ok ?? turn.refused, corner, along });
  // asked to place the 0.6 m crate 0.35 m to the side (toward a corner of the box), it is put wholly on the top or refused
  const put = call(W, "rowan", "place", { id: "crate-1", on: "table-1", offset: [0.35, 0] }); const p = worldT(openWorld(root, W).state(), "crate-1").pos;
  const corners = [[-0.3, -0.3], [-0.3, 0.3], [0.3, -0.3], [0.3, 0.3]].map(([dx, dz]) => [p[0] + dx, p[2] + dz]);
  ok(!put.ok || corners.every(([x, z]) => inTop(x, z)), "U8 …and a place on it puts the crate wholly on its top", { put: put.ok ?? put.refused, p });
  const ms = call(W, "rowan", "measure", { id: "table-1" }); const top0 = ms.surfaces?.[0];
  ok(ms.ok && JSON.stringify(top0?.size) === "[1.2,0.8]" && Array.isArray(top0?.xAxis), "U8 …and measure gives that top's own size, 1.2 × 0.8 m, with its axis, not the box of its corners", top0); }

// review of #260: a body at rest whose rest isn't logged yet is read where the engine has it, and said to be so
{ const W = playground("rest-unlogged");
  call(W, "rowan", "grab", { id: "ball" }); call(W, "rowan", "throw", { id: "ball", v: [0, 2, 3] }); at(300);
  const w = openWorld(root, W); const real = w.sim;
  // as the engine stands while a launch's rests coalesce: this body has stopped, its rest not logged yet
  w.sim = () => { const sf = real(); const b = sf.sim?.bodies.ball; if (b) { b.resting = true; b.v = [0, 0, 0]; } return sf; };
  const eng = w.sim().sim?.bodies.ball?.p; const seen = request(w, "rowan", "look", {}).things?.find((x: any) => x.id === "ball");
  const rec = worldT(w.state(), "ball").pos;
  ok(!!eng && Math.hypot(eng[0] - rec[0], eng[2] - rec[2]) > 0.05 && seen && Math.hypot(seen.at[0] - eng[0], seen.at[2] - eng[2]) < 0.02 && !seen.moving && /not yet/.test(JSON.stringify(seen)),
    "U9 look reads a body at rest but not yet logged where the engine has it, says so, and doesn't call it moving", { eng, rec, seen }); }

// S9: a shape is the authority's measurement whichever physics set in a batch carries the asker's: the last one, which is
// the one the fold keeps, is stamped too
{ const W = playground("pc-s9"); const e = () => openWorld(root, W).state().entities["crate-1"]?.c.physics;
  const want = e()?.shape; const fake = [[-4, 0, -4], [4, 9, 4]];
  const r = call(W, "rowan", "batch", { ops: [{ verb: "set", args: { id: "crate-1", component: "physics", value: { kind: "dynamic", who: "builder" } } },
    { verb: "set", args: { id: "crate-1", component: "physics", value: { kind: "dynamic", who: "builder", shape: fake } } }] });
  ok(r?.ok && want && JSON.stringify(e()?.shape) === JSON.stringify(want), "S9 the second of two physics sets in one batch can't put the asker's shape in place of the measured one", { r: r?.ok ?? r, want, got: e()?.shape }); }

// review of #260: a stamped shape stays while the model can't be measured right now; a changed model still takes it away
{ const W = playground("shape-unmeasured");
  const w = openWorld(root, W); const before = w.state().entities["crate-1"]?.c.physics?.shape;
  const cat = w.catalogue; w.catalogue = { get: (n: string) => (n === "crate" ? undefined : cat?.get?.(n)), list: (q: string) => cat?.list?.(q) ?? [] };
  const m = request(w, "rowan", "set", { id: "crate-1", component: "physics", value: { who: "inhabitant" }, merge: true });   // the merge the review traced
  const keptM = w.state().entities["crate-1"]?.c.physics?.shape;
  const r = request(w, "rowan", "set", { id: "crate-1", component: "physics", value: { kind: "dynamic", who: "builder" } });   // a whole value, without shape
  const kept = w.state().entities["crate-1"]?.c.physics?.shape; w.catalogue = cat;
  ok(!!before && m.ok && r.ok && JSON.stringify(keptM) === JSON.stringify(before) && JSON.stringify(kept) === JSON.stringify(before) && !JSON.stringify([m.notes, r.notes]).includes("its body is gone"),
    "U10 a stamped shape stays while the catalogue can't measure the model right now (a merge or a whole value), and no 'body is gone' note", { before, keptM, kept, notes: [m.notes, r.notes] }); }

// review of #260: in one rest of several bodies, each body's follow-up is its own: a thrown crate that leaves the world
// is lost while the crate it knocked, at rest inside, isn't; and a lost thing sent to its home is told it's home
if (RIGID) { const W = playground("rr-group");
  call(W, "rowan", "set", { id: "@world", component: "bounds", value: { min: [-20, 0, -20], max: [20, 30, 3] } });
  call(W, "rowan", "set", { id: "crate-1", component: "home", value: { pos: [3, 0, -1], q: [0, 0, 0, 1] } });
  call(W, "rowan", "create", { id: "tgt", model: "crate", components: { physics: { kind: "dynamic", who: "inhabitant" } }, place: { at: [0, 2.2] } });
  call(W, "rowan", "move", { to: [2, 0, -0.5] }); call(W, "rowan", "grab", { id: "crate-1" }); call(W, "rowan", "move", { to: [0, 0, 0.4] });
  const t = call(W, "rowan", "throw", { id: "crate-1", v: [0, 1.5, 5] }); call(W, "rowan", "wait", {}, 20000); const r = call(W, "rowan", "wait", {});
  const R = rests(log(W)), rt = R.find((x) => x.id === "tgt"), rc = R.find((x) => x.id === "crate-1");
  const ct = r.cameToRest?.find((x: any) => x.id === "tgt"), cc = r.cameToRest?.find((x: any) => x.id === "crate-1");
  ok(t.ok && rt && rc && rt.seq === rc.seq && !rt.lost && rc.lost && ct && !ct.lost && ct.on === "ground",
    "RR1 two bodies in one rest, one lost past the world's edge: wait says only that one is lost, and the other rests where it is", { rests: R.map((x) => [x.seq, x.id, !!x.lost]), came: r.cameToRest });
  const at = call(W, "rowan", "inspect", { id: "crate-1" }).world?.pos;
  ok(/back at its home/.test(cc?.lost ?? "") && JSON.stringify(at) === "[3,0,-1]", "RR2 …and the lost one, sent to its home, is told it's at its home", { lost: cc?.lost, at }); }

console.log(`${passes} passed, ${fails} failed`);
fs.rmSync(root, { recursive: true, force: true });
process.exit(fails ? 1 : 0);
