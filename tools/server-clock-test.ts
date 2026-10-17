/**
 * Server clock test: the server sends its time just before every snapshot,
 * and the browser takes it as its server clock, so a shared sound's playhead
 * is seeked, and its start stamped, in server time from the first snapshot on.
 *
 * The server half joins a real server three ways (embodied, spectating, and
 * travelling to a second world on the same socket) and checks that the
 * message just before each snapshot is `{type: "clock", t}`, with `t` the
 * server's Date.now() at the join. It also checks that an agent
 * (mcpl/agent.ts), which keeps its own estimate of the server's clock, has
 * that estimate set once its snapshot lands. The browser half runs net.js's
 * handler under happy-dom with the stubs remotes-lifecycle-test uses, and
 * checks that a `clock` message moves serverNow() to the server's time on a
 * machine whose own clock is 5 s behind it.
 *
 * Run: bun run tools/server-clock-test.ts
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PORT = Number(process.env.PORT ?? 8963);
const HTTP = `http://localhost:${PORT}`;
const WS_URL = `ws://localhost:${PORT}/ws`;

let pass = 0, fail = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
const brief = (m: any) => JSON.stringify(m)?.slice(0, 100);

type Sock = { ws: WebSocket; msgs: any[] };
function connect(): Promise<Sock> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL);
    const s: Sock = { ws, msgs: [] };
    ws.onmessage = (ev) => { s.msgs.push(JSON.parse(String(ev.data))); };
    ws.onopen = () => resolve(s);
    ws.onerror = (e) => reject(e);
  });
}
/** Sends a join and waits for its snapshot. Returns the messages that came
 *  after the join was sent, and the machine's time before the send and at
 *  the snapshot (the server runs on this machine, so it reads the same clock). */
async function joinWorld(s: Sock, msg: Record<string, unknown>) {
  const from = s.msgs.length;
  const sentAt = Date.now();
  s.ws.send(JSON.stringify({ type: "join", ...msg }));
  for (let i = 0; i < 80; i++) {
    const got = s.msgs.slice(from);
    if (got.some((m) => m.type === "snapshot" || m.type === "error")) return { got, sentAt, snapAt: Date.now() };
    await Bun.sleep(50);
  }
  throw new Error(`no snapshot in 4 s for ${JSON.stringify(msg)}`);
}
function checkJoin(label: string, r: { got: any[]; sentAt: number; snapAt: number }) {
  const i = r.got.findIndex((m) => m.type === "snapshot");
  const before = i > 0 ? r.got[i - 1] : undefined;
  check(`${label}: a snapshot came`, i >= 0, r.got.map((m) => m.type).join(","));
  check(`${label}: the message just before it is the server's clock`, before?.type === "clock", `before the snapshot: ${brief(before)}`);
  check(`${label}: its t is the server's Date.now() at the join`,
    typeof before?.t === "number" && before.t >= r.sentAt && before.t <= r.snapAt,
    `t=${before?.t} sent=${r.sentAt} snapshot=${r.snapAt}`);
}

const worldsDir = mkdtempSync(join(tmpdir(), "ew-serverclock-"));
const optDir = mkdtempSync(join(tmpdir(), "ew-serverclock-opt-"));
const proc = Bun.spawn([process.execPath, "run", join(import.meta.dir, "..", "server", "server.ts")], {
  env: { ...process.env, PORT: String(PORT), WORLDS_DIR: worldsDir, OPT_DIR: optDir, JOIN_TOKEN: "", SKIP_OPT_SWEEP: "1" },
  stdout: "ignore", stderr: "inherit",
});
let up = false;
for (let i = 0; i < 80 && !up; i++) { try { await fetch(`${HTTP}/`); up = true; } catch { await Bun.sleep(150); } }

const WORLD = `clock-${Math.random().toString(36).slice(2, 8)}`;
console.log(`\nserver clock — world "${WORLD}"\n`);
try {
  check("the server came up", up);
  console.log("\n— the server sends its clock just before each snapshot —\n");
  const ra = await connect();
  checkJoin("an embodied join", await joinWorld(ra, { world: WORLD, id: "ra" }));
  const eye = await connect();
  checkJoin("a spectator's join", await joinWorld(eye, { world: WORLD, id: "eye", spectate: true }));
  checkJoin("a travel to another world on the same socket", await joinWorld(ra, { world: `${WORLD}-b`, id: "ra" }));
  // An agent keeps its own estimate of the server's clock (mcpl/agent.ts
  // serverNow) and takes the same message. Nobody in this world has sent a
  // pose, so the server has sent no frame, and only the clock message can
  // have set the estimate by the time the agent's snapshot lands.
  const { WorldAgent } = await import("../mcpl/agent.ts");
  const agent: any = new WorldAgent({ url: WS_URL, name: "clocky", world: WORLD });
  await agent.connect();
  check("an agent's clock estimate is set once its snapshot lands", typeof agent.clockOffset === "number", `clockOffset=${agent.clockOffset}`);
  agent.close();
  ra.ws.close(); eye.ws.close();
} catch (e) {
  check("the server half ran", false, String(e));
} finally {
  proc.kill();
}

console.log("\n— the browser takes the clock as its server clock —\n");
{
  const { GlobalRegistrator } = await import("@happy-dom/global-registrator");
  GlobalRegistrator.register();
  const stubs = await import("./remotes-stubs.mjs");
  const { mock } = await import("bun:test");
  for (const m of ["core", "assets", "world", "chat", "fp_view", "boot", "ui", "avatar", "xrbody"]) {
    mock.module(`${import.meta.dir}/../client/lib/${m}.js`, () => stubs);
  }
  const remotesMod: any = await import("../client/lib/remotes.js");
  const netMod: any = await import("../client/lib/net.js");
  netMod.wireNet({ participants: remotesMod });   // as main.js wires it
  const machine = () => performance.timeOrigin + performance.now();
  check("before any clock or frame, serverNow() is the machine's own clock",
    Math.abs(remotesMod.serverNow() - machine()) < 50, `serverNow - machine = ${remotesMod.serverNow() - machine()} ms`);
  await netMod._dispatch({ type: "clock", t: machine() + 5_000 });   // this machine runs 5 s behind the server
  const ahead = remotesMod.serverNow() - machine();
  check("after the clock message, serverNow() reads the server's time", Math.abs(ahead - 5_000) < 50, `serverNow - machine = ${ahead} ms`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
