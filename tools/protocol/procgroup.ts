// A suite's processes, found and killed the same way on Linux, macOS and Windows (review #260, rereview blocker 2: the gate
// read /proc and crashed on macOS before the first suite).
//   Linux:   /proc/<pid>/stat (no subprocess per suite)
//   macOS and other POSIX: `ps -A -o pid=,pgid=,stat=`
//   Windows: no process groups, so a suite's processes are the tree under the pid it was started as, walked from the
//            parent links in Win32_Process (they survive the parent's exit, so orphans still count); killed with taskkill.
import fs from "node:fs"; import { spawnSync } from "node:child_process";

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
      "Get-CimInstance Win32_Process | ForEach-Object { \"$($_.ProcessId) $($_.ParentProcessId)\" }"], { encoding: "utf8" });
    return parseWinTable(r.stdout ?? "");
  }
  const r = spawnSync("ps", ["-A", "-o", "pid=,pgid=,ppid=,stat="], { encoding: "utf8" });
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
  for (const pid of suiteMembers(root, processTable("win32"), "win32").reverse()) spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
}
