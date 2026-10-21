// Fold a world from its log using ONLY shared/protocol/fold.js: no door, no catalogue, no blob store (L1: the fold reads
// only entries). Ported from the protocol lab's replay-check.js @ 11db981, which printed; this one asserts. The fixture is
// the lab's cottage world, built through the lab authority; its digest there (node:crypto) is pinned here, so it also
// checks the engine's hash shim against the lab's hash.
// usage: bun tools/protocol/replay-check.ts
import fs from "node:fs";
import { readLog, fold, digest } from "../../shared/protocol/fold.js";
import { ENGINE } from "./common.ts";

// The lab's own digest was 22a27ab0…7f663b (bun replay-check.js in the lab @ 11db981; unchanged by the §3d genesis
// migration, lab 62301b8). The names pass (2026-10-07) rewrote two things in the fixture: genesis states {dialect, v}
// (so the world id moved; the digest leaves it out), and @world.about's text no longer names the protocol's number,
// which IS state. The new pin is that state's digest, confirmed independently by the Python reference reader (hashlib):
// python3 spec/conformance/reader.py spec/conformance/lab-cottage.jsonl --json → the same digest.
const PINNED_DIGEST = "b17bf98f909347df1024b39ad4cc044b5f08a713f2d4765fb0d3c767253971b8";
const raw = fs.readFileSync(ENGINE + "spec/conformance/lab-cottage.jsonl");
const entries = readLog(raw);
const st = fold(entries), st2 = fold(readLog(raw)); // self-agreement: read and fold twice
const s = (id: string) => st.entities?.[id]?.c;
const out = { status: st.status, entries: entries.length, entities: st.entities ? Object.keys(st.entities).length : 0,
  digest: st.status === "ok" ? digest(st) : null, selfAgree: st.status === "ok" && digest(st) === digest(st2),
  malformed: st.diagnostics.filter(([, c]: any) => c.startsWith("malformed")).length,
  sample: { "wall-back": s("wall-back")?.transform.pos, "cottage-b-shelf-1": s("cottage-b-shelf-1")?.parent, "door-1": { locked: s("door-1")?.locked } } };
console.log(JSON.stringify(out));
const fails = [
  out.status !== "ok" && "status",
  !out.selfAgree && "selfAgree",
  out.malformed !== 0 && "malformed",
  out.digest !== PINNED_DIGEST && `digest ${out.digest} != pinned ${PINNED_DIGEST}`,
  out.entities !== 51 && `entities ${out.entities} != 51`,
].filter(Boolean);
console.log(fails.length ? `FAIL ${fails.join("; ")}` : "replay: ok (status ok, self-agrees, 0 malformed, digest pinned)");

// ---- RL: a world stored before sockets were entities, lifted by the maintenance command (authority.js maintain) ----
// Replay is untouched (the log up to its head folds byte-identically; the fold reads no socket); the REPAIRED world gains
// one system act and change per host. Every log in spec/, plus the copies in RL_WORLDS (a scratch dir of world logs,
// never a live world dir: copy the Commons and the gym there), is lifted in memory and checked.
const { worldOf, posAt, liftWorld, maintain, request } = await import("../../shared/protocol/authority.js");
const { worldPose, simFold, digestOf } = await import("../../shared/protocol/simlayer.js");
const { translate } = await import("./import-v1/translate-v1.js");
let rlFail = 0; const rl = (c: any, what: string, d?: any) => { if (!c) { rlFail++; console.log(`FAIL ${what}${d !== undefined ? ` — ${JSON.stringify(d).slice(0, 300)}` : ""}`); } else console.log(`ok   ${what}`); };
const loadLift = (raw: Buffer, now?: number) => { const entries = readLog(raw); const lines: string[] = []; const T = now ?? (entries.findLast?.((e: any) => Number.isInteger(e?.ts))?.ts ?? 0) + 1000;
  const w = worldOf({ name: "rl", entries: entries.map(posAt), getBlob: () => { throw new Error("no blob"); }, putBlob: () => "", writeLine: (l: string) => lines.push(l), now: () => T });
  const m = maintain(w); const lifted = m.refused ? [] : m.steps.lift.made;   // lead 10-18: the load writes nothing; the command lifts (RL rows exercise the command)
  const all = Buffer.concat([raw, Buffer.from(lines.map((l) => l + "\n").join(""))]); return { entries, lines, lifted, all, w, T }; };
const logs: [string, Buffer][] = [];
const walk = (d: string) => { for (const f of fs.readdirSync(d, { withFileTypes: true })) { const p = `${d}/${f.name}`; if (f.isDirectory()) walk(p); else if (f.name.endsWith(".jsonl")) logs.push([p.slice(ENGINE.length), fs.readFileSync(p)]); } };
walk(ENGINE + "spec");
const RLW = process.env.RL_WORLDS; if (RLW) for (const f of fs.readdirSync(RLW).filter((f) => f.endsWith(".jsonl")).sort()) logs.push([`RL_WORLDS/${f}`, fs.readFileSync(`${RLW}/${f}`)]);
else console.log("(RL_WORLDS unset: only spec/'s logs; set it to a scratch dir of copied world logs to lift the Commons and the gym)");
let liftedLogs = 0;
for (const [name, raw] of logs) {
  const before = fold(readLog(raw)); const L = loadLift(raw); const after = fold(readLog(L.all)); const n0 = L.entries.length;
  const prefix = before.status !== "ok" || digest(fold(readLog(L.all).slice(0, n0))) === digest(before);
  const hosts = before.status === "ok" ? Object.entries(before.entities).filter(([, e]: any) => e.c.sockets && typeof e.c.sockets === "object") : [];
  if (L.lines.length) liftedLogs++;
  let worst = 0; if (before.status === "ok") for (const id of Object.keys(before.entities)) { const a = worldPose(before, id), b = worldPose(after, id); if (a && b) worst = Math.max(worst, ...a.pos.map((v: number, i: number) => Math.abs(v - b.pos[i])), ...a.q.map((v: number, i: number) => Math.abs(v - b.q[i]))); }
  const legacy = after.status === "ok" ? Object.values(after.entities).filter((e: any) => e.c.sockets !== undefined || typeof e.c.parent?.socket === "string").length : 0;
  const named = hosts.every(([h, e]: any) => Object.keys(e.c.sockets).every((slot) => Object.values(after.entities).some((x: any) => x.c.parent?.to === h && x.c.socket?.name === slot)));
  rl(L.all.subarray(0, raw.length).equals(raw) && prefix && after.status === before.status && (before.status === "ok" || !L.lines.length) && worst < 1e-8 && !legacy && named,
    `RL1 ${name}: its head folds byte-identically after the lift; ${hosts.length} host(s) keep their seats by name, ${legacy} old spellings left, every thing within ${worst.toExponential(1)} of where it was (${L.lines.length} lines appended)`, { status: [before.status, after.status], prefix, worst, legacy, named });
  if (L.lines.length) { const again = loadLift(L.all); rl(!again.lines.length && !again.lifted.length, `RL2 ${name}: a second run of the command appends nothing`, again.lifted); }
  if (L.lines.length && before.status === "ok") { const s0 = simFold(L.entries, L.T), s1 = simFold(readLog(L.all), L.T);
    rl((s0.sim ? digestOf(s0.sim) : null) === (s1.sim ? digestOf(s1.sim) : null), `RL5 ${name}: the sim's bodies are unchanged by the lift (${s0.sim ? "an engine world" : "no engine"})`, [s0.sim && digestOf(s0.sim), s1.sim && digestOf(s1.sim)]); }
}
// RL3: two forks lifting apart agree (deterministic ids): the same children, the same state
{ const big = logs.find(([n]) => /commons/.test(n)) ?? null;
  // a fixture of our own when no copy was given: a translated world with seats on two hosts
  const v1 = [{ seq: 0, ts: 1, actor: "world", verb: "genesis", args: { v: 2, dialect: "eidoverse-log" } },
    { seq: 1, ts: 2, actor: "ann", verb: "grant", args: { id: "ann", role: "owner" } }, { seq: 2, ts: 2, actor: "ann", verb: "grant", args: { id: "bob", role: "builder" } },
    { seq: 3, ts: 3, actor: "ann", verb: "spawn", args: { id: "bench", lib: "crate", pos: [1, 0, 1] } },
    { seq: 4, ts: 4, actor: "bob", verb: "comp", args: { id: "bench", type: "sockets", data: { seat: { pos: [0, 0.5, 0], body: { action: "sit" } }, hook: { pos: [0.4, 0.9, 0], yaw: 0.5 } } } },
    { seq: 5, ts: 5, actor: "ann", verb: "spawn", args: { id: "hat", lib: "ball", pos: [0, 0, 0] } }, { seq: 6, ts: 6, actor: "ann", verb: "mount", args: { id: "hat", to: "bench", slot: "hook" } }];
  const tr = Buffer.from(translate(v1, {}).out.map((e: any) => JSON.stringify(e)).join("\n") + "\n");
  for (const [name, raw] of [["a translated bench", tr], ...(big ? [[big[0], big[1]]] : [])] as [string, Buffer][]) {
    const a = loadLift(Buffer.from(raw)), b = loadLift(Buffer.from(raw), (a.T ?? 0) + 5000);
    rl(a.lifted.length > 0 && JSON.stringify(a.lifted) === JSON.stringify(b.lifted) && digest(fold(readLog(a.all))) === digest(fold(readLog(b.all))), `RL3 ${name}: two forks lift to the same ids and the same state`, [a.lifted, b.lifted]); }
  // RL4: the lift is the builder's, by rights: bob authored the bench's sockets, so he still edits his seat; vic can't
  const L = loadLift(tr); const W = L.w; let T = L.T;
  const R = (who: string, verb: string, args: any) => { W.now = () => (T += 100); return request(W, who, verb, args); };
  const act = readLog(L.all).find((e: any) => e.kind === "act" && e.verb === "lift-sockets");
  R("ann", "set", { id: "@world", component: "roles:bob", value: { role: "builder", can: { editOthers: false } } }); R("ann", "set", { id: "@world", component: "roles:vic", value: { role: "builder", can: { editOthers: false } } });
  const seat = act?.body?.made?.seat; const v = { name: "seat", body: { action: "sit", pose: "sitchair" } };
  const byBob = R("bob", "set", { id: seat, component: "socket", value: v }), byVic = R("vic", "set", { id: seat, component: "socket", value: v });
  rl(act?.body?.capability?.author === "bob" && byBob.ok && byVic.refused?.code === "rights", "RL4 the lift's act names bob (who set the sockets) as its rights: bob may still edit his seat child, a builder without editOthers may not", [act?.body, byBob.refused, byVic.refused]);
  const hat = W.state().entities.hat.c; rl(W.state().entities[hat.parent?.to]?.c.socket?.name === "hook", "RL4 …and the hat mounted on the hook rides the hook child", hat.parent);
  // RL6: the lift is no one's work to undo around: bob's own undo of his pre-cut sockets edit still takes it back (his edit
  // to the seat above is undone first; then the sockets themselves, and the hat stays with the bench where it was)
  R("ann", "set", { id: "@world", component: "roles:bob", value: { role: "builder" } });   // (the bench is ann's: undoing on it needs editOthers)
  const hat0 = worldPose(W.state(), "hat"); const u1 = R("bob", "undo", {}), u2 = R("bob", "undo", {}); const st6 = W.state();
  const left = Object.values(st6.entities).filter((e: any) => e.c.parent?.to === "bench" && e.c.socket).length; const hat1 = worldPose(st6, "hat");
  rl(u1.ok && u2.ok && left === 0 && st6.entities.hat.c.parent?.to === "bench" && hat1.pos.every((x: number, i: number) => Math.abs(x - hat0.pos[i]) < 1e-8), "RL6 bob's undo reaches past the maintenance command's lift: his sockets edit is taken back (no socket children left; the hat stays with the bench, where it was)", [u1.refused ?? u1.undid, u2.refused ?? u2.undid, left, st6.entities.hat.c.parent]);
}
// RL7-8: a catalogue model that declares seats (the lab chair) stored before the cut gets them from the maintenance command, once: a seat someone
// then deletes stays deleted, and undoing the chair's creation takes its lift-made seat with it
{ const v1 = [{ seq: 0, ts: 1, actor: "world", verb: "genesis", args: { v: 2, dialect: "eidoverse-log" } },
    { seq: 1, ts: 2, actor: "ann", verb: "grant", args: { id: "ann", role: "owner" } }, { seq: 2, ts: 3, actor: "ann", verb: "spawn", args: { id: "chair1", lib: "chair", pos: [2, 0, 2] } },
    { seq: 3, ts: 4, actor: "ann", verb: "spawn", args: { id: "chair2", lib: "chair", pos: [4, 0, 2] } }];
  const tr = Buffer.from(translate(v1, {}).out.map((e: any) => JSON.stringify(e)).join("\n") + "\n");
  const L = loadLift(tr); const W = L.w; let T = L.T; const R = (who: string, verb: string, args: any) => { W.now = () => (T += 100); return request(W, who, verb, args); };
  const seatOf = (st: any, h: string) => Object.keys(st.entities).find((k) => st.entities[k].c.parent?.to === h && st.entities[k].c.socket?.name === "seat");
  const s1 = seatOf(W.state(), "chair1");
  const del = R("ann", "delete", { id: s1 }); const lines: string[] = [];
  const reopened = worldOf({ name: "rl", entries: W.entries, getBlob: () => { throw new Error(); }, putBlob: () => "", writeLine: (l: string) => lines.push(l), now: () => T + 1000 });
  const again = liftWorld(reopened);   // the LOAD: it must write nothing and need nothing
  rl(L.lifted.length === 2 && !!s1 && del.ok && !again.length && !lines.length && !seatOf(reopened.state(), "chair1"), "RL7 a lab chair from before the cut gets its seat child from the maintenance command; a seat then deleted stays deleted at the next load", [L.lifted, del.refused, again]);
  const u = R("ann", "undo", {});   // ann's latest act: the delete; then the chair2 spawn
  const u2 = R("ann", "undo", {}); const st8 = W.state();
  rl(u.ok && u2.ok && !st8.entities.chair2 && !Object.values(st8.entities).some((e: any) => e.c.socket && !st8.entities[e.c.parent?.to]), "RL8 undoing a pre-cut chair's creation takes its lift-made seat with it (no socket is left without a host)", [u.refused ?? u.undid, u2.refused ?? u2.undid]);
}
console.log(`[replay-check RL] ${logs.length} logs read, ${liftedLogs} lifted; ${rlFail} failed`);
process.exit(fails.length || rlFail ? 1 : 0);
