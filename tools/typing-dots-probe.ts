// typing-dots-probe — the typing dots of an agent whose host sends `channels/typing`, end to end: through
// the MCPL door and the world, to the pill a person sees in the full client.
//
//   bun tools/typing-dots-probe.ts
//
// Needs the door's sibling built (../mcpl-core-ts, as the door's other tests do) and a Chromium that
// tools/probe-harness.mjs can find. A run takes about two minutes.
//
// A scratch world and the door are children of this run, each proved ours by a per-run nonce it echoes
// (the ownership pattern of tools/door-cap-gate-live-test.mjs). A raw MCPL host stands in for
// agent-framework and sends what it sends: start when a turn begins and every 7 s, stop when it ends
// (agent-framework's test/channel-registry-typing.test.ts owns when it sends them). The full client runs in
// Chromium, joined to the same world, and a raw socket beside it logs what the world broadcasts.
//
// The page keeps its own log, by wrapping three of the agent avatar's methods (client/lib/avatar.js): each
// typing signal the client applies (setTyping), its speech (say), and the state after each update the render
// loop runs (update), which is where the client decides whether the pill is drawn. So the log is what a
// person saw, frame by frame, at whatever rate a loaded machine renders, whichever socket brought each
// signal. An agent's typing frames carry no state (mcpl/agent.ts, typing()), so the live-mic pill, which
// stays up over a bubble, doesn't arise here, and the log checks that it doesn't. The page and this side
// stamp everything with Date.now(), one wall clock.
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
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
  if (p.exitCode !== null) return resolve();
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
// This side's own event-loop stalls, which would delay the watcher's stamps: each gap over 250 ms, by its end.
let hbLast = Date.now();
const hbStalls: Array<[number, number]> = [];
const heartbeat = setInterval(() => { const now = Date.now(); if (now - hbLast > 250) hbStalls.push([now, now - hbLast]); hbLast = now; }, 100);
const sideStall = (a: number, b: number) => Math.max(0, ...hbStalls.filter(([end, gap]) => end > a && end - gap < b).map(([, gap]) => gap));
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

  // A raw socket in the same world, beside the browser: what the world broadcasts, by this side's clock, which
  // is where the door's contract lives. Each typing frame for the agent, and the log entry of its speech.
  const worldTyping: number[] = [];
  let sayEntryAt: number | null = null;
  const watcher = new WebSocket(`ws://127.0.0.1:${WPORT}/ws`);
  await new Promise<void>((res, rej) => {
    const t = setTimeout(() => rej(new Error("watcher join timeout")), 10000);
    watcher.onmessage = (ev) => {
      let m: any; try { m = JSON.parse(String(ev.data)); } catch { return; }
      if (m.type === "snapshot") { clearTimeout(t); res(); }
      if (m.type === "typing" && m.id === "claude") worldTyping.push(Date.now());
      if (m.type === "log" && m.entry?.verb === "say" && m.entry?.actor === "claude") sayEntryAt ??= Date.now();
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
  // Each start this side sends for this world, by its clock; nextStart() resolves on the next one.
  const starts: number[] = [];
  let onStart: (() => void) | null = null;
  const sendStart = () => { starts.push(Date.now()); typing("start"); onStart?.(); };
  const nextStart = () => new Promise<void>((res) => { onStart = () => { onStart = null; res(); }; });

  await pg.waitForFunction(() => !!(globalThis as any).EW?.remotes?.get("claude")?.avatar?.label, null, { timeout: 90000 });
  // The page's log (see the header). A replaced avatar, or a replaced socket, is wrapped or counted anew.
  await pg.evaluate(() => {
    const g = globalThis as any;
    g.__log = { signals: [] as number[], says: [] as number[], updates: [] as unknown[], avatars: 0, sockets: 0 };
    const wrap = (av: any) => {
      if (!av || av.__probed) return;
      av.__probed = true;
      g.__log.avatars++;
      const { setTyping, say, update } = av;
      av.setTyping = function (...a: unknown[]) { g.__log.signals.push(Date.now()); return setTyping.apply(this, a); };
      av.say = function (...a: unknown[]) { g.__log.says.push(Date.now()); return say.apply(this, a); };
      av.update = function (...a: unknown[]) {
        const r = update.apply(this, a);
        const now = typeof a[1] === "number" ? (a[1] as number) : performance.now();
        g.__log.updates.push({ w: Date.now(), drawn: !!this.typing?.visible, bubble: !!this.bubble, win: now < this._typingUntil, mic: this._typingState === "mic" });
        return r;
      };
    };
    let ws = g.EW.net.ws;
    const watch = () => { wrap(g.EW.remotes.get("claude")?.avatar); if (g.EW.net.ws !== ws) { ws = g.EW.net.ws; g.__log.sockets++; } };
    watch();
    setInterval(watch, 100);
  });
  type Update = { w: number; drawn: boolean; bubble: boolean; win: boolean; mic: boolean };
  const readLog = () => pg.evaluate(() => (globalThis as any).__log) as Promise<{ signals: number[]; says: number[]; updates: Update[]; avatars: number; sockets: number }>;
  // The first update after `since` for which pred holds, polled for up to ms, or null. A far avatar updates
  // only on its level-of-detail ticks (client/lib/remotes.js), which a loaded page spaces seconds apart, and
  // between updates its pill stays as the last one left it.
  const pollPage = async (pred: (u: Update) => boolean, ms: number, since: number) => {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      const us = await pg.evaluate((since: number) => (globalThis as any).__log.updates.filter((u: Update) => u.w > since), since) as Update[];
      const hit = us.find(pred);
      if (hit) return hit;
      await sleep(250);
    }
    return null;
  };
  // A span the dots should be drawn through: the update that set the pill at its start (the last at or
  // before it), and every update in it, drew them, since between updates the pill stays as it was.
  const drawnThrough = (name: string, U: Update[], a: number, b: number) => {
    const atStart = U.filter((u) => u.w <= a).at(-1);
    const us = [...(atStart ? [atStart] : []), ...U.filter((u) => u.w > a && u.w < b)];
    const notDrawn = us.filter((u) => !u.drawn);
    const gap = Math.max(0, ...us.slice(1).map((u, i) => u.w - us[i]!.w));
    check(name, us.length > 0 && notDrawn.length === 0,
      `${us.length - notDrawn.length}/${us.length} updates drew them, the one in place at the span's start included${notDrawn.length ? `; the first that didn't at ${notDrawn[0]!.w - T0} ms` : ""}; the page's longest gap between updates ${gap} ms`);
  };
  // After the dots' last window has ended: the page's next update leaves them undrawn. The last signal is
  // read again once that update lands, so a signal still on its way counts.
  const goneAfter = async (name: string, from: number) => {
    let last = Math.max(...(await readLog()).signals.filter((t) => t >= from));
    const next = await pollPage(() => true, 25000, last + 4100);
    last = Math.max(...(await readLog()).signals.filter((t) => t >= from));
    check(name, next !== null && next.w > last + 4100 && !next.drawn,
      next === null ? "no update came after the window" : `the last signal it applied at ${last - T0} ms; its next update after the window, at ${next.w - T0} ms, ${next.drawn ? "drew" : "didn't draw"} them`);
  };

  // A turn as agent-framework runs it: start, and again every 7 s until stop. It walks, speaks, and goes on
  // after the speech until the dots are back.
  const SAY = "Here now. I came over to see the frame you were building by the water, and to ask whether the beams on the east side are meant to meet the deck or to stop just short of it, as the drawing seems to show.";
  const T0 = Date.now();
  sendStart();
  const refresher = setInterval(sendStart, 7000);
  await sleep(9000);
  const walkStart = Date.now(); const walkId = walk(30);   // a walk the door answers on arrival, about 19 s on
  await sleep(15000);
  const walkPending15 = !responses.has(walkId);
  // The speech goes 300 ms after a start, so the host's next start is about 6.7 s after it: long enough to see
  // that the door's relay stopped at the speech, since it would otherwise signal every 2.5 s.
  await nextStart(); await sleep(300);
  const sayAt = Date.now(); say(SAY);
  const bubbleShown = await pollPage((u) => u.bubble, 20000, sayAt);
  const bubbleGone = bubbleShown && await pollPage((u) => !u.bubble, 30000, bubbleShown.w);
  const backUp = bubbleGone && await pollPage((u) => u.drawn, 15000, bubbleGone.w);
  await sleep(2000);
  // The stop goes 300 ms after a start too, so a door that ignored it would go on signalling for seconds.
  await nextStart(); await sleep(300);
  clearInterval(refresher);
  const stopAt = Date.now(); typing("stop");
  const walkReply = responses.get(walkId);
  await sleep(2000);
  const log = await readLog();
  const U = log.updates;

  const firstFrame = worldTyping.find((t) => t >= starts[0]!) ?? null;
  check("the world sends the first start's frame at once, within 1 s", firstFrame !== null && firstFrame - starts[0]! < 1000,
    firstFrame === null ? "none came" : `${firstFrame - starts[0]!} ms after the start, with this side's longest stall in it ${sideStall(starts[0]!, firstFrame)} ms`);
  const firstApplied = log.signals.find((t) => t >= starts[0]!) ?? null;
  const firstUpdate = firstApplied === null ? undefined : U.find((u) => u.w > firstApplied);
  check("the page's first update after it applied that signal draws the dots", !!firstUpdate?.drawn,
    firstApplied === null ? "no signal applied" : `applied ${firstApplied - starts[0]!} ms after the start, drawn at the update ${firstUpdate ? firstUpdate.w - firstApplied + " ms" : "never"} after that`);
  const firstDrawn = firstUpdate?.drawn ? firstUpdate.w : walkStart;
  drawnThrough("…they stay drawn between the host's 7 s starts, past the world's 4 s window", U, firstDrawn, walkStart);
  check("the walk is still under way 15 s in", walkPending15);
  drawnThrough("…and through the walk, up to the speech", U, walkStart, sayAt);
  const turnFrames = worldTyping.filter((t) => t >= starts[0]! && t <= (sayEntryAt ?? sayAt));
  const marks = [starts[0]!, ...turnFrames, sayEntryAt ?? sayAt];
  const steps = marks.slice(1).map((t, i) => t - marks[i]!);
  const longest = Math.max(...steps), at = steps.indexOf(longest);
  check("from the first start to the speech, the world sent a typing frame at least every 4 s, the window each one opens",
    turnFrames.length > 0 && sayEntryAt !== null && longest < 4000,
    `${turnFrames.length} frames; the start to the first ${steps[0]} ms, the last to the speech ${steps.at(-1)} ms, the longest step ${longest} ms, with this side's longest stall in it ${sideStall(marks[at]!, marks[at + 1]!)} ms`);

  check("the speech shows as a bubble", bubbleShown);
  const nextAfterSay = starts.find((s) => s > sayAt) ?? null;
  const quiet = sayEntryAt === null || nextAfterSay === null ? null : worldTyping.filter((t) => t > sayEntryAt! && t < nextAfterSay);
  check("the speech ends the door's relay: the world sends no typing frame from the speech to the host's next start",
    quiet !== null && nextAfterSay! - sayEntryAt! >= 3000 && quiet.length === 0,
    sayEntryAt === null ? "the world logged no speech" : `the next start came ${nextAfterSay === null ? "never" : nextAfterSay - sayEntryAt + " ms"} after the speech's log entry; frames between: ${quiet?.length ?? "-"}`);
  const bubbled = U.filter((u) => u.bubble && u.w >= sayAt);
  check("the pill isn't drawn while the bubble shows", bubbled.length > 0 && bubbled.every((u) => !u.drawn),
    `${bubbled.filter((u) => u.drawn).length} of ${bubbled.length} updates with the bubble drew it`);
  check("…though a typing window opened while it showed, so the rule was in play", bubbled.some((u) => u.win),
    `${bubbled.filter((u) => u.win).length} of ${bubbled.length} updates with the bubble had a window open`);
  check("the bubble goes", bubbleGone);
  const lastBubble = bubbled.at(-1)?.w ?? null;
  const backAt = lastBubble === null ? null : U.find((u) => u.w > lastBubble && u.drawn)?.w ?? null;
  check("after the bubble, the turn goes on and the dots are drawn again before the host's stop", !!backUp && backAt !== null && backAt < stopAt,
    `bubble last seen at ${lastBubble === null ? "-" : lastBubble - T0} ms, drawn again at ${backAt === null ? "-" : backAt - T0} ms, stop at ${stopAt - T0} ms`);
  drawnThrough("…and stay drawn until the stop", U, backAt ?? stopAt, stopAt);

  // An update's own clock is its frame's start, a little before its stamp, so goneAfter allows 100 ms.
  await goneAfter("after the host's stop, the page's first update once its last signal has had its 4 s doesn't draw the dots", starts[0]!);
  const lateFrames = worldTyping.filter((t) => t > stopAt + 1500);
  check("…and the world sends no typing frame later than 1.5 s after the stop", lateFrames.length === 0,
    lateFrames.length ? `at ${lateFrames.map((t) => t - stopAt).join(", ")} ms after it` : "");
  check("the turn's walk ended as asked", !!walkReply && "result" in walkReply && !walkReply.result?.isError, JSON.stringify(walkReply ?? null).slice(0, 160));
  check("no update drew the live-mic pill, since an agent's frames carry no state", U.every((u) => !u.mic));

  // Another channel's typing raises no dots here, and a start for this world after it does.
  const otherAt = Date.now(); typing("start", "world:elsewhere");
  const otherSeen = await pollPage(() => true, 25000, otherAt + 1000);
  check("a start for another channel draws no dots here", otherSeen !== null && !otherSeen.drawn && (await readLog()).signals.every((t) => t < otherAt),
    otherSeen === null ? "no update came" : `the update at ${otherSeen.w - otherAt} ms after it ${otherSeen.drawn ? "drew" : "didn't draw"} them`);
  const ctlAt = Date.now(); sendStart();
  const ctl = await pollPage((u) => u.drawn, 25000, ctlAt);
  check("…and a start for this world then does", ctl !== null, ctl === null ? "" : `drawn ${ctl.w - ctlAt} ms after it`);
  typing("stop");
  await goneAfter("…and after its stop, the page's first update once its window ends doesn't draw them", ctlAt);

  // The host disconnects mid-walk, with no stop: the door's relay ends with it, and the dots go with the window.
  const goneFrom = Date.now(); sendStart();
  await sleep(1500); walk(0);
  const raised = await pollPage((u) => u.drawn, 25000, goneFrom);
  check("before the host disconnects mid-walk, its start drew the dots", raised !== null);
  const closeAt = Date.now(); host.close();
  await goneAfter("once it disconnects, the page's first update after its last signal's window doesn't draw the dots", goneFrom);
  const afterClose = worldTyping.filter((t) => t > closeAt + 1500);
  check("…and the world sends no typing frame later than 1.5 s after the close", afterClose.length === 0,
    afterClose.length ? `at ${afterClose.map((t) => t - closeAt).join(", ")} ms after it` : "");
  const log3 = await readLog();

  check("the page threw nothing", errs.length === 0, errs.slice(0, 3).join(" | "));
  console.log(`  the page applied ${log3.signals.length} typing signals over ${log3.updates.length} updates; its socket was replaced ${log3.sockets} times, and the agent's avatar wrapped ${log3.avatars} times`);
  console.log(`  this side's event loop stalled over 250 ms ${hbStalls.length} times, the longest ${Math.max(0, ...hbStalls.map(([, gap]) => gap))} ms`);
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
