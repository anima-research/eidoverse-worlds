// door-frame-test — a malformed frame from anyone closes that one socket, never the MCPL door.
//
//   bun tools/door-frame-test.ts
//
// Bun 1.4's `ws` emits 'error' on a socket that sends an invalid frame, and an 'error' nobody listens for is an
// uncaught exception that ends mcpl/net-server.ts and every session with it. It reaches the door twice: on the socket
// itself, and, once a session is admitted, again on the session's McplConnection, which re-emits its socket's error.
// So this sends the frame as a stranger, whose socket never gets a session, and as an enrolled agent whose session has
// answered `initialize` (frames that arrive before admission are held, and a socket that closes then is dropped
// without a session), then asks the door whether it's still there.

import { connect, type Socket } from "node:net";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { foundWorlds, freePort } from "./harness.ts";
import { until, pause } from "./protocol/wait.ts";

const WPORT = freePort(21000), MPORT = freePort(23000), NONCE = randomUUID();
const worldsDir = mkdtempSync(join(tmpdir(), "eido-door-frame-"));
foundWorlds(worldsDir, ["commons"]);
const tokensPath = join(worldsDir, "tokens.json");
await Bun.write(tokensPath, JSON.stringify({ "doorframe-labtok": { id: "claude", name: "Claude", world: "commons" } }));

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, extra = "") => {
  console.log(`  ${ok ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m"} ${name}${ok ? "" : "  " + extra}`);
  ok ? pass++ : fail++;
};

// process.execPath, not "bun": the PATH "bun" is an npm .cmd shim on Windows whose pid dies at once, so kill() would
// leave the real server on its port.
const world = Bun.spawn([process.execPath, "server/server.ts"], {
  env: { ...process.env, PORT: String(WPORT), WORLDS_DIR: worldsDir, SKIP_OPT_SWEEP: "1", AGENT_TOKENS_PATH: tokensPath, BENCH_NONCE: NONCE },
  stdout: "ignore", stderr: "ignore",
});
const mcpl = Bun.spawn([process.execPath, "mcpl/net-server.ts"], {
  env: {
    ...process.env, MCPL_PORT: String(MPORT), WORLD_URL: `ws://127.0.0.1:${WPORT}/ws`,
    MCPL_TOKENS: tokensPath, MCPL_STATE: tokensPath + ".state.json", MCPL_INSTANCE_NONCE: NONCE,
  },
  stdout: "ignore", stderr: "pipe",
});
const doorLog = new Response(mcpl.stderr).text();

/** "ok <nonce>" from /healthz is this test's own door answering; anything else, or nothing, isn't. */
const healthz = () => fetch(`http://127.0.0.1:${MPORT}/healthz`).then((r) => r.text()).then((t) => t.trim(), (e) => String(e));
const worldOwn = () => fetch(`http://127.0.0.1:${WPORT}/health`).then((r) => r.json()).then((j: any) => j?.nonce === NONCE, () => false);

/** A masked client text frame. */
function textFrame(s: string): Buffer {
  const body = Buffer.from(s, "utf8"), mask = randomBytes(4);
  const head = body.length < 126 ? Buffer.from([0x81, 0x80 | body.length]) : Buffer.from([0x81, 0x80 | 126, body.length >> 8, body.length & 0xff]);
  return Buffer.concat([head, mask, Buffer.from(body.map((b, i) => b ^ mask[i % 4]!))]);
}
const INIT = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize",
  params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "door-frame-test", version: "0" } } }) + "\n";

type Peer = { sock: Socket; closed: boolean; got: string };
/** A raw socket upgraded to websocket, so it can send bytes no websocket client library would. */
async function upgraded(token: string): Promise<Peer> {
  const sock = connect(MPORT, "127.0.0.1");
  const peer: Peer = { sock, closed: false, got: "" };
  sock.on("data", (d) => { peer.got += d.toString("latin1"); });
  const gone = () => { peer.closed = true; };
  sock.on("close", gone); sock.on("end", gone); sock.on("error", gone);
  sock.on("connect", () => sock.write(
    `GET /?token=${token} HTTP/1.1\r\nHost: 127.0.0.1:${MPORT}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
    `Sec-WebSocket-Key: ${randomBytes(16).toString("base64")}\r\nSec-WebSocket-Version: 13\r\n\r\n`));
  const how = await until(`the door answers a connection with token ${token}`, () => (/ 101 /.test(peer.got) ? "upgraded" : peer.closed ? "closed" : null));
  if (how === "closed") throw new Error(`the door closed the connection with token ${token} before upgrading it`);
  return peer;
}

const ANSWERED = /"id"\s*:\s*1\b[^\n]*"result"|"result"[^\n]*"id"\s*:\s*1\b/;
/** An enrolled agent whose session is admitted: its `initialize` has a result (a refusal answers with an error). */
async function admitted(token: string): Promise<Peer> {
  const peer = await upgraded(token);
  peer.sock.write(textFrame(INIT));
  const how = await until("the session answers initialize with a result", () => (ANSWERED.test(peer.got) ? "answered" : peer.closed ? "closed" : null), { ms: 20_000 });
  if (how === "closed") throw new Error("the door closed the agent's connection before its session answered initialize");
  return peer;
}

try {
  const up = await until("the door answers /healthz with this test's nonce", async () => (await healthz()) === `ok ${NONCE}`, { ms: 30_000 })
    && await until("the world answers /health with this test's nonce", worldOwn, { ms: 30_000 });
  check("the door and the world are up, and they're this test's own", up);

  for (const [who, connectAs] of [["a stranger (unknown token)", () => upgraded("nobody")], ["an admitted agent", () => admitted("doorframe-labtok")]] as const) {
    const rude = await connectAs();
    rude.sock.write(Buffer.from([0x83, 0x80, 1, 2, 3, 4]));   // FIN, reserved opcode 3, masked, empty
    const closed = await until(`the door closes ${who}'s socket after the frame`, () => rude.closed).catch(() => false);
    // An uncaught 'error' ends the process within this; time passing is what's tested here, not a stand-in for a condition.
    await Promise.race([mcpl.exited, pause("a door the frame ended would have exited by now", 1000)]);
    const health = await healthz();
    check(`${who}: a malformed frame closes its socket and the door stays up`, closed && mcpl.exitCode === null && health === `ok ${NONCE}`,
      `socket closed=${closed} door exit=${mcpl.exitCode} healthz=${health}`);
    rude.sock.destroy();
  }

  const fresh = await admitted("doorframe-labtok").catch((e: Error) => e);
  check("a new agent's session is still admitted afterwards", !(fresh instanceof Error), fresh instanceof Error ? fresh.message : "");
  if (!(fresh instanceof Error)) fresh.sock.destroy();
} catch (e) {
  fail++;
  console.log(`\x1b[31mFATAL\x1b[0m ${(e as Error).message}`);
} finally {
  world.kill(); mcpl.kill();
}
if (fail) console.log(`\n  the door's stderr:\n${(await doorLog).split("\n").slice(-12).map((l) => "    " + l).join("\n")}`);
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
