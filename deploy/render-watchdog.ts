// render-watchdog — keep the /snap renderer alive AND current.
//
// The old run-mac-renderer.sh relaunched Chrome only when it EXITED. But the
// renderer's real failure mode is not a crash — it is a HANG: after a day or
// two the client leaks (measured 6.8 GB RSS), the main thread pegs, and Chrome
// keeps its websocket open (so the server still thinks it has a renderer) while
// answering no snap requests. A crash-only loop never notices, so the box sat
// with a dead renderer indefinitely.
//
// This watchdog OWNS the renderer's lifecycle and restarts it on any of:
//   - crash        — Chrome process gone
//   - hang         — main thread unresponsive to a trivial CDP eval
//   - frozen       — booted but 0 fps / not joined for several checks
//   - memory       — RSS over a cap, before it reaches the hang zone
//   - stale code   — the served client changed (a deploy) — reload for new code
//   - old age      — a max uptime, as a backstop against slow leaks
//
// Env: SHOW_URL WORLD KEY (as run-mac-renderer.sh), plus PORT (devtools),
//   CHROME, MEM_CAP_GB, MAX_UPTIME_MIN, CHECK_SEC, STRIKES, BOOT_GRACE_SEC.

const SHOW_URL = process.env.SHOW_URL;
if (!SHOW_URL) { console.error("set SHOW_URL (e.g. https://eidoverse.animalabs.ai)"); process.exit(1); }
const WORLD = process.env.WORLD ?? "commons";
const KEY = process.env.KEY ?? "";
const PORT = Number(process.env.PORT ?? 9223);
const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PROFILE = process.env.PROFILE ?? `/tmp/eido-renderer-${WORLD}`;

const MEM_CAP_GB = Number(process.env.MEM_CAP_GB ?? 5.5);   // fresh is ~2.8; hang was ~6.8
const MAX_UPTIME_MIN = Number(process.env.MAX_UPTIME_MIN ?? 180);
const CHECK_SEC = Number(process.env.CHECK_SEC ?? 20);
const STRIKES = Number(process.env.STRIKES ?? 3);           // consecutive bad checks → restart
const BOOT_GRACE_SEC = Number(process.env.BOOT_GRACE_SEC ?? 45);
const VERSION_URL = `${SHOW_URL}/client-version`;

const URL = `${SHOW_URL}/?world=${WORLD}&renderer&name=mac-gpu-${WORLD}` + (KEY ? `&key=${KEY}` : "");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const log = (m: string) => console.log(`[watchdog ${new Date().toISOString().slice(11, 19)}] ${m}`);
const sh = async (cmd: string) => (await new Response(Bun.spawn(["bash", "-c", cmd]).stdout).text()).trim();

/** Sum RSS (GB) of every Chrome process in this renderer's profile tree. */
async function rssGB(): Promise<number> {
  const out = await sh(`ps aux | grep 'user-data-dir=${PROFILE}' | grep -v grep | awk '{s+=$6} END{print s+0}'`);
  return (Number(out) || 0) / 1048576;
}

/** Fetch the served client's version marker (a deploy changes it). Absent/old
 *  server → null, which the caller treats as "can't tell, don't restart". */
async function clientVersion(): Promise<string | null> {
  try {
    const r = await fetch(VERSION_URL, { signal: AbortSignal.timeout(5000) });
    if (!r.ok) return null;
    return (await r.text()).trim().slice(0, 200);
  } catch { return null; }
}

type Health = { alive: boolean; healthy: boolean; reason: string; fps?: number };
async function health(): Promise<Health> {
  let list: any;
  try { list = await (await fetch(`http://127.0.0.1:${PORT}/json`, { signal: AbortSignal.timeout(4000) })).json(); }
  catch { return { alive: false, healthy: false, reason: "chrome down" }; }
  const page = list.find((t: any) => t.type === "page" && String(t.url).includes("renderer"));
  if (!page?.webSocketDebuggerUrl) return { alive: true, healthy: false, reason: "no renderer page" };

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  const opened = await new Promise((res) => { ws.onopen = () => res(true); ws.onerror = () => res(false); setTimeout(() => res(false), 4000); });
  if (!opened) return { alive: true, healthy: false, reason: "cannot attach devtools" };

  let id = 1;
  const TIMEOUT = Symbol("timeout");
  const evalx = (expr: string, ms = 5000) => new Promise<any>((res) => {
    const i = id++; let done = false;
    const h = (e: any) => { const m = JSON.parse(String(e.data)); if (m.id === i) { done = true; ws.removeEventListener("message", h); res(m.result?.result?.value); } };
    ws.addEventListener("message", h);
    ws.send(JSON.stringify({ id: i, method: "Runtime.evaluate", params: { expression: expr, returnByValue: true } }));
    setTimeout(() => { if (!done) res(TIMEOUT); }, ms);
  });

  try {
    if ((await evalx("1+1")) === TIMEOUT) return { alive: true, healthy: false, reason: "main thread hung" };
    const fps = Number(await evalx("+(document.getElementById('hud')?.textContent?.match(/(\\d+)fps/)?.[1]??0)"));
    const joined = (await evalx("!!(window.EW?.net?.joined)")) === true;
    return { alive: true, healthy: fps > 0 && joined, reason: joined ? `fps=${fps}` : "not joined", fps };
  } finally { ws.close(); }
}

async function killTree() {
  await sh(`pkill -9 -f 'user-data-dir=${PROFILE}' || true`);
  await sleep(2000);
}

async function launch() {
  await killTree();                       // never leave a stray tree behind
  log(`launching renderer → ${WORLD}`);
  Bun.spawn([CHROME, "--headless=new", `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${PROFILE}`, "--no-first-run", "--disable-extensions", URL],
    { stdout: "ignore", stderr: "ignore" });
}

// graceful shutdown: don't leave an orphan renderer when the watchdog is killed
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, async () => { log("shutting down — killing renderer"); await killTree(); process.exit(0); });
}

log(`watching ${SHOW_URL}/?world=${encodeURIComponent(WORLD)}&renderer  (credential redacted; mem cap ${MEM_CAP_GB}GB, max uptime ${MAX_UPTIME_MIN}m, check ${CHECK_SEC}s)`);
for (;;) {
  await launch();
  const started = Date.now();
  await sleep(BOOT_GRACE_SEC * 1000);
  // The version marker may be unreadable at boot — the sequencer could be
  // mid-restart, or (as happened here) running a build that predates the
  // /client-version route and answers 500. That used to pin bornVersion at
  // null for the renderer's whole life, and the deploy check below requires
  // it, so a renderer launched during that window NEVER picked up a deploy
  // again: exactly the "prod is serving stale client" failure this watchdog
  // exists to prevent, reintroduced by its own baseline. So the baseline
  // binds LATE — the first reading we can actually get becomes it.
  let bornVersion = await clientVersion();
  let strikes = 0, reason = "";

  while (!reason) {
    await sleep(CHECK_SEC * 1000);
    const upMin = (Date.now() - started) / 60000;

    const h = await health().catch((e) => ({ alive: true, healthy: false, reason: `probe error: ${e?.message ?? e}` } as Health));
    if (!h.alive) { reason = "crashed"; break; }

    const rss = await rssGB();
    if (rss > MEM_CAP_GB) { reason = `memory ${rss.toFixed(1)}GB`; break; }
    if (upMin > MAX_UPTIME_MIN) { reason = `uptime ${upMin.toFixed(0)}m`; break; }

    const nowVersion = await clientVersion();
    if (bornVersion === null && nowVersion !== null) {
      // Late baseline (see above). A deploy we could not observe is not a
      // deploy we can act on — adopt what we can now read and watch from here.
      bornVersion = nowVersion;
      log(`client version readable again — baseline adopted`);
    } else if (bornVersion && nowVersion && nowVersion !== bornVersion) {
      reason = "client updated"; break;
    }

    if (!h.healthy) {
      if (++strikes >= STRIKES) { reason = `unhealthy (${h.reason})`; break; }
      log(`strike ${strikes}/${STRIKES}: ${h.reason}`);
    } else {
      if (strikes) log(`recovered (${h.reason})`);
      strikes = 0;
    }
  }

  log(`restarting: ${reason}`);
  await killTree();
  await sleep(3000);
}
