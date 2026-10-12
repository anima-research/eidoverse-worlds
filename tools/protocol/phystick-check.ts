// tools/protocol/phystick-check.ts — the engine's heartbeat (DESIGN-physics-responsiveness §1; STRIKES PH-S1-2).
// Before: the sim advanced and rests were logged INSIDE whoever's request came next (503 ms for the first `wait` after a
// 40-crate knock, then 145–341 ms each), and rests never logged without a request. Now server.ts calls settle(w) on its
// own beat. usage: bun tools/protocol/phystick-check.ts   (NO_TICK=1 runs the old shape: every check below goes red)
//   T1  rests log with nobody asking: after the throw only settle() passes run; every launched body rests on the record
//   T2  a request during the cascade is cheap: max `wait` under the beat is a fraction of the request-path figure
//   T3  bounded passes: one pass advances at most maxTicks engine ticks, a stall catches up over later passes, and the
//       result is bit-identical to advancing straight (Covenant IV: advancement is schedule-independent)
// @ts-nocheck
import fs from "node:fs";
import { request, settle } from "../../shared/protocol/authority.js";
import { openLive } from "../../server/livehost.ts";
import { restsOf, digestOf, simFold, livePoses } from "../../shared/protocol/simlayer.js";
import { scratch } from "./common.ts";

const root = scratch("phystick"); let fails = 0, passes = 0;
const ok = (c, what, d) => { if (c) passes++; else { fails++; console.log("FAIL", what, d !== undefined ? JSON.stringify(d).slice(0, 300) : ""); } };
const NO_TICK = process.env.NO_TICK === "1";
const TICK = 33;
function world(name, N) {
  const dir = `${root}${name}`; fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true });
  let T = 1800000000000; const now = () => T;
  const w = openLive(dir, name, { now });
  const call = (actor, verb, args = {}, step = 100) => { T += step; return request(w, actor, verb, args); };
  call("rowan", "create-world", { title: name });
  call("rowan", "set", { id: "@world", component: "physics-engine", value: { engine: "eidosim@1.0.0", tickMs: TICK } });
  for (let i = 0; i < N; i++) call("rowan", "create", { id: `cr-${i}`, model: "crate", components: { physics: { kind: "dynamic", who: "visitor" } }, place: { at: [0, 3] } });
  call("rowan", "create", { id: "ball", model: "crate", components: { physics: { kind: "dynamic", who: "visitor" } }, place: { at: [0, 0] } });
  call("rowan", "move", { to: [0, 0, -0.5] }); call("rowan", "grab", { id: "ball" });
  const beat = (ms, maxTicks) => { T += ms; return NO_TICK ? 0 : settle(w, maxTicks ? { maxTicks } : {}); };
  return { w, call, beat, now };
}

// T1: throw, then only beats (no request at all) until the beat writes nothing for 2 s; every launched body has a rest
{
  const { w, call, beat } = world("t1", 12);
  ok(call("rowan", "throw", { id: "ball", v: [0, 1, 12] }).ok, "T1 throw");
  let wrote = 0; const flying = () => Object.values(w.simPeek().sim?.bodies ?? {}).some((b) => !b.resting);
  for (let k = 0; k < 1800; k++) { wrote += beat(TICK); if (k > 2 && !flying() && w.simPeek().rested.length === 0) break; }
  const R = restsOf(w.entries); const launched = Object.keys(w.sim().launched);
  ok(wrote > 0 && R.length > 0, "T1 rests were logged by the beat alone", { wrote, rests: R.length });
  ok(launched.every((id) => R.some((r) => r.id === id)), "T1 every launched body rests on the record", { launched, rested: R.map((r) => r.id) });
}

// T2: during a 40-crate cascade the beat runs between requests; a `wait` request must not carry the settling
{
  const { w, call, beat } = world("t2", 40);
  ok(call("rowan", "throw", { id: "ball", v: [0, 1, 12] }).ok, "T2 throw");
  const times = [];
  for (let s = 0; s < 40; s++) { for (let b = 0; b < 30; b++) beat(TICK); const a = performance.now(); const r = call("rowan", "wait", {}, 0); times.push(performance.now() - a); if (!Object.keys(r.inFlight ?? {}).length && s > 2) break; }
  const max = Math.max(...times);
  ok(max < 60, "T2 the slowest request under the beat is under 60 ms", { max: +max.toFixed(0), times: times.map((t) => +t.toFixed(0)) });
}

// T3: bounded passes. The same world advanced (a) straight to now and (b) by passes of maxTicks=3 after a 20-tick stall:
// the engine states agree bit for bit, and one bounded pass never moved more than 3 ticks.
{
  const A = world("t3a", 6), B = world("t3b", 6);
  A.call("rowan", "throw", { id: "ball", v: [0, 1, 12] }); B.call("rowan", "throw", { id: "ball", v: [0, 1, 12] });
  const stall = 20 * TICK;
  A.beat(stall, 1e6); const da = digestOf(A.w.simPeek().sim), ta = A.w.simPeek().sim.tick;
  const t0 = B.w.simPeek().sim.tick; B.beat(stall, 3); const t1 = B.w.simPeek().sim.tick;
  ok(!NO_TICK && t1 - t0 <= 3, "T3 one bounded pass advances at most maxTicks", { t0, t1 });
  for (let k = 0; k < 20; k++) B.beat(0, 3);
  const pb = B.w.simPeek(); ok(pb.sim.tick === ta && digestOf(pb.sim) === da, "T3 catching up by bounded passes is bit-identical to advancing straight", { ta, tb: pb.sim.tick, da, db: digestOf(pb.sim) });
}
// T4: log growth. One digest per settle pass and one change per launch per pass (STRIKES PH-S2-5: it was one of each per body,
// 42 digests for a 40-crate knock).
{
  const { w, call, beat } = world("t4", 40);
  const n0 = w.entries.length; ok(call("rowan", "throw", { id: "ball", v: [0, 1, 12] }).ok, "T4 throw");
  const flying = () => Object.values(w.simPeek().sim?.bodies ?? {}).some((b) => !b.resting);
  for (let k = 0; k < 1800; k++) { beat(TICK); if (k > 2 && !flying() && w.simPeek().rested.length === 0) break; }
  const L = w.entries.slice(n0); const digests = L.filter((e) => e.kind === "sim" && e.verb === "digest").length;
  const rested = restsOf(w.entries).length; const changes = L.filter((e) => e.kind === "change" && w.entries[e.cause]?.kind === "sim").length;
  console.log("T4 counts", JSON.stringify({ rested, digests, changes, entries: L.length }));
  ok(rested >= 30 && digests <= rested / 3 && changes <= rested / 3, "T4 a 40-crate knock logs far fewer digests and rest changes than bodies", { rested, digests, changes, entries: L.length });
}
// T5: a thing that leaves the world comes back to its HOME when it has one (else, as before, to where it was picked up)
{
  const { w, call, beat } = world("t5", 0);
  call("rowan", "set", { id: "@world", component: "bounds", value: { min: [-6, -1, -6], max: [6, 20, 6] } });
  call("rowan", "set", { id: "ball", component: "home", value: { pos: [0, 0, 2], q: [0, 0, 0, 1] } });
  call("rowan", "drop", { id: "ball" }); call("rowan", "move", { to: [4.6, 0, 0] }); call("rowan", "grab", { id: "ball" });
  ok(call("rowan", "throw", { id: "ball", v: [14, 2, 0] }).ok, "T5 throw it out of the world");
  const flying = () => Object.values(w.simPeek().sim?.bodies ?? {}).some((b) => !b.resting);
  for (let k = 0; k < 1800; k++) { beat(TICK); if (k > 2 && !flying() && w.simPeek().rested.length === 0) break; }
  const lost = w.entries.find((e) => e.kind === "act" && e.verb === "return-lost"); const at = w.state().entities.ball.c.transform.pos;
  ok(!!lost && lost.body.home === true && Math.hypot(at[0], at[1], at[2] - 2) < 1e-6, "T5 it rested outside and was sent home, not back to the hand", { lost: lost?.body, at });
}
// T6: a checkpoint. After a knock has rested and 20 s of quiet, the beat writes sim:checkpoint naming a blob with the cut;
// opening the same world again starts the sim from it (feeding only later entries), far faster, and lands on the same bits.
{
  const { w, call, beat, now } = world("t6", 30);
  ok(call("rowan", "throw", { id: "ball", v: [0, 1, 12] }).ok, "T6 throw");
  const flying = () => Object.values(w.simPeek().sim?.bodies ?? {}).some((b) => !b.resting);
  for (let k = 0; k < 1800; k++) { beat(TICK); if (k > 2 && !flying() && w.simPeek().rested.length === 0) break; }
  const n1 = w.entries.length; for (let k = 0; k < 40; k++) beat(1000);   // 40 s of quiet beats
  const ck = w.entries.slice(n1).filter((e) => e.kind === "sim" && e.verb === "checkpoint");
  ok(ck.length === 1 && ck[0].body.at === w.entries.indexOf(ck[0]) - 1 && typeof ck[0].body.state === "string", "T6 one checkpoint, right after the entry it names, with a blob", ck.map((e) => e.body));
  const fromGenesis = w.sim(); const dA = digestOf(fromGenesis.sim);   // both views at the same clock
  // w2 starts on the same clock as w (the comparison below), then r.tick moves its own
  const dir = `${root}t6`; let T2 = now(); const a0 = performance.now(); const w2 = openLive(dir, "t6", { now: () => T2 }); const openMs = performance.now() - a0;
  const again = w2.sim(); const dB = digestOf(again.sim);
  ok(w2.bootedFrom === w.entries.indexOf(ck[0]) && dA === dB && JSON.stringify(Object.keys(again.launched).sort()) === JSON.stringify(Object.keys(fromGenesis.launched).sort()),
    "T6 reopened from the checkpoint: the same sim digest and the same launched set", { bootedFrom: w2.bootedFrom, ckSeq: w.entries.indexOf(ck[0]), dA, dB });
  const b0 = performance.now(); const w3 = openLive(`${root}t6`, "t6", { now, simModels: {} }); const genesisMs = performance.now() - b0;   // same open path; reports the cost
  ok(openMs < 1500, `T6 opening from the checkpoint is quick (${openMs.toFixed(0)} ms; this world's history re-simulated takes longer)`, { openMs, genesisMs });
  // a throw after reopening still flies and rests from the checkpointed state
  w2.simPeek(); const r = { call: (v, args, s = 100) => { T2 += s; return request(w2, "rowan", v, args); }, tick: (ms) => { T2 += ms; } };
  { const bp = w2.state().entities.ball.c.transform.pos; r.call("move", { to: [bp[0], 0, bp[2] - 0.5] }); }   // bodies are presence: the reopened world has none until I move; the ball rested where the knock left it
  // an edit of a pre-checkpoint thing, then its flight: the reopened engine must agree with a from-genesis fold of the same
  // log, and the throw must really fly and rest (second review 10-11 S1-1: the cut carried no fold state; the first edit
  // removed the thing from the engine and a later throw was silently dropped — th.ok alone passed)
  r.call("set", { id: "cr-0", component: "transform", value: { pos: [3, 0, 3], q: [0, 0, 0, 1], scale: 1 } });
  // (the live host folds with no catalogue colliders, Covenant III: the from-genesis fold must too)
  { const a = digestOf(w2.sim().sim), b = digestOf(simFold(w2.entries, w2.now(), { models: {} }).sim); ok(a === b, "T6 after an edit the reopened engine equals a from-genesis fold of the same log", { a, b }); }
  { const g = r.call("grab", { id: "ball" }); const th = g.ok ? r.call("throw", { id: "ball", v: [0, 2, 3] }) : null;
    const flying = th?.ok && !!livePoses(w2.sim()).ball;
    let rested = false; for (let k = 0; k < 600 && !rested; k++) { r.tick(TICK); settle(w2); rested = restsOf(w2.entries).some((x) => x.id === "ball" && x.seq > (th?.seq ?? 0)); }
    ok(g.ok && th?.ok && flying && rested, "T6 …and a throw after the reopen flies in its engine and comes to rest on the record", { g: g.refused, th: th?.refused, flying, rested }); }
}
// T7: a purge after a checkpoint discards it: the bytes may sit in the cut, so the blob is deleted and the next open folds
// the sim from genesis (a purge is retroactive, L1).
{
  const { w, call, beat, now } = world("t7", 6);
  call("rowan", "set", { id: "cr-0", component: "label", value: "secret" });
  ok(call("rowan", "throw", { id: "ball", v: [0, 1, 12] }).ok, "T7 throw");
  const flying = () => Object.values(w.simPeek().sim?.bodies ?? {}).some((b) => !b.resting);
  for (let k = 0; k < 1800; k++) { beat(TICK); if (k > 2 && !flying() && w.simPeek().rested.length === 0) break; }
  for (let k = 0; k < 40; k++) beat(1000);
  const ck = w.entries.filter((e) => e.kind === "sim" && e.verb === "checkpoint"); const blobFile = `${root}t7/blobs/${String(ck[0]?.body.state).replace(/[^a-z0-9]/g, "-")}.json`;
  ok(ck.length === 1 && fs.existsSync(blobFile), "T7 a checkpoint with its blob on disk", { ck: ck.length, blobFile: fs.existsSync(blobFile) });
  const target = w.entries.findIndex((e) => e.kind === "change" && e.verb === "set" && e.body?.comp === "label");
  w.append({ kind: "purge", actor: "system", verb: "purge", body: { values: [{ seq: target }] } });
  ok(!fs.existsSync(blobFile), "T7 the purge deleted the checkpoint's blob", { blobFile });
  const w2 = openLive(`${root}t7`, "t7", { now });
  ok(w2.bootedFrom === null && digestOf(w2.sim().sim) === digestOf(w.sim().sim), "T7 reopened from genesis (no checkpoint after the purge), same bits", { bootedFrom: w2.bootedFrom });
}
console.log(`phystick: ${passes} ok, ${fails} failed${NO_TICK ? " (NO_TICK: the old shape)" : ""}`);
process.exit(fails ? 1 : 0);
