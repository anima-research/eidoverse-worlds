// Independent review probes for PR #89 (incident #88).
//
// Three questions the shipped incident test does not ask:
//
//  A. `applyEntry(place)` validates `pos` but folds `yaw`/`scale` verbatim.
//     `syncSupport` then abstains BEFORE its drop on a non-finite transform,
//     so an entity that DID move (valid pos) but carries a poisoned scale
//     keeps its old support box at the address it has left. That is a ghost
//     floor, which is the class this PR's own neighbour (#53 B1) blocked on.
//     The vector is not hypothetical: `scale:[0.5,0.5,0.5]` is the exact
//     wrong guess Sill named out loud before asking for the signature.
//
//  B. the same place with a SCALAR scale — the control that proves A is not
//     the probe trivially failing.
//
//  C. the diagnostic cap across repeated reconnect/replay: the entry is
//     durable, so the tail replays on every reconnect. Is the bound global
//     to the agent, or does it reset per replay (i.e. a slow flood)?
//
// Writes go through a RAW socket, not the MCPL door — deliberately. The door
// refuses all of these. The threat model #88 is written against is a log that
// already contains such an entry, plus writers that are not the MCPL door.
//
//   EIDOVERSE_DIR=... PORT=8904 bun tools/incident-88-edge-test.ts

import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

if (process.env.__EIDO_TEST_CACHE_OFF !== "1") {
  const child = Bun.spawnSync({
    cmd: [process.execPath, import.meta.path, ...process.argv.slice(2)],
    env: { ...process.env, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0", __EIDO_TEST_CACHE_OFF: "1" },
    stdout: "inherit", stderr: "inherit",
  });
  process.exit(child.exitCode ?? 1);
}

// Count the agent's own diagnostics before anything else can emit them.
let malformedLines = 0, physicsAbstains = 0;
const realError = console.error.bind(console);
console.error = (...a: any[]) => {
  const s = a.map(String).join(" ");
  if (s.includes("] malformed ")) malformedLines++;
  if (s.includes("[physics] support") && s.includes("abstained")) physicsAbstains++;
  realError(...a);
};

const { WorldAgent } = await import("../mcpl/agent.ts");
const { setHeightField } = await import("../mcpl/physics.ts");

let rejections = 0;
process.on("unhandledRejection", (e) => { rejections++; realError("  [unhandledRejection]", e); });

const PORT = Number(process.env.PORT ?? 8904);
const URL_ = process.env.URL ?? `ws://127.0.0.1:${PORT}/ws`;
const worldsDir = mkdtempSync(join(tmpdir(), "ew-i89-"));
const LIB = "eidoverse/assets/models/crate_large_red.glb";
const DECK_Y = 2.003;

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${name}${detail ? ` — ${detail}` : ""}`); }
  else { fail++; console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? ` — ${detail}` : ""}`); }
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let server: ReturnType<typeof spawn> | null = null;
async function startServer() {
  if (process.env.URL) return;
  // process.execPath, not "bun": the PATH "bun" is an npm .cmd shim on
  // Windows whose pid dies immediately, orphaning the real sequencer on this
  // port where it poisons the next run.
  server = spawn(process.execPath, [join(import.meta.dir, "..", "server", "server.ts")], {
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

function hand(world: string, name: string) {
  return new Promise<any>((res) => {
    const ws = new WebSocket(`${URL_}?name=${name}`);
    ws.onopen = () => ws.send(JSON.stringify({ type: "join", world, id: name, token: "" }));
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

let hipsOffset = 0.68;
const restsOn = (rootY: number, surfaceY: number) => Math.abs(rootY - (surfaceY - hipsOffset)) < 0.35;

async function dropOver(h: any, ag: any, name: string, at: number[], overY: number) {
  h.send({ type: "puppet", target: name, ragdoll: { lean: [1, 0, 0] } });
  await sleep(2200);
  h.send({ type: "bodydrag", target: name, grab: { joint: "hips" } });
  await sleep(250);
  h.send({ type: "bodydrag", target: name, pose: { hips: [0, 0, 0, 1] }, p: [at[0], overY + 0.4, at[1]], yaw: 0 });
  await sleep(250);
  h.send({ type: "bodydrag", target: name, end: true, pose: { hips: [0, 0, 0, 1] }, p: [at[0], overY + 1.2, at[1]], yaw: 0 });
  await sleep(9000);
  return ag.pos.y as number;
}

/** Where does the sim think this support box is, right now? */
async function boxAt(id: string): Promise<number[] | null> {
  await setHeightField(null);                       // warms the ./core.js stub plugin (#53 review note)
  const { colliders } = await import("../client/lib/colliders.js");
  const e = (colliders as Map<string, any>).get(id);
  if (!e) return null;
  const p = e.obj.position;
  return [p.x, p.y, p.z];
}

try {
  console.log(`\nPR #89 review probes: ${URL_}\n`);
  await startServer();
  {
    const HTTP = URL_.replace(/^ws/, "http").replace(/\/ws$/, "");
    const g = await (await fetch(`${HTTP}/geom?lib=${encodeURIComponent(LIB)}`)).json() as any;
    if (!(g?.geometry ?? g)?.bbox) throw new Error(`library not served — set EIDOVERSE_DIR`);
  }

  // ---- A. poisoned scale on a place that DOES move ------------------------
  console.log("A. a place with a valid pos and a VECTOR scale (Sill's stated wrong guess)");
  {
    const W = `i89-ghost-${Date.now().toString(36)}`;
    const h = await hand(W, "stagehand");
    h.verb("spawn", { id: "deck", lib: LIB, pos: [3, 0, 0], yaw: 0 });
    await sleep(600);
    const ag = new WorldAgent({ url: URL_, name: "i89-a", world: W });
    await ag.connect();
    await sleep(1500);

    h.send({ type: "puppet", target: "i89-a", ragdoll: { lean: [1, 0, 0] } });
    await sleep(3000);
    hipsOffset = -ag.pos.y;
    console.log(`     hips offset ${hipsOffset.toFixed(2)}m`);

    const before = await boxAt(`${W}/deck`);
    check("the crate's support box starts at its spawn spot", !!before && Math.abs(before![0] - 3) < 1e-6,
      `box=${JSON.stringify(before)}`);

    // valid pos — the crate really moves — with the scale shape Sill said he
    // would have guessed. Raw socket: the MCPL door refuses this one.
    h.verb("place", { id: "deck", pos: [-4, 0, 0], yaw: 0, scale: [0.5, 0.5, 0.5] });
    await sleep(1800);

    const e = ag.entities.get("deck");
    check("the agent folds the move — the crate is at the new address",
      !!e && Math.abs((e.pos as number[])[0] - -4) < 1e-6, `pos=${JSON.stringify(e?.pos)}`);
    check("...and folds the poisoned scale verbatim, unvalidated",
      Array.isArray(e?.scale), `scale=${JSON.stringify(e?.scale)}`);
    check("no unhandled rejection — the door stays up", rejections === 0, `rejections=${rejections}`);

    const after = await boxAt(`${W}/deck`);
    check("THE QUESTION: the support box is not left at the address the crate left",
      after == null || Math.abs(after[0] - -4) < 1e-6,
      `box=${JSON.stringify(after)} entity=${JSON.stringify(e?.pos)}`);

    // and behaviorally, at the abandoned address
    await ag.walkTo(3, 0, false, 8000);
    const y = await dropOver(h, ag, "i89-a", [3, 0], DECK_Y);
    check("a body released where the crate USED to be falls to the terrain",
      restsOn(y, 0), `root=${y.toFixed(2)} deck=${(DECK_Y - hipsOffset).toFixed(2)} terrain=${(-hipsOffset).toFixed(2)}`);
    h.close(); ag.close?.();
  }

  // ---- B. control: the same move with a SCALAR scale ----------------------
  console.log("\nB. control — the identical move with scale as a scalar");
  {
    const W = `i89-ctl-${Date.now().toString(36)}`;
    const h = await hand(W, "stagehand");
    h.verb("spawn", { id: "deck", lib: LIB, pos: [3, 0, 0], yaw: 0 });
    await sleep(600);
    const ag = new WorldAgent({ url: URL_, name: "i89-b", world: W });
    await ag.connect();
    await sleep(1500);
    h.verb("place", { id: "deck", pos: [-4, 0, 0], yaw: 0, scale: 0.5 });
    await sleep(1800);
    const after = await boxAt(`${W}/deck`);
    check("a well-formed scale moves the support box with the crate",
      !!after && Math.abs(after[0] - -4) < 1e-6, `box=${JSON.stringify(after)}`);
    h.close(); ag.close?.();
  }

  // ---- C. the diagnostic cap across repeated reconnect --------------------
  console.log("\nC. the durable entry replays on every reconnect — is the bound global?");
  {
    const W = `i89-cap-${Date.now().toString(36)}`;
    const h = await hand(W, "stagehand");
    h.verb("spawn", { id: "deck", lib: LIB, pos: [3, 0, 0], yaw: 0 });
    await sleep(400);
    // the exact incident packet, straight into history
    h.verb("place", { id: "deck", x: 15, y: 0, z: -7, yaw: 2.4, scale: 0.5 });
    await sleep(600);

    const beforeCount = malformedLines;
    const ag = new WorldAgent({ url: URL_, name: "i89-c", world: W });
    await ag.connect();
    await sleep(1200);
    const afterJoin = malformedLines - beforeCount;

    // force 8 non-deliberate socket closes; each auto-reconnect replays the tail
    const RECONNECTS = 8;
    for (let i = 0; i < RECONNECTS; i++) {
      (ag as any).ws?.close();
      await sleep(2200);                              // 1.5s backoff + join + replay
    }
    const total = malformedLines - beforeCount;
    check(`the join itself names the malformed entry`, afterJoin >= 1, `lines=${afterJoin}`);
    check(`${RECONNECTS} reconnects later the bound has held (<= 5 total for this agent)`,
      total <= 5, `total=${total} after ${RECONNECTS} replays`);
    check("the body is still connected and alive after the reconnect storm",
      rejections === 0 && (ag as any).joined === true, `rejections=${rejections} joined=${(ag as any).joined}`);
    console.log(`     [physics] abstain lines during the whole run: ${physicsAbstains}`);
    h.close(); ag.close?.();
  }
} finally {
  server?.kill();
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
