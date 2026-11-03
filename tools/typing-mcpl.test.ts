// Integration test for the MCPL typing bridge: the host's typing signal
// (channels/typing) must surface as an in-world typing signal, kept up while
// the host says the agent's turn runs and let go at `stop`. Starts its own
// world + MCPL servers on ports the kernel picks, connects a raw MCP websocket
// host, sends typing notifications, and a raw world-WS watcher confirms what
// the world broadcasts as `{type:"typing", id:<agent>}`.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";

// Ports the kernel hands out, so two runs on one machine don't meet on fixed
// ones and read each other's world.
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
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// Positive waits poll with a deadline, so a slow machine delays a pass instead
// of failing one.
const waitUntil = async (pred: () => boolean, ms: number) => {
  const until = Date.now() + ms;
  while (Date.now() < until) { if (pred()) return true; await sleep(50); }
  return pred();
};
let pass = 0, fail = 0;
const check = (name: string, ok: boolean, extra = "") => {
  console.log(`  ${ok ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m"} ${name}${ok ? "" : "  " + extra}`);
  ok ? pass++ : fail++;
};

// process.execPath, not "bun": the PATH "bun" is an npm .cmd shim on Windows
// whose pid dies immediately, orphaning both of these on their ports where
// they poison the next run.
const world = Bun.spawn([process.execPath, "server/server.ts"], {
  env: { ...process.env, PORT: String(WPORT), WORLDS_DIR: worldsDir },
  stdout: "ignore", stderr: "ignore",
});
// 🔴 post-hardening (anima merge): the token registry REJECTS any key that
// appears in the tracked example — and "dev-token" is in the example, so it
// can never authorize on any machine. Upstream's copy of this suite still
// uses it and is structurally red (flagged for them). A scratch registry
// with a test-only token is the honest fixture.
const tokensPath = join(worldsDir, "tokens.json");
await Bun.write(tokensPath, JSON.stringify({
  "typing-test-token": { id: "claude", name: "Claude", world: "commons" },
}));
const mcpl = Bun.spawn([process.execPath, "mcpl/net-server.ts"], {
  env: { ...process.env, MCPL_PORT: String(MPORT), WORLD_URL: `ws://127.0.0.1:${WPORT}/ws`,
         MCPL_TOKENS: tokensPath },
  stdout: "ignore", stderr: "ignore",
});

try {
  await sleep(2500);

  // A raw world-WS watcher, present in the world, listening for typing relays.
  const seen: any[] = [];
  const watcher = new WebSocket(`ws://127.0.0.1:${WPORT}/ws`);
  await new Promise<void>((res, rej) => {
    const t = setTimeout(() => rej(new Error("watcher join timeout")), 6000);
    watcher.onmessage = (ev) => { const m = JSON.parse(String(ev.data)); seen.push(m);
      if (m.type === "snapshot") { clearTimeout(t); res(); } };
    watcher.onopen = () => watcher.send(JSON.stringify({ type: "join", world: "commons", id: "watcher", avatar: "a.vrm" }));
  });

  // A raw MCP host connecting to the MCPL door as the "claude" agent (dev-token).
  const host = new WebSocket(`ws://127.0.0.1:${MPORT}/?token=typing-test-token`);
  // Each response the door sends, by request id.
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

  // The agent's body joins the world: wait until the watcher sees it arrive.
  if (!(await waitUntil(() => seen.some((m) => m.type === "arrive" && m.id === "claude"), 15000))) {
    throw new Error("the agent's body never arrived in the world");
  }

  const typingSeen = () => seen.filter((m) => m.type === "typing" && m.id === "claude").length;
  const saidSeen = (text: string) => seen.some((m) => m.type === "log" && m.entry?.verb === "say" && m.entry?.actor === "claude" && m.entry?.args?.text === text);
  const typingFor = (channelId: string, op?: "start" | "stop") =>
    rpc({ jsonrpc: "2.0", method: "channels/typing", params: { channelId, ...(op ? { op } : {}) } });
  let nextId = 100;
  const sayInWorld = (text: string) => rpc({ jsonrpc: "2.0", id: nextId++, method: "channels/publish",
    params: { channelId: "world:commons", content: [{ type: "text", text }] } });
  // The body sends at most one typing signal a second. Before each check that
  // expects none, wait that out, so a throttled signal isn't what keeps it quiet.
  const throttleClear = () => sleep(1200);
  // After a check that expects no dots, the host's start for this world must
  // raise them: the door handles notifications in order, so this shows the one
  // before it was taken and ignored, not lost.
  const control = async (what: string) => {
    seen.length = 0;
    typingFor("world:commons", "start");
    check(`…and a start for this world then raises the dots (${what})`, await waitUntil(() => typingSeen() >= 1, 3000));
    typingFor("world:commons", "stop");
  };

  // The host says the agent's turn has begun for this world.
  typingFor("world:commons", "start");
  check("the host's typing start surfaces as an in-world typing signal", await waitUntil(() => typingSeen() >= 1, 3000),
    `saw types: ${[...new Set(seen.map((m) => m.type))].join(",")}`);

  // The world's dots last 4 s and the host repeats start only every 7 s, so
  // the door must keep them up in between on its own, about every 2.5 s.
  seen.length = 0;
  check("the dots are kept up between the host's starts", await waitUntil(() => typingSeen() >= 2, 6500),
    `typing signals: ${typingSeen()}`);

  // The agent speaks: its bubble ends the dots, and the relay stays quiet
  // until the host's next start. Count from once the say has reached the
  // world, plus a moment for a signal already in flight.
  sayInWorld("hello from the typing test");
  check("the say reaches the world", await waitUntil(() => saidSeen("hello from the typing test"), 5000));
  await sleep(500);
  seen.length = 0;
  await sleep(3500);
  check("speaking ends the dots: no typing signal follows the say", typingSeen() === 0, `typing signals after the say: ${typingSeen()}`);
  await control("after a say");

  // The same for a say sent as a raw world verb, the other route to speech.
  typingFor("world:commons", "start");
  check("the dots are up again before the raw say", await waitUntil(() => typingSeen() >= 1, 3000));
  rpc({ jsonrpc: "2.0", id: nextId++, method: "tools/call",
    params: { name: "world_verb", arguments: { verb: "say", args: { text: "a raw say from the typing test" } } } });
  check("the raw say reaches the world", await waitUntil(() => saidSeen("a raw say from the typing test"), 5000));
  await sleep(500);
  seen.length = 0;
  await sleep(3500);
  check("a say sent as a raw world verb ends the dots too", typingSeen() === 0, `typing signals after the raw say: ${typingSeen()}`);
  await control("after a raw say");

  // stop: no signal after it. (A tick already in flight lands within the first second.)
  await throttleClear();
  seen.length = 0;
  typingFor("world:commons", "start");
  check("the dots are up before the stop", await waitUntil(() => typingSeen() >= 1, 3000));
  typingFor("world:commons", "stop");
  await sleep(1000);
  seen.length = 0;
  await sleep(3200);
  check("after stop, no typing signal follows", typingSeen() === 0, `typing signals after stop: ${typingSeen()}`);

  // A start with no op is a start.
  await throttleClear();
  seen.length = 0;
  typingFor("world:commons");
  check("a typing signal with no op starts the dots", await waitUntil(() => typingSeen() >= 1, 3000));
  typingFor("world:commons", "stop");

  // An op other than start or stop is ignored, not taken as a start.
  await throttleClear();
  seen.length = 0;
  rpc({ jsonrpc: "2.0", method: "channels/typing", params: { channelId: "world:commons", op: "end" } });
  await sleep(600);
  check("a typing signal with an unknown op raises no dots", typingSeen() === 0);
  await throttleClear();
  await control("after an unknown op");

  // Typing for a DIFFERENT channel must not light up this world.
  await throttleClear();
  seen.length = 0;
  typingFor("dm:someone", "start");
  await sleep(600);
  check("typing for another channel does not type in this world", typingSeen() === 0);
  typingFor("dm:someone", "stop");
  await throttleClear();
  await control("after another channel's start");

  // The generation stream draws no dots: a host may hold it back until it
  // publishes, and dots then would mean "published".
  await throttleClear();
  seen.length = 0;
  rpc({ jsonrpc: "2.0", method: "channels/outgoing/chunk",
    params: { inferenceId: "inf1", conversationId: "c1", channelId: "world:commons", index: 0, delta: "Hel" } });
  await sleep(600);
  check("a chunk of the generation stream does not type in this world", typingSeen() === 0);
  await throttleClear();
  await control("after a chunk");

  // A long tool call. The door serves the host's requests one at a time, and
  // walk_to answers only when the body arrives, so the host's refreshes come
  // in while the walk runs. They must keep the dots up past the overdue
  // window, rather than wait unread until the walk ends.
  await throttleClear();
  seen.length = 0;
  typingFor("world:commons", "start");
  check("the dots are up as a long walk begins", await waitUntil(() => typingSeen() >= 1, 3000));
  const walkId = nextId++;
  rpc({ jsonrpc: "2.0", id: walkId, method: "tools/call", params: { name: "walk_to", arguments: { x: 30, z: 0 } } });
  // The host refreshes its start every 7 s while the turn runs; every 4 s here.
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

  // The host goes away while a walk is under way. The door can't close the
  // session until the walk returns, but the dots stop with the connection.
  await throttleClear();
  seen.length = 0;
  typingFor("world:commons", "start");
  check("the dots are up as a second walk begins", await waitUntil(() => typingSeen() >= 1, 3000));
  rpc({ jsonrpc: "2.0", id: nextId++, method: "tools/call", params: { name: "walk_to", arguments: { x: 0, z: 0 } } });
  await sleep(500);
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
  world.kill(); mcpl.kill();
}
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
