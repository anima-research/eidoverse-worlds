/**
 * Server clock test: the server sends its time just before every snapshot
 * to a join that asks (`clock: true`), and the browser takes it as its server clock, so a shared sound's playhead
 * is seeked, and its start stamped, in server time from the first snapshot on.
 *
 * The server half joins a real server three ways that ask (embodied,
 * spectating, and travelling to a second world on the same socket) and
 * checks that the message just before each snapshot is `{type: "clock", t}`,
 * with `t` the server's Date.now() at the join; then two ways that don't
 * (spectating and embodied), which get no clock, the spectator's first
 * message being the snapshot. It also checks that an agent (mcpl/agent.ts),
 * which keeps its own estimate of the server's clock, on a machine whose
 * clock runs 5 s behind, takes its first sample from the clock message it
 * received, that message's t less its own clock, so its serverNow() lies
 * between that t and the server's time; that a sample taken late brings the
 * estimate down by the leak since its previous sample, and its serverNow()
 * reads the kept estimate; that it folds a frame's stamp, as the server sent it,
 * as that frame's own sample; that its own clock
 * is the monotonic one and its serverNow() doesn't follow a step of the wall
 * clock; and that its re-join on an avatar change asks too. The
 * browser half checks the rule every estimate keeps (shared/clockoffset.js:
 * the largest sample wins, it comes down by at most 2 ms a second and 100 ms
 * at once, and a sample that isn't finite isn't one), then
 * runs net.js's handler under happy-dom with the stubs remotes-lifecycle-test
 * uses: it checks that the early socket's join and net.js's join ask, that a
 * `clock` message moves serverNow() to the server's time on a machine whose
 * own clock is behind it, both as it arrives and when the early socket
 * (client/index.html's boot script) buffered it and connect() drains it
 * later, a frame too, and that a late sample brings the browser's estimate,
 * and the lite client's, down by the leak for the time between the two
 * samples' handling, the `at` each is given. Where a check finer than a
 * millisecond reads a clock, it reads it with performance.now() held still or
 * brackets each read with reads just before and after, so a stalled process
 * can't fail it. It checks that remote bodies are drawn on the stream's time,
 * which a run of late frames moves as the old 0.08 blend did, and that a pose
 * with no t is stamped on it.
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
  console.log("\n— the server sends its clock just before each snapshot, to a join that asks —\n");
  const ra = await connect();
  checkJoin("an embodied join", await joinWorld(ra, { world: WORLD, id: "ra", clock: true }));
  const eye = await connect();
  checkJoin("a spectator's join", await joinWorld(eye, { world: WORLD, id: "eye", spectate: true, clock: true }));
  checkJoin("a travel to another world on the same socket", await joinWorld(ra, { world: `${WORLD}-b`, id: "ra", clock: true }));
  // A join that doesn't ask gets the messages it always did: into a world
  // that already exists (no grant for a first joiner), its first message is
  // the snapshot, and no clock comes at all.
  const plain = await connect();
  const pr = await joinWorld(plain, { world: WORLD, id: "plain", spectate: true });
  check("a join that doesn't ask for the clock gets the snapshot as its first message",
    pr.got[0]?.type === "snapshot", pr.got.map((m) => m.type).join(","));
  check("…and no clock message", !pr.got.some((m) => m.type === "clock"), pr.got.map((m) => m.type).join(","));
  plain.ws.close();
  const walker = await connect();
  const wr = await joinWorld(walker, { world: WORLD, id: "walker" });
  check("an embodied join that doesn't ask gets no clock either",
    wr.got.some((m) => m.type === "snapshot") && !wr.got.some((m) => m.type === "clock"), wr.got.map((m) => m.type).join(","));
  walker.ws.close();
  // An agent keeps its own estimate of the server's clock (mcpl/agent.ts
  // serverNow) and takes the same message. Nobody in this world has sent a
  // pose, so the server has sent no frame, and only the clock message can
  // have set the estimate by the time the agent's snapshot lands. The
  // agent's own clock (localNow) is set 5 s behind the server's while it
  // joins, so the estimate has to come from the server's `t`.
  const { WorldAgent } = await import("../mcpl/agent.ts");
  const agent: any = new WorldAgent({ url: WS_URL, name: "clocky", world: WORLD });
  // the agent's own clock (localNow, monotonic) runs 5 s behind the server's
  const ownClock = agent.localNow.bind(agent);
  const AGENT_BEHIND = 5_000;
  agent.localNow = () => ownClock() - AGENT_BEHIND;
  const { LEAK_MS_PER_S, LEAK_MAX_MS } = await import("../shared/clockoffset.js");
  const leakFor = (ms: number) => Math.min(LEAK_MAX_MS, LEAK_MS_PER_S * ms / 1000);
  // Each fold during the join is recorded with the agent's clock read just
  // before and just after it, which bracket the clock it took the sample at.
  const joinFolds: { t: number; after: number; high: number; low: number }[] = [];
  const foldAtJoin = agent.noteServerTime;
  agent.noteServerTime = function (this: any, t: unknown) {
    const from = this.localNow();
    const r = foldAtJoin.call(this, t);
    const to = this.localNow();
    if (typeof t === "number" && Number.isFinite(t)) joinFolds.push({ t, after: this.clock?.offset, high: t - from, low: t - to });
    return r;
  };
  // The clock messages the agent's socket receives, as the server sent them:
  // a listener added as the socket is made, ahead of the agent's own handler.
  const clockOnWire: { t: unknown }[] = [];
  const RealWebSocket = globalThis.WebSocket;
  globalThis.WebSocket = class extends RealWebSocket {
    constructor(...a: ConstructorParameters<typeof WebSocket>) {
      super(...a);
      this.addEventListener("message", (ev: MessageEvent) => {
        try { const m = JSON.parse(String(ev.data)); if (m?.type === "clock") clockOnWire.push(m); } catch {}
      });
    }
  } as typeof WebSocket;
  try { await agent.connect(); } finally { globalThis.WebSocket = RealWebSocket; delete agent.noteServerTime; }
  const atJoin = joinFolds[0];
  check("an agent's first sample is the t of the clock message it received, less its own clock",
    atJoin != null && clockOnWire.length > 0 && atJoin.t === clockOnWire[0].t && atJoin.after >= atJoin.low - 1e-6 && atJoin.after <= atJoin.high + 1e-6,
    atJoin ? `folded t ${atJoin.t}, the clock message's ${clockOnWire[0]?.t}; estimate ${atJoin.after}, the sample ${atJoin.low} to ${atJoin.high}` : "no sample during the join");
  // what its motion evaluation (eff), its sim and its water read:
  // serverNow(), its own clock plus the estimate: no earlier than the clock
  // message's t, and no later than the server's time now. The server runs on
  // this machine, so its Date.now() is this one's, to the millisecond it
  // truncates to.
  const agentNow = agent.serverNow(), serverAfter = Date.now();
  check("…so its serverNow() lies between the clock message's t and the server's time now",
    atJoin != null && agentNow >= atJoin.t - 1e-6 && agentNow <= serverAfter + 1,
    `serverNow ${agentNow}, the clock message's t ${atJoin?.t}, the server's time ${serverAfter}`);
  // a frame handled 20 s late reads the server's clock 20 s early, and the
  // estimate keeps the earlier, quicker sample: it comes down by the leak for
  // the time since its previous sample, which the agent's clock read just
  // before and just after the fold bracket (shared/clockoffset.js)
  const agentSettled = agent.clock.offset, agentSince = agent.clock.at;
  const lateFrom = agent.localNow();
  agent.noteServerTime(lateFrom + agentSettled - 20_000);
  const lateTo = agent.localNow();
  const agentDown = agentSettled - agent.clock.offset;
  check("…and a sample taken 20 s late brings it down by the leak since its previous sample, and no more",
    agentDown >= leakFor(lateFrom - agentSince) - 1e-6 && agentDown <= leakFor(lateTo - agentSince) + 1e-6,
    `down ${agentDown} ms, ${lateFrom - agentSince} to ${lateTo - agentSince} ms after the previous sample`);
  // serverNow() is its own clock plus the kept offset: bracketed by its clock
  // read just before and just after, so a stall between the reads can't fail it
  const keptFrom = agent.localNow(), keptNow = agent.serverNow(), keptTo = agent.localNow();
  const kept = keptNow - agent.clock.offset;
  check("…nor its serverNow(), which reads the kept offset", kept >= keptFrom - 1e-3 && kept <= keptTo + 1e-3,
    `serverNow - offset = ${kept}, its clock ${keptFrom} to ${keptTo}`);
  // A frame's stamp is folded in too (mcpl/agent.ts, case "frame"). With its
  // estimate set an hour low, the first frame folded brings it up to that
  // frame's own sample, its t less the agent's clock when the frame was
  // handled, which a clock read just before the fold and just after it
  // bracket, so long as the frame was handled less than an hour after the
  // server stamped it. The server serializes each frame once for every
  // client in the world (server.ts, the frame tick), so the frame that
  // carries the posing body's own pose, sent after the estimate was set low,
  // reaches that body and the agent with the same t.
  const poser = await connect();
  await joinWorld(poser, { world: WORLD, id: "poser" });
  const lowered = agent.clock.offset - 3_600_000;
  agent.clock = { ...agent.clock, offset: lowered };
  const folds: { t: number; before: number; after: number; high: number; low: number }[] = [];
  const fold = agent.noteServerTime;
  agent.noteServerTime = function (this: any, t: unknown) {
    const before = this.clock?.offset, from = this.localNow();
    const r = fold.call(this, t);
    const to = this.localNow();
    if (typeof t === "number" && Number.isFinite(t)) folds.push({ t, before, after: this.clock?.offset, high: t - from, low: t - to });
    return r;
  };
  const seen = poser.msgs.length;
  poser.ws.send(JSON.stringify({ type: "pose", pose: { p: [1, 0, 1], yaw: 0 } }));
  let wire: any = null;
  for (let i = 0; i < 200; i++) {   // up to 10 s, done once that frame is folded
    wire ??= poser.msgs.slice(seen).find((m) => m.type === "frame" && m.poses && "poser" in m.poses) ?? null;
    if (wire && folds.some((f) => f.t === wire.t)) break;
    await Bun.sleep(50);
  }
  delete agent.noteServerTime;
  const first = folds[0], own = wire && folds.find((f) => f.t === wire.t);
  check("an agent folds a frame's stamp into its estimate, as that frame's own sample",
    first != null && first.before === lowered && first.after >= first.low - 1e-6 && first.after <= first.high + 1e-6,
    first ? `after ${first.after}, the frame's sample ${first.low} to ${first.high}, set to ${lowered}` : "no frame folded");
  // The fold's arithmetic is the check above's, which every frame gets: this
  // one shows only that the posing body's own frame reaches it with its t.
  check("…and the frame the server sent with the posing body's pose reaches the fold with its own t",
    own != null && own.after >= own.low - 1e-6 && own.after <= Math.max(own.before, own.high) + 1e-6,
    `the frame's t ${wire?.t ?? "none"}, folded ${JSON.stringify(folds.map((f) => f.t))}`);
  poser.ws.close();
  // its clock is the monotonic one: a step of the wall clock, read through
  // Date.now or new Date(), moves neither its own clock nor its serverNow()
  const RealDate = Date;
  class SteppedDate extends RealDate {
    constructor(...a: any[]) { super(...((a.length ? a : [RealDate.now() - 60_000]) as unknown as [number])); }
    static now() { return RealDate.now() - 60_000; }
  }
  // serverNow() less its offset, as read against the performance clock just
  // before and just after it: inside that bracket unless it follows the step
  const perf = () => performance.timeOrigin + performance.now();
  const bracket = () => { const a = perf(), s = agent.serverNow() - agent.clock.offset + AGENT_BEHIND, b = perf(); return { a, s, b }; };
  const beforeStep = bracket();
  let stepTook = false, steppedNow: any = null, stepped = NaN;
  globalThis.Date = SteppedDate as unknown as DateConstructor;
  try {
    stepTook = Math.abs(Date.now() - RealDate.now() + 60_000) < 1_000 && Math.abs(new Date().getTime() - RealDate.now() + 60_000) < 1_000;
    steppedNow = bracket() as any;
    stepped = ownClock() - (performance.timeOrigin + performance.now());
  } finally {
    globalThis.Date = RealDate;
  }
  check("setup: the wall clock reads a minute back, through Date.now and new Date()", stepTook);
  check("an agent's own clock doesn't follow a step of the host's wall clock", Math.abs(stepped) < 1_000, `localNow - performance clock = ${stepped} ms`);
  const inside = (r: any) => r != null && r.s >= r.a - 1e-3 && r.s <= r.b + 1e-3;   // 1 µs: above a double's resolution here
  check("…nor does its serverNow()", inside(beforeStep) && inside(steppedNow),
    `serverNow less its offset, 5 s on: ${JSON.stringify(steppedNow)} in the step, ${JSON.stringify(beforeStep)} just before`);
  // its re-join on an avatar change, on the same socket, asks too
  const agentSent: string[] = [];
  const agentSend = agent.ws.send.bind(agent.ws);
  agent.ws.send = (s: string) => { agentSent.push(s); return agentSend(s); };
  agent.setAvatar(agent.avatar);
  const rejoin = agentSent.map((s) => { try { return JSON.parse(s); } catch { return null; } }).find((m) => m?.type === "join");
  check("an agent's re-join on an avatar change asks for the clock", rejoin?.clock === true, String(agentSent[0]));
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
  // The rule every estimate keeps (shared/clockoffset.js), on its own: the
  // largest sample wins, so a late one moves it by no more than the leak: it
  // comes down by at most 2 ms for each second since the previous sample,
  // 100 ms at once.
  const { foldOffset, LEAK_MS_PER_S, LEAK_MAX_MS, STREAM_BLEND } = await import("../shared/clockoffset.js");
  const s0 = foldOffset(null, 5_000, 0);
  const show = (s: any) => JSON.stringify(s);
  check("the rule: the first sample sets the estimate", s0.offset === 5_000, show(s0));
  check("…a sample taken 20 s late, a second on, moves it down by the leak alone", foldOffset(s0, -15_000, 1_000).offset === 5_000 - LEAK_MS_PER_S, show(foldOffset(s0, -15_000, 1_000)));
  check("…a better sample wins at once", foldOffset(s0, 6_000, 1_000).offset === 6_000, show(foldOffset(s0, 6_000, 1_000)));
  check("…a drift down is followed: 100 s on, a sample 0.05 s lower is taken, inside the 0.1 s the leak allows", foldOffset(s0, 4_950, 100_000).offset === 4_950, show(foldOffset(s0, 4_950, 100_000)));
  check("…at 2 ms a second at most: 30 s on, a sample 5 s lower brings it down 0.06 s", LEAK_MS_PER_S === 2 && foldOffset(s0, 0, 30_000).offset === 4_940, show(foldOffset(s0, 0, 30_000)));
  const early = foldOffset({ offset: 5_000, at: 1_000, stream: 5_000 }, 4_000, 500);
  check("…and a sample stamped before the previous one lets nothing leak, and keeps the later time", early.offset === 5_000 && early.at === 1_000, show(early));
  check("…and an hour on, a sample 5 s late brings it down no more than 100 ms", LEAK_MAX_MS === 100 && foldOffset(s0, 0, 3_600_000).offset === 4_900, show(foldOffset(s0, 0, 3_600_000)));
  check("a non-finite sample or time isn't a sample",
    foldOffset(s0, Infinity, 1_000) === s0 && foldOffset(s0, -Infinity, 1_000) === s0 && foldOffset(s0, NaN, 1_000) === s0
      && foldOffset(s0, 6_000, NaN) === s0 && foldOffset(null, Infinity, 0) === null,
    show([foldOffset(s0, Infinity, 1_000), foldOffset(s0, -Infinity, 1_000), foldOffset(s0, NaN, 1_000), foldOffset(s0, 6_000, NaN), foldOffset(null, Infinity, 0)]));
  check("the stream offset starts at the first sample", s0.stream === 5_000, show(s0));
  check("…and blends each sample in at 0.08, a late one included, as the one estimate did before",
    STREAM_BLEND === 0.08 && foldOffset(s0, -15_000, 1_000).stream === 5_000 * 0.92 - 15_000 * 0.08, show(foldOffset(s0, -15_000, 1_000)));

  // The early socket: the boot script opens the socket and buffers what comes
  // while the module graph loads, and connect() drains it later. Run the boot
  // script itself, twice, as two page loads. Each buffered message must be
  // sampled at the time its own message's handler ran (the boot script's
  // performance.now() reads `lag` behind): sampled at the drain, with another
  // message's stamp, or not at all, the estimate lands tens of seconds off.
  // Each load's server is further ahead than the last, so each right sample
  // raises the estimate and a wrong one can't hide behind an earlier sample.
  const { CONFIG } = await import("../client/lib/base.js");
  const html = await Bun.file(join(import.meta.dir, "..", "client", "index.html")).text();
  const boot = html.match(/<script>\s*\n\/\/ The early socket[\s\S]*?<\/script>/)?.[0];
  check("the boot script's early socket is in client/index.html", !!boot);
  if (boot) {
    let sock: any = null;
    class FakeSocket { readyState = 1; sent: string[] = []; constructor() { sock = this; } send(s: string) { this.sent.push(s); } close() { this.readyState = 3; } }
    const fakeLocation = { search: `?name=${encodeURIComponent(CONFIG.name)}&world=${encodeURIComponent(CONFIG.world)}`, protocol: "http:", host: "localhost" };
    const fakeStorage = { getItem: () => null, setItem: () => {} };
    let lag = 0;
    const behind = { now: () => performance.now() - lag };
    const runBoot = () => new Function("location", "localStorage", "WebSocket", "performance", boot.replace(/^<script>/, "").replace(/<\/script>$/, ""))
      (fakeLocation, fakeStorage, FakeSocket, behind);
    const serverAt = (ahead: number) => performance.timeOrigin + behind.now() + ahead;
    globalThis.fetch = (async () => new Response("null", { status: 404 })) as any;   // no identity service here
    // 1. From a server 125 s ahead: a clock message 120 s before the drain,
    //    then a message that isn't JSON 80 s before.
    runBoot();
    sock.onopen();   // the boot script sends its join when the socket opens
    check("the early socket's join asks for the clock", JSON.parse(sock.sent[0] ?? "{}").clock === true, String(sock.sent[0]));
    lag = 120_000; sock.onmessage({ data: JSON.stringify({ type: "clock", t: serverAt(AHEAD) }) });
    lag = 80_000; sock.onmessage({ data: "not json" });
    lag = 0;
    await netMod.connect();
    check("connect() adopted the early socket", netMod.net.ws === sock, `net.ws is ${netMod.net.ws === sock ? "it" : "another"}`);
    const sentBefore = sock.sent.length;
    netMod.sendJoin();   // every connect's and reconnect's join
    check("net.js's join asks for the clock", sock.sent.length === sentBefore + 1 && JSON.parse(sock.sent.at(-1) ?? "{}").clock === true,
      `${sock.sent.length - sentBefore} sent: ${String(sock.sent.at(-1))}`);
    const afterClock = remotesMod.serverNow() - machine();
    check("a clock message the early socket buffered is sampled when its handler ran, not at the drain",
      Math.abs(afterClock - AHEAD) < MARGIN, `serverNow - machine = ${afterClock} ms, want ${AHEAD}`);
    // 2. A second load, from a server 250 s ahead: a message that isn't JSON
    //    80 s before the drain, then a frame 40 s before.
    const AHEAD2 = 250_000;
    runBoot();
    sock.onopen();
    lag = 80_000; sock.onmessage({ data: "not json" });
    lag = 40_000; sock.onmessage({ data: JSON.stringify({ type: "frame", t: serverAt(AHEAD2), poses: {} }) });
    lag = 0;
    await netMod.connect();
    const afterFrame = remotesMod.serverNow() - machine();
    check("…and so is a frame, with its own stamp, not the one before it",
      Math.abs(afterFrame - AHEAD2) < MARGIN, `serverNow - machine = ${afterFrame} ms, want ${AHEAD2}`);
    // 3. A boot script from before `arrived` (a page whose HTML was fetched
    //    just before a deploy rewrote net.js) still has its socket adopted and
    //    drained, its clock sampled at the drain.
    const OLDER = 400_000;
    const older = { ws: new FakeSocket(), sent: { world: CONFIG.world, id: CONFIG.name, avatar: "claude", token: CONFIG.token },
      buffered: [JSON.stringify({ type: "clock", t: machine() + OLDER })], failed: false };
    (globalThis as any).__ewEarlySocket = older;
    const outcome = await netMod.connect().then(() => "drained", (e: unknown) => `threw ${e}`);
    const fallback = remotesMod.serverNow() - machine();
    check("a buffer with no arrival times is still adopted and drained, its clock sampled at the drain",
      outcome === "drained" && netMod.net.ws === older.ws && Math.abs(fallback - OLDER) < MARGIN, `${outcome}, serverNow - machine = ${fallback} ms, want ${OLDER}`);
  }
  // heldStill runs fn with performance.now() held at one instant, so every
  // clock read inside it reads that instant, however long the process stalls.
  // From here on an estimate is read that way, as serverNow() or streamNow()
  // less that instant: exact to the 2^-12 ms a double keeps near 1.8e12 ms.
  // NaN for a reader that has no such function.
  const heldStill = <T>(fn: (p: number) => T): T => {
    const real = performance.now, p = real.call(performance);
    performance.now = () => p;
    try { return fn(p); } finally { performance.now = real; }
  };
  const estimateAt = (read: (() => number) | undefined) =>
    typeof read === "function" ? heldStill((p) => read() - (performance.timeOrigin + p)) : NaN;
  const held = estimateAt(() => { const a = performance.now(), b = performance.now(); return a === b ? performance.timeOrigin + a : NaN; });
  check("setup: performance.now() holds still while an estimate is read", held === 0, `read ${held}`);
  // A frame handled late, after the page was blocked, reads the server's
  // clock early: the browser's estimate keeps the quicker sample, and comes
  // down only by the leak for the time between the two samples' handling,
  // the `at` each is given. They're given 20 s apart, a 40 ms leak, so a fold
  // that timed the leak on another clock, or took the whole cap, or none,
  // comes down by tens of ms more or less. The late one's `at` is 20 s ahead
  // of the page's own clock, so the folds after it here take no leak.
  const LATE_LEAK = Math.min(LEAK_MAX_MS, LEAK_MS_PER_S * 20);
  const kept = estimateAt(remotesMod.serverNow);
  const keptAt = performance.now(), lateAt = keptAt + 20_000;
  remotesMod.noteServerTime(performance.timeOrigin + keptAt + kept, keptAt);
  const beforeLate = estimateAt(remotesMod.serverNow);
  remotesMod.noteServerTime(performance.timeOrigin + lateAt + kept - 200_000, lateAt);
  const browserDown = beforeLate - estimateAt(remotesMod.serverNow);
  check("a sample taken 200 s late, handled 20 s after the previous one, brings the browser's estimate down by the leak for those 20 s",
    Math.abs(browserDown - LATE_LEAK) < 0.01, `down ${browserDown} ms, the leak ${LATE_LEAK} ms`);
  // a t that isn't finite (1e999 parses as Infinity) isn't a sample, through the reader too
  const beforeOdd = [estimateAt(remotesMod.serverNow), estimateAt(remotesMod.streamNow)];
  remotesMod.noteServerTime(Infinity); remotesMod.noteServerTime(-Infinity); remotesMod.noteServerTime(NaN);
  const afterOdd = [estimateAt(remotesMod.serverNow), estimateAt(remotesMod.streamNow)];
  check("a t that isn't finite leaves the browser's estimates as they were", afterOdd.every((v, i) => Number.isFinite(v) && Math.abs(v - beforeOdd[i]) < 0.01),
    `before ${beforeOdd.join(", ")}, after ${afterOdd.join(", ")}`);

  // Remote bodies are interpolated on the stream's time (remotes.js
  // streamNow): every sample blended in at 0.08, as the one estimate was
  // before, so INTERP_MS stays a buffer behind the frames as they arrive. A
  // run of frames handled 2 s late moves it as that blend did, while
  // serverNow() keeps the quickest sample. Each sample is given its exact
  // handling time, so the arithmetic is the check's own.
  check("remotes.js keeps a time of its own for interpolation (streamNow)", typeof remotesMod.streamNow === "function", typeof remotesMod.streamNow);
  if (typeof remotesMod.streamNow === "function") {
    // The run is handled at one held instant, after a sample as quick as the
    // estimate, handled at that instant too: no time passes between its folds,
    // so no leak runs, and serverNow() has to stay where it was, where a blend
    // at 0.08 would have come down 1.6 s.
    const run = heldStill((p) => {
      const machineNow = performance.timeOrigin + p;
      remotesMod.noteServerTime(machineNow + estimateAt(remotesMod.serverNow), p);
      const offBefore = estimateAt(remotesMod.serverNow);
      let wantStream = estimateAt(remotesMod.streamNow);
      for (let i = 0; i < 20; i++) {
        const late = offBefore - 2_000;
        remotesMod.noteServerTime(machineNow + late, p);
        wantStream = wantStream * 0.92 + late * 0.08;
      }
      return { offBefore, wantStream, streamOff: estimateAt(remotesMod.streamNow), offAfter: estimateAt(remotesMod.serverNow) };
    });
    check("a run of frames handled 2 s late moves interpolation's time as the 0.08 blend does",
      Math.abs(run.streamOff - run.wantStream) < 0.01, `streamNow - machine = ${run.streamOff} ms, want ${run.wantStream}`);
    check("…while serverNow() keeps the quickest sample", Math.abs(run.offAfter - run.offBefore) < 0.01, `serverNow - machine = ${run.offAfter} ms, was ${run.offBefore}`);
    // A pose with no `t` (the snapshot's, once a body loads: net.js) is
    // stamped on the stream's time, among the stamped frames around it.
    const camera: any = stubs.camera;
    camera.getWorldPosition ??= (v: any) => v.copy(camera.position);
    const stamped = await remotesMod.ensureRemote("stamped", null);
    // a real Object3D root for every body updateRemotes draws below, since it
    // sets a root's rotation with rotation.set or a quaternion (since #248)
    check("setup: the stamped body has an avatar", stamped.avatar != null);
    if (stamped.avatar) stamped.avatar.root = new stubs.THREE.Object3D();
    const stampFrom = remotesMod.streamNow();
    remotesMod.pushPose("stamped", { p: [0, 0, 0], yaw: 0 });
    const stampTo = remotesMod.streamNow(), stamp = stamped.buf.at(-1)?.t;
    check("a pose with no t is stamped at the stream's time", stamp >= stampFrom && stamp <= stampTo,
      `stamp ${stamp}, stream's time ${stampFrom} to ${stampTo}`);
    // updateRemotes draws a remote body at streamNow() less INTERP_MS (110 ms):
    // between two poses stamped 2 s either side of that point, it's drawn
    // halfway. With performance.now() held still from placing the poses to
    // drawing, that point doesn't move, so the body is drawn at x = 5 exactly:
    // with no buffer it would stand at 5.275, and drawn at serverNow(),
    // seconds ahead of the stream after the late run, at the newer pose, 10.
    const drawn = await remotesMod.ensureRemote("drawn", null);
    drawn.avatar = { root: new stubs.THREE.Object3D(), pitch: 0,
      update() {}, setLimp() {}, setClip() {}, setPose() {}, clearPose() {}, playEmote() {} };
    const x = heldStill(() => {
      const renderPoint = remotesMod.streamNow() - 110;
      remotesMod.pushPose("drawn", { p: [0, 0, 0], yaw: 0 }, renderPoint - 2_000);
      remotesMod.pushPose("drawn", { p: [10, 0, 0], yaw: 0 }, renderPoint + 2_000);
      remotesMod.updateRemotes(0.016);
      return drawn.avatar.root.position.x;
    });
    check("a remote body is drawn 110 ms behind the stream's time", Math.abs(x - 5) < 1e-6, `x = ${x}, want 5 (5.275 with no buffer, 10 at its newer pose)`);
  }

  // The lite client keeps its estimate by the same rule (participants_lite.js).
  const lite: any = await import("../client/lib/participants_lite.js");
  lite.noteServerTime(machine() - 120_000 + 5_000, performance.now() - 120_000);
  const liteAhead = lite.serverNow() - machine();
  check("the lite client's estimate takes a sample at the time its message's handler ran", Math.abs(liteAhead - 5_000) < MARGIN, `serverNow - machine = ${liteAhead} ms`);
  lite.noteServerTime(machine() + AHEAD);   // handled as its event runs: no arrival time
  const liteLive = lite.serverNow() - machine();
  check("…and a sample with no arrival time is taken now", Math.abs(liteLive - AHEAD) < MARGIN, `serverNow - machine = ${liteLive} ms, want ${AHEAD}`);
  const liteKeptAt = performance.now(), liteLateAt = liteKeptAt + 20_000;
  lite.noteServerTime(performance.timeOrigin + liteKeptAt + liteLive, liteKeptAt);
  const liteBefore = estimateAt(lite.serverNow);
  lite.noteServerTime(performance.timeOrigin + liteLateAt + liteLive - 200_000, liteLateAt);
  const liteDown = liteBefore - estimateAt(lite.serverNow);
  check("…and a sample taken 200 s late, handled 20 s after the previous one, brings it down by the leak for those 20 s",
    Math.abs(liteDown - LATE_LEAK) < 0.01, `down ${liteDown} ms, the leak ${LATE_LEAK} ms`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
