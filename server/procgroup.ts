// server/procgroup.ts — a suite's processes, found and killed the same way on Linux, macOS and Windows.
//   Linux:   /proc/<pid>/stat (no subprocess per suite)
//   macOS and other POSIX: `ps -A -o pid=,pgid=,ppid=,stat=`
//   Windows: a job object where the caller makes one (winJob: the gate's suites, the server's one-shots): the kernel's own
//            record of what a process started. Without one there are no process groups, so a suite's processes are the tree
//            under the pid it was started as, walked from the parent links (they survive the parent's exit, so orphans
//            still count; an id is no proof of ancestry, see winJob); killed with taskkill. The links come
//            from the kernel's own snapshot (CreateToolhelp32Snapshot through bun:ffi, in process, ~5 ms), and from
//            Win32_Process through PowerShell (~0.5 s a read: the gate's per-suite floor on Windows) when bun:ffi or kernel32
//            can't load, when the snapshot call fails, or when its walk stops on anything but ERROR_NO_MORE_FILES or lists nothing.
import fs from "node:fs"; import { spawn, spawnSync } from "node:child_process";

export type Row = { pid: number; pgid: number; ppid: number; zombie: boolean };

// ---- Windows: the process table from the kernel's snapshot (the same ProcessId/ParentProcessId pairs Win32_Process reports) ----
/** PROCESSENTRY32W on 64-bit Windows: dwSize at 0, th32ProcessID at 8, th32ParentProcessID at 32, 568 bytes in all. */
export const PE32W = { size: 568, pid: 8, ppid: 32 } as const;
/** One PROCESSENTRY32W's (pid, parent) as a Row. */
export function decodeEntry(dv: DataView): Row { return { pid: dv.getUint32(PE32W.pid, true), ppid: dv.getUint32(PE32W.ppid, true), pgid: 0, zombie: false }; }
/** Which source answered the last Windows table read: "toolhelp32" (in process) or "powershell" (Win32_Process). */
export const winTable = { source: "" as "" | "toolhelp32" | "powershell" };
type K32 = { CreateToolhelp32Snapshot(f: number, p: number): bigint; Process32FirstW(h: bigint, e: unknown): number; Process32NextW(h: bigint, e: unknown): number; CloseHandle(h: bigint): number; GetLastError(): number };
let k32: { sym: K32; ptr: (b: Uint8Array) => unknown } | null | undefined;
/** The Windows table from CreateToolhelp32Snapshot, or null when bun:ffi or kernel32 can't be had or the snapshot fails
 *  (the caller then asks PowerShell). A snapshot is a local kernel call: it doesn't wait on WMI, so it can't hang. */
export function toolhelpTable(): Row[] | null {
  if (process.platform !== "win32") return null;
  if (k32 === undefined) {
    try {
      const { dlopen, FFIType, ptr } = require("bun:ffi");
      const h = FFIType.u64, sym = dlopen("kernel32.dll", { CreateToolhelp32Snapshot: { args: [FFIType.u32, FFIType.u32], returns: h },
        Process32FirstW: { args: [h, FFIType.ptr], returns: FFIType.i32 }, Process32NextW: { args: [h, FFIType.ptr], returns: FFIType.i32 }, CloseHandle: { args: [h], returns: FFIType.i32 }, GetLastError: { args: [], returns: FFIType.u32 } }).symbols as K32;
      k32 = { sym, ptr };
    } catch (e) { k32 = null; console.error(`[procgroup] no in-process Windows process table (${(e as Error).message}); asking PowerShell`); }
  }
  if (!k32) return null;
  const snap = k32.sym.CreateToolhelp32Snapshot(0x2 /* TH32CS_SNAPPROCESS */, 0);
  if (snap === 0xffffffffffffffffn || snap === 0n) { snapshotFailed(`CreateToolhelp32Snapshot failed, error ${k32.sym.GetLastError()}`); return null; }   // INVALID_HANDLE_VALUE
  try {
    const buf = new Uint8Array(PE32W.size), dv = new DataView(buf.buffer); dv.setUint32(0, PE32W.size, true);
    const sym = k32.sym, at = k32.ptr(buf), w = walkSnapshot(() => sym.Process32FirstW(snap, at), () => sym.Process32NextW(snap, at), () => sym.GetLastError(), () => decodeEntry(dv));
    if (!w.rows) snapshotFailed(w.why); return w.rows;
  } finally { k32.sym.CloseHandle(snap); }
}
const ERROR_NO_MORE_FILES = 18;
/** A snapshot's walk: the rows, or null with why when it stopped on anything but ERROR_NO_MORE_FILES (a table cut short
 *  would hide a suite's processes from the sweep: the caller asks PowerShell instead). The calls are passed in for tests. */
export function walkSnapshot(first: () => number, next: () => number, lastError: () => number, read: () => Row): { rows: Row[] | null; why: string } {
  const rows: Row[] = [];
  for (let ok = first(); ok; ok = next()) rows.push(read());
  const err = lastError();
  if (err !== ERROR_NO_MORE_FILES) return { rows: null, why: `the process walk stopped after ${rows.length} entries with error ${err}, not ERROR_NO_MORE_FILES` };
  return rows.length ? { rows, why: "" } : { rows: null, why: "the snapshot listed no process" };
}
let warned = false;
/** Said once per process: a snapshot that fails here is asked of PowerShell from then on, read by read, as before. */
function snapshotFailed(why: string) { if (!warned) { warned = true; console.error(`[procgroup] the in-process Windows process table failed (${why}); asking PowerShell`); } }

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
    const t = process.platform === "win32" ? toolhelpTable() : null;
    if (t) { winTable.source = "toolhelp32"; return t; }
    winTable.source = "powershell";
    const r = spawnSync("powershell.exe", ["-NoProfile", "-Command",
      "Get-CimInstance Win32_Process | ForEach-Object { \"$($_.ProcessId) $($_.ParentProcessId)\" }"], { encoding: "utf8", timeout: 30_000 });
    // bounded: the gate waits on this, and a stalled WMI query would freeze it
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
  // Windows has no signals or groups: the root's tree first (/T), then each member by id (/T can't find orphans of a dead parent)
  const members = suiteMembers(root, processTable("win32"), "win32");
  for (const pid of (members.length ? members : [root]).reverse()) spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", timeout: 15_000 });
}

// ---- the gate's kill path, asynchronous end to end: on Windows a synchronous WMI query or taskkill can block forever when a
// grandchild holds its pipe. Each child call here has a bound, past which we give up on the answer and say so.

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
export async function processTableAsync(platform: NodeJS.Platform = process.platform, o: { ms?: number; query?: () => Promise<string | null> } = {}): Promise<Row[]> {
  return (await tableOrNull(platform, o)) ?? [];
}
/** The table, or null when it didn't answer in `ms` (killSuiteAsync then falls back to the root's tree). */
async function tableOrNull(platform: NodeJS.Platform, { ms = 30_000, query }: { ms?: number; query?: () => Promise<string | null> } = {}): Promise<Row[] | null> {
  if (platform === "linux" && !query) return processTable("linux");   // /proc reads are local files: they don't hang
  if (platform === "win32" && !query) { const t = toolhelpTable(); if (t) { winTable.source = "toolhelp32"; return t; } winTable.source = "powershell"; }   // a snapshot doesn't hang either
  const ask = query ?? (() => platform === "win32" ? outputOf("powershell.exe", WIN_QUERY, ms) : outputOf("ps", ["-A", "-o", "pid=,pgid=,ppid=,stat="], ms));
  const out = await Promise.race([ask(), new Promise<null>((r) => setTimeout(() => r(null), ms))]);
  if (out === null) { if (platform === "win32") console.error("[procgroup] the Windows process table didn't answer in time; killing by tree only"); return null; }
  return platform === "win32" ? parseWinTable(out) : parsePsTable(out);
}
export async function suiteMembersAsync(root: number, platform: NodeJS.Platform = process.platform): Promise<number[]> {
  return suiteMembers(root, await processTableAsync(platform), platform);
}
/** What a suite left running, read once it has ended: `read` gives the live processes of its group (null: unreadable, which
 *  counts none). On Windows a suite's own teardown is still landing as it exits (its kill of a server is a taskkill, a
 *  process of its own; a child goes with its parent a moment after it), and a read that takes microseconds sees that. So a
 *  process counts only if it is still running `ms` later. POSIX passes ms 0: the first reading stands, as it always has. */
export async function stillRunning(read: () => number[] | null | Promise<number[] | null>, { ms = 1000, step = 50 }: { ms?: number; step?: number } = {}): Promise<number[]> {
  let m = (await read()) ?? [];
  for (const end = performance.now() + ms; m.length && performance.now() < end; m = (await read()) ?? []) await new Promise((r) => setTimeout(r, step));
  return m;
}

// ---- Windows: a job object. A process id and a parent id are not proof of ancestry there: ids are reused and a parent id is
// never updated, so a walk from a suite's id can claim processes that ran long before it (CI run 46055310133: 127 of them,
// the runner's own ancestors among them). A job is the kernel's own record of what a process started, whoever has exited since.
type Job32 = { CreateJobObjectW(a: null, n: null): bigint; OpenProcess(access: number, inherit: number, pid: number): bigint; AssignProcessToJobObject(j: bigint, h: bigint): number;
  QueryInformationJobObject(j: bigint, c: number, b: unknown, n: number, r: null): number; SetInformationJobObject(j: bigint, c: number, b: unknown, n: number): number; TerminateJobObject(j: bigint, code: number): number; CloseHandle(h: bigint): number };
let job32: { sym: Job32; ptr: (b: Uint8Array) => unknown } | null | undefined;
function jobCalls() {
  if (job32 !== undefined) return job32;
  try {
    const { dlopen, FFIType: T, ptr } = require("bun:ffi");
    job32 = { ptr, sym: dlopen("kernel32.dll", {
      CreateJobObjectW: { args: [T.ptr, T.ptr], returns: T.u64 },
      OpenProcess: { args: [T.u32, T.i32, T.u32], returns: T.u64 },
      AssignProcessToJobObject: { args: [T.u64, T.u64], returns: T.i32 },
      QueryInformationJobObject: { args: [T.u64, T.i32, T.ptr, T.u32, T.ptr], returns: T.i32 },
      SetInformationJobObject: { args: [T.u64, T.i32, T.ptr, T.u32], returns: T.i32 },
      TerminateJobObject: { args: [T.u64, T.u32], returns: T.i32 },
      CloseHandle: { args: [T.u64], returns: T.i32 },
    }).symbols as Job32 };
  } catch { job32 = null; }
  return job32;
}
export type WinJob = { members(): number[] | null; kill(): void; close(): void };
/** A new job object holding the running process `pid` and everything it starts from now on, or null when one can't be made
 *  (not Windows, no bun:ffi, the process already gone). Make it right after the spawn: what the process started before the
 *  assign is not in it. `killOnClose`: the job is killed when its last handle closes, so a caller that dies takes the job
 *  with it (64-bit Windows: JOBOBJECT_EXTENDED_LIMIT_INFORMATION is 144 bytes, LimitFlags at 16); a job that can't take the
 *  limit is no job. Windows 8 and later nest jobs, so a process bun already keeps in a job of its own can join this one. */
export function winJob(pid: number, { killOnClose = false }: { killOnClose?: boolean } = {}): WinJob | null {
  if (process.platform !== "win32") return null;
  const k = jobCalls(); if (!k) return null;
  const job = k.sym.CreateJobObjectW(null, null); if (!job) return null;
  if (killOnClose) { const b = new Uint8Array(144); new DataView(b.buffer).setUint32(16, 0x2000 /* JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE */, true);
    if (!k.sym.SetInformationJobObject(job, 9 /* JobObjectExtendedLimitInformation */, k.ptr(b), b.length)) { k.sym.CloseHandle(job); return null; } }
  const h = k.sym.OpenProcess(0x0101 /* TERMINATE | SET_QUOTA */, 0, pid);
  if (!h || !k.sym.AssignProcessToJobObject(job, h)) { if (h) k.sym.CloseHandle(h); k.sym.CloseHandle(job); return null; }
  return {
    members(): number[] | null {   // JOBOBJECT_BASIC_PROCESS_ID_LIST: two DWORD counts, then ULONG_PTR ids
      const b = new Uint8Array(8 + 8 * 1024), v = new DataView(b.buffer);
      if (!k.sym.QueryInformationJobObject(job, 3, k.ptr(b), b.length, null)) return null;
      return Array.from({ length: v.getUint32(4, true) }, (_, i) => Number(v.getBigUint64(8 + 8 * i, true)));
    },
    kill() { k.sym.TerminateJobObject(job, 9); },
    close() { k.sym.CloseHandle(h); k.sym.CloseHandle(job); },
  };
}
/** Which Windows processes to kill for a suite started as `root`, deepest first, each by its own id (never `/T`). Windows
 *  reuses process ids: once the suite has `exited`, an id back in the table belongs to someone else, so nothing is killed; if
 *  the id is free, only its orphans are. */
export function winKillPlan(root: number, table: Row[], exited: boolean, self: number = process.pid): number[] {
  if (exited && table.some((r) => r.pid === root)) return [];
  // never ourselves or an ancestor: once the dead root's id is reused, a stale ParentProcessId can make the gate itself look like its orphan
  const byPid = new Map(table.map((r) => [r.pid, r])), mine = new Set<number>();
  for (let p: number | undefined = self; p !== undefined && !mine.has(p); p = byPid.get(p)?.ppid) mine.add(p);
  const kids = new Map<number, number[]>(); for (const r of table) { if (r.pid !== r.ppid) kids.set(r.ppid, [...(kids.get(r.ppid) ?? []), r.pid]); }
  const depth = new Map<number, number>(), todo: [number, number][] = [[root, 0]];
  while (todo.length) { const [p, d] = todo.shift()!; for (const c of kids.get(p) ?? []) if (!depth.has(c) && c !== root && !mine.has(c)) { depth.set(c, d + 1); todo.push([c, d + 1]); } }
  const out = [...depth.entries()].sort((x, y) => y[1] - x[1]).map(([p]) => p);
  return exited || !table.some((r) => r.pid === root) ? out : [...out, root];
}
/** killSuite, without blocking: POSIX signals the group (a signal never blocks); Windows kills what winKillPlan finds,
 *  children first, each by its own id; only when the table doesn't answer, the still-running root's tree with taskkill /T. */
export async function killSuiteAsync(root: number, sig: NodeJS.Signals, platform: NodeJS.Platform = process.platform, { exited = false, query, ms, taskkill = (a: string[]) => outputOf("taskkill", a, 15_000) }: { exited?: boolean | (() => boolean); query?: () => Promise<string | null>; ms?: number; taskkill?: (args: string[]) => Promise<unknown> } = {}): Promise<void> {
  if (platform !== "win32") { try { process.kill(-root, sig); } catch { /* gone */ } return; }
  const table = await tableOrNull("win32", { query, ms }), gone = () => (typeof exited === "function" ? exited() : exited);
  // no table: the root's own tree, while the root still runs (its id is still its own; an exited root's may be someone's now)
  if (table === null) { if (!gone()) await taskkill(["/PID", String(root), "/T", "/F"]); return; }
  for (const pid of winKillPlan(root, table, gone())) await taskkill(["/PID", String(pid), "/F"]);
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
  if (process.platform === "win32" && typeof p.pid === "number") void killSuiteAsync(p.pid, "SIGKILL", "win32", { exited: () => p.exitCode != null || p.signalCode != null });
  try { p.kill(); } catch { /* gone */ }
}
