// Cold-boot benchmark.
//
//   bun tools/bootbench.ts                        # localhost, cold cache
//   bun tools/bootbench.ts --mbit 5               # throttled to 5 Mbit
//   URL=https://show.example bun tools/bootbench.ts --mbit 20 --runs 3
//
// Warm localhost numbers are close to meaningless for judging arrival — the
// whole payload lands in a few hundred milliseconds and every asset is already
// in the disk cache. This drives a REAL headless Chrome over CDP with the cache
// disabled and the link throttled, and reads the client's own `[boot]` line, so
// the phases it reports are the ones a person actually waits through.

import { chromeArgs, findChrome } from "./protocol/chrome.ts";

const args = process.argv.slice(2);
const flag = (n: string, d: number) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? Number(args[i + 1]) : d;
};
const MBIT = flag("mbit", 0);            // 0 = unthrottled
const RUNS = flag("runs", 1);
const LATENCY = flag("latency", MBIT ? 40 : 0);
const BASE = process.env.URL ?? "http://localhost:8941";
const WORLD = process.env.WORLD ?? "scene1";
const CHROME = findChrome() ?? "";
if (!CHROME) { console.error("no Chromium found (set CHROME=/path/to/chrome)"); process.exit(2); }
const PORT_BASE = 9444;

type Boot = { ms: number; marks: Record<string, number>; bytes: number; requests: number };

async function cdp<T = any>(ws: WebSocket, id: number, method: string, params: unknown = {}, sessionId?: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const onMsg = (ev: MessageEvent) => {
      const m = JSON.parse(String(ev.data));
      if (m.id !== id) return;
      ws.removeEventListener("message", onMsg as any);
      m.error ? reject(new Error(`${method}: ${m.error.message}`)) : resolve(m.result);
    };
    ws.addEventListener("message", onMsg as any);
    ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
}

async function once(run: number): Promise<Boot> {
  const PORT = PORT_BASE + run;   // a fresh port per run; the last Chrome may still be dying
  const profile = `/tmp/ew-bootbench-${Date.now()}-${run}`;
  const chrome = Bun.spawn([
    CHROME, ...chromeArgs({ port: PORT, profile, extra: ["--disable-gpu-shader-disk-cache"] }), "about:blank",
  ], { stdout: "ignore", stderr: "ignore" });

  // wait for the debugger
  let target: any = null;
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const list = await r.json();
      target = list.find((t: any) => t.type === "page");
      if (target) break;
    } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 120));
  }
  if (!target) { chrome.kill(); throw new Error("chrome debugger never appeared"); }

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

  let id = 1;
  await cdp(ws, id++, "Runtime.enable");
  await cdp(ws, id++, "Network.enable");
  await cdp(ws, id++, "Page.enable");
  // A cold arrival means an empty cache — otherwise this measures nothing but
  // the disk.
  await cdp(ws, id++, "Network.setCacheDisabled", { cacheDisabled: true });
  if (MBIT > 0) {
    const bps = (MBIT * 1_000_000) / 8;
    await cdp(ws, id++, "Network.emulateNetworkConditions", {
      offline: false, latency: LATENCY, downloadThroughput: bps, uploadThroughput: bps,
    });
  }

  const bootLine = new Promise<{ ms: number; marks: Record<string, number> }>((resolve) => {
    ws.addEventListener("message", (ev: any) => {
      const m = JSON.parse(String(ev.data));
      if (m.method !== "Runtime.consoleAPICalled") return;
      const first = m.params.args?.[0]?.value;
      if (typeof first !== "string" || !first.startsWith("[boot] ready")) return;
      const ms = Number(/ready in (\d+)ms/.exec(first)?.[1] ?? 0);
      const marks: Record<string, number> = {};
      for (const p of m.params.args?.[1]?.preview?.properties ?? []) marks[p.name] = Number(p.value);
      resolve({ ms, marks });
    });
  });

  const url = `${BASE}/?name=bench${run}&world=${WORLD}`;
  await cdp(ws, id++, "Page.navigate", { url });

  const timeout = new Promise<never>((_, rej) => setTimeout(() => rej(new Error("no [boot] line within 120s")), 120_000));
  const { ms, marks } = await Promise.race([bootLine, timeout]);

  const stats = await cdp<any>(ws, id++, "Runtime.evaluate", {
    expression: `JSON.stringify((() => {
      const r = performance.getEntriesByType('resource');
      return { bytes: r.reduce((s,x) => s + (x.encodedBodySize||0), 0), requests: r.length };
    })())`,
    returnByValue: true,
  });
  const parsed = JSON.parse(stats.result.value);

  ws.close();
  chrome.kill();
  await chrome.exited.catch(() => {});
  await Bun.$`rm -rf ${profile}`.quiet().catch(() => {});
  return { ms, marks, bytes: parsed.bytes, requests: parsed.requests };
}

const label = MBIT ? `${MBIT} Mbit / ${LATENCY}ms RTT` : "unthrottled";
console.log(`\ncold boot — ${BASE} · ${label} · cache disabled · ${RUNS} run(s)\n`);

const results: Boot[] = [];
for (let i = 0; i < RUNS; i++) {
  const r = await once(i);
  results.push(r);
  const ph = Object.entries(r.marks).sort((a, b) => a[1] - b[1])
    .map(([k, v]) => `${k} ${v}ms`).join(" · ");
  console.log(`  run ${i + 1}: \x1b[36m${r.ms}ms\x1b[0m  ${(r.bytes / 1048576).toFixed(1)}MB over ${r.requests} requests`);
  console.log(`          ${ph}`);
}

if (RUNS > 1) {
  const times = results.map((r) => r.ms).sort((a, b) => a - b);
  const median = times[Math.floor(times.length / 2)];
  console.log(`\n  median \x1b[36m${median}ms\x1b[0m  (min ${times[0]}, max ${times[times.length - 1]})`);
}
console.log("");
