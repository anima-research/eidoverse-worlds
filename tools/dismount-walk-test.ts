// Getting off a seat stamps where the ride ACTUALLY let go (#18).
//
//   bun tools/dismount-walk-test.ts             # spawns its own scratch server
//   URL=ws://host:8940/ws bun tools/...         # or against a running one
//
// The reported failure: FC mounts a chair, calls walk_to without dismounting,
// and "teleports to a stale ground position" once the seat lets go. The verb
// was never the missing piece — walkTo has emitted `dismount` for some time.
// What it emitted was BARE: no pos, no yaw. The server's own handler calls the
// absolute stamp a "plane-transition invariant", the browser has stamped one
// since sockets existed (client/main.js dismountMe), and a headless body
// stamped nothing — so its `pos` kept the pre-mount ground coordinate and the
// first stride started from wherever it had sat down.
//
// Every assertion here is therefore a LANDING: where `pos` is the instant the
// mount clears, read synchronously out of walkTo before a single step is
// taken. The seats are placed far from the body's standing spot, and the
// ferries carry it further, so "stamped" and "stale" are never within metres
// of each other — nothing below is a near-miss.
//
// Determinism: the moving seats use `path` with an explicit `t0` and
// `loop: 'once'`, so the ferry has provably ALREADY ARRIVED at its endpoint
// and sits there. The one deliberately mid-flight case asserts a bounded
// window plus "it moved between two samples", never an exact coordinate.
//
// On unmodified main the stamping cases fail with the landing sitting on the
// body's pre-mount position — the bug, printed.

import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Bun 1.3.x caches transpiled module graphs globally by content, so a stale
// plugin-resolved path can bypass onResolve entirely and leave the headless
// sim "unavailable". Same guard as the rest of the suite (#13) — this file
// reaches the plugin indirectly, through WorldAgent -> physics.ts.
if (process.env.__EIDO_TEST_CACHE_OFF !== '1') {
  const child = Bun.spawnSync({
    cmd: [process.execPath, import.meta.path, ...process.argv.slice(2)],
    env: {
      ...process.env,
      BUN_RUNTIME_TRANSPILER_CACHE_PATH: '0',
      __EIDO_TEST_CACHE_OFF: '1',
    },
    stdout: 'inherit',
    stderr: 'inherit',
  });
  process.exit(child.exitCode ?? 1);
}

const { WorldAgent } = await import("../mcpl/agent.ts");

const EXTERNAL = process.env.URL;
const PORT = Number(process.env.PORT ?? 8992);
const URL_ = EXTERNAL ?? `ws://127.0.0.1:${PORT}/ws`;
const TOKEN = process.env.TOKEN ?? "";
const worldsDir = mkdtempSync(join(tmpdir(), "ew-dismount-"));
const LIB = "eidoverse/assets/models/crate_large_red.glb";
/** A second model, for the one case that needs a /geom fetch to actually go
 *  out: the agent caches geometry per LIB, not per entity. */
const LIB2 = "eidoverse/assets/models/crate_large_blue.glb";

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  else { fail++; console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? ` — ${detail}` : ""}`); }
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const near = (a: number, b: number, tol = 0.06) => Math.abs(a - b) <= tol;

// ---- server ----------------------------------------------------------------

let server: ReturnType<typeof spawn> | null = null;
async function startServer() {
  if (EXTERNAL) return;
  server = spawn("bun", [join(import.meta.dir, "..", "server", "server.ts")], {
    env: { ...process.env, PORT: String(PORT), WORLDS_DIR: worldsDir, JOIN_TOKEN: "",
           VERB_RATE: "5000", MSG_RATE: "5000" },
    stdio: "ignore",
  });
  for (let i = 0; i < 80; i++) {
    try { if ((await fetch(`http://127.0.0.1:${PORT}/avatars`)).ok) return; } catch { /* not up */ }
    await sleep(100);
  }
  throw new Error("server did not start");
}

/** A bare socket that joins and authors — the "someone else" whose acts the
 *  agent must fold, and who can take a body off its seat. */
function human(world: string, name: string): Promise<{
  verb: (v: string, a: any) => void; close: () => void;
}> {
  return new Promise((res) => {
    const ws = new WebSocket(`${URL_}?name=${name}`);
    ws.onopen = () => ws.send(JSON.stringify({ type: "join", world, id: name, token: TOKEN }));
    ws.onmessage = (e) => {
      if (JSON.parse(String(e.data)).type === "snapshot") res({
        verb: (v, a) => ws.send(JSON.stringify({ type: "verb", verb: v, args: a })),
        close: () => ws.close(),
      });
    };
  });
}

await startServer();

const W = `dw-${Math.random().toString(36).slice(2, 8)}`;
const h = await human(W, "author");
await sleep(300);

/** Spawn a seat with a declared socket. `motion` rides along when given. */
function seat(id: string, pos: number[], socket: any, motion?: any) {
  h.verb("spawn", { id, lib: LIB, pos, yaw: 0 });
  h.verb("comp", { id, type: "sockets", data: { perch: socket } });
  if (motion) h.verb("motion", { id, ...motion });
}

/** Put the agent on a seat and wait for the log echo to land in `mounts`. */
async function mount(ag: any, to: string, slot: string | undefined, extra: any = {}) {
  ag.verb("mount", { id: ag.name, to, ...(slot ? { slot } : {}), ...extra });
  for (let i = 0; i < 60; i++) { if (ag.mounts.has(ag.name)) return true; await sleep(50); }
  return false;
}

/** The landing: `pos` the instant the mount clears, read synchronously out of
 *  walkTo before any stride. walkTo's promise is deliberately not awaited here
 *  — the walk is a separate concern, and awaiting it would report the
 *  DESTINATION, which is the same on a fixed and a broken build. */
/** The direct door, tolerantly: on a build that predates it the method does
 *  not exist, and a control must FAIL its checks rather than crash out of the
 *  ones after it. */
const selfDismount = (a: any) => (typeof a.dismountSelf === "function" ? a.dismountSelf() : null);

function landingOfWalk(ag: any, x: number, z: number) {
  const p = ag.walkTo(x, z, false, 20_000);
  const at = { x: ag.pos.x, y: ag.pos.y, z: ag.pos.z, yaw: ag.yaw };
  ag.stop();                       // we measured the stamp; don't walk the map
  void p.catch(() => {});
  return at;
}

console.log("\ndismount stamps the landing (#18):\n");

// ---------------------------------------------------------------- static seat
// A chair 13m from where the body stands. On main the landing is the body's
// own pre-mount spot; the seat's position never enters the arithmetic.
const ag: any = new WorldAgent({ url: URL_, name: "dw-bot", world: W });
await ag.connect();
await sleep(400);
ag.pos.x = 0; ag.pos.z = 0;

seat("chair", [12, 0, -6], { pos: [0, 0.5, 0], yaw: 0 });
await sleep(400);
check("setup: the agent folded the chair", ag.entities.has("chair"));

check("setup: it takes the seat", await mount(ag, "chair", "perch"));
const stale = { x: ag.pos.x, z: ag.pos.z };
const L1 = landingOfWalk(ag, 12, 0);
// socket [0,0.5,0] on a yaw-0 parent, then 0.7m along the seat's facing (+z)
check("a walk off a static seat lands AT THE SEAT, not where the body sat down",
  near(L1.x, 12) && near(L1.z, -6 + 0.7),
  `landed (${L1.x.toFixed(2)}, ${L1.z.toFixed(2)}) · seat (12, -6) · stale (${stale.x}, ${stale.z})`);
check("...and the mount is gone locally, without waiting for the echo",
  !ag.mounts.has("dw-bot"));
check("...and the landing is on the ground, not the seat's height",
  near(L1.y, 0), `y=${L1.y.toFixed(2)}`);
check("...and no gap was recorded — the seat resolved", ag.lastDismountGap === null,
  JSON.stringify(ag.lastDismountGap));

// ------------------------------------------------- approximate is not a fallback
// #101 gave eff() a third outcome this file predates. A seat can COMPOSE and
// still report `seat.state: "approximate"`: the avatar profile's contact plane
// was not applied — no profile, a legacy socket, a stale or uncountersigned
// one. That is a real declaration, and look() carries it (agent.ts,
// selfSeatNote) the whole time the body sits there.
//
// It is NOT a landing fallback, and folding it into one would be B1's
// complaint mirrored — a declared seam where there is no seam. The reason it
// cannot reach the landing is closed-form: applySeatCorrection moves the
// socket point along WORLD Y and nothing else (seatcore.js), and dismountSelf
// throws that Y away for heightAt(x, z). So the landing off an approximate
// seat is the SAME hand-computed step a profiled seat yields, and the gap
// stays null. This case exists so a later change cannot quietly conflate the
// two: it fails loudly if `approximate` ever starts moving x/z or raising a
// gap.
ag.pos.x = 0; ag.pos.z = 0;
check("setup: it sits back on the chair", await mount(ag, "chair", "perch"));
const unprofiled = ag.eff(ag.name, ag.serverNow());
// Asserted by SHAPE, not by reason text: which of seatGateCore's refusals this
// harness lands on is #101's business, and pinning the string here would couple
// this file to a vocabulary it does not own. What matters is that the seat
// really is uncorrected — otherwise the checks below pass vacuously.
check("setup: and the seat really is uncorrected (else this case proves nothing)",
  unprofiled.ok === true && unprofiled.seat?.state === "approximate"
    && typeof unprofiled.seat?.reason === "string" && unprofiled.seat.reason.length > 0,
  JSON.stringify(unprofiled.ok ? unprofiled.seat : unprofiled));
const L1b = landingOfWalk(ag, 12, 0);
check("an uncorrected contact plane does not move the landing",
  near(L1b.x, 12) && near(L1b.z, -6 + 0.7),
  `landed (${L1b.x.toFixed(4)}, ${L1b.z.toFixed(4)}) · expected (12.0000, ${(-6 + 0.7).toFixed(4)})`);
check("...and it raises NO gap — an approximate seat is not a fallback",
  ag.lastDismountGap === null, JSON.stringify(ag.lastDismountGap));

// -------------------------------------------------------------- arrived ferry
// `loop: 'once'` with a t0 a minute old: the ferry has finished its run and
// SITS at the endpoint. No clock sensitivity anywhere in this assertion.
seat("ferry", [0, 0, 0], { pos: [0, 0.5, 0], yaw: 0 }, {
  type: "path", points: [[0, 0, 0], [30, 0, 0]], speed: 10, loop: "once",
  face: false, t0: Date.now() - 60_000,
});
await sleep(400);
ag.pos.x = 0; ag.pos.z = 0;
check("setup: it boards the ferry", await mount(ag, "ferry", "perch"));
const L2 = landingOfWalk(ag, 30, 4);
check("a walk off an ARRIVED ferry lands where the ferry now is, 30m downrange",
  near(L2.x, 30) && near(L2.z, 0.7),
  `landed (${L2.x.toFixed(2)}, ${L2.z.toFixed(2)}) · ferry endpoint (30, 0) · authored (0, 0)`);

// ------------------------------------------------------------ ferry in flight
// The real swing case: the seat is moving WHILE the body decides to leave.
// Bounded window, not an exact coordinate — and the discriminator is that two
// dismounts one second apart land in different places.
seat("tram", [0, 0, 0], { pos: [0, 0.5, 0], yaw: 0 }, {
  type: "path", points: [[0, 0, 20], [60, 0, 20]], speed: 4, loop: "once",
  face: false, t0: Date.now(),
});
await sleep(400);
ag.pos.x = 0; ag.pos.z = 0;
check("setup: it boards the tram", await mount(ag, "tram", "perch"));
const L3 = landingOfWalk(ag, 5, 20);
await sleep(1000);
ag.pos.x = 0; ag.pos.z = 0;
check("setup: it boards the moving tram again", await mount(ag, "tram", "perch"));
const L4 = landingOfWalk(ag, 5, 20);
check("a walk off a MOVING seat lands along its track, near the tram",
  L3.x > 0.5 && L3.x < 40 && near(L3.z, 20.7),
  `landed (${L3.x.toFixed(2)}, ${L3.z.toFixed(2)})`);
check("...and a second dismount a second later lands ~4m further on (it TRACKS)",
  L4.x - L3.x > 2.5 && L4.x - L3.x < 6,
  `first x=${L3.x.toFixed(2)} second x=${L4.x.toFixed(2)} Δ=${(L4.x - L3.x).toFixed(2)}`);

// ------------------------------------------------- the seat leaves afterwards
// "Deleting the seat after auto-dismount does not move the resident": the
// landing was stamped as an ABSOLUTE, so nothing about it can be re-derived
// from a parent that no longer exists.
ag.pos.x = 0; ag.pos.z = 0;
seat("stool", [-9, 0, 14], { pos: [0, 0.5, 0], yaw: 0 });
await sleep(300);
check("setup: it sits on the stool", await mount(ag, "stool", "perch"));
const L5 = landingOfWalk(ag, -9, 14);
h.verb("remove", { id: "stool" });
await sleep(600);
check("deleting the seat afterwards does not move the resident",
  near(ag.pos.x, L5.x) && near(ag.pos.z, L5.z),
  `landed (${L5.x.toFixed(2)}, ${L5.z.toFixed(2)}) now (${ag.pos.x.toFixed(2)}, ${ag.pos.z.toFixed(2)})`);

// ------------------------------------------------------- standing up, and raw
// setPosture('idle') is the other door onto the same act, and the raw
// `world_verb dismount {id: me}` is the one look() advertises.
ag.pos.x = 0; ag.pos.z = 0;
seat("bench", [7, 0, 21], { pos: [0, 0.5, 0], yaw: 0 });
await sleep(300);
check("setup: it sits on the bench", await mount(ag, "bench", "perch"));
ag.setPosture("idle");
check("standing up stamps the same landing a walk would",
  near(ag.pos.x, 7) && near(ag.pos.z, 21.7),
  `(${ag.pos.x.toFixed(2)}, ${ag.pos.z.toFixed(2)})`);

ag.pos.x = 0; ag.pos.z = 0;
check("setup: it sits on the bench again", await mount(ag, "bench", "perch"));
const at = selfDismount(ag);
check("an explicit self-dismount stamps it too — look() promises exactly this",
  !!at && near(at.x, 7) && near(at.z, 21.7), JSON.stringify(at));
check("...and dismounting while unmounted is a no-op, not a fabricated landing",
  selfDismount(ag) === null);

// --------------------------------------------------------- the refusal ladder
// A socket riding a model PART is geometry this side does not possess, so
// effective.ts refuses it by name. The body must still get off — being stuck
// on an unresolvable seat forever is worse than the bug — but it must not
// silently keep the stale coordinate. It lands on the parent's own frame,
// which we DO resolve, and says so.
ag.pos.x = 0; ag.pos.z = 0;
seat("swing", [18, 0, -22], { pos: [0, 0.5, 0], yaw: 0, part: "rope" });
await sleep(300);
check("setup: it takes the part-mounted swing", await mount(ag, "swing", "perch"));
const L6 = landingOfWalk(ag, 18, -22);
check("an unresolvable seat lands on its PARENT's frame, not the pre-mount spot",
  near(L6.x, 18) && near(L6.z, -22 + 0.7),
  `landed (${L6.x.toFixed(2)}, ${L6.z.toFixed(2)}) · swing (18, -22) · stale (0, 0)`);
check("...and the gap is recorded, naming the link that refused",
  ag.lastDismountGap?.landedOn === "parent" && ag.lastDismountGap?.to === "swing"
  && /part/.test(ag.lastDismountGap?.why ?? ""),
  JSON.stringify(ag.lastDismountGap));

// The bottom rung: a chain deeper than effective.ts will vouch for, so the
// seat AND its parent both refuse. (The door already blocks the obvious way
// to reach this — mounting onto a nonexistent entity is rejected outright —
// so the reachable configuration is a tower.) Nothing resolves, the browser's
// own fallback applies (`sw ? seat : myState.pos`), and it is DECLARED rather
// than performed.
const TOWER = 10;
for (let i = 0; i < TOWER; i++) h.verb("spawn", { id: `c${i}`, lib: LIB, pos: [50 + i, 0, 40], yaw: 0 });
await sleep(400);
for (let i = 1; i < TOWER; i++) h.verb("mount", { id: `c${i}`, to: `c${i - 1}` });
await sleep(500);
ag.pos.x = 3; ag.pos.z = 3; ag.yaw = 0;
check("setup: it mounts the top of a tower deeper than the composer allows",
  await mount(ag, `c${TOWER - 1}`, undefined));
const L7 = landingOfWalk(ag, 3, 5);
check("a seat that resolves NOWHERE falls back to the last stamped position",
  near(L7.x, 3) && near(L7.z, 3.7),
  `landed (${L7.x.toFixed(2)}, ${L7.z.toFixed(2)})`);
check("...and says so instead of performing a coordinate",
  ag.lastDismountGap?.landedOn === "stale", JSON.stringify(ag.lastDismountGap));

// ------------------------------------------------- the echo must not yank us
// dismountSelf stamps locally and immediately; the log echo of our OWN
// dismount then arrives ~a round trip later. If that echo applied, a body
// that had already taken a stride would snap back to the landing point.
ag.pos.x = 0; ag.pos.z = 0;
seat("perch2", [-14, 0, -3], { pos: [0, 0.5, 0], yaw: 0 });
await sleep(300);
check("setup: it takes the far perch", await mount(ag, "perch2", "perch"));
landingOfWalk(ag, -14, -3);        // a real dismount goes onto the wire
ag.pos.x += 5; ag.pos.z += 5;      // stand in for the stride taken meanwhile
const moved = { x: ag.pos.x, z: ag.pos.z };
await sleep(800);                   // the echo of our own dismount arrives here
check("the echo of our OWN dismount does not snap the body back to the landing",
  near(ag.pos.x, moved.x) && near(ag.pos.z, moved.z),
  `moved to (${moved.x.toFixed(2)}, ${moved.z.toFixed(2)}) now (${ag.pos.x.toFixed(2)}, ${ag.pos.z.toFixed(2)})`);

// ------------------------------------- a parked tumble must not overwrite it
// Stamping a landing takes authority over the body, so it has to outrank an
// act already suspended on an await — the failure mode that cost this branch's
// predecessor two rounds of review (#53: a suspended tumble resumed after the
// drag ended and clobbered the settle). Forced deterministically: delay /geom,
// so the tumble parks inside supportReady() with a pending support, and
// dismount while it is demonstrably still parked.
const realFetch = globalThis.fetch;
let geomDelay = 0;
globalThis.fetch = (async (...a: any[]) => {
  if (String(a[0]).includes("/geom") && geomDelay) await sleep(geomDelay);
  return realFetch(...(a as any));
}) as any;

// The discriminator is NOT the landing coordinate — a resuming tumble begins
// from wherever `pos` now is, so it would settle the body roughly AT the
// landing and a position assertion would pass either way (checked: it does).
// What differs is whether a sim seizes the body at all. So watch startSim.
let simTookOver = false, tumbleFinished = false;
const origStartSim = ag.startSim.bind(ag);
ag.startSim = (...a: any[]) => { simTookOver = true; return origStartSim(...a); };
const origTumble = ag.tumble.bind(ag);
ag.tumble = async (...a: any[]) => { const r = await origTumble(...a); tumbleFinished = true; return r; };

ag.pos.x = 0; ag.pos.z = 0;
geomDelay = 2500;
// a DIFFERENT model on purpose: geomCache is keyed by lib, so re-spawning the
// crate would be served from cache and suspend nothing at all
h.verb("spawn", { id: "late-deck", lib: LIB2, pos: [-30, 0, 30], yaw: 0 });
await sleep(150);
h.verb("force", { at: [-2, 0, 0], power: 4, radius: 6 });  // a blast: tumble() starts
await sleep(400);                                          // ...and parks on /geom
check("setup: it sits down while a tumble is parked mid-flight",
  await mount(ag, "chair", "perch"));
const stillParked = !tumbleFinished && !simTookOver;
const L8 = selfDismount(ag);
check("setup: the tumble really was still suspended (not a vacuous race)", stillParked,
  `finished=${tumbleFinished} sim=${simTookOver}`);
await sleep(4000);                                    // it resumes in here
check("setup: and it did resume within the window", tumbleFinished);
check("a tumble suspended across the dismount abandons itself — no sim seizes the body",
  !simTookOver);
check("...and the stamped landing still stands",
  !!L8 && near(ag.pos.x, L8.x, 0.1) && near(ag.pos.z, L8.z, 0.1),
  `landed ${JSON.stringify(L8)} now (${ag.pos.x.toFixed(2)}, ${ag.pos.z.toFixed(2)})`);
geomDelay = 0;
globalThis.fetch = realFetch;
ag.startSim = origStartSim; ag.tumble = origTumble;

// ------------------------------------------- someone else takes us off a seat
// The same invariant from the other side: a stamped landing authored by
// another party IS this body's position, and without applying it the body
// keeps the pre-mount coordinate exactly the way #18 describes.
ag.pos.x = 0; ag.pos.z = 0;
check("setup: it sits back down", await mount(ag, "chair", "perch"));
h.verb("dismount", { id: "dw-bot", pos: [41, 0, -17], yaw: 1.25 });
let took = false;
for (let i = 0; i < 60; i++) { if (near(ag.pos.x, 41)) { took = true; break; } await sleep(50); }
check("a dismount authored by someone else stamps this body's landing", took,
  `(${ag.pos.x.toFixed(2)}, ${ag.pos.z.toFixed(2)})`);
check("...and its yaw", near(ag.yaw, 1.25), `yaw=${ag.yaw.toFixed(3)}`);
check("...and the mount is cleared", !ag.mounts.has("dw-bot"));

// ------------------------------------------------------------ late join agrees
// A fresh agent folding the whole log must not believe this body is still
// seated — the second half of #61, which is what folded mounts exist for.
const ag2: any = new WorldAgent({ url: URL_, name: "dw-late", world: W });
await ag2.connect();
await sleep(700);
check("a late joiner folding the log sees no surviving mount for that body",
  !ag2.mounts.has("dw-bot"), JSON.stringify([...ag2.mounts.keys()]));

ag.close?.(); ag2.close?.(); h.close();
await sleep(200);
server?.kill();
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
