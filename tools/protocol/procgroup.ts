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
/** Which Windows processes to kill for a suite started as `root`, deepest first, each one by its own id (never `/T`).
 *  Windows reuses process ids (CI 10-22: the runner "lost communication" mid-gate, with a tree kill aimed at an exited
 *  suite's id on every suite): once the suite has `exited`, an id that is in the table again belongs to someone else, so
 *  nothing is killed; if the id is free, only its orphans are, and the dead root's id never is. */
export function winKillPlan(root: number, table: Row[], exited: boolean, self: number = process.pid): number[] {
  if (exited && table.some((r) => r.pid === root)) return [];
  // never ourselves or an ancestor: a parent id on Windows is only a number, and once the dead root's id is reused a
  // stale ParentProcessId can make the gate (or the shell that started it) look like that root's orphan. A tree kill
  // landed there once: the gate died mid-lane with exit 1 and no tally (windows-latest, 10-23, run 40054616217)
  const byPid = new Map(table.map((r) => [r.pid, r])), mine = new Set<number>();
  for (let p: number | undefined = self; p !== undefined && !mine.has(p); p = byPid.get(p)?.ppid) mine.add(p);
  const kids = new Map<number, number[]>(); for (const r of table) { if (r.pid !== r.ppid) kids.set(r.ppid, [...(kids.get(r.ppid) ?? []), r.pid]); }
  const depth = new Map<number, number>(), todo: [number, number][] = [[root, 0]];
  while (todo.length) { const [p, d] = todo.shift()!; for (const c of kids.get(p) ?? []) if (!depth.has(c) && c !== root && !mine.has(c)) { depth.set(c, d + 1); todo.push([c, d + 1]); } }
  const out = [...depth.entries()].sort((x, y) => y[1] - x[1]).map(([p]) => p);
  return exited || !table.some((r) => r.pid === root) ? out : [...out, root];
}
export async function killSuiteAsync(root: number, sig: NodeJS.Signals, platform: NodeJS.Platform = process.platform, { exited = false }: { exited?: boolean } = {}): Promise<void> {
  if (platform !== "win32") { try { process.kill(-root, sig); } catch { /* gone */ } return; }
  for (const pid of winKillPlan(root, await processTableAsync("win32"), exited)) await outputOf("taskkill", ["/PID", String(pid), "/F"], 15_000);
}
/** At exit, where nothing can be awaited: signal the group (POSIX), or start a kill of the still-running root and leave it
 *  running (Windows). The caller passes only a root it knows is still running; its children go with the next sweep. */
export function killSuiteAtExit(root: number, platform: NodeJS.Platform = process.platform): void {
  if (platform !== "win32") { try { process.kill(-root, "SIGKILL"); } catch { /* gone */ } return; }
  try { spawn("taskkill", ["/PID", String(root), "/T", "/F"], { detached: true, stdio: "ignore", windowsHide: true }).unref(); } catch { /* gone */ }
}
/** A child that isn't a group leader (spawned without `detached`): the child itself on POSIX, its whole tree on Windows,
 *  where a browser's or server's own children outlive a plain kill. Never blocks, and never aims at an exited child's id. */
export function killChild(p: { pid?: number; exitCode?: number | null; signalCode?: string | null; kill(): void } | null): void {
  if (!p || p.exitCode != null || p.signalCode != null) return;
  if (process.platform === "win32" && typeof p.pid === "number") void killSuiteAsync(p.pid, "SIGKILL", "win32");
  try { p.kill(); } catch { /* gone */ }
}
