// Incident #88: one malformed raw `place` took the whole MCPL door down.
//
//   bun tools/incident-88-test.ts              # spawns its own scratch server
//   URL=ws://host:8940/ws bun tools/...        # or against a running one
//
// The packet was raw `world_verb place` carrying the typed tool's convenience
// shape — {id, x, y, z, yaw, scale} — where the log wants pos:[x,y,z]. The
// server fold ignored the missing pos (partial update), so the world was
// fine; PR #53's replay assigned `e.pos = args.pos` unconditionally, and the
// undefined rode the support transform into `fitSupportBox(position[0])` as
// an unhandled rejection in a detached async call. Every agent that lived in
// the process died with it, and every reconnect replaying the tail died
// again.
//
// Three layers, each tested against the exact incident packet:
//   1. the door (mcpl/shape.ts, wired into world_verb) refuses it with the
//      expected shape named, BEFORE it becomes history;
//   2. the agent fold (applyEntry) mirrors the server's partial-update
//      semantics if such an entry reaches history anyway — position kept,
//      yaw/scale folded, live AND replay;
//   3. support registration abstains on non-finite geometry instead of
//      killing the shared door.
// Plus the control the incident spec demands: a well-formed raw
// place{pos:[...]} still moves the thing and re-syncs its support.

import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Same cache guard as the rest of the suite (#13): tests need deterministic
// resolver behavior, and this file reaches the plugin indirectly through
// WorldAgent -> physics.ts.
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
const { rawShapeError } = await import("../mcpl/shape.ts");

// The crash was an unhandled rejection in `void registerSupport(...)` — on
// broken code it kills the process and this test with it. Counting instead
// of dying turns "the door fell over" into an assertion.
let rejections = 0;
process.on("unhandledRejection", (e) => { rejections++; console.error("  [unhandledRejection]", e); });

const EXTERNAL = process.env.URL;
const PORT = Number(process.env.PORT ?? 8996);
const URL_ = EXTERNAL ?? `ws://127.0.0.1:${PORT}/ws`;
const TOKEN = process.env.TOKEN ?? "";
const worldsDir = mkdtempSync(join(tmpdir(), "ew-i88-"));

const LIB = "eidoverse/assets/models/crate_large_red.glb";
const DECK_Y = 2.003;                                   // deck top, local y, scale 1

// The EXACT packet from the incident log (world eanpa, 2026-08-09 ~15:06Z),
// id renamed to this world's entity.
const INCIDENT_ARGS = { id: "deck", x: 15, y: 0, z: -7, yaw: 2.4, scale: 0.5 };

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  else { fail++; console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? ` — ${detail}` : ""}`); }
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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

/** A bare socket: authors the scene and plays the dragger's hand. */
function hand(world: string, name: string) {
  return new Promise<any>((res) => {
    const ws = new WebSocket(`${URL_}?name=${name}`);
    ws.onopen = () => ws.send(JSON.stringify({ type: "join", world, id: name, token: TOKEN }));
    ws.onmessage = (e) => {
      const m = JSON.parse(String(e.data));
      if (m.type === "snapshot") res({
        verb: (v: string, a: any) => ws.send(JSON.stringify({ type: "verb", verb: v, args: a })),
        send: (o: any) => ws.send(JSON.stringify(o)),
        close: () => ws.close(),
      });
    };
  });
}

/** Knock a body down, drag it over `at`, release; where did its root settle? */
async function dropOver(h: any, ag: any, name: string, at: number[], overY: number) {
  h.send({ type: "puppet", target: name, ragdoll: { lean: [1, 0, 0] } });
  await sleep(2200);
  h.send({ type: "bodydrag", target: name, grab: { joint: "hips" } });
  await sleep(250);
  h.send({ type: "bodydrag", target: name, pose: { hips: [0, 0, 0, 1] },
           p: [at[0], overY + 0.4, at[1]], yaw: 0 });
  await sleep(250);
  h.send({ type: "bodydrag", target: name, end: true, pose: { hips: [0, 0, 0, 1] },
           p: [at[0], overY + 1.2, at[1]], yaw: 0 });
  await sleep(9000);
  return ag.pos.y as number;
}

let hipsOffset = 0.68;
const restsOn = (rootY: number, surfaceY: number) => Math.abs(rootY - (surfaceY - hipsOffset)) < 0.35;

const near3 = (a: number[] | undefined, b: number[]) =>
  !!a && a.length === 3 && a.every((v, i) => Math.abs(v - b[i]) < 1e-6);

// ---- the run ---------------------------------------------------------------

try {
  console.log(`\nincident #88 — malformed raw place vs the door: ${URL_}\n`);

  // ---- 1. THE DOOR: world_verb now refuses the exact incident packet ------
  // rawShapeError is the function the world_verb case calls verbatim; these
  // are the door's semantics, tested at the seam the door imports.
  {
    const why = rawShapeError("place", { ...INCIDENT_ARGS });
    check("the exact incident packet is refused", why != null, "accepted");
    check("...and the refusal names the log's shape", !!why && why.includes("pos:[x,y,z]"), why ?? "");
    check("a well-formed raw place passes", rawShapeError("place", { id: "t", pos: [15, 0, -7], yaw: 2.4, scale: 0.5 }) == null,
      rawShapeError("place", { id: "t", pos: [15, 0, -7], yaw: 2.4, scale: 0.5 }) ?? "");
    check("a partial raw place (yaw/scale only) passes — the fold is partial-update",
      rawShapeError("place", { id: "t", scale: 0.5 }) == null);
    check("non-finite pos is refused", rawShapeError("place", { id: "t", pos: [NaN, 0, 0] }) != null);
    check("a 2-vector pos is refused", rawShapeError("place", { id: "t", pos: [1, 2] }) != null);
    check("a missing id is refused", rawShapeError("place", { pos: [1, 2, 3] }) != null);
    check("spawn with a malformed pos is refused", rawShapeError("spawn", { id: "t", lib: "x.glb", pos: { x: 1 } }) != null);
    check("verbs without a pos contract are untouched", rawShapeError("mount", { id: "t", to: "u" }) == null);
  }

  await startServer();

  // From a detached worktree, server.ts's EIDOVERSE_DIR default points at a
  // directory that does not exist and /geom answers "no such asset" — which
  // silently turns every support assertion below into a no-op (#53 review).
  // Refuse to run rather than pass against empty air.
  {
    const HTTP = URL_.replace(/^ws/, "http").replace(/\/ws$/, "");
    const g = await (await fetch(`${HTTP}/geom?lib=${encodeURIComponent(LIB)}`)).json() as any;
    if (!(g?.geometry ?? g)?.bbox) throw new Error(`library not served (${JSON.stringify(g).slice(0, 120)}) — set EIDOVERSE_DIR`);
  }

  // ---- 2. THE POISONED LOG: the incident sequence past the door -----------
  // A raw socket writes the packet straight into history — the position the
  // fleet is actually in: the malformed entry from 08-09 is durable in
  // eanpa's log, and pre-#88 stacks and browser writers exist. The agent
  // must survive it LIVE, a fresh join must survive REPLAYING it, and both
  // must fold it the way the server does: position kept, yaw/scale applied.
  {
    const W = `i88-poison-${Date.now().toString(36)}`;
    const h = await hand(W, "stagehand");
    h.verb("spawn", { id: "deck", lib: LIB, pos: [3, 0, 0], yaw: 0 });
    await sleep(600);

    const ag = new WorldAgent({ url: URL_, name: "i88-bot", world: W });
    await ag.connect();
    await sleep(1200);

    // calibrate the rig's hips offset on flat ground in THIS world
    h.send({ type: "puppet", target: "i88-bot", ragdoll: { lean: [1, 0, 0] } });
    await sleep(3000);
    hipsOffset = -ag.pos.y;
    check("a body knocked down on flat terrain reports a stable hips offset",
      hipsOffset > 0.3 && hipsOffset < 1.2, `offset=${hipsOffset.toFixed(2)}m`);

    // the incident preamble: a body mounts the structure and dismounts again
    h.verb("mount", { id: "stagehand", to: "deck", slot: "deck" });
    await sleep(400);
    h.verb("dismount", { id: "stagehand" });
    await sleep(400);

    // ...and the malformed write, exactly as logged
    h.verb("place", INCIDENT_ARGS);
    await sleep(1500);

    check("LIVE: the agent is still alive after receiving the entry", rejections === 0 && ag.pos != null,
      `rejections=${rejections}`);
    const live = ag.entities.get("deck");
    check("LIVE: position kept — the malformed pos never lands", near3(live?.pos, [3, 0, 0]),
      `pos=${JSON.stringify(live?.pos)}`);
    check("LIVE: yaw and scale fold as partial updates, like the server",
      live?.yaw === 2.4 && live?.scale === 0.5, `yaw=${live?.yaw} scale=${live?.scale}`);

    // THE crash loop: a fresh agent replays the tail containing the entry
    const rep = new WorldAgent({ url: URL_, name: "i88-rep", world: W });
    await rep.connect();
    await sleep(1500);
    const fold = rep.entities.get("deck");
    check("REPLAY: a fresh agent joins over the poisoned tail and lives",
      rejections === 0 && fold != null, `rejections=${rejections}`);
    check("REPLAY: its fold matches the server's", near3(fold?.pos, [3, 0, 0]) && fold?.scale === 0.5,
      `pos=${JSON.stringify(fold?.pos)} scale=${fold?.scale}`);

    // support survived, and it is the FOLDED thing's support: the crate is
    // half-scale at its old spot, so a released body rests at half deck
    // height there — not on the phantom full-height deck, not on terrain.
    await ag.walkTo(3, 0, false, 8000);
    const y = await dropOver(h, ag, "i88-bot", [3, 0], DECK_Y * 0.5);
    check("SUPPORT: a body released over the old spot rests on the half-scale deck",
      restsOn(y, DECK_Y * 0.5), `root=${y.toFixed(2)} half-deck=${(DECK_Y * 0.5 - hipsOffset).toFixed(2)} terrain=${(-hipsOffset).toFixed(2)}`);

    check("...and the whole scene drew no unhandled rejections", rejections === 0, `rejections=${rejections}`);
    h.close(); ag.close?.(); rep.close?.();
  }

  // ---- 3. THE CONTROL: a well-formed raw place still does its job ---------
  {
    const W = `i88-valid-${Date.now().toString(36)}`;
    const h = await hand(W, "stagehand");
    h.verb("spawn", { id: "deck", lib: LIB, pos: [3, 0, 0], yaw: 0 });
    await sleep(600);
    const ag = new WorldAgent({ url: URL_, name: "i88-ctl", world: W });
    await ag.connect();
    await sleep(1200);

    h.verb("place", { id: "deck", pos: [-4, 0, 0], yaw: 0 });
    await sleep(1200);
    check("a valid raw place{pos} moves the entity", near3(ag.entities.get("deck")?.pos, [-4, 0, 0]),
      `pos=${JSON.stringify(ag.entities.get("deck")?.pos)}`);

    await ag.walkTo(3, 0, false, 8000);
    const gone = await dropOver(h, ag, "i88-ctl", [3, 0], DECK_Y);
    check("support LEAVES the old spot", restsOn(gone, 0), `root=${gone.toFixed(2)}`);

    await ag.walkTo(-4, 0, false, 10_000);
    const there = await dropOver(h, ag, "i88-ctl", [-4, 0], DECK_Y);
    check("...and ARRIVES at the new one", restsOn(there, DECK_Y), `root=${there.toFixed(2)}`);
    h.close(); ag.close?.();
  }
} finally {
  server?.kill();
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
