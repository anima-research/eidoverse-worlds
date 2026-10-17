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
// Chromium, joined to the same world, and a raw socket beside it times what the world broadcasts. In the
// page, every 100 ms, the dots count as up when a typing signal has opened the body's 4 s window
// (avatar._typingUntil) and no speech bubble hides them (client/lib/avatar.js), and as drawn when the pill
// sprite is visible (avatar.typing.visible), which follows on the next rendered frame.
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
const { browser, page } = await launchBrowser();
try {
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
  const pg = await page();
  const errs: string[] = [];
  pg.on("pageerror", (e: Error) => errs.push(e.message));
  pg.on("dialog", (d: any) => d.dismiss().catch(() => {}));
  await pg.goto(`${origin}/?world=commons&name=viewer`, { waitUntil: "domcontentloaded", timeout: 60000 });
  await pg.waitForFunction(() => document.getElementById("splash")?.classList.contains("gone") && !!(globalThis as any).EW?.me?.(),
    null, { timeout: 120000 });

  // A raw socket in the same world, beside the browser: when the world broadcasts each typing frame for
  // the agent, by this side's clock. Set against the page's own record, it tells a delay in the door or
  // the world from one in the page.
  const worldTyping: number[] = [];
  const watcher = new WebSocket(`ws://127.0.0.1:${WPORT}/ws`);
  await new Promise<void>((res, rej) => {
    const t = setTimeout(() => rej(new Error("watcher join timeout")), 10000);
    watcher.onmessage = (ev) => {
      let m: any; try { m = JSON.parse(String(ev.data)); } catch { return; }
      if (m.type === "snapshot") { clearTimeout(t); res(); }
      if (m.type === "typing" && m.id === "claude") worldTyping.push(Date.now());
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

  await pg.waitForFunction(() => !!(globalThis as any).EW?.remotes?.get("claude")?.avatar?.label, null, { timeout: 90000 });
  // Every typing message the page's socket receives for the agent, by the page's clock: what sets the
  // body's 4 s window (client/lib/net.js, the 'typing' case). Exact, whatever the sampling rate.
  await pg.evaluate(() => { const g = globalThis as any; g.__typingAt = [];
    g.EW.net.ws.addEventListener("message", (ev: MessageEvent) => {
      try { const m = JSON.parse(String(ev.data)); if (m.type === "typing" && m.id === "claude") g.__typingAt.push(performance.now()); } catch { /* not ours */ }
    }); });

  // The browser's own record, sampled in the page every 100 ms for `ms`: t (ms from the start of the record),
  // up, drawn, bubble. Started without waiting, so the host can act while it records.
  const record = (ms: number) => pg.evaluate((ms: number) => new Promise<any[]>((res) => {
    const out: any[] = []; const t0 = performance.now(); (globalThis as any).__recT0 = t0;
    const id = setInterval(() => {
      const now = performance.now(), av = (globalThis as any).EW.remotes.get("claude")?.avatar;
      out.push({ t: Math.round(now - t0), up: !!av && now < av._typingUntil && !av.bubble, drawn: !!av?.typing?.visible, bubble: !!av?.bubble });
      if (now - t0 >= ms) { clearInterval(id); res(out); }
    }, 100);
  }), ms);
  const between = (rec: any[], a: number, b: number) => rec.filter((s) => s.t >= a && s.t < b);
  const longestDown = (rec: any[]) => { let run = 0, best = 0, prev = -1;
    for (const s of rec) { if (!s.up) { run += prev < 0 ? 0 : s.t - prev; best = Math.max(best, run); } else run = 0; prev = s.t; } return best; };
  const firstAt = (rec: any[], pred: (s: any) => boolean, from = 0) => rec.find((s) => s.t >= from && pred(s))?.t ?? null;
  const share = (rec: any[], key: string) => rec.length ? `${rec.filter((s) => s[key]).length}/${rec.length}` : "0/0";

  // A turn as agent-framework runs it: start, and start again every 7 s until stop. The turn has a walk and
  // speech in it, and goes on after the speech until the dots are back; the record runs past its end.
  const REC = 75000;
  const rec = record(REC);
  const T0 = Date.now(), at = () => Date.now() - T0;
  typing("start");
  const refresher = setInterval(() => typing("start"), 7000);
  await sleep(9000);
  const walkStart = at(); const walkId = walk(30);       // a walk the door answers only on arrival, ~19 s
  await sleep(15000);
  const walkPending15 = !responses.has(walkId);
  const sayAt = at(); say("Here now.");
  // The bubble shows, and goes; the turn goes on, so the host's next start raises the dots again.
  const poll = async (pred: (v: any) => boolean, ms: number) => { const u = Date.now() + ms;
    while (Date.now() < u) { const v = await pg.evaluate(() => { const av = (globalThis as any).EW.remotes.get("claude")?.avatar;
      return { bubble: !!av?.bubble, up: !!av && performance.now() < av._typingUntil && !av.bubble }; }); if (pred(v)) return true; await sleep(500); } return false; };
  await poll((v) => v.bubble, 15000);
  await poll((v) => !v.bubble, 30000);
  await poll((v) => v.up, 9000);
  await sleep(2000);
  const stopAt = at(); clearInterval(refresher); typing("stop");
  const samples = await rec;
  const arrivals: number[] = await pg.evaluate(() => { const g = globalThis as any; return g.__typingAt.map((t: number) => Math.round(t - g.__recT0)); });
  const off = 300;                                       // this side's clock against the page's record: a margin

  const rise = firstAt(samples, (s) => s.up);
  check("the host's first start raises the dots within 3 s", rise !== null && rise < 3000, `rose at ${rise} ms`);
  const before = between(samples, (rise ?? 0) + 100, walkStart - off);
  check("…they stay up between the host's 7 s starts, past the world's 4 s window",
    before.length > 0 && before.every((s) => s.up), `up ${share(before, "up")}, longest gap ${longestDown(before)} ms`);
  const walking = between(samples, walkStart + off, Math.min(walkStart + 15000, sayAt) - off);
  check("the walk is still under way 15 s in", walkPending15);
  check("…and the dots stay up through it, on the host's refreshes", walking.length > 0 && walking.every((s) => s.up),
    `up ${share(walking, "up")}, longest gap ${longestDown(walking)} ms`);
  const sayOnPage = firstAt(samples, (s) => s.bubble, sayAt - off) ?? sayAt;
  const worldTurn = worldTyping.map((t) => t - T0).filter((t) => t <= sayAt);
  const worldGaps = worldTurn.slice(1).map((t, i) => t - worldTurn[i]);
  const pageStall = Math.max(...samples.slice(1).map((s, i) => s.t - samples[i].t));
  console.log(`  the world broadcast ${worldTurn.length} typing frames before the speech, longest interval ${worldGaps.length ? Math.max(...worldGaps) : "-"} ms (${worldGaps.join(",")})`);
  console.log(`  the page's own 100 ms sampler: longest stall ${pageStall} ms over ${samples.length} samples`);
  const inTurn = arrivals.filter((t) => t <= sayOnPage);
  const gaps = inTurn.slice(1).map((t, i) => t - inTurn[i]);
  // The door's contract is what the world broadcasts: a frame at least every 4 s, the window each opens. The
  // page's own handling of those frames is reported beside it, since a page whose main thread stalls (software
  // rendering on a loaded machine) handles them late and in bunches; its sampler's longest stall says how much.
  check("from the first start to the speech, the world broadcast a typing frame at least every 4 s, the window each one opens",
    worldTurn.length > 1 && Math.max(...worldGaps) < 4000, `${worldTurn.length} frames, longest interval ${worldGaps.length ? Math.max(...worldGaps) : "-"} ms`);
  console.log(`  the page handled ${inTurn.length} of them, longest interval ${gaps.length ? Math.max(...gaps) : "-"} ms (${gaps.join(",")}), beside its own longest stall of ${pageStall} ms`);
  const lateSignals = arrivals.filter((t) => t > stopAt + 1000);
  check("no typing signal reached the browser after the host's stop", lateSignals.length === 0, `after it: ${lateSignals.join(",")}`);
  const bub = firstAt(samples, (s) => s.bubble, sayAt - off);
  check("the agent's speech shows as a bubble", bub !== null, `bubble at ${bub} ms`);
  const whileBubble = samples.filter((s) => s.bubble && s.t >= (bub ?? 0));
  check("…and the dots are down while it shows", whileBubble.length > 0 && whileBubble.every((s) => !s.up), `up ${share(whileBubble, "up")}`);
  const bubbleGone = firstAt(samples, (s) => !s.bubble, (bub ?? 0) + 100);
  const back = bubbleGone === null ? null : firstAt(samples, (s) => s.up, bubbleGone);
  check("after the bubble, the turn goes on and the dots are up again before the host's stop", back !== null && back < stopAt - off,
    `bubble gone at ${bubbleGone} ms, up again at ${back} ms, stop at ${stopAt} ms`);
  // The world's typing message can't end an agent's dots early, so after the stop they last out the 4 s
  // window of the last signal the browser got.
  const lastSignal = Math.max(...arrivals.filter((t) => t <= stopAt + 1000));
  // Judged by the samples themselves, whatever their spacing under load: none is up once that window has ended.
  const windowEnds = lastSignal + 4000;
  const upAfter = samples.filter((s) => s.t > windowEnds + 100 && s.up);
  const cleared = firstAt(samples, (s) => !s.up, stopAt);
  check("after the host's stop, the dots are down once the last signal's 4 s window ends", cleared !== null && upAfter.length === 0,
    `stop at ${stopAt} ms, last signal at ${lastSignal} ms, window ends ${windowEnds} ms, first down sample ${cleared} ms, up after it: ${upAfter.length}`);
  const after = between(samples, windowEnds + 100, REC);
  check("…and stay down until the record ends", after.length > 0 && after.every((s) => !s.up), `up ${share(after, "up")} of ${after.length}`);

  // What was drawn follows what the client decided, on the next rendered frame. Under software rendering on
  // a loaded machine a frame can be slow, so this reports how closely it followed rather than asserting it.
  const upRec = samples.filter((s) => s.up), downRec = samples.filter((s) => !s.up && s.t > (rise ?? 0));
  console.log(`  drawn: ${share(upRec, "drawn")} of the samples with the dots up, ${share(downRec, "drawn")} of those with them down`);

  // Another channel's typing raises no dots here, and a start for this world after it does.
  typing("start", "world:elsewhere");
  const other = await record(3000);
  check("a start for another channel raises no dots here", other.every((s) => !s.up), `up ${share(other, "up")}`);
  typing("start");
  const ctl = await record(3000);
  check("…and a start for this world then does", ctl.some((s) => s.up));
  typing("stop");
  await sleep(4500);

  // The host disconnects mid-walk: no new signal, so the dots go within the world's 4 s.
  typing("start");
  await sleep(1500);
  walk(0);
  await sleep(500);
  host.close();
  const gone = await record(7000);
  const lastUp = [...gone].reverse().find((s) => s.up)?.t ?? null;
  check("when the host disconnects mid-walk, the dots go within 4.5 s", lastUp === null || lastUp < 4500, `last up at ${lastUp} ms`);

  check("the turn's walk ended", !!(await (async () => { const u = Date.now() + 40000; while (Date.now() < u) { if (responses.has(walkId)) return true; await sleep(250); } return false; })()));
  check("the page threw nothing", errs.length === 0, errs.slice(0, 3).join(" | "));
} catch (e) {
  fail++;
  console.log(`FATAL ${(e as Error).message}\n${(e as Error).stack}`);
} finally {
  await browser.close().catch(() => {});
  await Promise.all([awaitExit(door), awaitExit(world)]);
  rmSync(scratch, { recursive: true, force: true });
}
// A failed run shows what the world and the door said last.
if (fail) for (const { name, err } of kids) if (err().trim()) console.log(`--- the ${name}'s stderr, last lines:\n${err()}`);
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
