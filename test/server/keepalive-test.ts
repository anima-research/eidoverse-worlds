// The MCPL door's keepalive must tolerate a thinking agent: survive missed pongs, reap only after the full grace window.
// The peer is a raw socket that completes the upgrade and never pongs (what a blocked event loop looks like); a `ws`
// client can't do this under Bun, which ignores `autoPong: false`. MCPL_PING_SEC/MCPL_PING_MISSES scale the timings down.

import { connect, type Socket } from "node:net";
import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { foundWorlds, freePort, scratchState } from "../harness/harness.ts";
import { suite } from "../gate/suite.ts";
import { until, tryUntil, pause } from "../gate/wait.ts";

const WPORT = freePort(8957), MPORT = freePort(WPORT + 1);
// MISSES is overridable so the suite can prove this test has teeth: run it
// with KEEPALIVE_MISSES=1 (the old single-miss behaviour) and the
// survive-a-miss assertion must FAIL.
const PING_SEC = 1, MISSES = Number(process.env.KEEPALIVE_MISSES ?? 5);
const worldsDir = mkdtempSync(join(tmpdir(), "eido-keepalive-"));
foundWorlds(worldsDir, ["commons"]);   // joining never founds a world
// a scratch token registry: "dev-token" is in the tracked example, which the registry refuses to honour anywhere
const tokensPath = join(worldsDir, "tokens.json");
await Bun.write(tokensPath, JSON.stringify({ "keepalive-labtok": { id: "claude", name: "Claude", world: "commons" } }));
const S = suite("keepalive");
const check = (name: string, ok: unknown, extra?: unknown) => S.check(name, ok, extra);

// process.execPath, not "bun": the PATH "bun" is an npm .cmd shim on Windows
// whose pid dies immediately, orphaning both of these on their ports where
// they poison the next run.
const world = Bun.spawn([process.execPath, "server/server.ts"], {
  env: { ...process.env, ...scratchState(), PORT: String(WPORT), WORLDS_DIR: worldsDir, SKIP_OPT_SWEEP: "1", AGENT_TOKENS_PATH: tokensPath },   // the world honours the same enrolments the MCPL door does
  stdout: "ignore", stderr: "ignore",
});
const mcpl = Bun.spawn([process.execPath, "mcpl/net-server.ts"], {
  env: {
    ...process.env, MCPL_PORT: String(MPORT),
    WORLD_URL: `ws://127.0.0.1:${WPORT}/ws`,
    MCPL_PING_SEC: String(PING_SEC), MCPL_PING_MISSES: String(MISSES), MCPL_TOKENS: tokensPath, MCPL_STATE: tokensPath + ".state.json",
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

type Peer = { sock: Socket; openedAt: number; closedAt: number; heard: string; send(s: string): void };
/** A peer that upgrades to websocket and then NEVER answers a ping. */
function deafPeer(): Promise<Peer> {
  return new Promise((res, rej) => {
    const sock = connect(MPORT, "127.0.0.1");
    const peer: Peer = {
      sock, openedAt: 0, closedAt: 0, heard: "",
      send: (s) => { try { sock.write(textFrame(s)); } catch { /* closing */ } },
    };
    let upgraded = false;
    const t = setTimeout(() => rej(new Error("upgrade timeout")), 6000);
    sock.on("connect", () => {
      sock.write(
        `GET /?token=keepalive-labtok HTTP/1.1\r\nHost: 127.0.0.1:${MPORT}\r\n` +
        `Upgrade: websocket\r\nConnection: Upgrade\r\n` +
        `Sec-WebSocket-Key: ${randomBytes(16).toString("base64")}\r\n` +
        `Sec-WebSocket-Version: 13\r\n\r\n`,
      );
    });
    // Server frames (including pings) are read and DELIBERATELY ignored.
    sock.on("data", (d) => {
      peer.heard += d.toString("latin1");
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

/** Initialize, wait for the door's answer, then say initialized: a handshaken agent. */
async function handshake(p: Peer) {
  p.send(INIT);
  await until("the door answered initialize", () => p.heard.includes('"result"'));
  p.send(INITED);
}
const listening = (port: number) => new Promise<boolean>((res) => {
  const s = connect(port, "127.0.0.1"); s.on("connect", () => { s.destroy(); res(true); }); s.on("error", () => res(false));
});

try {
  await until("the world serves", () => fetch(`http://127.0.0.1:${WPORT}/`).then(() => true, () => false), { ms: 20_000 });
  await until("the MCPL door listens", () => listening(MPORT), { ms: 20_000 });

  // ── a thinking agent: connected, handshaken, then silent ──
  const quiet = await deafPeer();
  await handshake(quiet);
  check("a silent agent connects", quiet.closedAt === 0);

  // OLD behaviour reaped it here (one missed pong). It must survive.
  await pause("two missed pings: the single-miss check reaped here, the grace window must not", PING_SEC * 1000 * 2 + 400);
  check("survives missed pongs that the old single-miss check would have killed",
    quiet.closedAt === 0,
    `died after ${((quiet.closedAt - quiet.openedAt) / 1000).toFixed(1)}s`);

  // ...but a peer that never answers at all IS still reaped, just later.
  await tryUntil("the deaf peer is reaped", () => quiet.closedAt !== 0, { ms: PING_SEC * 1000 * (MISSES + 3) });
  const lived = (quiet.closedAt - quiet.openedAt) / 1000;
  check("a genuinely unresponsive peer is still terminated", quiet.closedAt !== 0, "never closed");
  check(`reaped only near the end of the grace window (at least 70% of ${MISSES * PING_SEC}s, lived ${lived.toFixed(1)}s)`,
    quiet.closedAt !== 0 && lived >= MISSES * PING_SEC * 0.7,
    `lived ${lived.toFixed(1)}s`);
  quiet.sock.destroy();

  // ── an agent that TALKS is alive, pongs or not: inbound traffic is proof ──
  const chatty = await deafPeer();
  await handshake(chatty);
  const talk = setInterval(() => chatty.send(JSON.stringify({ jsonrpc: "2.0", id: 99, method: "tools/list" })),
    PING_SEC * 700);
  await pause("longer than the whole grace window: talking must keep it alive that long", PING_SEC * 1000 * (MISSES + 3));
  clearInterval(talk);
  check("an agent that keeps talking is never reaped, pongs or not",
    chatty.closedAt === 0, `died after ${((chatty.closedAt - chatty.openedAt) / 1000).toFixed(1)}s`);
  chatty.sock.destroy();
} catch (e) {
  check("the suite ran to the end", false, (e as Error).stack);
} finally {
  world.kill(); mcpl.kill();
}
S.done();
