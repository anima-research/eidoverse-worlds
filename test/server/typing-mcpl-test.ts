// The MCPL typing bridge, integrated: the host's typing signal (channels/typing) must surface as an in-world typing
// signal, kept up while the host says the agent's turn runs and let go at `stop`. Own world + MCPL servers on
// kernel-picked ports, a raw MCP websocket host, and a raw world-WS watcher reading `{type:"typing", id:<agent>}`.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { foundWorlds, saysIn } from "../harness/harness.ts";
import { createServer } from "node:net";
import { helloOf } from "../../shared/protocol/hello.js";

// kernel-handed ports, so two runs on one machine never read each other's world
const freePort = () => new Promise<number>((resolve, reject) => {
  const s = createServer();
  s.once("error", reject);
  s.listen(0, "127.0.0.1", () => {
    const port = (s.address() as { port: number }).port;
    s.close(() => resolve(port));
  });
});
const WPORT = await freePort(), MPORT = await freePort();
const worldsDir = mkdtempSync(join(tmpdir(), "eido-typing-"));
foundWorlds(worldsDir, ["commons"]);   // joining never founds a world
// 🔴 the token registry REJECTS any key in the tracked example ("dev-token" among them): a scratch registry with a
// test-only token is the fixture
const tokensPath = join(worldsDir, "tokens.json");
await Bun.write(tokensPath, JSON.stringify({
  "typing-test-token": { id: "claude", name: "Claude", world: "commons" },
}));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// positive waits poll with a deadline, so a slow machine delays a pass instead of failing one
const waitUntil = async (pred: () => boolean, ms: number) => {
  const until = Date.now() + ms;
  while (Date.now() < until) { if (pred()) return true; await sleep(50); }
  return pred();
};
// this side's event-loop stalls delay the watcher's stamps: each heartbeat gap past 100 ms, as [end, excess]
let hbLast = Date.now();
const hb: Array<[number, number]> = [];
const heartbeat = setInterval(() => { const now = Date.now(); if (now - hbLast > 100) hb.push([now, now - hbLast - 100]); hbLast = now; }, 100);
const waitedIn = (b: number) => Math.max(0, ...hb.filter(([end]) => Math.abs(b - end) <= 20).map(([, excess]) => excess));
let pass = 0, fail = 0;
const check = (name: string, ok: boolean, extra = "") => {
  console.log(`  ${ok ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m"} ${name}${ok ? "" : "  " + extra}`);
  ok ? pass++ : fail++;
};

// process.execPath, not "bun": on Windows the PATH "bun" is an npm .cmd shim whose pid dies at once, orphaning both of
// these on their ports, where they poison the next run
const world = Bun.spawn([process.execPath, "server/server.ts"], {
  env: { ...process.env, PORT: String(WPORT), WORLDS_DIR: worldsDir, SKIP_OPT_SWEEP: "1", AGENT_TOKENS_PATH: tokensPath },   // the world honours the same enrolments the MCPL door does
  stdout: "ignore", stderr: "ignore",
});
const mcpl = Bun.spawn([process.execPath, "mcpl/net-server.ts"], {
  env: { ...process.env, MCPL_PORT: String(MPORT), WORLD_URL: `ws://127.0.0.1:${WPORT}/ws`,
         MCPL_TOKENS: tokensPath, MCPL_STATE: tokensPath + ".state.json" },
  stdout: "ignore", stderr: "ignore",
});

try {
  await sleep(2500);

  // a raw world-WS watcher, present in the world, listening for typing relays
  const seen: any[] = [], all: any[] = [];   // all: never cleared, so the stream's names (sent once per actor) stay read
  const frames: number[] = [];   // when each of the agent's typing frames was read, never cleared
  const watcher = new WebSocket(`ws://127.0.0.1:${WPORT}/ws`);
  await new Promise<void>((res, rej) => {
    const t = setTimeout(() => rej(new Error("watcher join timeout")), 6000);
    watcher.onmessage = (ev) => { const m = JSON.parse(String(ev.data)); seen.push(m); all.push(m);
      if (m.type === "typing" && m.id === "claude") frames.push(Date.now());
      if (m.type === "snapshot") { clearTimeout(t); res(); } };
    watcher.onopen = () => watcher.send(JSON.stringify({ type: "join", hello: helloOf(), world: "commons", id: "watcher", avatar: "a.vrm", replica: true }));
  });

  // a raw MCP host connecting to the MCPL door as the "claude" agent
  const host = new WebSocket(`ws://127.0.0.1:${MPORT}/?token=typing-test-token`);
  // each response the door sends, by request id
  const responses = new Map<number, any>();
  const rpc = (obj: any) => host.send(JSON.stringify(obj));
  await new Promise<void>((res, rej) => {
    const t = setTimeout(() => rej(new Error("mcpl init timeout")), 6000);
    host.onopen = () => rpc({ jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2024-11-05", capabilities: { experimental: { mcpl: {} } }, clientInfo: { name: "test", version: "0" } } });
    host.onmessage = (ev) => {
      const m = JSON.parse(String(ev.data));
      if (m.id !== undefined && ("result" in m || "error" in m)) responses.set(m.id, m);
      if (m.id === 1) { rpc({ jsonrpc: "2.0", method: "notifications/initialized" }); clearTimeout(t); res(); }
    };
  });

  // the agent's body joins the world: wait until the watcher sees it arrive
  if (!(await waitUntil(() => seen.some((m) => m.type === "arrive" && m.id === "claude"), 15000))) {
    throw new Error("the agent's body never arrived in the world");
  }

  const typingSeen = () => seen.filter((m) => m.type === "typing" && m.id === "claude").length;
  // chat is the log stream's say entries (opaque actors, named by the stream: harness.ts saysIn)
  const saidSeen = (text: string) => saysIn(all).some((x) => x.actor === "claude" && x.text === text);
  const typingFor = (channelId: string, op?: "start" | "stop") =>
    rpc({ jsonrpc: "2.0", method: "channels/typing", params: { channelId, ...(op ? { op } : {}) } });
  let nextId = 100;
  const sayInWorld = (text: string) => rpc({ jsonrpc: "2.0", id: nextId++, method: "channels/publish",
    params: { channelId: "world:commons", content: [{ type: "text", text }] } });
  // the body sends at most one typing signal a second: before a check that expects none, wait it out
  const throttleClear = () => sleep(1200);
  // after a no-dots check, the host's start must raise them: the door handles notifications in order, so the one before
  // was taken and ignored, not lost
  const control = async (what: string) => {
    seen.length = 0;
    typingFor("world:commons", "start");
    check(`…and a start for this world then raises the dots (${what})`, await waitUntil(() => typingSeen() >= 1, 3000));
    typingFor("world:commons", "stop");
  };

  // the host says the agent's turn has begun for this world
  typingFor("world:commons", "start"); const t0 = Date.now();
  check("the host's typing start surfaces as an in-world typing signal", await waitUntil(() => typingSeen() >= 1, 3000),
    `saw types: ${[...new Set(seen.map((m) => m.type))].join(",")}`);
  const late = (t: number, from: number) => t - waitedIn(t) - from;
  const first = frames.find((t) => t >= t0);
  check("the world sends the first start's frame within 1 s, less the stall it waited in", first !== undefined && late(first, t0) < 1000,
    first === undefined ? "none came" : `${first - t0} ms, ${waitedIn(first)} ms of it a stall`);

  // the world's dots last 4 s and the host repeats start only every 7 s: the door keeps them up itself, about every 2.5 s
  seen.length = 0;
  check("the dots are kept up between the host's starts", await waitUntil(() => typingSeen() >= 2, 6500),
    `typing signals: ${typingSeen()}`);

  // the agent speaks: its bubble ends the dots, and the relay stays quiet until the host's next start. Count from once
  // the say reached the world, plus a moment for a signal in flight
  sayInWorld("hello from the typing test");
  check("the say reaches the world", await waitUntil(() => saidSeen("hello from the typing test"), 5000));
  // the measured cadence: from the start to the say, every step between frames is under the 4 s window the frame opens
  const saidAt = Date.now();
  const marks = [t0, ...frames.filter((t) => t >= t0 && t <= saidAt), saidAt];   // the last frame → say gap is judged too
  const steps = marks.slice(1).map((t, i) => late(t, marks[i]!));
  check("from the start to the say, a typing frame came at least every 4 s, less the stall each waited in",
    marks.length >= 4 && steps.every((d) => d < 4000), `${marks.length - 2} frames; steps ${steps.join(", ")} ms`);
  await sleep(500);
  seen.length = 0;
  await sleep(3500);
  check("speaking ends the dots: no typing signal follows the say", typingSeen() === 0, `typing signals after the say: ${typingSeen()}`);
  await control("after a say");

  // the same for a say sent as a raw world verb, the other route to speech
  typingFor("world:commons", "start");
  check("the dots are up again before the raw say", await waitUntil(() => typingSeen() >= 1, 3000));
  rpc({ jsonrpc: "2.0", id: nextId++, method: "tools/call",
    params: { name: "act", arguments: { verb: "say", args: { text: "a raw say from the typing test" } } } });   // (the general request tool; there is no raw world_verb)
  check("the raw say reaches the world", await waitUntil(() => saidSeen("a raw say from the typing test"), 5000));
  await sleep(500);
  seen.length = 0;
  await sleep(3500);
  check("a say sent as a raw world verb ends the dots too", typingSeen() === 0, `typing signals after the raw say: ${typingSeen()}`);
  await control("after a raw say");

  // stop: no signal after it (a tick already in flight lands within the first second)
  await throttleClear();
  seen.length = 0;
  typingFor("world:commons", "start");
  check("the dots are up before the stop", await waitUntil(() => typingSeen() >= 1, 3000));
  typingFor("world:commons", "stop");
  await sleep(1000);
  seen.length = 0;
  await sleep(3200);
  check("after stop, no typing signal follows", typingSeen() === 0, `typing signals after stop: ${typingSeen()}`);

  // a start with no op is a start
  await throttleClear();
  seen.length = 0;
  typingFor("world:commons");
  check("a typing signal with no op starts the dots", await waitUntil(() => typingSeen() >= 1, 3000));
  typingFor("world:commons", "stop");

  // an op other than start or stop is ignored, not taken as a start
  await throttleClear();
  seen.length = 0;
  rpc({ jsonrpc: "2.0", method: "channels/typing", params: { channelId: "world:commons", op: "end" } });
  await sleep(600);
  check("a typing signal with an unknown op raises no dots", typingSeen() === 0);
  await throttleClear();
  await control("after an unknown op");

  // typing for a DIFFERENT channel must not light up this world
  await throttleClear();
  seen.length = 0;
  typingFor("dm:someone", "start");
  await sleep(600);
  check("typing for another channel does not type in this world", typingSeen() === 0);
  typingFor("dm:someone", "stop");
  await throttleClear();
  await control("after another channel's start");

  // the generation stream draws no dots: a host may hold it back until it publishes, and dots would mean "published"
  await throttleClear();
  seen.length = 0;
  rpc({ jsonrpc: "2.0", method: "channels/outgoing/chunk",
    params: { inferenceId: "inf1", conversationId: "c1", channelId: "world:commons", index: 0, delta: "Hel" } });
  await sleep(600);
  check("a chunk of the generation stream does not type in this world", typingSeen() === 0);
  await throttleClear();
  await control("after a chunk");

  // a long tool call: walk_to answers only on arrival, so the host's refreshes arrive mid-walk and must keep the dots up
  // past the overdue window, not wait unread
  await throttleClear();
  seen.length = 0;
  typingFor("world:commons", "start");
  check("the dots are up as a long walk begins", await waitUntil(() => typingSeen() >= 1, 3000));
  const walkId = nextId++;
  // (the world's bounds are ±20 m here, so the long walk is the diagonal, ~25 m at a walk)
  rpc({ jsonrpc: "2.0", id: walkId, method: "tools/call", params: { name: "walk_to", arguments: { x: 18, z: 18 } } });
  // the host refreshes its start every 7 s while the turn runs; every 4 s here
  const refresher = setInterval(() => typingFor("world:commons", "start"), 4000);
  await sleep(13_000);
  seen.length = 0;
  await sleep(2_500);
  check("the walk is still under way 15 s in", !responses.has(walkId));
  check("…and the host's refreshes keep the dots up past the overdue window during it",
    typingSeen() >= 1, `typing signals 13–15.5 s into the walk: ${typingSeen()}`);
  clearInterval(refresher);
  typingFor("world:commons", "stop");
  check("the walk ends", await waitUntil(() => responses.has(walkId), 30_000));

  // the host goes away mid-walk: the door can't close the session until the walk returns, but the dots stop with the connection
  await throttleClear();
  seen.length = 0;
  typingFor("world:commons", "start");
  check("the dots are up as a second walk begins", await waitUntil(() => typingSeen() >= 1, 3000));
  const backWalk = nextId++;
  rpc({ jsonrpc: "2.0", id: backWalk, method: "tools/call", params: { name: "walk_to", arguments: { x: 0, z: 0 } } });
  await sleep(500);
  check("the walk back is still under way when the host disconnects", !responses.has(backWalk));
  host.close();
  await sleep(1000);
  seen.length = 0;
  await sleep(4000);
  check("when the host disconnects mid-walk, the dots get no new signal", typingSeen() === 0,
    `typing signals after the disconnect: ${typingSeen()}`);

  watcher.close(); host.close();
} catch (e) {
  fail++;
  console.log(`\x1b[31mFATAL\x1b[0m ${(e as Error).message}\n${(e as Error).stack}`);
} finally {
  clearInterval(heartbeat); world.kill(); mcpl.kill();
}
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
