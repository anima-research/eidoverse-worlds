/**
 * Effective-transform test — #82: agent perception must report mounted cargo
 * (and moving things) where they ACTUALLY are, or refuse to give a number.
 * No servers needed; time is injected everywhere.
 *
 * Run: cd mcpl && bun run effective-test.ts
 *
 * Fail-on-main controls: the look()-level checks below use only surface that
 * exists on main (WorldAgent, applyEntry, look), so running this file on a
 * pre-#82 checkout demonstrates the stale-coordinate contradiction failing
 * on its own receipts (the pure-module checks report the module as absent).
 *
 * Expected values are HAND-COMPUTED from the closed forms — never from the
 * code under test. Worked math is inline at each case.
 */

import { WorldAgent } from "./agent.ts";

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
try { EFF = await import("./effective.ts"); } catch { /* pre-#82 checkout */ }

const T0 = 1_700_000_000_000;                       // fixed epoch; all time injected

/** An agent that never connects: entries are folded straight through
 *  applyEntry (live=false = replay semantics), the same door join uses. */
function offlineAgent(): WorldAgent {
  return new WorldAgent({ url: "ws://127.0.0.1:9/ws", name: "tester", world: "efftest" });
}
const fold = (a: WorldAgent, entry: { verb: string; args: any; actor?: string }, live = false) =>
  (a as any).applyEntry({ seq: 0, ts: T0, actor: entry.actor ?? "t", ...entry }, live);

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

  // socket default; then mount offset/yaw OVERRIDING socket defaults
  {
    const ents = { swing: { pos: [0, 0, 0], yaw: 0, comp: { sockets: { seat: { pos: [0, 1, 0], yaw: 1 } } } }, crate: { pos: [9, 9, 9], yaw: 0 } };
    const bySock = eff("crate", view(ents, { crate: { to: "swing", slot: "seat" } }), T0);
    check("socket supplies the local frame", bySock.ok && near3(bySock.pos, [0, 1, 0]) && near(bySock.yaw, 1), JSON.stringify(bySock));
    const byMount = eff("crate", view(ents, { crate: { to: "swing", slot: "seat", offset: [0, 2, 0], yaw: 0.5 } }), T0);
    check("mount offset/yaw override socket defaults", byMount.ok && near3(byMount.pos, [0, 2, 0]) && near(byMount.yaw, 0.5), JSON.stringify(byMount));
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
      swing: { pos: [10, 0, 10], yaw: 0, comp: {
        sockets: { seat: { pos: [0, 0.55, 0] } },
        motion: { type: "pendulum", axis: "x", pivot: [0, 2.4, 0], amp: 0.5, period: 4, damp: 0, t0: T0 } } },
      crate: { pos: [3, 0, 3], yaw: 0 },
    };
    const v = view(ents, { crate: { to: "swing", slot: "seat" } });
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
      ferry: { pos: [0, 0, 0], yaw: 0, comp: { motion: { type: "path", points: [[0, 0, 0], [10, 0, 0]], speed: 1, loop: "once", t0: T0 } } },
      pallet: { pos: [90, 0, 90], yaw: 0 }, crate: { pos: [80, 0, 80], yaw: 0 },
    };
    const v = view(ents, { pallet: { to: "ferry", offset: [0, 1, 0] }, crate: { to: "pallet", offset: [0, 1, 0] } });
    const r = eff("crate", v, T0 + 5000);
    check("nested mounts compose recursively", r.ok && near3(r.pos, [5, 2, 0]) && near(r.yaw, Math.PI / 2), JSON.stringify(r));
  }

  // a body seat: no entity record → the browser's [0, 0.5, 0] body default
  {
    const r = eff("rider", view({ bench: { pos: [4, 0, 4], yaw: 0 } }, { rider: { to: "bench" } }), T0);
    check("a mounted body defaults to the seat offset", r.ok && near3(r.pos, [4, 0.5, 4]), JSON.stringify(r));
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
      { swing: { pos: [0, 0, 0], comp: { sockets: { seat: { pos: [0, -0.83, 0], part: "plank" } } } }, crate: { pos: [0, 0, 0] } },
      { crate: { to: "swing", slot: "seat" } }), T0);
    check("part socket: honestly unsupported in slice one", !part.ok && /part "plank"/.test((part as any).why), JSON.stringify(part));

    const wig = eff("crate", view(
      { ufo: { pos: [0, 0, 0], comp: { motion: { type: "wiggle", t0: T0 } } }, crate: { pos: [0, 0, 0] } },
      { crate: { to: "ufo" } }), T0);
    check("unknown motion type on a link: refused and named", !wig.ok && /wiggle/.test((wig as any).why), JSON.stringify(wig));
  }

  // part-frame motion does not displace the root (and reports the chain still)
  {
    const r = eff("mill", view({ mill: { pos: [7, 0, 7], yaw: 0.3, comp: { motion: { type: "spin", part: "blades", t0: T0 } } } }, {}), T0 + 9000);
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
  check("still says what it rides", line.includes("mounted on swing1"), line);

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
  check("part socket: coordinate withheld, frame named", line.includes("position rides swing2") && !/at \(/.test(line), line);
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

console.log("");
process.exit(failures ? 1 : 0);
