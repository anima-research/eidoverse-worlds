/**
 * Effective-transform test — #82: agent perception must report mounted cargo
 * (and moving things) where they ACTUALLY are, or refuse to give a number.
 * No servers needed; time is injected everywhere.
 *
 * Run: bun tools/effective-test.ts
 *
 * The scenes are written as old-protocol entries (that is how these cases were
 * first recorded) and folded by the old-world importer's fold
 * (tools/protocol/import-v1/fold.js) into entity records the agent reads as its view
 * — the record shape (shared/protocol/view.js) began as that fold's projection.
 *
 * Expected values are HAND-COMPUTED from the closed forms — never from the
 * code under test. Worked math is inline at each case.
 */

import { WorldAgent } from "../mcpl/agent.ts";
import { emptyState, foldEntry } from "./protocol/import-v1/fold.js";

let failures = 0;
const check = (label: string, ok: boolean, detail?: string) => {
  console.log(ok ? `  \x1b[32m✓\x1b[0m ${label}` : `  \x1b[31m✗ ${label}${detail ? ` — ${detail}` : ""}\x1b[0m`);
  if (!ok) failures++;
};
const near = (a: number, b: number, eps = 1e-4) => Math.abs(a - b) < eps;
const near3 = (a: number[], b: number[], eps = 1e-4) => a.length === 3 && a.every((v, i) => near(v, b[i], eps));

// effective.ts does not exist on main — load it dynamically so the
// look()-level receipts still run there.
let EFF: typeof import("./effective.ts") | null = null;
try { EFF = await import("../mcpl/effective.ts"); } catch { /* pre-#82 checkout */ }

const T0 = 1_700_000_000_000;                       // fixed epoch; all time injected

/** An agent that never connects: each scene is folded into entity records and handed to the agent as its view (its
 *  entities and mounts are reconciled from that, as from a joined world's view). */
const scenes = new WeakMap<WorldAgent, any>();
function offlineAgent(): WorldAgent {
  const a = new WorldAgent({ url: "ws://127.0.0.1:9/ws", name: "tester", world: "efftest" });
  scenes.set(a, emptyState());
  return a;
}
let seqN = 0;
/** A socket child's id here: "<host>.<slot>" (the door mints its own; any stable id serves a fixture). */
const SID = (host: string, slot: string) => `${host}.${slot}`;
/** The scenes are old-protocol entries, so a seat arrives as a `sockets` map and cargo as mount {to, slot}. Every world is
 *  lifted into socket children (PLAN-sockets-entities: the door at load); this does the same to the folded records — a
 *  socket child {pos, yaw/q, socket: {name, …}, parent: {to: host, offset, yaw/q}}, and cargo on a slot rides it
 *  (no offset: on the socket itself) — so the agent reads exactly what a lifted world gives it. */
function liftV1(E: Record<string, any>) {
  // the v1 fold's records speak the old protocol (lib, a comp bag): today's record is flat, in the protocol's names (view.js)
  for (const [id, e] of Object.entries<any>({ ...E })) { const { lib, comp, ...rest } = e; E[id] = { ...rest, ...(lib != null ? { model: lib } : {}), ...(comp ?? {}) }; }
  for (const [id, e] of Object.entries<any>({ ...E })) {
    const S = e?.sockets; if (!S) continue;
    for (const [slot, sk] of Object.entries<any>(S)) {
      const { pos = [0, 0, 0], yaw, q, ...rest } = sk;
      const turn = q ? { q } : { yaw: yaw ?? 0 };
      E[SID(id, slot)] = { pos, ...turn, socket: { name: slot, ...rest }, parent: { to: id, offset: pos, ...turn } };
    }
    delete e.sockets;
  }
  for (const e of Object.values<any>(E)) if (e.parent?.slot) { const { slot, ...p } = e.parent; e.parent = { ...p, to: SID(p.to, slot) }; }
  return E;
}
const fold = (a: WorldAgent, entry: { verb: string; args: any; actor?: string }, live = false) => {
  const A = a as any;
  // a body sitting is presence, never the fold: the agent's own seat (a socket child's id)
  if ((entry.verb === "mount" || entry.verb === "dismount") && entry.args?.id === A.name) { A.setSeat(entry.verb === "mount" ? { to: entry.args.slot ? SID(entry.args.to, entry.args.slot) : entry.args.to } : null); A.reconcileFromFold(); return; }
  const was = entry.args?.id != null ? A.entities.get(entry.args.id) : undefined;
  const st = scenes.get(a); foldEntry(st, { seq: ++seqN, ts: T0, actor: entry.actor ?? "t", ...entry });
  A.st = { ...A.st, entities: liftV1(structuredClone(st.entities)) };
  A.reconcileFromFold();
  for (const id of Object.keys(st.entities)) A.trackSupport?.(A.syncSupport?.(id));
  // a change seen live: the agent's own change handler (what a door write it watched would run)
  if (live && entry.verb === "comp") A.onThingChange({ id: entry.args.id, what: "comp", comp: entry.args.type }, was, true, entry.actor ?? "t", T0);
};

// A fake view for the pure module — plain data, no agent.
const view = (ents: Record<string, any>, mounts: Record<string, any>) => ({
  entity: (id: string) => ents[id],
  mount: (id: string) => mounts[id],
});

// ---- pure module: composition contract -------------------------------------
console.log("\n━━ effective.ts: the composition contract ━━");
if (!EFF) {
  check("effective.ts present", false, "module absent (pre-#82 checkout)");
} else {
  const { effectiveWorldTransform: eff } = EFF;

  // static parent + mount offset (no socket)
  {
    const r = eff("crate", view(
      { swing: { pos: [10, 0, 10], yaw: 0 }, crate: { pos: [3, 0, 3], yaw: 0 } },
      { crate: { to: "swing", offset: [0, 0.55, 0] } }), T0);
    check("static parent + offset: composed, not stale", r.ok && near3(r.pos, [10, 0.55, 10]), JSON.stringify(r));
  }

  // a socket is a child entity (PLAN-sockets-entities): cargo on it lands on the socket's own frame; its own local pose
  // composes in that frame
  {
    const ents = { swing: { pos: [0, 0, 0], yaw: 0 }, "swing.seat": { pos: [0, 1, 0], yaw: 1, socket: { name: "seat" } }, crate: { pos: [9, 9, 9], yaw: 0 } };
    const sock = { "swing.seat": { to: "swing", offset: [0, 1, 0], yaw: 1 } };
    const bySock = eff("crate", view(ents, { ...sock, crate: { to: "swing.seat" } }), T0);
    check("socket supplies the local frame", bySock.ok && near3(bySock.pos, [0, 1, 0]) && near(bySock.yaw, 1), JSON.stringify(bySock));
    const byMount = eff("crate", view(ents, { ...sock, crate: { to: "swing.seat", offset: [0, 1, 0], yaw: 0.5 } }), T0);
    check("the cargo's own local pose composes in the socket's frame", byMount.ok && near3(byMount.pos, [0, 2, 0]) && near(byMount.yaw, 1.5), JSON.stringify(byMount));
    // a tilted socket (a rocket's seat on its back: pitch −90°): its whole rotation carries what rides it — [0, 0, 1] in
    // the socket's frame is world up (Rx(−90°)·[0,0,1] = [0, 1, 0])
    const tilt = { "swing.seat": { to: "swing", offset: [0, 1, 0], q: [-Math.SQRT1_2, 0, 0, Math.SQRT1_2] } };
    const byTilt = eff("crate", view(ents, { ...tilt, crate: { to: "swing.seat", offset: [0, 0, 1] } }), T0);
    check("a tilted socket's whole rotation carries its cargo (q, not just a heading)", byTilt.ok && near3(byTilt.pos, [0, 2, 0]), JSON.stringify(byTilt));
  }

  // parent yaw + non-1 scalar scale: offset [1,0,0] under yaw π/2, scale 2
  // rotY(π/2): [x,z] → [x·cosθ + z·sinθ, −x·sinθ + z·cosθ]; [2,0] → [0,−2]
  {
    const r = eff("crate", view(
      { boat: { pos: [10, 0, 10], yaw: Math.PI / 2, scale: 2 }, crate: { pos: [0, 0, 0], scale: 3 } },
      { crate: { to: "boat", offset: [1, 0, 0] } }), T0);
    check("parent yaw rotates the offset", r.ok && near3(r.pos, [10, 0, 8]), JSON.stringify(r));
    check("parent scale scales the offset, scales multiply down", r.ok && near(r.yaw, Math.PI / 2) && near(r.scale, 6), JSON.stringify(r));
  }

  // moving parent (pendulum) at two explicit nowMs.
  // θ(t) = amp·e^{-damp·t}·cos(2π t/period + phase); axis x, pivot p, socket s.
  // Swing shift = p − q·p (yaw 0); crate = swingPos + q·s.
  //   t=0: θ=0.5 → y = 2.4 − 1.85·cos(0.5), z = 10 − 1.85·sin(0.5)
  //   t=1s (¼ period of 4s): θ = 0.5·cos(π/2) ≈ 0 → crate at rest point (10, 0.55, 10)
  {
    const ents = {
      swing: { pos: [10, 0, 10], yaw: 0, motion: { type: "pendulum", axis: "x", pivot: [0, 2.4, 0], amp: 0.5, period: 4, damp: 0, t0: T0 } },
      "swing.seat": { pos: [0, 0.55, 0], socket: { name: "seat" } },
      crate: { pos: [3, 0, 3], yaw: 0 },
    };
    const v = view(ents, { "swing.seat": { to: "swing", offset: [0, 0.55, 0] }, crate: { to: "swing.seat" } });
    const r1 = eff("crate", v, T0);
    const r2 = eff("crate", v, T0 + 1000);
    const y1 = 2.4 - 1.85 * Math.cos(0.5), z1 = 10 - 1.85 * Math.sin(0.5);
    check("pendulum parent, phase 1: hand-computed", r1.ok && near3(r1.pos, [10, y1, z1]), JSON.stringify(r1));
    check("pendulum parent, phase 2: back through rest", r2.ok && near3(r2.pos, [10, 0.55, 10], 1e-3), JSON.stringify(r2));
    check("two nowMs, two positions", r1.ok && r2.ok && !near3(r1.pos, r2.pos, 1e-3));
    check("the moving link is named", r1.ok && r1.moving === "pendulum", JSON.stringify(r1.ok && r1.moving));
  }

  // nested root mounts on a path-motion grandparent.
  // path [[0,0,0]→[10,0,0]], speed 1, 'once', t=5s → ferry (5,0,0), yaw atan2(10,0)=π/2.
  // Offsets [0,1,0] are yaw-invariant → pallet (5,1,0), crate (5,2,0).
  {
    const ents = {
      ferry: { pos: [0, 0, 0], yaw: 0, motion: { type: "path", points: [[0, 0, 0], [10, 0, 0]], speed: 1, loop: "once", t0: T0 } },
      pallet: { pos: [90, 0, 90], yaw: 0 }, crate: { pos: [80, 0, 80], yaw: 0 },
    };
    const v = view(ents, { pallet: { to: "ferry", offset: [0, 1, 0] }, crate: { to: "pallet", offset: [0, 1, 0] } });
    const r = eff("crate", v, T0 + 5000);
    check("nested mounts compose recursively", r.ok && near3(r.pos, [5, 2, 0]) && near(r.yaw, Math.PI / 2), JSON.stringify(r));
  }

  // a body seat: no entity record, on a socket child → the socket itself (the browser's mountTransform)
  {
    const r = eff("rider", view({ bench: { pos: [4, 0, 4], yaw: 0 }, "bench.seat": { pos: [0, 0.5, 0], socket: { name: "seat", body: {} } } },
      { "bench.seat": { to: "bench", offset: [0, 0.5, 0] }, rider: { to: "bench.seat" } }), T0);
    check("a mounted body sits on its socket", r.ok && near3(r.pos, [4, 0.5, 4]), JSON.stringify(r));
  }

  // refusals: every bad link is named, no number escapes
  {
    const cyc = eff("a", view({ a: { pos: [0, 0, 0] }, b: { pos: [1, 1, 1] } }, { a: { to: "b" }, b: { to: "a" } }), T0);
    check("cycle: refused and named", !cyc.ok && /cycle/.test((cyc as any).why), JSON.stringify(cyc));

    const deepEnts: any = {}, deepMounts: any = {};
    for (let i = 0; i <= 10; i++) { deepEnts[`c${i}`] = { pos: [i, 0, 0] }; if (i > 0) deepMounts[`c${i}`] = { to: `c${i - 1}` }; }
    const deep = eff("c10", view(deepEnts, deepMounts), T0);
    check("over-deep chain: refused", !deep.ok && /deeper/.test((deep as any).why), JSON.stringify(deep));

    const orphan = eff("crate", view({ crate: { pos: [0, 0, 0] } }, { crate: { to: "ghost" } }), T0);
    check("missing parent: refused, link names the parent", !orphan.ok && (orphan as any).link === "ghost", JSON.stringify(orphan));

    const nan = eff("crate", view({ boat: { pos: [0, 0, 0] }, crate: { pos: [0, 0, 0] } }, { crate: { to: "boat", offset: [1, NaN, 0] } }), T0);
    check("non-finite offset: refused, never substituted", !nan.ok && /non-finite/.test((nan as any).why), JSON.stringify(nan));

    const part = eff("crate", view(
      { swing: { pos: [0, 0, 0] }, "swing.seat": { pos: [0, -0.83, 0], socket: { name: "seat", part: "plank" } }, crate: { pos: [0, 0, 0] } },
      { "swing.seat": { to: "swing", offset: [0, -0.83, 0] }, crate: { to: "swing.seat" } }), T0);
    check("part socket: honestly unsupported in slice one", !part.ok && /part "plank"/.test((part as any).why), JSON.stringify(part));

    const wig = eff("crate", view(
      { ufo: { pos: [0, 0, 0], motion: { type: "wiggle", t0: T0 } }, crate: { pos: [0, 0, 0] } },
      { crate: { to: "ufo" } }), T0);
    check("unknown motion type on a link: refused and named", !wig.ok && /wiggle/.test((wig as any).why), JSON.stringify(wig));
  }

  // part-frame motion does not displace the root (and reports the chain still)
  {
    const r = eff("mill", view({ mill: { pos: [7, 0, 7], yaw: 0.3, motion: { type: "spin", part: "blades", t0: T0 } } }, {}), T0 + 9000);
    check("part motion leaves the root at base", r.ok && near3(r.pos, [7, 0, 7]) && r.moving === null, JSON.stringify(r));
  }
}

// ---- look(): the sense organ itself ----------------------------------------
console.log("\n━━ look(): stale coordinates are gone from perception ━━");

const crateLine = (txt: string) => txt.split("\n").find((l) => l.includes("[crate1]")) ?? "";
const distOf = (line: string) => { const m = line.match(/:\s*([\d.]+)m\s+(\w+)\s+at\s+\(/); return m ? { d: Number(m[1]), b: m[2] } : null; };

// the founding contradiction: mounted cargo printed at its pre-mount spot
{
  const a = offlineAgent();
  await fold(a, { verb: "spawn", args: { id: "swing1", lib: "models/bench.glb", pos: [10, 0, 10], yaw: 0 } });
  await fold(a, { verb: "spawn", args: { id: "crate1", lib: "models/crate.glb", pos: [3, 0, 3], yaw: 0 } });
  await fold(a, { verb: "comp", args: { id: "swing1", type: "sockets", data: { seat: { pos: [0, 0.55, 0] } } } });
  await fold(a, { verb: "mount", args: { id: "crate1", to: "swing1", slot: "seat" } });
  const line = crateLine(a.look(T0));
  check("mounted cargo reports the carrier's frame", line.includes("at (10.0, 0.6, 10.0)"), line);
  check("the stale pre-mount coordinate is GONE", !line.includes("(3.0, 0.0, 3.0)"), line);
  check("still says what it rides", line.includes("mounted on swing1 (seat)"), line);

  // dismount stamps an authoritative absolute — perception returns to it
  await fold(a, { verb: "dismount", args: { id: "crate1", pos: [1, 2, 3], yaw: 0.7 } });
  const after = crateLine(a.look(T0));
  check("dismount restores the stamped absolute", after.includes("at (1.0, 2.0, 3.0)") && !after.includes("mounted on"), after);
  a.close();
}

// distance and bearing move with the effective position, not just the tuple
{
  const a = offlineAgent();
  await fold(a, { verb: "spawn", args: { id: "wheel", lib: "models/wheel.glb", pos: [0, 0, 0], yaw: 0 } });
  await fold(a, { verb: "motion", args: { id: "wheel", type: "orbit", center: [0, 0, 0], radius: 5, degPerSec: 90, face: false, t0: T0 } });
  await fold(a, { verb: "spawn", args: { id: "crate1", lib: "models/crate.glb", pos: [50, 0, 50], yaw: 0 } });
  await fold(a, { verb: "mount", args: { id: "crate1", to: "wheel", offset: [0, 1, 0] } });
  // orbit: pos = center + r·(sin a, ·, cos a); a = 90°/s. t=0 → (0,·,5) = S of
  // the origin-standing agent; t=2s → a=π → (0,·,−5) = N. Same distance.
  const p1 = distOf(crateLine(a.look(T0)));
  const p2 = distOf(crateLine(a.look(T0 + 2000)));
  check("bearing follows the ride (S → N)", p1?.b === "S" && p2?.b === "N", JSON.stringify({ p1, p2 }));
  check("distance is measured to the effective position", p1 != null && near(p1.d, 5, 0.15) && p2 != null && near(p2.d, 5, 0.15), JSON.stringify({ p1, p2 }));
  a.close();
}

// the sort walks the composed world too: cargo on a far carrier lists far
{
  const a = offlineAgent();
  // near1 sits at 5m — FARTHER than the crate's stale 4.2m, so a sort on
  // stale positions lists the crate first and this check fails on main
  await fold(a, { verb: "spawn", args: { id: "near1", lib: "models/rock.glb", pos: [5, 0, 0], yaw: 0 } });
  await fold(a, { verb: "spawn", args: { id: "far1", lib: "models/bench.glb", pos: [30, 0, 30], yaw: 0 } });
  await fold(a, { verb: "spawn", args: { id: "crate1", lib: "models/crate.glb", pos: [3, 0, 3], yaw: 0 } });
  await fold(a, { verb: "mount", args: { id: "crate1", to: "far1", offset: [0, 1, 0] } });
  const txt = a.look(T0);
  check("distance sort uses the effective position", txt.indexOf("[near1]") < txt.indexOf("[crate1]"), txt.split("\n").filter((l) => l.includes("[")).join(" | "));
  a.close();
}

// suppression in the sense organ: part sockets and unknown motion say WHY
{
  const a = offlineAgent();
  await fold(a, { verb: "spawn", args: { id: "swing2", lib: "models/swing.glb", pos: [5, 0, 5], yaw: 0 } });
  await fold(a, { verb: "comp", args: { id: "swing2", type: "sockets", data: { seat: { pos: [0, -0.83, 0], part: "plank" } } } });
  await fold(a, { verb: "spawn", args: { id: "crate1", lib: "models/crate.glb", pos: [3, 0, 3], yaw: 0 } });
  await fold(a, { verb: "mount", args: { id: "crate1", to: "swing2", slot: "seat" } });
  const line = crateLine(a.look(T0));
  check("part socket: coordinate withheld, frame named", line.includes("position rides swing2 (seat)") && !/at \(/.test(line), line);
  check("part socket: the reason is spoken", /part "plank"/.test(line), line);

  await fold(a, { verb: "spawn", args: { id: "ufo1", lib: "models/ufo.glb", pos: [8, 0, 8], yaw: 0 } });
  await fold(a, { verb: "motion", args: { id: "ufo1", type: "wiggle", t0: T0 } });
  const uline = a.look(T0).split("\n").find((l) => l.includes("[ufo1]")) ?? "";
  check("unknown motion: no guessed coordinate", uline.includes("position unavailable") && /wiggle/.test(uline), uline);
  a.close();
}

// the agent's own seat: distances measured from where the body actually is
{
  const a = offlineAgent();
  await fold(a, { verb: "spawn", args: { id: "swing1", lib: "models/bench.glb", pos: [10, 0, 10], yaw: 0 } });
  await fold(a, { verb: "comp", args: { id: "swing1", type: "sockets", data: { seat: { pos: [0, 0.55, 0] } } } });
  await fold(a, { verb: "mount", args: { id: "tester", to: "swing1", slot: "seat" } });
  const head = a.look(T0).split("\n")[0];
  check("self position rides the seat", head.includes("at (10.0, 10.0)"), head);
  check("the seat is named", head.includes("seated on swing1"), head);
  a.close();
}

// another body's seat rides its presence frame as a socket id; an older client's {to: host, slot} names that host's
// socket child of that name (shared/sockbody.js resolveSeat, one release) — and its line says where, by name
{
  const a = offlineAgent();
  await fold(a, { verb: "spawn", args: { id: "swing1", lib: "models/bench.glb", pos: [10, 0, 10], yaw: 0 } });
  await fold(a, { verb: "comp", args: { id: "swing1", type: "sockets", data: { seat: { pos: [0, 0.55, 0], body: {} } } } });
  const A = a as any;
  A.notePose("bob", { p: [10, 0, 10], yaw: 0, speed: 0, clip: "sitchair", seat: { to: "swing1", slot: "seat" } }, T0);
  const old = A.mounts.get("bob")?.to;
  A.notePose("cal", { p: [10, 0, 10], yaw: 0, speed: 0, clip: "sitchair", seat: { to: "swing1.seat" } }, T0);
  check("a presence seat: {to: <socket id>} as sent; the old {to: host, slot} resolves to that socket child", old === "swing1.seat" && A.mounts.get("cal")?.to === "swing1.seat", JSON.stringify([old, A.mounts.get("cal")]));
  const pl = a.look(T0).split("\n").find((l) => l.includes("- bob:")) ?? "";
  check("…and look says where they sit: the thing and its seat's name", /on swing1 \(seat\)/.test(pl), pl);
  a.close();
}

// folded replay is EVENT-SILENT: state reconstructs, nothing performs
{
  const a = offlineAgent();
  let events = 0;
  a.onEvent = () => { events++; };
  await fold(a, { verb: "spawn", args: { id: "swing1", lib: "models/bench.glb", pos: [10, 0, 10], yaw: 0 }, actor: "digi" });
  await fold(a, { verb: "comp", args: { id: "swing1", type: "particles", data: { preset: "fire" } }, actor: "digi" });
  await fold(a, { verb: "motion", args: { id: "swing1", type: "pendulum", amp: 0.3, t0: T0 }, actor: "digi" });
  await fold(a, { verb: "spawn", args: { id: "crate1", lib: "models/crate.glb", pos: [3, 0, 3] }, actor: "digi" });
  await fold(a, { verb: "mount", args: { id: "crate1", to: "swing1" }, actor: "digi" });
  a.look(T0);
  check("no invented event during folded replay", events === 0 && a.pings.length === 0, `events=${events} pings=${a.pings.length}`);
  a.close();
}

// live and folded-join shapes agree: one composition path, byte-identical line
{
  const live = offlineAgent();
  for (const e of [
    { verb: "spawn", args: { id: "swing1", lib: "models/bench.glb", pos: [10, 0, 10], yaw: 0 } },
    { verb: "comp", args: { id: "swing1", type: "sockets", data: { seat: { pos: [0, 0.55, 0] } } } },
    { verb: "spawn", args: { id: "crate1", lib: "models/crate.glb", pos: [3, 0, 3], yaw: 0 } },
  ]) await fold(live, e, true);
  await fold(live, { verb: "mount", args: { id: "crate1", to: "swing1", slot: "seat" } }, true);

  const folded = offlineAgent();
  // the synthetic order a folded join produces (stateToEntries): spawns,
  // then comps, then the mount recovered from entities[].parent — live=false
  for (const e of [
    { verb: "spawn", args: { id: "swing1", lib: "models/bench.glb", pos: [10, 0, 10], yaw: 0 } },
    { verb: "spawn", args: { id: "crate1", lib: "models/crate.glb", pos: [3, 0, 3], yaw: 0 } },
    { verb: "comp", args: { id: "swing1", type: "sockets", data: { seat: { pos: [0, 0.55, 0] } } } },
    { verb: "mount", args: { id: "crate1", to: "swing1", slot: "seat" } },
  ]) await fold(folded, e, false);

  const a = crateLine(live.look(T0)), b = crateLine(folded.look(T0));
  check("live mount and folded late join agree exactly", a === b && a.length > 0, `live: ${a}\n      fold: ${b}`);
  live.close(); folded.close();
}

// ---- #92 review: B1 — motion runs on SEQUENCER time, not the host clock ----
console.log("\n━━ B1: sequencer-relative clock ━━");
{
  const a = offlineAgent();
  // the embodied plane's frame stamps say the sequencer is 7s AHEAD of this
  // host; the motion's t0 is in the host's present — so the true phase is
  // t ≈ 7s, and a host-clock evaluation reads t ≈ 0 instead
  const skew = 7000;
  // optional-called so a pre-revision head FAILS the checks below by phase
  // rather than crashing the file — the control stays a control
  for (let i = 0; i < 3; i++) (a as any).noteServerTime?.(Date.now() + skew);
  const t0 = Date.now();
  await fold(a, { verb: "spawn", args: { id: "swing1", lib: "models/bench.glb", pos: [10, 0, 10], yaw: 0 } });
  await fold(a, { verb: "comp", args: { id: "swing1", type: "sockets", data: { seat: { pos: [0, 0.55, 0] } } } });
  await fold(a, { verb: "motion", args: { id: "swing1", type: "pendulum", axis: "x", pivot: [0, 2, 0], amp: 1, period: 20, damp: 0, t0 } });
  await fold(a, { verb: "spawn", args: { id: "crate1", lib: "models/crate.glb", pos: [3, 0, 3], yaw: 0 } });
  await fold(a, { verb: "mount", args: { id: "crate1", to: "swing1", slot: "seat" } });
  // crate = base + [0, 2 − 1.45·cosθ, −1.45·sinθ];  θ(7s) = cos(2π·7/20) ≈ −0.5885
  // → (10.0, 0.8, 10.8).  A host-clock evaluation gives θ(0) = 1 → (10.0, 1.2, 8.8).
  const def = crateLine(a.look());
  check("default look() evaluates on sequencer time", def.includes("at (10.0, 0.8, 10.8)"), def);
  const explicit = crateLine(a.look(Date.now()));
  check("explicit nowMs is still honored verbatim", explicit.includes("at (10.0, 1.2, 8.8)"), explicit);
  a.close();
}

// ---- #92 review: B2 — refusals never fall back to stale coordinates --------
console.log("\n━━ B2: no stale fallbacks ━━");

// (1) the sort: an unresolved thing makes no spatial claim — it lists last
{
  const a = offlineAgent();
  await fold(a, { verb: "spawn", args: { id: "far1", lib: "models/bench.glb", pos: [30, 0, 30], yaw: 0 } });
  await fold(a, { verb: "spawn", args: { id: "swing2", lib: "models/swing.glb", pos: [5, 0, 5], yaw: 0 } });
  await fold(a, { verb: "comp", args: { id: "swing2", type: "sockets", data: { seat: { pos: [0, 0.5, 0], part: "plank" } } } });
  await fold(a, { verb: "spawn", args: { id: "crate1", lib: "models/crate.glb", pos: [1, 0, 1], yaw: 0 } });
  await fold(a, { verb: "mount", args: { id: "crate1", to: "swing2", slot: "seat" } });
  const txt = a.look(T0);
  check("unresolved cargo lists after resolved things, not by its stale 1.4m", txt.indexOf("[far1]") < txt.indexOf("[crate1]"),
    txt.split("\n").filter((l) => l.includes("[")).join(" | "));
  a.close();
}

// (2) the emitter gate: unknown position → abstain + bounded diagnostic
{
  const a = offlineAgent();
  let events = 0;
  a.onEvent = () => { events++; };
  await fold(a, { verb: "spawn", args: { id: "swing2", lib: "models/swing.glb", pos: [5, 0, 5], yaw: 0 } });
  await fold(a, { verb: "comp", args: { id: "swing2", type: "sockets", data: { seat: { pos: [0, 0.5, 0], part: "plank" } } } });
  await fold(a, { verb: "spawn", args: { id: "lantern", lib: "models/lantern.glb", pos: [1, 0, 1], yaw: 0 } });
  await fold(a, { verb: "mount", args: { id: "lantern", to: "swing2", slot: "seat" } });
  await fold(a, { verb: "comp", args: { id: "lantern", type: "particles", data: { preset: "fire" } }, actor: "digi" }, true);
  check("unresolvable emitter abstains from proximity delivery", events === 0 && a.effGaps > 0, `events=${events} gaps=${a.effGaps}`);
  await fold(a, { verb: "spawn", args: { id: "hearth", lib: "models/hearth.glb", pos: [10, 0, 10], yaw: 0 } });
  await fold(a, { verb: "comp", args: { id: "hearth", type: "particles", data: { preset: "fire" } }, actor: "digi" }, true);
  check("a resolvable emitter still delivers", events === 1, `events=${events}`);
  a.close();
}

// (3) the mounted self: unknown is SAID, and dependent distances are withheld
{
  const a = offlineAgent();
  await fold(a, { verb: "spawn", args: { id: "swing2", lib: "models/swing.glb", pos: [5, 0, 5], yaw: 0 } });
  await fold(a, { verb: "comp", args: { id: "swing2", type: "sockets", data: { seat: { pos: [0, 0.5, 0], part: "plank" } } } });
  await fold(a, { verb: "spawn", args: { id: "rock1", lib: "models/rock.glb", pos: [2, 0, 2], yaw: 0 } });
  await fold(a, { verb: "mount", args: { id: "tester", to: "swing2", slot: "seat" } });
  const txt = a.look(T0);
  const head = txt.split("\n")[0];
  check("own unresolved seat: position unknown, said out loud", head.includes("position unknown") && /part "plank"/.test(head) && head.includes("seated on swing2"), head);
  check("no distance/bearing is measured from a ghost", !/\d+\.\d+m /.test(txt), txt.split("\n").find((l) => /\d+\.\d+m /.test(l)));
  check("resolved coordinates still print (facts survive)", txt.includes("[rock1]") && /\[rock1\][^\n]*at \(2\.0, 0\.0, 2\.0\)/.test(txt), txt);
  a.close();
}

// ---- #92 review, precision: cargo's own root motion is inert while mounted -
console.log("\n━━ precision: mount chain wins over own motion ━━");
{
  const a = offlineAgent();
  await fold(a, { verb: "spawn", args: { id: "swing1", lib: "models/bench.glb", pos: [10, 0, 10], yaw: 0 } });
  await fold(a, { verb: "comp", args: { id: "swing1", type: "sockets", data: { seat: { pos: [0, 0.55, 0] } } } });
  await fold(a, { verb: "spawn", args: { id: "crate1", lib: "models/crate.glb", pos: [3, 0, 3], yaw: 0 } });
  await fold(a, { verb: "motion", args: { id: "crate1", type: "orbit", center: [3, 0, 3], radius: 4, degPerSec: 90, t0: T0 - 60_000 } });
  await fold(a, { verb: "mount", args: { id: "crate1", to: "swing1", slot: "seat" } });
  // the renderer skips a mounted entity's own motion (motion.js tickMotion:
  // `obj.userData.mountedTo` guard) — the seat, not the orbit, is the truth
  const line = crateLine(a.look(T0));
  check("own root motion is inert while mounted (matches the renderer)", line.includes("at (10.0, 0.6, 10.0)"), line);
  await fold(a, { verb: "dismount", args: { id: "crate1", pos: [3, 0, 3], yaw: 0 } });
  const after = crateLine(a.look(T0 + 1000));
  // dismounted, the orbit resumes: a = 90°/s · 61s = 5490° ≡ 90° → (3+4, 0, 3+0)
  check("own motion resumes on dismount", after.includes("at (7.0, 0.0, 3.0)"), after);
  a.close();
}

// ---- body size (pose.scale): a profiled seat's contact is measured at the
// rider's AUTHORED size, so it multiplies the rider's chosen size — the
// browser's seats.js riderScalar(root × avatar.bodyScale()) — and nothing else.
console.log("\n━━ body size: a profiled seat lowers a scaled rider in proportion ━━");
if (EFF) {
  // chair at the origin, unscaled; a surface socket 0.5 up; contact plane 0.45
  // below the rider root at authored size → root y = 0.5 − 0.45·u
  // the seat: a socket child whose body anchors at the surface (D14)
  const chair = { pos: [0, 0, 0], yaw: 0, scale: 1 };
  const seat = { pos: [0, 0.5, 0], yaw: 0, socket: { name: "seat", body: { anchor: "surface", pose: "sitchair" } } };
  const seatMount = { to: "chair", offset: [0, 0.5, 0] };
  const view = (riderScale?: (id: string) => number) => ({
    entity: (id: string) => (id === "chair" ? chair : id === "chair.seat" ? seat : undefined),
    mount: (id: string) => (id === "rider" ? { to: "chair.seat" } : id === "chair.seat" ? seatMount : undefined),
    seatVerdict: () => ({ status: "countersigned", pose: "sitchair", contactY: 0.45 }),
    ...(riderScale ? { riderScale } : {}),
  });
  for (const [u, y] of [[1, 0.05], [0.5, 0.275], [2, -0.4]] as const) {
    const r = EFF.effectiveWorldTransform("rider", view(() => u), T0);
    check(`a ${u}× rider's root sits at y = 0.5 − 0.45·${u} = ${y}`, r.ok && near3(r.pos, [0, y, 0]) && r.seat?.state === "profiled", JSON.stringify(r));
  }
  const absent = EFF.effectiveWorldTransform("rider", view(), T0);
  check("a view without riderScale reads the rider as 1×", absent.ok && near3(absent.pos, [0, 0.05, 0]), JSON.stringify(absent));

  // the agent's own view feeds riderScale from the rider's presence sample
  // (clamped; absent = 1) — the seam the text tier's seated perception reads
  const a = offlineAgent() as any;
  a.entities.set("chair", { id: "chair", model: "x.glb", actor: "t", ...chair });
  a.entities.set("chair.seat", { id: "chair.seat", model: "", actor: "t", ...seat });
  a.mounts.set("chair.seat", seatMount);
  a.mounts.set("rider", { to: "chair.seat" });
  a.seatVerdictFor = () => ({ status: "countersigned", pose: "sitchair", contactY: 0.45 });
  a.people.set("rider", { id: "rider", avatar: "", pose: { p: [0, 0, 0], yaw: 0, speed: 0, clip: "sitchair", scale: 2 } });
  const big = a.eff("rider", T0);
  check("the agent seats a 2× rider (presence scale 2) at y = −0.4", big.ok && near3(big.pos, [0, -0.4, 0]), JSON.stringify(big));
  a.people.get("rider").pose.scale = 9;
  check("…and clamps an untrusted presence scale (9 → 2)", near3(a.eff("rider", T0).pos, [0, -0.4, 0]));
  delete a.people.get("rider").pose.scale;
  check("…and an absent presence scale is 1×", near3(a.eff("rider", T0).pos, [0, 0.05, 0]));
  a.close();
}

console.log("");
process.exit(failures ? 1 : 0);
