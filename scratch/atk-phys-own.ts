// scratch/atk-phys-own.ts — my OWN server on a copy of the gym. PHASE=q|kill|stack|perf (comma list). usage:
//   PHASE=q bun scratch/atk-phys-own.ts
// @ts-nocheck
import fs from "node:fs"; import path from "node:path";
import { client, sleep, show, arrive, walk, settleAll, transformOf, copyWorlds, startServer, procs } from "./atk-phys-lib.ts";
import { openLive } from "../server/livehost.ts";
import { request, settle } from "../shared/protocol/authority.js";
import { restsOf, digestOf, simFold, livePoses } from "../shared/protocol/simlayer.js";
const SRC = "/home/claude/eido/scratch-worlds/garden", TREE = path.resolve(import.meta.dir, "..");
const SCR = process.env.SCR ?? "/tmp/claude-1000/-mnt-c-Users-Claude/59761a5f-1639-4fa8-8de1-0926d6c2903a/scratchpad/atk-own";
const PH = (process.env.PHASE ?? "q").split(",");
const say = (k, r) => console.log(k.padEnd(36), show(r));
const worlds = copyWorlds(SRC, SCR + "/worlds"); fs.mkdirSync(SCR + "/.relay", { recursive: true });
let S = await startServer(TREE, worlds, SCR + "/server.log"); console.log("own server on", S.port, "pid", S.proc.pid);
const CRATE = "eidoverse/assets/models/crate_large_red.glb", BALL = "props/ball.glb";
const retry = async (f) => { for (let i = 0; i < 40; i++) { const r = await f(); if (r.ok || r.refused?.code !== "rate") return r; await sleep(1500); } return { ok: false, refused: { code: "rate-giveup" } }; };
const mk = async (c, id, model, pos, scale, extra = {}) => { const r = await retry(() => c.req("create", { id, model, components: { physics: { kind: "dynamic", who: "visitor" }, grabbable: { who: "visitor" }, ...extra }, place: { at: [pos[0], pos[2]] } })); if (!r.ok) return r;
  return retry(() => c.req("set", { id, component: "transform", value: { pos, q: [0, 0, 0, 1], scale } })); };
const rab = await client(S.port, "gym", "rab"); say("rab arrive", await arrive(rab, [-10, 0, -10]));

if (PH.includes("q")) {   // sunk rests: ball throws with and without q, twice each; the rest's y
  const atk = await client(S.port, "gym", "atk-phys-q"); say("atk arrive", await arrive(atk)); say("atk walk", await walk(atk, [0, 0, -3]));
  say("rab mk ball", await mk(rab, "atk-qb1161", BALL, [0, 0.175, -3.8], [0.5, 0.5, 0.5], { collider: { shape: "sphere" } }));
  console.log("atk-ball shape", JSON.stringify((await rab.req("inspect", { id: "atk-qb1161" }))?.components?.physics));
  for (const [label, extra] of [["unit q", { q: [0, 0, 0, 1] }], ["no q", {}], ["q 1.0005", { q: [0, 0, 0, 1.0005] }], ["unit q again", { q: [0, 0, 0, 1] }], ["v [0,1,1] no q", { v1: true }]]) {
    // rab resets the ball to the start spot (owner edit), atk throws from the same spot
    say(`rab reset`, await rab.req("set", { id: "atk-qb1161", component: "transform", value: { pos: [0, 0.175, -3.8], q: [0, 0, 0, 1], scale: [0.5, 0.5, 0.5] } }));
    say(`atk grab`, await atk.req("grab", { id: "atk-qb1161" }));
    const v = extra.v1 ? [0, 1, 1] : [0, 2, 3]; delete extra.v1;
    const th = await atk.req("throw", { id: "atk-qb1161", v, ...extra }); say(`throw ${label}`, th);
    const w = await settleAll(atk); const t = await transformOf(atk, "atk-qb1161");
    console.log(`  REST ${label}: y=${t?.pos?.[1]} pos=${JSON.stringify(t?.pos?.map((n) => +n.toFixed(3)))} wait=${JSON.stringify(w.cameToRest ?? w).slice(0, 160)}`);
  }
  // a crate for comparison
  say("rab mk crate", await mk(rab, "atk-qc1161", CRATE, [0.8, 0, -3.8], [0.25, 0.25, 0.25]));
  say("atk grab crate", await atk.req("grab", { id: "atk-qc1161" })); say("throw crate", await atk.req("throw", { id: "atk-qc1161", v: [0, 2, 3] }));
  await settleAll(atk); const tc = await transformOf(atk, "atk-qc1161"); console.log("  REST crate: pos=", JSON.stringify(tc?.pos?.map((n) => +n.toFixed(3))));
  atk.close();
}
if (PH.includes("stack")) {   // (3) bottom of a tower; carries
  const atk = await client(S.port, "gym", "atk-phys-s"); say("atk arrive", await arrive(atk));
  for (let i = 0; i < 5; i++) say(`rab mk st-${i}`, await mk(rab, `st1161-${i}`, CRATE, [2.6, 0.5 * i, 9.6], [0.25, 0.25, 0.25]));
  await sleep(500); console.log("st parents:", JSON.stringify(await Promise.all([0, 1, 2, 3, 4].map(async (i) => (await rab.req("inspect", { id: `st1161-${i}` }))?.components?.parent ?? null))));
  say("atk walk tower", await walk(atk, [2.6, 0, 8.7]));
  const g = await atk.req("grab", { id: "st1161-0" }); say("atk grab st-0 (bottom)", g); console.log("  notes:", JSON.stringify(g.notes ?? null).slice(0, 300));
  await sleep(300); const w = await settleAll(atk); console.log("  wait:", JSON.stringify(w).slice(0, 300));
  for (let i = 1; i < 5; i++) { const t = await transformOf(atk, `st1161-${i}`); console.log(`  st-${i} after: y=${t?.pos?.[1]?.toFixed(3)} parent=${JSON.stringify((await atk.req("inspect", { id: `st1161-${i}` }))?.components?.parent ?? null)}`); }
  say("atk drop st-0", await atk.req("drop", { id: "st1161-0" })); await settleAll(atk);
  // carries: the tray (carries:true) with corn vs carries:false
  say("rab move tray by spawn", await rab.req("set", { id: "tray", component: "transform", value: { pos: [0.2, 0, 10.6], q: [0, 0, 0, 1], scale: 0.6 } }));
  say("rab put corn on tray", await rab.req("set", { id: "tray-corn-0", component: "transform", value: { pos: [0.3, 0.09, 10.5], q: [0, 0, 0.7071068, 0.7071068], scale: 0.1998 } }));
  await sleep(300); const tr = await transformOf(atk, "tray"); say("atk walk tray", await walk(atk, [0.2, 0, 9.7]));
  const corn0 = await transformOf(atk, "tray-corn-0"); console.log("  tray", JSON.stringify(tr.pos.map((n) => +n.toFixed(2))), "corn-0", JSON.stringify(corn0.pos.map((n) => +n.toFixed(2))), "corn parent", JSON.stringify((await atk.req("inspect", { id: "tray-corn-0" }))?.components?.parent ?? null));
  const gt = await atk.req("grab", { id: "tray" }); say("atk grab tray (carries:true)", gt); console.log("  notes:", JSON.stringify(gt.notes ?? null).slice(0, 300), "carrying:", JSON.stringify(gt.carrying ?? gt.riders ?? null));
  say("atk walk 2m with tray", await walk(atk, [2.2, 0, 9.7]));
  say("atk put tray", await atk.req("put", { id: "tray" })); await settleAll(atk);
  const tr2 = await transformOf(atk, "tray"), c2 = await transformOf(atk, "tray-corn-0"); console.log("  after put: tray", JSON.stringify(tr2.pos.map((n) => +n.toFixed(2))), "corn-0", JSON.stringify(c2.pos.map((n) => +n.toFixed(2))), "corn parent", JSON.stringify((await atk.req("inspect", { id: "tray-corn-0" }))?.components?.parent ?? null));
  // carries:false on the tray
  const gv = (await rab.req("inspect", { id: "tray" }))?.components?.grabbable; say("rab set carries:false", await rab.req("set", { id: "tray", component: "grabbable", value: { ...gv, carries: false } }));
  const gt2 = await atk.req("grab", { id: "tray" }); say("atk grab tray (carries:false)", gt2); console.log("  notes:", JSON.stringify(gt2.notes ?? null).slice(0, 300));
  await sleep(300); await settleAll(atk); const c3 = await transformOf(atk, "tray-corn-0"); console.log("  corn-0 now", JSON.stringify(c3.pos.map((n) => +n.toFixed(2))), "parent", JSON.stringify((await atk.req("inspect", { id: "tray-corn-0" }))?.components?.parent ?? null));
  say("atk drop tray", await atk.req("drop", { id: "tray" })); await settleAll(atk); atk.close();
}
if (PH.includes("kill")) {   // (1) kill mid-flight
  const N = 10, COLS = 4; say("rab tp", await rab.req("move", { to: [-14.9, 0, -14], teleport: true }));
  for (let c = 0; c < COLS; c++) for (let i = 0; i < N; i++) { const r = await mk(rab, `tw1161-${c}-${i}`, CRATE, [-14 + c * 0.66, 0.5 * i, -14], [0.25, 0.25, 0.25]); if (!r.ok) say(`mk tw-${c}-${i}`, r); }
  console.log("sleeping 11 s for the rate window"); await sleep(11000);
  say("rab grab tw-0-0 (bottom)", await rab.req("grab", { id: "tw1161-0-0" }));
  const th = await rab.req("throw", { id: "tw1161-0-0", v: [20, 2, 0] }); say("rab throw into columns", th);
  await sleep(450); const peek = await rab.req("wait", {}); console.log("in flight at kill:", Object.keys(peek.inFlight ?? {}).length, "head", peek.head ?? "");
  const lines0 = fs.readFileSync(worlds + "/gym/world.jsonl", "utf8").split("\n").filter(Boolean).length;
  S.proc.kill(9); await sleep(800); console.log("KILLED. log lines", lines0);
  // reopen in-process (read-only: no requests appended) and compare the checkpoint-booted engine with a from-genesis fold
  let T = Date.now(); const w = openLive(worlds + "/gym", "gym", { now: () => T });
  const a = w.sim(), dA = digestOf(a.sim); const b = simFold(w.entries, w.now(), { models: {} }), dB = digestOf(b.sim);
  const fly = (v) => Object.entries(v.sim.bodies).filter(([, x]) => !x.resting).map(([k]) => k);
  console.log("reopen: bootedFrom", w.bootedFrom, "entries", w.entries.length, "digest ckpt-boot", dA, "from-genesis", dB, "EQUAL", dA === dB, "flying", fly(a).length, fly(b).length, "launched", Object.keys(a.launched).length);
  const diff = []; for (const id of Object.keys(a.sim.bodies)) { const p = a.sim.bodies[id].p, q = b.sim.bodies[id]?.p; if (!q || p.some((n, i) => n !== q[i])) diff.push([id, p, q]); } console.log("position diffs", diff.length, JSON.stringify(diff.slice(0, 3)));
  for (const id of ["ball-0", "ball-1"]) console.log("  sphere body", id, "ckpt-boot:", JSON.stringify(a.sim.bodies[id] ?? null).slice(0, 260), "\n     genesis:", JSON.stringify(b.sim.bodies[id] ?? null).slice(0, 260));
  // let it settle in-process (the clock jumps 20 s; settle writes the rests), then compare again with a fresh genesis fold
  T += 20000; const wrote = settle(w, {}); const a2 = w.sim(), dA2 = digestOf(a2.sim); const b2 = simFold(w.entries, w.now(), { models: {} }), dB2 = digestOf(b2.sim);
  console.log("after settle: wrote", wrote, "rests", restsOf(w.entries).filter((r) => r.seq > th.seq).length, "flying", fly(a2).length, "digest", dA2, dB2, "EQUAL", dA2 === dB2, "unsettled", JSON.stringify(w.unsettled ?? []).slice(0, 200));
  const sunk = Object.entries(a2.sim.bodies).filter(([k, x]) => x.resting && x.p[1] < -0.05).map(([k, x]) => [k, +x.p[1].toFixed(3)]); console.log("resting under the floor:", sunk.length, JSON.stringify(sunk.slice(0, 8)));
  // restart the server on the same dir; a pre-checkpoint thing (the key) is thrown by a fresh attacker
  S = await startServer(TREE, worlds, SCR + "/server2.log"); console.log("restarted on", S.port, "bootedFrom?", fs.readFileSync(SCR + "/server2.log", "utf8").split("\n").filter((l) => /checkpoint|gym/.test(l)).slice(0, 4).join(" | "));
  const atk = await client(S.port, "gym", "atk-phys-k"); say("atk arrive", await arrive(atk)); const rab2 = await client(S.port, "gym", "rab"); say("rab2 edit key (pre-checkpoint thing)", await rab2.req("set", { id: "key", component: "transform", value: { pos: [1.2, 0, 8.6], q: [0, 0, 0, 1], scale: 0.6 } })); say("atk step", await atk.req("move", { to: [1.2, 0, 7.8] }));
  say("atk grab key", await atk.req("grab", { id: "key" })); const th2 = await atk.req("throw", { id: "key", v: [0, 3, -3] }); say("atk throw key (pre-checkpoint thing)", th2);
  const w1 = await atk.req("wait", {}); console.log("  in flight right after:", JSON.stringify(w1.inFlight ?? {}).slice(0, 120));
  const w2 = await settleAll(atk); const k2 = await transformOf(atk, "key"); console.log("  key rested at", JSON.stringify(k2?.pos?.map((n) => +n.toFixed(3))), "wait", JSON.stringify(w2).slice(0, 200));
  { const wr = openLive(worlds + "/gym", "gym", {}); const x = digestOf(wr.sim().sim), y = digestOf(simFold(wr.entries, wr.now(), { models: {} }).sim); console.log("  restarted server's log: ckpt-boot vs genesis digest EQUAL", x === y, x, y, "bootedFrom", wr.bootedFrom); }
  // and a thing that was mid-flight at the kill: where is it, and does the log have exactly one rest per launch?
  const rs = restsOf(w.entries.concat()).filter((r) => r.seq > th.seq); const byId = {}; for (const r of restsOf(openLive(worlds + "/gym", "gym", {}).entries)) if (r.seq > th.seq) byId[r.id] = (byId[r.id] ?? 0) + 1;
  console.log("  rests per launched body after the throw:", JSON.stringify(Object.entries(byId).filter(([, n]) => n > 1)), "bodies rested", Object.keys(byId).length);
  atk.close();
}
if (PH.includes("steal")) {   // steal:false — the second grab; an owner's grab; the holder's throw after
  const A = await client(S.port, "gym", "atk-phys-sa"), B = await client(S.port, "gym", "atk-phys-sb"); say("A arrive", await arrive(A)); say("B arrive", await arrive(B, [0.8, 0, 8]));
  const id = "atk-sb" + Date.now() % 100000; say("rab mk", await mk(rab, id, BALL, [0.4, 0.175, 7], [0.5, 0.5, 0.5], { collider: { shape: "sphere" }, grabbable: { who: "visitor", steal: false } }));
  console.log("  grabbable:", JSON.stringify((await rab.req("inspect", { id }))?.components?.grabbable));
  say("A grab", await A.req("grab", { id })); say("B grab (steal:false)", await B.req("grab", { id })); say("B grab again", await B.req("grab", { id }));
  say("rab tp", await rab.req("move", { to: [0, 0, 7.5], teleport: true })); say("rab (owner) grab", await rab.req("grab", { id }));
  say("A throw after owner took", await A.req("throw", { id, v: [0, 1, 1] })); say("rab drop", await rab.req("drop", { id })); await settleAll(rab);
  // both grab in one tick under steal:false
  let ra, rb; { const pa = A.req("grab", { id }); const pb = B.req("grab", { id }); [ra, rb] = await Promise.all([pa, pb]); } say("race A", ra); say("race B", rb);
  A.close(); B.close();
}
if (PH.includes("edge")) {   // (4) throw out of the world; put outside; (the owner throws: rights aren't the question, the edge is)
  const A = rab; const id = "atk-eb" + Date.now() % 100000; say("rab mk edge ball", await mk(rab, id, BALL, [18.6, 0.175, 8], [0.5, 0.5, 0.5], { collider: { shape: "sphere" } }));
  say("rab set home", await rab.req("set", { id, component: "home", value: { pos: [1, 0, 9], q: [0, 0, 0, 1] } }));
  say("A tp edge", await A.req("move", { to: [18.6, 0, 8.8], teleport: true })); say("A grab", await A.req("grab", { id }));
  say("A put outside", await A.req("put", { id, pos: [20.4, 0, 8.8] })); say("A put on the line", await A.req("put", { id, pos: [20, 0, 8.8] })); say("A grab", await A.req("grab", { id }));
  say("A throw out +x", await A.req("throw", { id, v: [19, 3, 0] })); const w1 = await A.req("wait", {}); console.log("  right after:", JSON.stringify(w1.inFlight ?? {}).slice(0, 160));
  const w = await settleAll(A); console.log("  wait:", JSON.stringify((w.cameToRest ?? []).filter((r) => r.id === id))); console.log("  now at", JSON.stringify((await transformOf(A, id))?.pos));
  const L = fs.readFileSync(worlds + "/gym/world.jsonl", "utf8").split("\n").filter(Boolean).slice(-8).map((l) => JSON.parse(l)).map((e) => ({ kind: e.kind, verb: e.verb, actor: e.actor, cause: e.cause, body: JSON.stringify(e.body).slice(0, 150) })); console.log("  log tail:", JSON.stringify(L, null, 0).replace(/},{/g, "},\n   {"));
  say("A grab from the edge (it went home?)", await A.req("grab", { id })); say("A tp home", await A.req("move", { to: [1, 0, 9.8], teleport: true })); say("A grab at home", await A.req("grab", { id }));
  say("A throw straight up 20", await A.req("throw", { id, v: [0, 20, 0] })); await sleep(700); const wu = await A.req("wait", {}); console.log("  up at 0.7 s:", JSON.stringify(wu.inFlight?.[id] ?? null)); const wr = await settleAll(A); console.log("  rest:", JSON.stringify((wr.cameToRest ?? []).filter((r) => r.id === id)));
  // a thing with NO home thrown out: back to where it was picked up
  const id2 = "atk-eh" + Date.now() % 100000; say("rab mk homeless", await mk(rab, id2, BALL, [18.6, 0.175, 7], [0.5, 0.5, 0.5], { collider: { shape: "sphere" } })); say("rab del home", await rab.req("delete", { id: id2, component: "home" }));
  say("A tp edge", await A.req("move", { to: [18.6, 0, 7.8], teleport: true })); say("A grab", await A.req("grab", { id: id2 })); say("A throw out", await A.req("throw", { id: id2, v: [19, 3, 0] })); const w2 = await settleAll(A); console.log("  wait:", JSON.stringify((w2.cameToRest ?? []).filter((r) => r.id === id2)), "now at", JSON.stringify((await transformOf(A, id2))?.pos));
}
if (PH.includes("perf")) {   // (5) 200 things: a floating block the ball cascades through
  const t0 = performance.now(); let n = 0;
  for (let i = 0; i < 200; i++) { const x = -6 + (i % 5) * 0.5, z = -18 + (Math.floor(i / 5) % 5) * 0.45, y = 0.4 + Math.floor(i / 25) * 0.35; const r = await mk(rab, `pf1161-${i}`, CRATE, [x, y, z], [0.15, 0.15, 0.15]); if (r.ok) n++; else if (i < 3) say("mk", r); }
  console.log("made", n, "in", ((performance.now() - t0) / 1000).toFixed(1), "s");
  say("rab mk pball", await mk(rab, "pf1161-ball", BALL, [-4, 0.175, -14], [0.5, 0.5, 0.5], { collider: { shape: "sphere" } }));
  say("rab tp", await rab.req("move", { to: [-4, 0, -13.2], teleport: true })); say("rab grab", await rab.req("grab", { id: "pf1161-ball" }));
  const rss = () => { try { return +fs.readFileSync(`/proc/${S.proc.pid}/status`, "utf8").match(/VmRSS:\s+(\d+)/)[1] / 1024 | 0; } catch { return -1; } };
  const base = []; for (let i = 0; i < 5; i++) { const a = performance.now(); await rab.req("wait", {}); base.push(+(performance.now() - a).toFixed(1)); }
  console.log("baseline wait ms", JSON.stringify(base), "rss MB", rss());
  const th = await rab.req("throw", { id: "pf1161-ball", v: [0, 1, -20] }); say("throw into the block", th);
  const samples = []; const t1 = performance.now(); let maxFlying = 0;
  while (performance.now() - t1 < 40000) { const a = performance.now(); const w = await rab.req("wait", {}); const ms = performance.now() - a; const f = Object.keys(w.inFlight ?? {}).length; maxFlying = Math.max(maxFlying, f); samples.push([+((performance.now() - t1) / 1000).toFixed(1), +ms.toFixed(0), f, rss()]); if (f === 0 && performance.now() - t1 > 3000) break; await sleep(200); }
  const ms = samples.map((s) => s[1]); console.log("settle: samples", samples.length, "max flying", maxFlying, "wait ms max", Math.max(...ms), "p50", ms.sort((a, b) => a - b)[ms.length >> 1], "rss MB max", Math.max(...samples.map((s) => s[3])));
  console.log("timeline [t s, wait ms, flying, rssMB]:", JSON.stringify(samples.filter((_, i) => i % 3 === 0).slice(0, 40)));
  const lines = fs.readFileSync(worlds + "/gym/world.jsonl", "utf8").split("\n").filter(Boolean); const after = lines.slice(-400).map((l) => JSON.parse(l)); const kinds = {}; for (const e of after) { if ((e.seq ?? 0) < th.seq && !(e.kind === "change" && e.actor === "sim" && e.cause >= th.seq)) continue; const k = e.kind + ":" + e.verb; kinds[k] = (kinds[k] ?? 0) + 1; } console.log("entries since the throw:", JSON.stringify(kinds));
  const sl = fs.readFileSync(S.log, "utf8").split("\n").filter((l) => /settle|pass|ms|slow/i.test(l)).slice(-8); console.log("server log tail:", sl.join(" | ").slice(0, 600));
}
if (PH.includes("perf2")) {   // (5b) a 200-crate column; the bottom is taken and the whole column comes down
  const t0 = performance.now(); let n = 0; say("rab tp", await rab.req("move", { to: [-5.9, 0, -15], teleport: true }));
  for (let i = 0; i < 200; i++) { const r = await mk(rab, `pc${Date.now() % 1000}-${i}`, CRATE, [-5, 0.3 * i, -15], [0.15, 0.15, 0.15]); if (r.ok) n++; else if (i < 3) say("mk", r); }
  const ids = Object.keys((await rab.req("look", {}))?.things ? {} : {}); console.log("made", n, "in", ((performance.now() - t0) / 1000).toFixed(1), "s"); await sleep(11000);
  const rss = () => { try { return +fs.readFileSync(`/proc/${S.proc.pid}/status`, "utf8").match(/VmRSS:\s+(\d+)/)[1] / 1024 | 0; } catch { return -1; } };
  const base = []; for (let i = 0; i < 5; i++) { const a = performance.now(); await rab.req("wait", {}); base.push(+(performance.now() - a).toFixed(1)); } console.log("baseline wait ms", JSON.stringify(base), "rss MB", rss());
  const L0 = fs.readFileSync(worlds + "/gym/world.jsonl", "utf8").split("\n").filter(Boolean); const bottom = JSON.parse(L0.find((l) => l.includes('"verb":"create"') && l.includes("-0\"")) ?? "{}"); const bid = L0.map((l) => JSON.parse(l)).filter((e) => e.kind === "act" && e.verb === "create" && /^pc\d+-0$/.test(e.body?.request?.id ?? "")).at(-1)?.body.request.id;
  const g = await rab.req("grab", { id: bid }); say("rab grab the bottom " + bid, g); console.log("  notes", JSON.stringify(g.notes ?? null).slice(0, 200));
  const th = await rab.req("throw", { id: bid, v: [0, 2, 20] }); say("rab throw it away", th);
  const samples = []; const t1 = performance.now(); let maxFlying = 0;
  while (performance.now() - t1 < 60000) { const a = performance.now(); const w = await rab.req("wait", {}); const ms = performance.now() - a; const f = Object.keys(w.inFlight ?? {}).length; maxFlying = Math.max(maxFlying, f); samples.push([+((performance.now() - t1) / 1000).toFixed(1), +ms.toFixed(0), f, rss()]); if (f === 0 && performance.now() - t1 > 4000) break; await sleep(200); }
  const ms = samples.map((s) => s[1]); console.log("settle: samples", samples.length, "max flying", maxFlying, "wait ms max", Math.max(...ms), "p50", [...ms].sort((a, b) => a - b)[ms.length >> 1], "rss MB max", Math.max(...samples.map((s) => s[3])));
  console.log("timeline [t s, wait ms, flying, rssMB]:", JSON.stringify(samples.filter((_, i) => i % 4 === 0).slice(0, 40)));
  const lines = fs.readFileSync(worlds + "/gym/world.jsonl", "utf8").split("\n").filter(Boolean); const kinds = {}; let rested = new Set(); for (const l of lines.slice(-700)) { const e = JSON.parse(l); if ((e.seq ?? 0) < th.seq && !(e.kind === "change" && e.actor === "sim" && e.cause >= th.seq)) continue; const k = e.kind + ":" + e.verb; kinds[k] = (kinds[k] ?? 0) + 1; if (e.kind === "change" && e.actor === "sim") for (const m of l.matchAll(/"id":"([^"]+)","comp":"transform"/g)) rested.add(m[1]); } console.log("entries since the throw:", JSON.stringify(kinds), "bodies rested", rested.size);
  { const wr = openLive(worlds + "/gym", "gym", {}); const x = digestOf(wr.sim().sim), y = digestOf(simFold(wr.entries, wr.now(), { models: {} }).sim); console.log("  log: ckpt-boot vs genesis digest EQUAL", x === y, "bootedFrom", wr.bootedFrom, "entries", wr.entries.length); }
}
if (PH.includes("perf3")) {   // (5c) the 200-crate column knocked at its base by a ball: how many fly, and the door's latency while they settle
  const t0 = performance.now(); let n = 0; say("rab tp", await rab.req("move", { to: [-5, 0, -13.2], teleport: true })); const tag = `pk${Date.now() % 1000}`;
  for (let i = 0; i < 200; i++) { const r = await mk(rab, `${tag}-${i}`, CRATE, [-5, 0.3 * i, -15], [0.15, 0.15, 0.15]); if (r.ok) n++; else if (i < 3) say("mk", r); }
  say("rab mk ball", await mk(rab, `${tag}-ball`, BALL, [-5, 0.175, -13.9], [0.5, 0.5, 0.5], { collider: { shape: "sphere" } })); console.log("made", n, "in", ((performance.now() - t0) / 1000).toFixed(1), "s"); await sleep(11000);
  const rss = () => { try { return +fs.readFileSync(`/proc/${S.proc.pid}/status`, "utf8").match(/VmRSS:\s+(\d+)/)[1] / 1024 | 0; } catch { return -1; } };
  const base = []; for (let i = 0; i < 5; i++) { const a = performance.now(); await rab.req("wait", {}); base.push(+(performance.now() - a).toFixed(1)); } console.log("baseline wait ms", JSON.stringify(base), "rss MB", rss());
  say("rab grab ball", await rab.req("grab", { id: `${tag}-ball` })); const th = await rab.req("throw", { id: `${tag}-ball`, v: [0, -4, -20] }); say("rab throw at the base", th);
  const samples = []; const t1 = performance.now(); let maxFlying = 0;
  while (performance.now() - t1 < 90000) { const a = performance.now(); const w = await rab.req("wait", {}); const ms = performance.now() - a; const f = Object.keys(w.inFlight ?? {}).length; maxFlying = Math.max(maxFlying, f); samples.push([+((performance.now() - t1) / 1000).toFixed(1), +ms.toFixed(0), f, rss()]); if (f === 0 && performance.now() - t1 > 4000) break; await sleep(200); }
  const ms = samples.map((s) => s[1]); console.log("settle: samples", samples.length, "max flying", maxFlying, "wait ms max", Math.max(...ms), "p50", [...ms].sort((a, b) => a - b)[ms.length >> 1], "p90", [...ms].sort((a, b) => a - b)[Math.floor(ms.length * 0.9)], "rss MB max", Math.max(...samples.map((s) => s[3])));
  console.log("timeline [t s, wait ms, flying, rssMB]:", JSON.stringify(samples.filter((_, i) => i % 5 === 0).slice(0, 60)));
  const lines = fs.readFileSync(worlds + "/gym/world.jsonl", "utf8").split("\n").filter(Boolean); const kinds = {}; let rested = new Set(); for (const l of lines.slice(-900)) { const e = JSON.parse(l); if ((e.seq ?? 0) < th.seq && !(e.kind === "change" && e.actor === "sim" && e.cause >= th.seq)) continue; const k = e.kind + ":" + e.verb; kinds[k] = (kinds[k] ?? 0) + 1; if (e.kind === "change" && e.actor === "sim") for (const m of l.matchAll(/"id":"([^"]+)","comp":"transform"/g)) rested.add(m[1]); } console.log("entries since the throw:", JSON.stringify(kinds), "bodies rested", rested.size);
  { const wr = openLive(worlds + "/gym", "gym", {}); const x = digestOf(wr.sim().sim), y = digestOf(simFold(wr.entries, wr.now(), { models: {} }).sim); console.log("  log: ckpt-boot vs genesis digest EQUAL", x === y, "bootedFrom", wr.bootedFrom, "entries", wr.entries.length); }
  const sl = fs.readFileSync(S.log, "utf8").split("\n").filter((l) => /settle|slow|budget|ms\b/i.test(l)).slice(-6); console.log("server log:", sl.join(" | ").slice(0, 500));
}
if (PH.includes("idle")) { fs.writeFileSync(SCR + "/port", String(S.port)); console.log("idle: port", S.port); await sleep(+(process.env.IDLE_S ?? 60) * 1000); }
rab.close(); for (const p of procs) try { p.kill(); } catch {} ; process.exit(0);
