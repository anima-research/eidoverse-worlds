// tools/protocol/chrome.ts — the one place a Chromium is found and its launch flags are chosen: the gate's preflight
// (run.ts), the bench harness (tools/harness.ts), browser-check's playwright launch, and the standalone benches.
//   findChrome()            CHROME, else playwright's own build, else this OS's installed Chrome/Edge, else (Linux) the
//                           newest build already in playwright's cache
//   chromeArgs({…})         a CDP-driven launch: headless, debugging port, fresh profile, quiet profile flags, this OS's flags
//   platformArgs()          only this OS's flags (+ EIDO_CHROME_ARGS): what a playwright launch adds to its own
// EIDO_CHROME_ARGS="<flags>" is appended last, an override for an experiment; a flag every run on an OS needs belongs in
// platformArgs, not in a workflow's env.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import net from "node:net";
import { spawn } from "node:child_process";
import { until } from "./wait.ts";
import { killChild } from "./procgroup.ts";

const SYSTEM: Record<string, string[]> = {
  win32: [
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  ],
  darwin: [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
  ],
  linux: ["/usr/bin/google-chrome", "/usr/bin/microsoft-edge", "/usr/bin/chromium", "/usr/bin/chromium-browser"],
};

/** A path that exists and isn't a launcher script: on Ubuntu /usr/bin/chromium-browser is a 2 KB shell stub that only
 *  says "snap install chromium", a path that exists and is not a browser. */
export function isBrowser(p: string): boolean {
  let fd: number | undefined;
  try { fd = fs.openSync(p, "r"); const b = Buffer.alloc(2); fs.readSync(fd, b, 0, 2, 0); return b.toString("latin1") !== "#!"; }
  catch { return false; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}

function playwrightBuild(): string | null {
  try { return createRequire(import.meta.url)("playwright").chromium.executablePath() as string; } catch { return null; }
}

// a playwright version bump shouldn't fail a run for want of a download: any build it already fetched will do
function cachedPlaywrightBuilds(platform: NodeJS.Platform): string[] {
  if (platform !== "linux") return [];
  const cache = process.env.PLAYWRIGHT_BROWSERS_PATH || path.join(os.homedir(), ".cache", "ms-playwright");
  let dirs: string[] = []; try { dirs = fs.readdirSync(cache); } catch { return []; }
  const rev = (d: string) => Number(d.split("-").at(-1));
  const of = (re: RegExp, exe: string) => dirs.filter((d) => re.test(d)).sort((a, b) => rev(b) - rev(a)).map((d) => path.join(cache, d, exe));
  return [...of(/^chromium-\d+$/, "chrome-linux64/chrome"), ...of(/^chromium_headless_shell-\d+$/, "chrome-headless-shell-linux64/chrome-headless-shell")];
}

/** Every place findChrome looks, in order (for a "none found" message). */
export function chromeCandidates(platform: NodeJS.Platform = process.platform): string[] {
  return [...new Set([playwrightBuild(), ...(SYSTEM[platform] ?? []), ...cachedPlaywrightBuilds(platform)].filter((p): p is string => !!p))];
}

/** CHROME when set (as given: the caller says if it's missing), else the first real browser among chromeCandidates. */
export function findChrome(platform: NodeJS.Platform = process.platform): string | null {
  if (process.env.CHROME) return process.env.CHROME;
  return chromeCandidates(platform).find(isBrowser) ?? null;
}

/** The flags every run on this OS needs, then EIDO_CHROME_ARGS. */
export function platformArgs(platform: NodeJS.Platform = process.platform): string[] {
  return [
    // Ubuntu 23.10+ (GitHub's ubuntu-latest) disables the unprivileged user namespaces Chrome's sandbox needs: "No usable
    // sandbox!" at launch. playwright passes this on Linux for the same reason.
    ...(platform === "linux" ? ["--no-sandbox"] : []),
    // run.ts gives each suite a fresh HOME, and Chrome then waits on a new login keychain forever (proven 10-19 in CI: the
    // same suite failed with a fresh HOME and passed with this flag; playwright passes it too)
    // macOS: the keychain (a launch hung on it, 10-19), and vsync. On a display-less runner VM Chrome's vsync source barely
    // ticks: the page got 4 animation frames in 2 s (264 decoupled), so anything that moves on frames ran at ~2 fps (10-22,
    // fork exp/mac-gl runs 39853908965 and 39854960274). Not --disable-frame-rate-limit too: unbounded frames starved party B2
    // on the 3-core runner (run 39866082490); vsync alone ran the lane fastest (614 s, run 39873667367)
    ...(platform === "darwin" ? ["--use-mock-keychain", "--disable-gpu-vsync"] : []),
    // Windows: a GPU-less host (GitHub's windows-latest) has no WebGPU adapter, and current Chrome no longer falls back to
    // SwiftShader for WebGL on its own: getContext() returned null and the page threw in three's WebGLExtensions at boot,
    // "the page never booted" in every browser suite (10-23, fork run 39998895713, browser.events.jsonl). This allows the
    // software fallback; a host with a GPU keeps its GPU. --use-angle=d3d11 (Chrome's default backend on a Windows GPU) makes
    // the fallback fast enough: client 205/0 in 60-68 s; without it, or with ANGLE's swiftshader backend, the suite ran past
    // its 300 s. Both flags are needed: d3d11 alone never booted. --disable-gpu-vsync changed nothing here (62 vs 60 s).
    // Fork probe runs 40016549160, 40017129818 and the 4-way matrix before them (10-23)
    ...(platform === "win32" ? ["--enable-unsafe-swiftshader", "--use-angle=d3d11"] : []),
    ...(process.env.EIDO_CHROME_ARGS ?? "").split(/\s+/).filter(Boolean),
  ];
}

/** A Chromium driven over CDP on `port`, with its own profile dir. `extra` goes before platformArgs, so the env still wins. */
export function chromeArgs({ headed = false, port, profile, extra = [] }: { headed?: boolean; port: number; profile: string; extra?: string[] },
  platform: NodeJS.Platform = process.platform): string[] {
  return [
    ...(headed ? [] : ["--headless=new"]), `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
    "--no-first-run", "--no-default-browser-check", "--disable-extensions", "--disable-background-networking", "--disable-sync", "--mute-audio",
    ...extra, ...platformArgs(platform),
  ];
}

export type Cdp = { send<T = any>(m: string, p?: unknown): Promise<T> };
/** One CDP call's budget. SwiftShader can pin a page's main thread past 60 s on a full world (Commons, 10-15), so a
 *  probe that needs to wait sets CDP_CALL_MS; the default is the old 60 s. */
const CDP_CALL_MS = Math.max(1000, Number(process.env.CDP_CALL_MS) || 60_000);
export function cdpOn(ws: WebSocket): Cdp {
  let id = 0;
  return {
    send<T = any>(method: string, params: unknown = {}): Promise<T> {
      const myId = ++id;
      return new Promise((resolveP, reject) => {
        const finish = (err?: Error, result?: T) => {
          clearTimeout(timer);
          ws.removeEventListener("message", onMsg);
          ws.removeEventListener("close", onClose);
          if (err) reject(err); else resolveP(result!);
        };
        const onMsg = (ev: MessageEvent) => {
          const m = JSON.parse(String(ev.data));
          if (m.id === myId) finish(m.error ? new Error(`${method}: ${m.error.message}`) : undefined, m.result);
        };
        const onClose = () => finish(new Error(`${method}: browser connection closed`));
        const timer = setTimeout(() => finish(new Error(`${method}: timed out`)), CDP_CALL_MS);
        ws.addEventListener("message", onMsg);
        ws.addEventListener("close", onClose);
        try { ws.send(JSON.stringify({ id: myId, method, params })); }
        catch (err) { finish(err as Error); }
      });
    },
  };
}

/** One headless page, driven over raw CDP on the runtime's own WebSocket: the way every browser suite drives Chrome.
 *  Not playwright: under Bun on Windows its launch (extra pipe descriptors Bun's spawn doesn't pass) and its connectOverCDP
 *  (its websocket transport) both hang to their timeouts (10-22, Burrow: the same launch took 112 ms under Node). The page
 *  starts blank with Runtime enabled, so an error in the first script is caught; `errors` collects uncaught exceptions
 *  and console.error. close() ends the browser and removes its profile. */
export async function cdpPage({ args = [] }: { args?: string[] } = {}) {
  const exe = findChrome();
  if (!exe) throw new Error("no Chromium to launch: set CHROME, or install playwright's (bun node_modules/playwright/cli.js install chromium)");
  const port = await new Promise<number>((res, rej) => { const s = net.createServer(); s.on("error", rej); s.listen(0, "127.0.0.1", () => { const p = (s.address() as net.AddressInfo).port; s.close(() => res(p)); }); });
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "cdp-page-"));
  const child = spawn(exe, [...chromeArgs({ port, profile, extra: args }), "about:blank"], { stdio: "ignore", windowsHide: true });
  let ws: WebSocket | null = null;
  // ask Chrome to quit (it takes its helper processes with it; a kill takes only the main one), then make sure
  const close = async () => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      await new Promise<void>((res) => { ws!.addEventListener("close", () => res()); try { ws!.send(JSON.stringify({ id: 1e9, method: "Browser.close" })); } catch { res(); } setTimeout(res, 3000); });
      await until("Chrome has exited", () => child.exitCode !== null || child.signalCode !== null, { ms: 5000 }).catch(() => {});
    }
    killChild(child); try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* still locked: the scratch dir goes with the suite */ }
  };
  try {
    const target = await until("Chromium lists its blank page", async () => {
      try { const l = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(); return l.find((t: any) => t.type === "page") ?? null; } catch { return null; }
    }, { ms: 60_000 });
    ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise<void>((res, rej) => { ws!.addEventListener("open", () => res()); ws!.addEventListener("error", () => rej(new Error("the page's debugging socket didn't open"))); });
    const errors: string[] = [];
    ws.addEventListener("message", (ev: MessageEvent) => {
      const m = JSON.parse(String(ev.data));
      if (m.method === "Runtime.exceptionThrown") errors.push(`pageerror ${m.params.exceptionDetails?.exception?.description ?? m.params.exceptionDetails?.text}`);
      if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") errors.push(`console.error ${m.params.args.map((a: any) => a.value ?? a.description).join(" ")}`);
    });
    const cdp = cdpOn(ws);
    await cdp.send("Runtime.enable"); await cdp.send("Page.enable");
    const evaluate = async (expression: string): Promise<any> => {
      const r: any = await cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails) throw new Error(`evaluate: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
      return r.result.value;
    };
    const goto = async (url: string) => {
      // A navigation can be lost to Chrome restarting its network service just after launch (windows-latest, 10-23: the page
      // sat on about:blank for 30 s). Page.navigate says so in errorText; say it, and ask once more.
      const loaded = async () => (await evaluate(`location.href.startsWith(${JSON.stringify(url)}) && document.readyState === "complete"`)) || null;
      const nav: any = await cdp.send("Page.navigate", { url });
      if (nav?.errorText) {
        console.error(`[cdpPage] navigation to ${url} failed (${nav.errorText}); asking once more`);
        await cdp.send("Page.navigate", { url });
      }
      await until(`the page loaded ${url}`, loaded, { ms: 30_000 });
    };
    return { cdp, evaluate, goto, errors, close };
  } catch (e) { await close(); throw e; }
}
