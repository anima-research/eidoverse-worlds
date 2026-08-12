// The MCPL door's keepalive must tolerate a THINKING agent.
//
// Regression test for the bug that cut Fable off five times in one evening:
// the door pinged every 20s and terminated on a SINGLE missed pong, so an
// agent host blocked in a long generation (or GC, or context assembly) was
// reaped as "half-open" while very much alive. Each silent reconnect hid it
// until an expired credential made the reconnect fail too.
//
// The peer here is a RAW socket: it completes the websocket upgrade and then
// never answers a ping, which is exactly what a blocked event loop looks like
// from the server's side. (A `ws` client cannot simulate this — `autoPong:
// false` is not honoured under Bun, so the library pongs even when the app
// would not. Ask me how we know.)
//
// Timings are scaled down via MCPL_PING_SEC/MCPL_PING_MISSES; the ratio under
// test — survive a miss, die only after the full grace window — is the point.

import { connect, type Socket } from "node:net";
import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const WPORT = 8957, MPORT = 8958;
// MISSES is overridable so the suite can prove this test has teeth: run it
// with KEEPALIVE_MISSES=1 (the old single-miss behaviour) and the
// survive-a-miss assertion must FAIL.
const PING_SEC = 1, MISSES = Number(process.env.KEEPALIVE_MISSES ?? 5);
const worldsDir = mkdtempSync(join(tmpdir(), "eido-keepalive-"));
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
const mcpl = Bun.spawn([process.execPath, "mcpl/net-server.ts"], {
  env: {
    ...process.env, MCPL_PORT: String(MPORT),
    WORLD_URL: `ws://127.0.0.1:${WPORT}/ws`,
    MCPL_PING_SEC: String(PING_SEC), MCPL_PING_MISSES: String(MISSES),
  },
  stdout: "ignore", stderr: "ignore",
});

/** Minimal masked client text frame (payloads here are well under 64KiB). */
function textFrame(s: string): Buffer {
  const body = Buffer.from(s, "utf8");
  const mask = randomBytes(4);
  const head = body.length < 126
    ? Buffer.from([0x81, 0x80 | body.length])
    : Buffer.concat([Buffer.from([0x81, 0xfe]), (() => { const b = Buffer.alloc(2); b.writeUInt16BE(body.length); return b; })()]);
  const masked = Buffer.alloc(body.length);
  for (let i = 0; i < body.length; i++) masked[i] = body[i]! ^ mask[i % 4]!;
  return Buffer.concat([head, mask, masked]);
}

type Peer = { sock: Socket; openedAt: number; closedAt: number; send(s: string): void };
/** A peer that upgrades to websocket and then NEVER answers a ping. */
function deafPeer(): Promise<Peer> {
  return new Promise((res, rej) => {
    const sock = connect(MPORT, "127.0.0.1");
    const peer: Peer = {
      sock, openedAt: 0, closedAt: 0,
      send: (s) => { try { sock.write(textFrame(s)); } catch { /* closing */ } },
    };
    let upgraded = false;
    const t = setTimeout(() => rej(new Error("upgrade timeout")), 6000);
    sock.on("connect", () => {
      sock.write(
        `GET /?token=dev-token HTTP/1.1\r\nHost: 127.0.0.1:${MPORT}\r\n` +
        `Upgrade: websocket\r\nConnection: Upgrade\r\n` +
        `Sec-WebSocket-Key: ${randomBytes(16).toString("base64")}\r\n` +
        `Sec-WebSocket-Version: 13\r\n\r\n`,
      );
    });
    // Server frames (including pings) are read and DELIBERATELY ignored.
    sock.on("data", (d) => {
      if (!upgraded && d.toString("latin1").includes("101")) {
        upgraded = true; peer.openedAt = Date.now(); clearTimeout(t); res(peer);
      }
    });
    const gone = () => { if (!peer.closedAt) peer.closedAt = Date.now(); };
    sock.on("close", gone); sock.on("end", gone);
    sock.on("error", gone);
  });
}

const INIT = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize",
  params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "0" } } });
const INITED = JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" });

try {
  await sleep(2500);

  // ── a thinking agent: connected, handshaken, then silent ──
  const quiet = await deafPeer();
  quiet.send(INIT); await sleep(250); quiet.send(INITED);
  await sleep(500);
  check("a silent agent connects", quiet.closedAt === 0);

  // OLD behaviour reaped it here (one missed pong). It must survive.
  await sleep(PING_SEC * 1000 * 2 + 400);
  check("survives missed pongs that the old single-miss check would have killed",
    quiet.closedAt === 0,
    `died after ${((quiet.closedAt - quiet.openedAt) / 1000).toFixed(1)}s`);

  // ...but a peer that never answers at all IS still reaped, just later.
  await sleep(PING_SEC * 1000 * (MISSES + 3));
  const lived = (quiet.closedAt - quiet.openedAt) / 1000;
  check("a genuinely unresponsive peer is still terminated", quiet.closedAt !== 0, "never closed");
  check(`reaped only after the full grace window (~${MISSES * PING_SEC}s, lived ${lived.toFixed(1)}s)`,
    quiet.closedAt !== 0 && lived >= MISSES * PING_SEC * 0.7,
    `lived ${lived.toFixed(1)}s`);
  quiet.sock.destroy();

  // ── an agent that TALKS is alive, pongs or not: inbound traffic is proof ──
  const chatty = await deafPeer();
  chatty.send(INIT); await sleep(250); chatty.send(INITED);
  const talk = setInterval(() => chatty.send(JSON.stringify({ jsonrpc: "2.0", id: 99, method: "tools/list" })),
    PING_SEC * 700);
  await sleep(PING_SEC * 1000 * (MISSES + 3));
  clearInterval(talk);
  check("an agent that keeps talking is never reaped, pongs or not",
    chatty.closedAt === 0, `died after ${((chatty.closedAt - chatty.openedAt) / 1000).toFixed(1)}s`);
  chatty.sock.destroy();
} catch (e) {
  fail++;
  console.log(`\x1b[31mFATAL\x1b[0m ${(e as Error).message}\n${(e as Error).stack}`);
} finally {
  world.kill(); mcpl.kill();
}
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
