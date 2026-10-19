// typing-dots-probe — the typing dots of an agent whose host sends `channels/typing`, end to end: through
// the MCPL door and the world, to the pill a person sees in the full client.
//
//   bun tools/typing-dots-probe.ts
//
// Needs the door's sibling built (../mcpl-core-ts, which the door imports: mcpl/net-server.ts) and a Chromium
// that tools/probe-harness.mjs can find. A run takes two to three minutes on a loaded machine.
//
// A scratch world and the door are children of this run, each proved ours by a per-run nonce it echoes
// (the ownership pattern of tools/door-cap-gate-live-test.mjs). A raw MCPL host stands in for
// agent-framework and sends what it sends: start when a turn begins and every 7 s, stop when it ends
// (agent-framework's test/channel-registry-typing.test.ts owns when it sends them). The full client runs in
// Chromium, joined to the same world, and a raw socket beside it logs what the world broadcasts, in order.
//
// The page is judged by the client's own state, in one sequence the page logs. Two of the agent avatar's
// methods (client/lib/avatar.js) are wrapped: each typing signal the client applies, with the window it set,
// and the state each update of the render loop left, which is where the client decides whether the pill is
// drawn. A signal is setTyping with anything but null: an agent's typing frames carry no state (mcpl/agent.ts
// typing(), which the door's relay calls), so the client applies setTyping(undefined), which opens the window
// as a state would. A listener on the client's socket, added after the client's own handler, logs each typing
// frame the page received, and a requestAnimationFrame loop logs each frame the page rendered. So every update
// must draw the pill exactly when the window is open at the update's own `now` and no bubble shows; each
// signal must open a window ending 4 s after it; the page must receive every typing frame the world sent; and
// the client must apply each one after the one before it and before the page renders again. A loaded page lets
// its socket's messages queue while it renders, so a deadline counted from this side's own receipt of a frame
// would fail a working client; one counted from the page's own receipt doesn't. With no state on the frames,
// the live-mic pill, which the client keeps up over a bubble, can't arise here, and the first rule relies on
// that. The agent's plate is never hidden on the viewer's page, since hideLabel and firstPersonView are set
// only on the viewer's own avatar (client/lib/xr.js selfFirstPerson, client/lib/controller.js), so an update
// that hid it would be a defect, and the first rule counts it as one. The client decides the pill only at an
// update, and updates a remote avatar only on its level-of-detail ticks, further apart the further it is and
// the more loaded the page (client/lib/remotes.js), so between updates the pill stays as the last one left it:
// the probe judges each decision, and the run prints how far apart they came. Where a wait compares the page's
// times with this side's, both are Date.now(), the machine's one wall clock.
//
// The raw socket judges the door's contract, what the world broadcasts, by this side's clock, as a viewer
// would see it. So only this side's own stalls are excused, since they delay a stamp and not the dots: a door
// or world slowed past a bound's margin fails it, and the run prints the machine's load. A heartbeat records
// every gap between its ticks past their 100 ms. A frame that arrives while this side is stalled is read in
// the same backlog as the late tick that ends the stall, so a stamp is allowed the stall whose late tick ran
// within 20 ms of it, and a stall that ended earlier delayed nothing. This side can't tell when in a stall a
// frame arrived, so it allows the whole stall, erring toward the door by at most that stall; a step between
// two frames is judged by the shortest gap their stamps allow, for the same reason. The times this side sends
// at are read after each send, so a stall before a send delays its time with it.
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { loadavg, tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { launchBrowser } from "./probe-harness.mjs";

const ROOT = join(import.meta.dir, "..");

const freePort = () => new Promise<number>((resolve, reject) => {
  const s = createServer();
  s.once("error", reject);
  s.listen(0, "127.0.0.1", () => { const port = (s.address() as { port: number }).port; s.close(() => resolve(port)); });
});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (name: string, ok: boolean, extra = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${name}${extra ? "  " + extra : ""}`);
  ok ? pass++ : fail++;
};

const load0 = loadavg()[0]!;
const NONCE = `dots${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
const WPORT = await freePort(), MPORT = await freePort();
const scratch = mkdtempSync(join(tmpdir(), "eido-dots-"));
const tokensPath = join(scratch, "tokens.json");
await Bun.write(tokensPath, JSON.stringify({ "dots-probe-token": { id: "claude", name: "Claude", world: "commons" } }));
// Every child is registered before it can be lost, and keeps its stderr's tail for a failed run's report.
const kids: Array<{ p: ChildProcess; name: string; err: () => string }> = [];
const child = (name: string, args: string[], env: Record<string, string>) => {
  const p = spawn(process.execPath, args, { cwd: ROOT, env: { ...process.env, ...env }, stdio: ["ignore", "ignore", "pipe"] });
  let err = "";
  p.stderr!.on("data", (d) => { err = (err + String(d)).slice(-2000); });
  kids.push({ p, name, err: () => err.slice(-600) });
  return p;
};
process.on("exit", () => { for (const { p } of kids) { try { p.kill("SIGKILL"); } catch { /* gone */ } } });
class StaleListener extends Error {}
const awaitExit = (p: ChildProcess, ms = 5000) => new Promise<void>((resolve) => {
  // A child that a signal ended has no exitCode, only a signalCode, and its exit event has already fired.
  if (p.exitCode !== null || p.signalCode !== null) return resolve();
  const t = setTimeout(() => { try { p.kill("SIGKILL"); } catch { /* gone */ } }, ms);
  p.once("exit", () => { clearTimeout(t); resolve(); });
  try { p.kill("SIGTERM"); } catch { clearTimeout(t); resolve(); }
});
const waitFor = async (what: string, probe: () => Promise<boolean>, ms = 30000) => {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try { if (await probe()) return; } catch (e) { if (e instanceof StaleListener) throw e; /* not up yet */ }
    await sleep(250);
  }
  throw new Error(`timed out: ${what}`);
};

const world = child("world", ["server/server.ts"], { PORT: String(WPORT), WORLDS_DIR: scratch, SKIP_OPT_SWEEP: "1", WORLD_INSTANCE_NONCE: NONCE });
const door = child("door", ["mcpl/net-server.ts"], { MCPL_PORT: String(MPORT), WORLD_URL: `ws://127.0.0.1:${WPORT}/ws`,
  MCPL_TOKENS: tokensPath, MCPL_STATE: join(scratch, "mcpl-state.json"), MCPL_INSTANCE_NONCE: NONCE });
// This side's own event-loop stalls, which would delay the watcher's stamps: every gap between the heartbeat's
// ticks past their 100 ms, as [when it ended, its excess].
let hbLast = Date.now();
const hb: Array<[number, number]> = [];
const heartbeat = setInterval(() => { const now = Date.now(); if (now - hbLast > 100) hb.push([now, now - hbLast - 100]); hbLast = now; }, 100);
// The stall a stamp at `b` was read in. A frame that arrives while this side is stalled is read when the stall
// ends, in the same backlog as the late tick that ends it, within a few milliseconds of it (with Bun 1.4.3 on
// Linux, stalled for about a second by a busy loop or by SIGSTOP, each held frame was read between 0.6 ms before
// that tick and 6.8 ms after it): so the tick ran within 20 ms of `b`. A stall that ended earlier delayed
// nothing, so it isn't allowed.
const waitedIn = (b: number) => Math.max(0, ...hb.filter(([end]) => Math.abs(b - end) <= 20).map(([, excess]) => excess));
let browser: { close(): Promise<void> } | null = null;
try {
  const launched = await launchBrowser();
  browser = launched.browser;
  const origin = `http://127.0.0.1:${WPORT}`;
  await waitFor("the world echoes our nonce", async () => {
    const r = await fetch(`${origin}/version`); if (!r.ok) return false;
    const b = await r.json().catch(() => null);
    if (b && !("instance" in b)) throw new StaleListener("a world answered without our nonce: another run's listener");
    return b?.instance === NONCE;
  });
  await waitFor("the door echoes our nonce", async () => {
    const r = await fetch(`http://127.0.0.1:${MPORT}/healthz`); if (!r.ok) return false;
    const b = (await r.text()).trim();
    if (b !== `ok ${NONCE}` && b.startsWith("ok")) throw new StaleListener(`a door answered without our nonce (${b.slice(0, 20)}): another run's listener`);
    return b === `ok ${NONCE}`;
  });
  console.log("  identity: the world and the door each echo this run's nonce");

  // A person in the world, in the full client.
  const pg = await launched.page();
  const errs: string[] = [];
  pg.on("pageerror", (e: Error) => errs.push(e.message));
  pg.on("dialog", (d: any) => d.dismiss().catch(() => {}));
  await pg.goto(`${origin}/?world=commons&name=viewer`, { waitUntil: "domcontentloaded", timeout: 60000 });
  await pg.waitForFunction(() => document.getElementById("splash")?.classList.contains("gone") && !!(globalThis as any).EW?.me?.(),
    null, { timeout: 120000 });

  // A raw socket in the same world, beside the browser: what the world broadcasts, by this side's clock and in
  // the order it came, which is where the door's contract lives. Each typing frame for the agent, and the log
  // entry of its speech.
  type Seen = { t: number; seq: number };
  const frames: Seen[] = [];
  let sayEntry = null as Seen | null;   // set by the watcher's handler, so not narrowed to null here
  let seen = 0;
  const watcher = new WebSocket(`ws://127.0.0.1:${WPORT}/ws`);
  await new Promise<void>((res, rej) => {
    const t = setTimeout(() => rej(new Error("watcher join timeout")), 10000);
    watcher.onmessage = (ev) => {
      const at = Date.now(), seq = ++seen;
      let m: any; try { m = JSON.parse(String(ev.data)); } catch { return; }
      if (m.type === "snapshot") { clearTimeout(t); res(); }
      if (m.type === "typing" && m.id === "claude") frames.push({ t: at, seq });
      if (m.type === "log" && m.entry?.verb === "say" && m.entry?.actor === "claude") sayEntry ??= { t: at, seq };
    };
    watcher.onopen = () => watcher.send(JSON.stringify({ type: "join", world: "commons", id: "watcher", avatar: "a.vrm" }));
  });

  // The host: an MCPL client on the door, as the agent `claude`.
  const host = new WebSocket(`ws://127.0.0.1:${MPORT}/?token=dots-probe-token`);
  const responses = new Map<number, any>();
  const rpc = (obj: any) => host.send(JSON.stringify(obj));
  await new Promise<void>((res, rej) => {
    const t = setTimeout(() => rej(new Error("mcpl init timeout")), 10000);
    host.onopen = () => rpc({ jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2024-11-05", capabilities: { experimental: { mcpl: {} } }, clientInfo: { name: "dots-probe", version: "0" } } });
    host.onmessage = (ev) => {
      const m = JSON.parse(String(ev.data));
      if (m.id !== undefined && ("result" in m || "error" in m)) responses.set(m.id, m);
      if (m.id === 1) { rpc({ jsonrpc: "2.0", method: "notifications/initialized" }); clearTimeout(t); res(); }
    };
  });
  let nextId = 100;
  const typing = (op: "start" | "stop", channelId = "world:commons") => rpc({ jsonrpc: "2.0", method: "channels/typing", params: { channelId, op } });
  const say = (text: string) => rpc({ jsonrpc: "2.0", id: nextId++, method: "channels/publish",
    params: { channelId: "world:commons", content: [{ type: "text", text }] } });
  const walk = (x: number) => { const id = nextId++; rpc({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "walk_to", arguments: { x, z: 0 } } }); return id; };
  // Each start this side sends for this world, by its clock, read once it's sent; nextStart() resolves on the
  // next one.
  const starts: number[] = [];
  let onStart: (() => void) | null = null;
  const sendStart = () => { typing("start"); const at = Date.now(); starts.push(at); onStart?.(); return at; };
  const nextStart = () => new Promise<void>((res) => { onStart = () => { onStart = null; res(); }; });

  await pg.waitForFunction(() => !!(globalThis as any).EW?.remotes?.get("claude")?.avatar?.label, null, { timeout: 90000 });
  // The page's log (see the header), in one sequence. A replaced avatar is wrapped, and a replaced socket
  // listened to, at the next look 100 ms on, so a frame in between would be logged on one side only. In the run
  // the page keeps one socket and the agent one avatar throughout, and the receipt checks' messages count both.
  await pg.evaluate(() => {
    const g = globalThis as any;
    g.__log = { seq: 0, signals: [] as unknown[], updates: [] as unknown[], receipts: [] as unknown[], renders: [] as number[], avatars: 0, sockets: 0 };
    const wrap = (av: any) => {
      if (!av || av.__probed) return;
      av.__probed = true;
      g.__log.avatars++;
      const { setTyping, update } = av;
      // The window a signal set, read once the client set it, between the clock's readings either side of the
      // call. A null state shuts the window (resetTransients) and opens none, so it isn't a signal.
      av.setTyping = function (...a: unknown[]) {
        const p0 = performance.now(), r = setTyping.apply(this, a), p1 = performance.now();
        if (a[0] !== null) g.__log.signals.push({ t: Date.now(), seq: ++g.__log.seq, p0, p1, until: this._typingUntil });
        return r;
      };
      // What an update left: the pill drawn or not, the bubble, and whether the window was open at the `now` it
      // was given, which is the time the client decides by (client/lib/remotes.js passes the render loop's).
      av.update = function (...a: unknown[]) {
        const now = typeof a[1] === "number" ? (a[1] as number) : performance.now();
        const r = update.apply(this, a);
        g.__log.updates.push({ t: Date.now(), seq: ++g.__log.seq, drawn: !!this.typing?.visible, bubble: !!this.bubble,
          win: now < this._typingUntil, hidden: !!this.ownPlateHidden });
        return r;
      };
    };
    // Each typing frame for the agent the page's socket received. The client applies a typing frame
    // synchronously in its socket's onmessage (client/lib/net.js), so this listener logs it in the same task.
    // That onmessage was set when the socket opened (by client/index.html's boot script for its early socket,
    // which net.js reassigns, keeping its place), so this listener, added later, runs just after it.
    const listen = (sock: any) => sock?.addEventListener("message", (ev: MessageEvent) => {
      if (typeof ev.data !== "string" || !ev.data.includes('"typing"')) return;
      let m: any; try { m = JSON.parse(ev.data); } catch { return; }
      if (m.type === "typing" && m.id === "claude") g.__log.receipts.push({ t: Date.now(), seq: ++g.__log.seq });
    });
    // Each frame the page rendered, after the client's own render loop in that frame.
    const render = () => { g.__log.renders.push(++g.__log.seq); requestAnimationFrame(render); };
    requestAnimationFrame(render);
    let ws = g.EW.net.ws;
    listen(ws);
    const watch = () => { wrap(g.EW.remotes.get("claude")?.avatar); if (g.EW.net.ws !== ws) { ws = g.EW.net.ws; g.__log.sockets++; listen(ws); } };
    watch();
    setInterval(watch, 100);
  });
  type Signal = { t: number; seq: number; p0: number; p1: number; until: number };
  type Update = { t: number; seq: number; drawn: boolean; bubble: boolean; win: boolean; hidden: boolean };
  type Seq = { t: number; seq: number };
  type PageLog = { signals: Signal[]; updates: Update[]; receipts: Seq[]; renders: number[]; avatars: number; sockets: number };
  const readLog = () => pg.evaluate(() => (globalThis as any).__log) as Promise<PageLog>;
  // The signals and updates alone, for a wait that looks often: the renders run to thousands.
  const readWindows = () => pg.evaluate(() => { const l = (globalThis as any).__log; return { signals: l.signals, updates: l.updates }; }) as Promise<Pick<PageLog, "signals" | "updates">>;
  // The first update after `since` for which pred holds, polled for up to ms, or null. A far avatar updates
  // only on its level-of-detail ticks (client/lib/remotes.js), which a loaded page spaces seconds apart, and
  // between updates its pill stays as the last one left it.
  const pollPage = async (pred: (u: Update) => boolean, ms: number, since: number) => {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      const us = await pg.evaluate((since: number) => (globalThis as any).__log.updates.filter((u: Update) => u.t > since), since) as Update[];
      const hit = us.find(pred);
      if (hit) return hit;
      await sleep(250);
    }
    return null;
  };
  // Once the dots' last window has run out: the page's first update after the last signal it applied since
  // `from` that found the window shut, so the rule below has an update to judge there. The last signal is read
  // again with each look, so a signal still on its way counts.
  const shut = async (name: string, from: number) => {
    const until = Date.now() + 25000;
    let last: Signal | undefined;
    while (Date.now() < until) {
      const log = await readWindows();
      last = log.signals.filter((s) => s.t >= from).at(-1);
      const u = last && log.updates.find((u) => u.seq > last!.seq && !u.win);
      if (u) return check(name, true, `the last signal at ${Math.round(last!.t - T0)} ms; the update at ${Math.round(u.t - T0)} ms found the window shut`);
      if (!last && Date.now() > from + 10000) break;
      await sleep(250);
    }
    check(name, false, last ? "no update after the last signal found the window shut" : "the page applied no signal to judge a window by");
  };

  // A turn as agent-framework runs it: start, and again every 7 s until stop. It walks, speaks, and goes on
  // after the speech until the dots are back.
  // Long enough for the client's longest bubble (avatar.js say: 2500 ms and 45 ms a character, at most 22 s),
  // so the bubble is still up for about 15 s after the host's next start opens a window under it.
  const SAY = "Here now. I came over to see the frame you were building by the water, and to ask whether the beams on the east side are meant to meet the deck or to stop just short of it, as the drawing seems to show. If they stop short, I'd like to know how wide the gap is meant to be, and whether the rail along the edge runs on past it or ends at the last post. I can hold the far end while you measure, if that helps, and then we can walk the rest of the frame together.";
  if (2500 + SAY.length * 45 < 22000) throw new Error(`the speech is too short for a 22 s bubble: ${SAY.length} characters`);
  const T0 = Date.now();
  sendStart();
  const refresher = setInterval(sendStart, 7000);
  await sleep(9000);
  const walkId = walk(30);   // a walk the door answers on arrival, about 19 s on
  await sleep(15000);
  const walkPending15 = !responses.has(walkId);
  // The speech goes 300 ms after a start, so the host's next start is about 6.7 s after it: long enough to see
  // that the door's relay stopped at the speech, since it would otherwise signal every 2.5 s.
  await nextStart(); await sleep(300);
  say(SAY); const sayAt = Date.now();
  // The bubble's waits allow the avatar's updates to come 30 s apart, past the bubble's 22 s; at a load of 92
  // they came up to 15 s apart.
  const bubbleShown = await pollPage((u) => u.bubble, 30000, sayAt);
  const bubbleGone = bubbleShown && await pollPage((u) => !u.bubble, 22000 + 30000, bubbleShown.t);
  // The turn's starts keep the window open, so the update the bubble went at draws the dots already.
  const backUp = bubbleGone && await pollPage((u) => u.drawn, 30000, bubbleGone.t - 1);
  await sleep(2000);
  await waitFor("the walk's reply", async () => responses.has(walkId), 30000).catch(() => {});
  const walkReply = responses.get(walkId);
  // The stop goes 300 ms after a start too, so a relay that ignored it would go on signalling for about 10 s.
  await nextStart(); await sleep(300);
  clearInterval(refresher);
  typing("stop"); const stopAt = Date.now();
  await shut("after the host's stop, the page's window runs out", T0);

  // Another channel's typing raises no dots here, and starts for this world after it do.
  typing("start", "world:elsewhere"); const otherAt = Date.now();
  await pollPage(() => true, 25000, otherAt + 1000);
  const ctlAt = sendStart();
  // Every 7 s, as a turn sends them, until the page draws the dots: one start keeps the relay signalling for
  // about 10 s, and a loaded page can update the agent's avatar further apart than that.
  const ctlRefresher = setInterval(sendStart, 7000);
  const ctl = await pollPage((u) => u.drawn, 25000, ctlAt);
  clearInterval(ctlRefresher);
  typing("stop"); const ctlStopAt = Date.now();
  await shut("…and after its stop, the window runs out again", ctlAt);

  // The host disconnects mid-walk, with no stop, 300 ms after a start: the door's relay ends with the
  // connection, and the dots go with their window. A relay that outlived it would go on signalling for about
  // 10 s after that start, until its own overdue stop.
  const backWalk = walk(0);
  await sleep(1500);
  const goneFrom = sendStart();
  await sleep(300);
  const backPending = !responses.has(backWalk);
  host.close(); const closeAt = Date.now();
  // Its start opened one 4 s window. A page whose updates come further apart than that may never draw the
  // dots in it, which is the machine's pace, not a defect; that the page received and applied the start is
  // for the receipt checks, and that it drew nothing once the window shut is the update rule's.
  await shut("once it disconnects, the page's window runs out", goneFrom);
  // Long enough after the close for a relay that outlived it to have signalled twice.
  await sleep(Math.max(0, closeAt + 6000 - Date.now()));
  const log = await readLog();
  const U = log.updates, S = log.signals;

  // The door's contract, at the world, by this side's clock.
  const late = (f: Seen, from: number) => f.t - waitedIn(f.t) - from;
  const firstFrame = frames.find((f) => f.t >= starts[0]!) ?? null;
  check("the world sends the first start's frame at once, within 1 s less the stall it waited in", firstFrame !== null && late(firstFrame, starts[0]!) < 1000,
    firstFrame === null ? "none came" : `${firstFrame.t - starts[0]!} ms after the start, ${waitedIn(firstFrame.t)} ms of it a stall of this side's`);
  const turnFrames = sayEntry === null ? [] : frames.filter((f) => f.t >= starts[0]! && f.seq < sayEntry!.seq);
  const marks = [{ t: starts[0]!, stall: 0 }, ...[...turnFrames, ...(sayEntry ? [sayEntry] : [])].map((f) => ({ t: f.t, stall: waitedIn(f.t) }))];
  const steps = marks.slice(1).map((b, i) => ({ step: b.t - marks[i]!.t, stall: b.stall }));
  const slowest = steps.reduce((m, s) => (s.step - s.stall > m.step - m.stall ? s : m), { step: 0, stall: 0 });
  check("from the first start to the speech, the world sent a typing frame at least every 4 s, the window each one opens, less the stall each waited in",
    turnFrames.length > 0 && sayEntry !== null && steps.every((s) => s.step - s.stall < 4000),
    sayEntry === null ? "the world logged no speech" : `${turnFrames.length} frames; the start to the first ${steps[0]?.step} ms, the last to the speech ${steps.at(-1)?.step} ms; the longest step less its stall ${slowest.step - slowest.stall} ms (${slowest.step} ms, ${slowest.stall} ms of it a stall)`);
  // By order and by this side's own send times: a frame that came after the speech's log entry, and before the
  // host's next start was even sent, can only be the relay's. A stall makes a frame look later, never sooner,
  // and only a frame held in the same stall as the next start's send can be stamped after that send. A relay
  // that went on signals within 2.5 s of the speech (starts don't reset its phase), over 4 s before the next
  // start less any stall that delayed the speech, so only stalls of over 4 s in all could hide its first frame.
  // The run prints the gap and this side's longest stall.
  const nextAfterSay = starts.find((s) => s > sayAt) ?? null;
  const relayed = sayEntry === null || nextAfterSay === null ? null : frames.filter((f) => f.seq > sayEntry!.seq && f.t < nextAfterSay);
  check("the speech ends the door's relay: no typing frame comes after the world logs it and before the host's next start is sent",
    relayed !== null && nextAfterSay! - sayAt >= 3000 && relayed.length === 0,
    sayEntry === null ? "the world logged no speech" : `the next start went ${nextAfterSay === null ? "never" : nextAfterSay - sayAt + " ms"} after the speech; frames between: ${relayed?.length ?? "-"}`);
  // After a stop or the close, nothing more until the next start for this world, but a frame already on its way.
  const quiet = (name: string, from: number, to: number) => {
    const after = frames.filter((f) => f.t > from && f.t < to && late(f, from) > 500);
    check(name, after.length === 0, after.length ? `at ${after.map((f) => `${f.t - from} ms (${waitedIn(f.t)} ms of it a stall)`).join(", ")} after it` : "");
  };
  quiet("after the host's stop, the world sends no typing frame later than 500 ms on, less the stall it waited in", stopAt, otherAt);
  // Every frame read from the other channel's start on counts, the same millisecond's included: a door that took
  // the start would signal at once, and its frame is read within a few milliseconds of the send.
  const elsewhere = frames.filter((f) => f.t >= otherAt && f.t < ctlAt);
  check("a start for another channel sends no typing frame for this world", ctlAt - otherAt >= 1000 && elsewhere.length === 0,
    `${elsewhere.length} frames in the ${ctlAt - otherAt} ms before this world's next start was sent`);
  check("…and a start for this world then draws the dots", ctl !== null, ctl === null ? "" : `drawn ${Math.round(ctl.t - ctlAt)} ms after it`);
  quiet("…and after its stop, again no typing frame later than 500 ms on", ctlStopAt, goneFrom);
  quiet("once the host disconnects, the world sends no typing frame later than 500 ms on, less the stall it waited in", closeAt, Infinity);

  // The page, by the client's own state.
  const wrong = U.filter((u) => u.drawn !== (u.win && !u.bubble));
  const w0 = wrong[0];
  check("every update of the agent's avatar draws the pill exactly when its window is open and no bubble shows", U.length > 0 && wrong.length === 0,
    `${U.length - wrong.length}/${U.length} updates${w0 ? `; the first that didn't, at ${Math.round(w0.t - T0)} ms: ${w0.drawn ? "drawn" : "not drawn"}, window ${w0.win ? "open" : "shut"}, ${w0.bubble ? "a bubble" : "no bubble"}${w0.hidden ? ", its plate hidden" : ""}` : ""}`);
  const misset = S.filter((s) => !(s.until >= s.p0 + 4000 - 1e-6 && s.until <= s.p1 + 4000 + 1e-6));
  check("each signal opens a window that runs out 4 s after it", S.length > 0 && misset.length === 0,
    misset.length ? `${misset.length} of ${S.length}; the first ran ${Math.round(misset[0]!.until - misset[0]!.p0)} ms` : `${S.length} signals`);
  // The page's socket received each typing frame the world sent, and the client applied each one in its turn:
  // after the page received the one before it, and before the page rendered again once this one came. The
  // page's renders are in sequence order, so the first one past a receipt is the next frame it drew.
  const R = log.receipts;
  check("the page's socket received each typing frame the world sent", R.length === frames.length,
    `${frames.length} frames, ${R.length} received; its socket replaced ${log.sockets} times`);
  const turns = R.map((r, i) => {
    const s = S[i], next = log.renders.find((seq) => seq > r.seq);
    return { r, s, inTurn: !!s && s.seq > (i ? R[i - 1]!.seq : 0) && next !== undefined && s.seq < next };
  });
  const outOfTurn = turns.filter((x) => !x.inTurn), o0 = outOfTurn[0];
  check("the client applied each typing frame its page received after the one before it, and before the page rendered again",
    R.length > 0 && S.length === R.length && outOfTurn.length === 0,
    `${R.length} received, ${S.length} applied${o0 ? `; ${outOfTurn.length} out of turn, the first received at ${Math.round(o0.r.t - T0)} ms and ${o0.s ? `applied ${o0.s.t - o0.r.t} ms from it` : "never applied"}` : ""}; the agent's avatar wrapped ${log.avatars} times`);

  // What the turn showed.
  check("the walk is still under way 15 s in", walkPending15);
  const bubbled = U.filter((u) => u.bubble && u.t >= sayAt);
  check("the speech shows as a bubble", !!bubbleShown);
  check("…a typing window opened while it showed, so the bubble rule was in play", bubbled.some((u) => u.win),
    `${bubbled.filter((u) => u.win).length} of ${bubbled.length} updates with the bubble had a window open`);
  check("…and the bubble goes", !!bubbleGone);
  const lastBubble = bubbled.at(-1)?.t ?? null;
  const backAt = lastBubble === null ? null : U.find((u) => u.t > lastBubble && u.drawn)?.t ?? null;
  check("after the bubble, the turn goes on and the dots are drawn again before the host's stop", !!backUp && backAt !== null && backAt < stopAt,
    `bubble last seen at ${lastBubble === null ? "-" : Math.round(lastBubble - T0)} ms, drawn again at ${backAt === null ? "-" : Math.round(backAt - T0)} ms, stop at ${stopAt - T0} ms`);
  const arrived = /^arrived at \((-?\d+(?:\.\d+)?), (-?\d+(?:\.\d+)?)\)/.exec(walkReply?.result?.content?.[0]?.text ?? "");
  check("the turn's walk arrived within 0.5 m of where it was sent, x = 30", !!arrived && !walkReply.result.isError && Math.hypot(Number(arrived[1]) - 30, Number(arrived[2])) <= 0.5,
    JSON.stringify(walkReply ?? null).slice(0, 160));
  check("the host's walk back is still under way when it disconnects", backPending, JSON.stringify(responses.get(backWalk) ?? null).slice(0, 160));

  check("the page threw nothing", errs.length === 0, errs.slice(0, 3).join(" | "));
  const long = hb.filter(([, excess]) => excess > 250);
  // How often the update rule had a decision of the client's to judge.
  const gaps = U.slice(1).map((u, i) => u.t - U[i]!.t).sort((a, b) => a - b);
  console.log(`  the page rendered ${log.renders.length} frames and updated the agent's avatar ${U.length} times, a median ${gaps[gaps.length >> 1] ?? "-"} ms and at most ${gaps.at(-1) ?? "-"} ms apart; this side's heartbeat ran late ${long.length} times by over 250 ms, the most by ${Math.max(0, ...hb.map(([, excess]) => excess))} ms; the machine's load average was ${load0.toFixed(1)} at the start and ${loadavg()[0]!.toFixed(1)} at the end`);
} catch (e) {
  fail++;
  console.log(`FATAL ${(e as Error).message}\n${(e as Error).stack}`);
} finally {
  clearInterval(heartbeat);
  await browser?.close().catch(() => {});
  await Promise.all([awaitExit(door), awaitExit(world)]);
  rmSync(scratch, { recursive: true, force: true });
}
// A failed run shows what the world and the door said last.
if (fail) for (const { name, err } of kids) if (err().trim()) console.log(`--- the ${name}'s stderr, last lines:\n${err()}`);
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
