// server/procgroup.ts — a suite's processes, found and killed the same way on Linux, macOS and Windows.
//   Linux:   /proc/<pid>/stat (no subprocess per suite)
//   macOS and other POSIX: `ps -A -o pid=,pgid=,ppid=,stat=`
//   Windows: no process groups, so a suite's processes are the tree under the pid it was started as, walked from the
//            parent links (they survive the parent's exit, so orphans still count); killed with taskkill. The links come
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
/** The rows of `table` that weren't running in `before` (a table read earlier). Windows never updates a parent id and
 *  reuses process ids, so a suite whose id once belonged to a long-dead process reads as the parent of that process's
 *  children (CI run 46055310133: 127 processes under lite-graph's id, the runner's own ancestors among them). Whatever was
 *  running before the suite started is not the suite's, and with those rows gone a walk can't pass through them either.
 *  Same id and same parent is the same process; an id that has changed parent is a new process holding a reused id. */
export function startedSince(before: Row[], table: Row[]): Row[] {
  const was = new Map(before.map((r) => [r.pid, r.ppid]));
  return table.filter((r) => was.get(r.pid) !== r.ppid);
}
/** What a suite started as `root` left running, read once it has ended. On Windows a suite's own teardown is still landing
 *  as it exits (its kill of a server is a taskkill, a process of its own; a child goes with its parent's job a moment after
 *  it): the PowerShell read took ~0.5 s to look, the snapshot looks ~5 ms on. So there a process counts only if it is
 *  still running `ms` later; one seen under the suite stays the suite's after its own parent has gone (the walk from `root`
 *  can't reach it any more), and so does what it starts. The caller kills these by id. POSIX reads once, as it always has.
 *  `before` is the table read before the suite started: nothing in it is the suite's (startedSince). `table` is for tests. */
export async function leftoverMembers(root: number, platform: NodeJS.Platform = process.platform, { before = [], ms = 1000, step = 50, table = () => processTableAsync(platform) }: { before?: Row[]; ms?: number; step?: number; table?: () => Promise<Row[]> } = {}): Promise<number[]> {
  if (platform !== "win32") return suiteMembers(root, await table(), platform);
  const seen = new Set<number>();
  const read = async () => { const t = startedSince(before, await table()), live = new Set(t.map((r) => r.pid));
    for (const from of [root, ...seen]) for (const p of suiteMembers(from, t, "win32")) seen.add(p);
    return [...seen].filter((p) => live.has(p)); };
  let m = await read();
  for (const end = performance.now() + ms; m.length && performance.now() < end; m = await read()) await new Promise((r) => setTimeout(r, step));
  return m;
}
/** Which Windows processes to kill for a suite started as `root`, deepest first, each by its own id (never `/T`). Windows
 *  reuses process ids: once the suite has `exited`, an id back in the table belongs to someone else, so nothing is killed; if
 *  the id is free, only its orphans are. Never this process or one above it, even as the `root` asked for.
 *  `before` is the table read before the suite started (see startedSince), and there are three cases:
 *    rows:    nothing that was running then is planned or walked through, and this process's ancestors are found among those
 *             rows only (each of them predates the suite), so a suite whose id is a stale parent id up that chain is still killed;
 *    []:      the caller asked and the table didn't answer. Nothing can be told from what was already running: the live
 *             root alone, and no orphan is looked for;
 *    omitted: a caller that keeps no such table (killChild, server/oneshot.ts): the tree by parent links, as it always was. */
export function winKillPlan(root: number, table: Row[], exited: boolean, self: number = process.pid, before?: Row[]): number[] {
  const live = table.some((r) => r.pid === root);
  if (exited && live) return [];
  const fresh = new Set(startedSince(before ?? [], table));
  // never ourselves or an ancestor: once the dead root's id is reused, a stale ParentProcessId can make the gate itself look like its orphan
  const byPid = new Map((before?.length ? table.filter((r) => !fresh.has(r)) : table).map((r) => [r.pid, r])), mine = new Set<number>();
  for (let p: number | undefined = self; p !== undefined && !mine.has(p); p = byPid.get(p)?.ppid) mine.add(p);
  if (byPid.has(root) && mine.has(root)) return [];   // a root that is this process or above it (an id with no row can be a stale link in that chain: PG14, PG31)
  if (before && !before.length) return live && !exited ? [root] : [];
  const kids = new Map<number, number[]>(); for (const r of fresh) { if (r.pid !== r.ppid) kids.set(r.ppid, [...(kids.get(r.ppid) ?? []), r.pid]); }
  const depth = new Map<number, number>(), todo: [number, number][] = [[root, 0]];
  while (todo.length) { const [p, d] = todo.shift()!; for (const c of kids.get(p) ?? []) if (!depth.has(c) && c !== root && !mine.has(c)) { depth.set(c, d + 1); todo.push([c, d + 1]); } }
  const out = [...depth.entries()].sort((x, y) => y[1] - x[1]).map(([p]) => p);
  return exited || !live ? out : [...out, root];
}
/** killSuite, without blocking: POSIX signals the group (a signal never blocks); Windows kills what winKillPlan finds,
 *  children first, each by its own id; only when the table doesn't answer, the still-running root's tree with taskkill /T. */
export async function killSuiteAsync(root: number, sig: NodeJS.Signals, platform: NodeJS.Platform = process.platform, { exited = false, before, query, ms, taskkill = (a: string[]) => outputOf("taskkill", a, 15_000) }: { exited?: boolean | (() => boolean); before?: Row[]; query?: () => Promise<string | null>; ms?: number; taskkill?: (args: string[]) => Promise<unknown> } = {}): Promise<void> {
  if (platform !== "win32") { try { process.kill(-root, sig); } catch { /* gone */ } return; }
  const table = await tableOrNull("win32", { query, ms }), gone = () => (typeof exited === "function" ? exited() : exited);
  // no table: the root's own tree, while the root still runs (its id is still its own; an exited root's may be someone's now)
  if (table === null) { if (!gone()) await taskkill(["/PID", String(root), "/T", "/F"]); return; }
  for (const pid of winKillPlan(root, table, gone(), process.pid, before)) await taskkill(["/PID", String(pid), "/F"]);
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
