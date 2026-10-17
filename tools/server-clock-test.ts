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
 * that estimate at the server's time once its snapshot lands, on a machine
 * whose clock runs 5 s behind. The browser half runs net.js's handler under
 * happy-dom with the stubs remotes-lifecycle-test uses, and checks that a
 * `clock` message moves serverNow() to the server's time on a machine whose
 * own clock is 5 s behind it, both as it arrives and when the early socket
 * (client/index.html's boot script) buffered it and connect() drains it
 * later.
 *
 * Run: bun run tools/server-clock-test.ts
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// A free port unless PORT names one: on a fixed default, another server
// already listening there would answer this test's joins.
const PORT = Number(process.env.PORT ?? (() => {
  const s = Bun.serve({ port: 0, fetch: () => new Response() });
  const port = s.port;
  s.stop(true);
  return port;
})());
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
  check("the server came up", up && proc.exitCode === null, `exit code ${proc.exitCode}`);
  console.log("\n— the server sends its clock just before each snapshot —\n");
  const ra = await connect();
  checkJoin("an embodied join", await joinWorld(ra, { world: WORLD, id: "ra" }));
  const eye = await connect();
  checkJoin("a spectator's join", await joinWorld(eye, { world: WORLD, id: "eye", spectate: true }));
  checkJoin("a travel to another world on the same socket", await joinWorld(ra, { world: `${WORLD}-b`, id: "ra" }));
  // An agent keeps its own estimate of the server's clock (mcpl/agent.ts
  // serverNow) and takes the same message. Nobody in this world has sent a
  // pose, so the server has sent no frame, and only the clock message can
  // have set the estimate by the time the agent's snapshot lands. The agent
  // runs in this process, whose Date.now() is set 5 s behind the server's
  // while it joins, so the estimate has to come from the server's `t`.
  const { WorldAgent } = await import("../mcpl/agent.ts");
  const agent: any = new WorldAgent({ url: WS_URL, name: "clocky", world: WORLD });
  const realNow = Date.now;
  Date.now = () => realNow() - 5_000;
  try { await agent.connect(); } finally { Date.now = realNow; }
  check("an agent's clock estimate is the server's time once its snapshot lands",
    typeof agent.clockOffset === "number" && Math.abs(agent.clockOffset - 5_000) < 2_000, `clockOffset=${agent.clockOffset}`);
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
  // As main.js wires it, before connect(); the avatar is the boot script's
  // default, so the early socket's join below matches the one net.js would send.
  netMod.wireNet({ participants: remotesMod, myAvatarPath: () => "claude" });
  const machine = () => performance.timeOrigin + performance.now();
  // Margins of 2 s: wide enough for a stalled process, and the skews and
  // waits below are large enough that every wrong sample lands further off.
  const MARGIN = 2_000;
  const AHEAD = 125_000;   // the early socket's server, far enough ahead that a wrong sample shows
  check("before any clock or frame, serverNow() is the machine's own clock",
    Math.abs(remotesMod.serverNow() - machine()) < MARGIN, `serverNow - machine = ${remotesMod.serverNow() - machine()} ms`);
  await netMod._dispatch({ type: "clock", t: machine() + 5_000 });   // this machine runs 5 s behind the server
  const ahead = remotesMod.serverNow() - machine();
  check("after the clock message, serverNow() reads the server's time", Math.abs(ahead - 5_000) < MARGIN, `serverNow - machine = ${ahead} ms`);
  // remotes.js smooths every sample after the first: 0.92 of the estimate, 0.08 of the sample
  const blend = (estimate: number, sample: number) => estimate * 0.92 + sample * 0.08;

  // The early socket: the boot script opens the socket and buffers what comes
  // while the module graph loads, and connect() drains it later. Run the boot
  // script itself and give it, from a server now 125 s ahead, a clock message
  // 120 s before the drain, a frame that isn't JSON 80 s before, and a frame
  // 40 s before (the boot script's performance.now() reads that far behind).
  // Each sample must be the one its own message's handler took: sampled at the
  // drain, or with another message's stamp, or not at all, the estimate lands
  // at least 3 s from where the two right samples put it.
  const { CONFIG } = await import("../client/lib/base.js");
  const html = await Bun.file(join(import.meta.dir, "..", "client", "index.html")).text();
  const boot = html.match(/<script>\s*\n\/\/ The early socket[\s\S]*?<\/script>/)?.[0];
  check("the boot script's early socket is in client/index.html", !!boot);
  if (boot) {
    let sock: any = null;
    class FakeSocket { readyState = 1; constructor() { sock = this; } send() {} close() { this.readyState = 3; } }
    const fakeLocation = { search: `?name=${encodeURIComponent(CONFIG.name)}&world=${encodeURIComponent(CONFIG.world)}`, protocol: "http:", host: "localhost" };
    const fakeStorage = { getItem: () => null, setItem: () => {} };
    let lag = 0;
    const behind = { now: () => performance.now() - lag };
    new Function("location", "localStorage", "WebSocket", "performance", boot.replace(/^<script>/, "").replace(/<\/script>$/, ""))
      (fakeLocation, fakeStorage, FakeSocket, behind);
    const serverAt = () => performance.timeOrigin + behind.now() + AHEAD;
    lag = 120_000; sock.onmessage({ data: JSON.stringify({ type: "clock", t: serverAt() }) });
    lag = 80_000; sock.onmessage({ data: "not json" });
    lag = 40_000; sock.onmessage({ data: JSON.stringify({ type: "frame", t: serverAt(), poses: {} }) });
    const before = remotesMod.serverNow() - machine();
    globalThis.fetch = (async () => new Response("null", { status: 404 })) as any;   // no identity service here
    await netMod.connect();
    check("connect() adopted the early socket", netMod.net.ws === sock, `net.ws is ${netMod.net.ws === sock ? "it" : "another"}`);
    const drained = remotesMod.serverNow() - machine(), want = blend(blend(before, AHEAD), AHEAD);
    check("a clock message and a frame the early socket buffered are each sampled when its own handler ran, not at the drain",
      Math.abs(drained - want) < MARGIN, `serverNow - machine = ${drained} ms, want ${want}`);
    // A boot script from before `arrived` (a page whose HTML was fetched just
    // before a deploy rewrote net.js) still has its socket adopted and drained.
    const older = { ws: new FakeSocket(), sent: { world: CONFIG.world, id: CONFIG.name, avatar: "claude", token: CONFIG.token },
      buffered: [JSON.stringify({ type: "clock", t: machine() + AHEAD })], failed: false };
    (globalThis as any).__ewEarlySocket = older;
    const settled = remotesMod.serverNow() - machine();
    const outcome = await netMod.connect().then(() => "drained", (e: unknown) => `threw ${e}`);
    const fallback = remotesMod.serverNow() - machine();
    check("a buffer with no arrival times is still adopted and drained, its clock sampled at the drain",
      outcome === "drained" && netMod.net.ws === older.ws && Math.abs(fallback - blend(settled, AHEAD)) < MARGIN, `${outcome}, serverNow - machine = ${fallback} ms, want ${blend(settled, AHEAD)}`);
  }

  // The lite client keeps its own copy of the estimate (participants_lite.js).
  const lite: any = await import("../client/lib/participants_lite.js");
  lite.noteServerTime(machine() - 120_000 + 5_000, performance.now() - 120_000);
  const liteAhead = lite.serverNow() - machine();
  check("the lite client's estimate takes a sample at the time its message's handler ran", Math.abs(liteAhead - 5_000) < MARGIN, `serverNow - machine = ${liteAhead} ms`);
  lite.noteServerTime(machine() + AHEAD);   // handled as its event runs: no arrival time
  const liteLive = lite.serverNow() - machine();
  check("…and a sample with no arrival time is taken now", Math.abs(liteLive - blend(liteAhead, AHEAD)) < MARGIN, `serverNow - machine = ${liteLive} ms, want ${blend(liteAhead, AHEAD)}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
