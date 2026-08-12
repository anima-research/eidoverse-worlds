// Getting off a seat, through the SHIPPED MCPL DOOR (#18, review of #98).
//
//   bun mcpl/dismount-door-test.ts        # spawns its own sequencer + door
//
// tools/dismount-walk-test.ts drives WorldAgent directly: it proves the
// landing math, the refusal ladder and the ordering guard. It cannot prove
// that a resident calling `walk_to` over MCPL is any better off — and the
// #98 review caught exactly that gap twice over:
//
//   B1  the gap reached the server console and the raw dismount reply, but
//       `walk_to` (the founding path) said only "arrived at (…)" and look()
//       never mentioned it, despite the field comment claiming it did. A
//       resident could still fall back silently.
//   B2  playtest.ts passes on main AND on the branch, because it never mounts
//       the agent — so nothing exercised the door routing at all.
//
// This suite is the missing half: a real agent-framework host, real
// `tools/call`, real durable log. Every assertion is something a RESIDENT can
// see — the tool's own text, or the entry the world will replay forever.
//
// On unmodified main: the raw dismount reply is "sent dismount", the durable
// dismount carries no pos, and neither walk_to nor look() ever mentions a
// fallback. Six checks fail, and the file still runs to the end.

// Bun 1.3.x caches transpiled module graphs globally. This suite spawns the
// door as a SEPARATE process, and a stale transpile of net-server.ts is
// served to it silently — caught here the hard way: an edit to the posture
// reply simply did not exist in the running door, and an unconditional
// marker string never appeared in its output. The same #13 guard the rest of
// the suite carries, extended to the children this one starts, because the
// code under test lives in THEM.
if (process.env.__EIDO_TEST_CACHE_OFF !== '1') {
  const child = Bun.spawnSync({
    cmd: [process.execPath, import.meta.path, ...process.argv.slice(2)],
    env: { ...process.env, BUN_RUNTIME_TRANSPILER_CACHE_PATH: '0', __EIDO_TEST_CACHE_OFF: '1' },
    stdout: 'inherit', stderr: 'inherit',
  });
  process.exit(child.exitCode ?? 1);
}

import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Children inherit the guard: the sequencer and the door are where the code
 *  under test actually runs. */
const CHILD_ENV = { ...process.env, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" };

// Deliberately NOT through @animalabs/agent-framework, the way playtest.ts
// connects. The door's wire is plain JSON-RPC 2.0 and it accepts a plain-MCP
// client (net-server handshake(): initialize, then notifications/initialized,
// then tools/call — the `experimental.mcpl` block is optional). Speaking that
// directly costs ~20 lines and removes an OPTIONAL dependency from the test
// path, so this suite runs on a checkout that has never built the framework.
// It is also the surface any MCP client sees, which is the one under review.

const SEQ_PORT = Number(process.env.SEQ_PORT ?? 8938);
const DOOR_PORT = Number(process.env.DOOR_PORT ?? 8939);
const WORLD_URL = `ws://127.0.0.1:${SEQ_PORT}/ws`;
const LIB = "eidoverse/assets/models/crate_large_red.glb";
const ME = "claude";           // what dev-token authenticates as (net-server.ts)
const WORLD = "commons";

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  else { fail++; console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? ` — ${detail}` : ""}`); }
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const near = (a: number, b: number, tol = 0.06) => Math.abs(a - b) <= tol;

// ---- the two services ------------------------------------------------------

const worldsDir = mkdtempSync(join(tmpdir(), "ew-door-"));
const here = import.meta.dir;

// REFUSE to run against a port someone else already holds. A leftover door
// from an earlier run answers the handshake perfectly and then reports on
// code that is not the code under test — this suite spent a debugging cycle
// on exactly that, watching an unconditional marker string fail to appear
// because the process serving it had started three minutes earlier. It is
// the same trap that once made smoke.ts read 72/85 for days against a stale
// server. A test that quietly talks to a stranger is worse than one that
// does not run.
async function demandFree(port: number, what: string) {
  try {
    const probe = Bun.listen({ hostname: "127.0.0.1", port, socket: { data() {} } });
    probe.stop(true);
  } catch {
    console.error(`\n  port ${port} is already in use — refusing to run.\n` +
      `  Something is already serving there; this suite would measure IT, not this checkout's ${what}.\n` +
      `  Kill it, or pass SEQ_PORT= / DOOR_PORT= to pick free ports.\n`);
    process.exit(2);
  }
}
await demandFree(SEQ_PORT, "sequencer");
await demandFree(DOOR_PORT, "door");
// process.execPath, NOT "bun": on Windows the PATH entry is an npm shim that
// launches the real binary and exits immediately, so the handle's pid is dead
// within milliseconds and the server it started is orphaned — unkillable by
// this process, and squatting the port forever. That is the mechanism behind
// the stale servers this repo keeps accumulating (and behind smoke.ts's
// long-lived phantom 72/85). Spawning the binary directly makes the pid the
// server's own.
const seq = spawn(process.execPath, [join(here, "..", "server", "server.ts")], {
  env: { ...CHILD_ENV, PORT: String(SEQ_PORT), WORLDS_DIR: worldsDir, JOIN_TOKEN: "",
         VERB_RATE: "5000", MSG_RATE: "5000" },
  stdio: "ignore",
});
for (let i = 0; i < 100; i++) {
  try { if ((await fetch(`http://127.0.0.1:${SEQ_PORT}/avatars`)).ok) break; } catch { /* not up */ }
  await sleep(100);
}
const door = spawn(process.execPath, [join(here, "net-server.ts")], {
  env: { ...CHILD_ENV, MCPL_PORT: String(DOOR_PORT), WORLD_URL, HN_ISSUER_KEY: "" },
  stdio: "ignore",
});

// Stopping these is fiddlier than it looks, and getting it wrong is what
// feeds the trap above. SIGTERM does not reliably stop a spawned bun; on
// Windows even SIGKILL leaves the process TREE standing, so the child keeps
// the port and the NEXT run refuses to start. taskkill /T /F is the portable
// escape hatch there. Run on every exit path, not just the happy one.
let downed = false;
function shutdown() {
  if (downed) return;
  downed = true;
  for (const c of [door, seq]) {
    try { c.kill("SIGKILL"); } catch { /* already gone */ }
    // SYNCHRONOUS on purpose: an async spawn here never runs, because the
    // process exits before it is scheduled — which is precisely how the
    // earlier version of this teardown "worked" and still leaked both ports.
    // Belt and braces on Windows, where a survivor would squat the port and
    // the preflight check above would then refuse the NEXT run. Synchronous:
    // an async spawn here is never scheduled before the process exits.
    if (process.platform === "win32" && c.pid) {
      try { Bun.spawnSync({ cmd: ["taskkill", "/pid", String(c.pid), "/T", "/F"], stdout: "ignore", stderr: "ignore" }); }
      catch { /* already dead — SIGKILL usually got there first */ }
    }
  }
}
process.on("exit", shutdown);
for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => { shutdown(); process.exit(130); });
process.on("uncaughtException", (e) => { shutdown(); throw e; });

await sleep(2500);

// ---- a bystander, to read the durable log ----------------------------------
// The tool's reply is one surface; the log is the other, and it is the one
// every future joiner folds. A stamped landing that never reaches the log is
// not a landing, it is a local opinion.

const entries: any[] = [];
const bws = new WebSocket(`${WORLD_URL}?name=author`);
await new Promise<void>((res, rej) => {
  const t = setTimeout(() => rej(new Error("bystander never joined")), 10_000);
  bws.onopen = () => bws.send(JSON.stringify({ type: "join", world: WORLD, id: "author", token: "" }));
  bws.onmessage = (e) => {
    const m = JSON.parse(String(e.data));
    if (m.type === "log" && m.entry) entries.push(m.entry);
    if (m.type === "snapshot") { clearTimeout(t); res(); }
  };
});
const verb = (v: string, a: any) => bws.send(JSON.stringify({ type: "verb", verb: v, args: a }));
/** The most recent durable dismount of OUR body. */
const lastDismount = () =>
  [...entries].reverse().find((e) => e.verb === "dismount" && e.args?.id === ME);

// ---- the host ---------------------------------------------------------------

const dws = new WebSocket(`ws://127.0.0.1:${DOOR_PORT}?token=dev-token`);
const pending = new Map<number, (m: any) => void>();
let rpcId = 0;
await new Promise<void>((res, rej) => {
  const t = setTimeout(() => rej(new Error("door never accepted the connection")), 10_000);
  dws.onopen = () => { clearTimeout(t); res(); };
  dws.onerror = () => { clearTimeout(t); rej(new Error("door refused the connection")); };
});
dws.onmessage = (e) => {
  const m = JSON.parse(String(e.data));
  if (m.id != null && pending.has(m.id)) { pending.get(m.id)!(m); pending.delete(m.id); }
};
const rpc = (method: string, params?: any) => new Promise<any>((res, rej) => {
  const id = ++rpcId;
  const t = setTimeout(() => { pending.delete(id); rej(new Error(`${method} timed out`)); }, 120_000);
  pending.set(id, (m) => { clearTimeout(t); m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result); });
  dws.send(JSON.stringify({ jsonrpc: "2.0", id, method, ...(params !== undefined ? { params } : {}) }));
});
const notify = (method: string, params?: any) =>
  dws.send(JSON.stringify({ jsonrpc: "2.0", method, ...(params !== undefined ? { params } : {}) }));

await rpc("initialize", {
  protocolVersion: "2024-11-05",
  capabilities: {},
  clientInfo: { name: "dismount-door-test", version: "1.0.0" },
});
notify("notifications/initialized");
await sleep(1200);

/** One tool call, flattened to the text a resident actually reads. */
const call = async (name: string, args: any) => {
  const r: any = await rpc("tools/call", { name, arguments: args });
  return (r.content as any[]).filter((b) => b.type === "text").map((b) => b.text).join("");
};

/** Sit on something, and wait for the door's own body to believe it. */
async function takeSeat(to: string, slot?: string) {
  await call("world_verb", { verb: "mount", args: { id: ME, to, ...(slot ? { slot } : {}) } });
  for (let i = 0; i < 60; i++) {
    if ((await call("look", {})).includes(`seated on ${to}`)) return true;
    await sleep(100);
  }
  return false;
}

console.log("\ndismount through the MCPL door (#98 review B1 + B2):\n");

// Put the body somewhere known, so "the seat" and "where it sat down" cannot
// be confused for one another.
await call("walk_to", { x: 0, z: 0 });
verb("spawn", { id: "chair", lib: LIB, pos: [18, 0, -7], yaw: 0 });
verb("comp", { id: "chair", type: "sockets", data: { perch: { pos: [0, 0.5, 0], yaw: 0 } } });
await sleep(700);

// ---------------------------------------------------- walk_to, the founding path
check("setup: the resident takes a seat 19m away", await takeSeat("chair", "perch"));
const beforeCount = entries.length;
const walked = await call("walk_to", { x: 3, z: 3 });
check("walk_to still arrives", /arrived at/.test(walked), walked);

// The ARRIVAL coordinate cannot discriminate — both builds end at the target
// they were asked for. What differs is what the world was told on the way.
const d1 = lastDismount();
check("the durable dismount carries a stamped position",
  !!d1?.args?.pos && Array.isArray(d1.args.pos), JSON.stringify(d1?.args));
check("...and it is the SEAT, not where the body sat down",
  !!d1?.args?.pos && near(d1.args.pos[0], 18) && near(d1.args.pos[2], -6.3),
  `pos=${JSON.stringify(d1?.args?.pos)} · seat (18, -7) · sat down at (0, 0)`);
check("...and a yaw with it", d1?.args?.yaw != null, JSON.stringify(d1?.args?.yaw));
check("...emitted during that walk, not left over", entries.indexOf(d1) >= beforeCount);

// ------------------------------------------------------- the explicit raw door
check("setup: it sits back down", await takeSeat("chair", "perch"));
const raw = await call("world_verb", { verb: "dismount", args: { id: ME } });
check("a bare self-dismount answers with the landing it stamped",
  /dismounted at \(18\.0, -6\.3\)/.test(raw), raw);

// ------------------------------------------- the fallback must reach the resident
// A socket riding a model part cannot be composed this side. The body still
// gets off — but B1's whole point is that the RESIDENT has to be told, on the
// path they actually used, not just in the server's console.
verb("spawn", { id: "swing", lib: LIB, pos: [-24, 0, 11], yaw: 0 });
verb("comp", { id: "swing", type: "sockets", data: { perch: { pos: [0, 0.5, 0], yaw: 0, part: "rope" } } });
await sleep(700);
check("setup: it takes a seat this side cannot resolve", await takeSeat("swing", "perch"));
const fellBack = await call("walk_to", { x: -20, z: 14 });
check("walk_to DECLARES the fallback instead of walking off in silence",
  /without a seat this side could resolve/.test(fellBack), fellBack);
check("...naming the link that refused", /part "rope"/.test(fellBack), fellBack);
check("...and where the walk actually began", /swing's own frame/.test(fellBack), fellBack);

// Standing up is the other door onto the same act.
check("setup: it takes the unresolvable seat again", await takeSeat("swing", "perch"));
const stood = await call("posture", { kind: "stand" });
check("posture stand DECLARES the fallback too",
  /without a seat this side could resolve/.test(stood), stood);

check("setup: back on the unresolvable seat", await takeSeat("swing", "perch"));
await call("walk_to", { x: -20, z: 14 });
const lookedAfter = await call("look", {});
check("look() surfaces the same gap — the field comment's own promise",
  /stepped off swing without a seat this side could resolve/.test(lookedAfter),
  lookedAfter.split("\n")[1] ?? lookedAfter.slice(0, 120));

// A gap belongs to the transition that caused it. An ordinary later walk, off
// no seat at all, must not inherit it.
const plain = await call("walk_to", { x: -18, z: 12 });
check("a later ordinary walk is NOT annotated with the stale gap",
  !/without a seat this side could resolve/.test(plain), plain);
check("...and look() has dropped it too",
  !/stepped off swing/.test(await call("look", {})));

// ------------------------------------------------------------------- teardown
dws.close();
bws.close();
await sleep(300);
shutdown();
await sleep(600);            // let the kills actually land before we vanish
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
