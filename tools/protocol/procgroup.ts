// A suite's processes, found and killed the same way on Linux, macOS and Windows (review #260, rereview blocker 2: the gate
// read /proc and crashed on macOS before the first suite).
//   Linux:   /proc/<pid>/stat (no subprocess per suite)
//   macOS and other POSIX: `ps -A -o pid=,pgid=,stat=`
//   Windows: no process groups, so a suite's processes are the tree under the pid it was started as, walked from the
//            parent links in Win32_Process (they survive the parent's exit, so orphans still count); killed with taskkill.
import fs from "node:fs"; import { spawn, spawnSync } from "node:child_process";

export type Row = { pid: number; pgid: number; ppid: number; zombie: boolean };

/** Every process on this machine, as far as this OS lets us see it. */
export function processTable(platform: NodeJS.Platform = process.platform): Row[] {
  if (platform === "linux" && fs.existsSync("/proc/self/stat")) {
    return fs.readdirSync("/proc").filter((p) => /^\d+$/.test(p)).flatMap((p) => {
      try {
        const s = fs.readFileSync(`/proc/${p}/stat`, "utf8"); const f = s.slice(s.lastIndexOf(")") + 2).split(" ");
        return [{ pid: Number(p), ppid: Number(f[1]), pgid: Number(f[2]), zombie: f[0] === "Z" }];
      } catch { return []; }
    });
  }
  if (platform === "win32") {
    const r = spawnSync("powershell.exe", ["-NoProfile", "-Command",
      "Get-CimInstance Win32_Process | ForEach-Object { \"$($_.ProcessId) $($_.ParentProcessId)\" }"], { encoding: "utf8", timeout: 30_000 });
    // bounded: the gate is sequential and waits on this, so a stalled WMI query once froze a whole CI run past its 90 min (10-19)
    if (r.error || r.status !== 0) console.error(`[procgroup] the Windows process table didn't answer (${r.error?.message ?? `exit ${r.status}`}); killing by tree only`);
    return parseWinTable(r.stdout ?? "");
  }
  const r = spawnSync("ps", ["-A", "-o", "pid=,pgid=,ppid=,stat="], { encoding: "utf8", timeout: 30_000 });
  return parsePsTable(r.stdout ?? "");
}

export function parsePsTable(out: string): Row[] {
  return out.split("\n").map((l) => l.trim().split(/\s+/)).filter((f) => f.length >= 4 && /^\d+$/.test(f[0]))
    .map((f) => ({ pid: Number(f[0]), pgid: Number(f[1]), ppid: Number(f[2]), zombie: f[3].startsWith("Z") }));
}
export function parseWinTable(out: string): Row[] {
  return out.split(/\r?\n/).map((l) => l.trim().split(/\s+/)).filter((f) => f.length >= 2 && /^\d+$/.test(f[0]))
    .map((f) => ({ pid: Number(f[0]), ppid: Number(f[1]), pgid: 0, zombie: false }));
}

/** The live processes a suite started as `root` still has: its process group on POSIX, its process tree on Windows. */
export function suiteMembers(root: number, table: Row[] = processTable(), platform: NodeJS.Platform = process.platform): number[] {
  if (platform !== "win32") return table.filter((r) => r.pgid === root && !r.zombie).map((r) => r.pid);
  const kids = new Map<number, number[]>(); for (const r of table) { if (r.pid !== r.ppid) kids.set(r.ppid, [...(kids.get(r.ppid) ?? []), r.pid]); }
  const seen = new Set<number>(), todo = [root];
  while (todo.length) { const p = todo.pop()!; for (const c of kids.get(p) ?? []) if (!seen.has(c)) { seen.add(c); todo.push(c); } }
  if (table.some((r) => r.pid === root)) seen.add(root);
  return [...seen];
}

/** Kill what a suite started (`root` and everything with it). Never throws: a gone process is the goal. */
export function killSuite(root: number, sig: NodeJS.Signals, platform: NodeJS.Platform = process.platform): void {
  if (platform !== "win32") { try { process.kill(-root, sig); } catch { /* gone */ } return; }
  // Windows has no signals or groups: kill the tree, children first (taskkill /T can't find orphans of a dead root)
  const members = suiteMembers(root, processTable("win32"), "win32");
  for (const pid of (members.length ? members : [root]).reverse()) spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", timeout: 15_000 });
}

// ---- the gate's kill path, asynchronous end to end (CI 10-21: on Windows a synchronous WMI query or taskkill can block forever
// when a grandchild holds its pipe, whatever timeout it was given; the gate's event loop froze, and with it every timer that
// could have moved on, until the job's two-hour limit). These never block: each child call has a bound, and past it we
// give up on the answer (an empty table, a kill that may not have landed) and say so, rather than wait.

/** Run a command, give back its stdout, or null past `ms` (the command is killed and left behind; never waited on). */
function outputOf(cmd: string, args: string[], ms: number): Promise<string | null> {
  return new Promise((res) => {
    let out = "", done = false; const end = (v: string | null) => { if (!done) { done = true; clearTimeout(t); res(v); } };
    let c: ReturnType<typeof spawn>;
    try { c = spawn(cmd, args, { stdio: ["ignore", "pipe", "ignore"], windowsHide: true }); } catch { return res(null); }
    const t = setTimeout(() => { try { c.kill("SIGKILL"); } catch { /* gone */ } end(null); }, ms);
    c.stdout!.on("data", (b) => { out += b.toString(); });
    c.on("error", () => end(null)); c.on("exit", (code) => end(code === 0 ? out : null));
  });
}
const WIN_QUERY = ["-NoProfile", "-Command", "Get-CimInstance Win32_Process | ForEach-Object { \"$($_.ProcessId) $($_.ParentProcessId)\" }"];

/** processTable, without blocking. `query` and `ms` are for tests (a query that never answers). */
export async function processTableAsync(platform: NodeJS.Platform = process.platform, { ms = 30_000, query }: { ms?: number; query?: () => Promise<string | null> } = {}): Promise<Row[]> {
  if (platform === "linux" && !query) return processTable("linux");   // /proc reads are local files: they don't hang
  const ask = query ?? (() => platform === "win32" ? outputOf("powershell.exe", WIN_QUERY, ms) : outputOf("ps", ["-A", "-o", "pid=,pgid=,ppid=,stat="], ms));
  const out = await Promise.race([ask(), new Promise<null>((r) => setTimeout(() => r(null), ms))]);
  if (out === null) { if (platform === "win32") console.error("[procgroup] the Windows process table didn't answer in time; killing by tree only"); return []; }
  return platform === "win32" ? parseWinTable(out) : parsePsTable(out);
}
export async function suiteMembersAsync(root: number, platform: NodeJS.Platform = process.platform): Promise<number[]> {
  return suiteMembers(root, await processTableAsync(platform), platform);
}
/** killSuite, without blocking: POSIX signals the group (a signal never blocks); Windows kills the tree it can find, children
 *  first, then the root's own tree with taskkill /T, each call bounded. */
export async function killSuiteAsync(root: number, sig: NodeJS.Signals, platform: NodeJS.Platform = process.platform): Promise<void> {
  if (platform !== "win32") { try { process.kill(-root, sig); } catch { /* gone */ } return; }
  const members = await suiteMembersAsync(root, "win32");
  for (const pid of [...members].reverse().filter((p) => p !== root)) await outputOf("taskkill", ["/PID", String(pid), "/T", "/F"], 15_000);
  await outputOf("taskkill", ["/PID", String(root), "/T", "/F"], 15_000);
}
