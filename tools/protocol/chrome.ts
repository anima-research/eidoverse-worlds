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
    // fork exp/mac-gl runs 39853908965 and 39854960274)
    ...(platform === "darwin" ? ["--use-mock-keychain", "--disable-gpu-vsync", "--disable-frame-rate-limit"] : []),
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
