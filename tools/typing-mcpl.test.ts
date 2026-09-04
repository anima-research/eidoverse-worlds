// Integration test for the MCPL typing bridge: a host streaming an agent's
// generation (channels/outgoing/chunk) must surface as an in-world typing
// signal. Starts its own world + MCPL servers on temp ports, connects a raw
// MCP websocket host, drives one chunk notification, and a raw world-WS
// watcher confirms the world broadcasts `{type:"typing", id:<agent>}`.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const WPORT = 8955, MPORT = 8956;
const worldsDir = mkdtempSync(join(tmpdir(), "eido-typing-"));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
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
  const rpc = (obj: any) => host.send(JSON.stringify(obj));
  await new Promise<void>((res, rej) => {
    const t = setTimeout(() => rej(new Error("mcpl init timeout")), 6000);
    host.onopen = () => rpc({ jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2024-11-05", capabilities: { experimental: { mcpl: {} } }, clientInfo: { name: "test", version: "0" } } });
    host.onmessage = (ev) => {
      const m = JSON.parse(String(ev.data));
      if (m.id === 1) { rpc({ jsonrpc: "2.0", method: "notifications/initialized" }); clearTimeout(t); res(); }
    };
  });

  // give the agent body time to actually join the world
  await sleep(1500);

  // The host streams the agent's generation destined for the world channel.
  const chunk = (delta: string, i: number) => rpc({ jsonrpc: "2.0", method: "channels/outgoing/chunk",
    params: { inferenceId: "inf1", conversationId: "c1", channelId: "world:commons", index: i, delta } });
  chunk("Hel", 0); await sleep(150);
  chunk("lo", 1); await sleep(150);

  await sleep(400);
  const typing = seen.filter((m) => m.type === "typing" && m.id === "claude");
  check("streaming an agent's generation surfaces as an in-world typing signal", typing.length >= 1,
    `saw types: ${[...new Set(seen.map((m) => m.type))].join(",")}`);

  // A chunk for a DIFFERENT channel must not light up this world.
  seen.length = 0;
  rpc({ jsonrpc: "2.0", method: "channels/outgoing/chunk",
    params: { inferenceId: "inf2", conversationId: "c2", channelId: "dm:someone", index: 0, delta: "x" } });
  await sleep(400);
  check("a chunk for another channel does not type in this world",
    seen.filter((m) => m.type === "typing" && m.id === "claude").length === 0);

  watcher.close(); host.close();
} catch (e) {
  fail++;
  console.log(`\x1b[31mFATAL\x1b[0m ${(e as Error).message}\n${(e as Error).stack}`);
} finally {
  world.kill(); mcpl.kill();
}
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
