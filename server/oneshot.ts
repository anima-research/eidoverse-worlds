// server/oneshot.ts — a one-shot child (tools/protocol/world.ts) run to its answer and ended the same way wherever it runs:
// server/upgrade.ts, server/worldindex.ts ownersOf, and inplace-check (Mica 11-05; notes WINDOWS-STALL-2026-11-05: Bun 1.3.14 on
// Windows can sit in ExitProcess after a complete answer). This bounds the consequence; it doesn't make the stall rarer.
//   The child frames its answer (frameAtExit, only when EIDO_ONESHOT_FRAME=<nonce>, which only runOneShot sets): at exit, the last
//   line of stdout AND of stderr is "[oneshot <nonce>] answered (exit N); open handles: <none | Kind×n, …>".
//   exited, framed on both streams, the frame's exit its own, no handle, nothing of its group left → accepted ("exited")
//   framed, no handle, still alive graceMs on → its group killed, its end awaited, the group checked empty → accepted, and the
//     receipt logged: "semantic result complete / forced process cleanup"
//   anything else (no frame, a partial or malformed one, a handle named, a descendant at its end, a group that won't empty, no
//     frame by guardMs) → not accepted, `why` says which; the caller's operation fails. Being alive is never an answer.
// Its group: POSIX, its own process group (spawned detached); Windows, a job object (descendants join it even when their parent
// has exited; a process that starts one in its first instant, before it is assigned, would escape: world.ts starts none).
import fs from "node:fs";
import crypto from "node:crypto";
import { heapStats } from "bun:jsc";
import { processTableAsync, suiteMembers, suiteMembersAsync, killSuiteAsync } from "./procgroup.ts";

// ---- the child's side --------------------------------------------------------------------------------------------------
// The event-loop handles this process holds, as Bun's heap sees them (its protected objects). Bun stubs
// process.getActiveResourcesInfo (always []); this doesn't. Not seen: fs.watch and Worker (Bun 1.3.14 doesn't protect them).
const HANDLE = /Timeout|Immediate|Listener|Socket|Server|Watcher|Subprocess|Worker/;
export function openHandles(): string {
  const open = Object.entries(heapStats().protectedObjectTypeCounts).filter(([k, n]) => HANDLE.test(k) && n > 0);
  return open.length ? open.map(([k, n]) => `${k}×${n}`).join(", ") : "none";
}
const NONCE = /^[0-9a-f]{16}$/;
/** In the child, at load: when its parent is runOneShot, frame its answer at exit. Operators running it by hand see nothing. */
export function frameAtExit(): void {
  const nonce = process.env.EIDO_ONESHOT_FRAME ?? "";
  if (NONCE.test(nonce)) process.on("exit", (code) => { const f = `\n[oneshot ${nonce}] answered (exit ${code}); open handles: ${openHandles()}\n`; fs.writeSync(1, f); fs.writeSync(2, f); });
}

// ---- the parent's side -------------------------------------------------------------------------------------------------
export type OneShotEnd = "exited" | "forced process cleanup" | "timed out";
export type OneShot = {
  accepted: boolean; why: string | null;   // may the answer be read; if not, why
  code: number | null;                     // its exit code (the frame's, on a forced cleanup)
  out: string; err: string;                // its output, frames removed
  end: OneShotEnd; framed: boolean; handles: string | null;
  left: number[];                          // processes of its group still running at its end (or at the kill)
  gone: boolean;                           // nothing of its group running when we returned
  receipt: string | null;                  // the forced-cleanup line logged, if any
  ms: number; group: "pgid" | "job" | "tree";
};
export type OneShotOpts = { cwd: string; env: Record<string, string | undefined>; guardMs: number; graceMs?: number; label: string };
export const FORCED = "semantic result complete / forced process cleanup";

const frameIn = (s: string, nonce: string) => new RegExp(`\\n?\\[oneshot ${nonce}\\] answered \\(exit (-?\\d+)\\); open handles: ([^\\n]*)\\n$`).exec(s);
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const within = <T>(p: Promise<T>, ms: number, v: T) => { let t: any; return Promise.race([p, new Promise<T>((r) => { t = setTimeout(() => r(v), ms); })]).finally(() => clearTimeout(t)); };

export async function runOneShot(argv: string[], { cwd, env, guardMs, graceMs = 5_000, label }: OneShotOpts): Promise<OneShot> {
  const t0 = performance.now(), nonce = crypto.randomBytes(8).toString("hex"), win = process.platform === "win32";
  const p = Bun.spawn(argv, { cwd, env: { ...env, EIDO_ONESHOT_FRAME: nonce }, stdin: "ignore", stdout: "pipe", stderr: "pipe", ...(win ? {} : { detached: true }) } as any);
  const g = groupOf(p.pid);
  let so = "", se = "", seen = () => {};
  const framedNow = () => { const a = frameIn(so.slice(-512), nonce), b = frameIn(se.slice(-512), nonce); return !!a && !!b && a[1] === b[1] && a[2] === b[2]; };
  const framed = new Promise<void>((r) => { seen = r; });
  const pump = async (s: ReadableStream, put: (t: string) => void) => { const d = new TextDecoder(); for await (const c of s as any) { put(d.decode(c, { stream: true })); if (framedNow()) seen(); } };
  const read = Promise.all([pump(p.stdout as any, (t) => { so += t; }), pump(p.stderr as any, (t) => { se += t; })]).catch(() => {});
  const exited = p.exited.then(() => "exit" as const);
  const first = await within(Promise.race([exited, framed.then(() => within(exited, graceMs, "grace" as const))]), guardMs, "guard" as const);

  let end: OneShotEnd = "exited", left: number[] = [], why: string | null = null;
  if (first === "exit") {
    await within(read, 3_000, undefined);   // a descendant still holding its pipes: the group check below names it
    const m = await g.members(); left = (m ?? []).filter((x) => x !== p.pid);
    if (m === null) why = "its group couldn't be read at its end";
    else if (left.length) { why = `a process of its group was still running at its end (${left.join(", ")})`; await g.kill(); }
  } else {
    end = first === "grace" ? "forced process cleanup" : "timed out";
    const m = first === "grace" ? await g.members() : [];   // its descendants at the kill
    left = (m ?? []).filter((x) => x !== p.pid); if (m === null) why = "its group couldn't be read before the kill";
    await g.kill(); try { p.kill(9); } catch { /* gone */ }
    await within(p.exited, 10_000, null); await within(read, 3_000, undefined);
    if (first === "guard") why = `no complete framed answer in ${Math.round(guardMs / 1000)} s`;
    else if (!why && left.length) why = `a process of its group was still running when it was killed (${left.join(", ")})`;
  }
  // the group, emptied: polled for a while (a killed process takes a moment to leave the table)
  let rest = await g.members();
  for (let i = 0; i < 20 && (rest === null || rest.length) && (end !== "exited" || why); i++) { await sleep(250); rest = await g.members(); }
  const gone = p.exitCode !== null || p.signalCode !== null ? rest !== null && rest.length === 0 : false;
  g.close();

  const a = frameIn(so, nonce), b = frameIn(se, nonce), isFramed = framedNow();
  const handles = isFramed ? b![2] : null, fcode = isFramed ? Number(b![1]) : null;
  if (!why) {
    if (!a && !b) why = "no frame: its answer isn't known to be complete";
    else if (!isFramed) why = `a partial or malformed frame (stdout ${a ? "framed" : "unframed"}, stderr ${b ? "framed" : "unframed"})`;
    else if (isFramed && handles !== "none") why = `it answered with a handle of its own open: ${handles}`;
    else if (isFramed && end === "exited" && fcode !== p.exitCode) why = `its frame says exit ${fcode}, it exited ${p.exitCode ?? p.signalCode}`;
    else if (!gone) why = `its group didn't empty${rest === null ? " (unreadable)" : `: ${rest.join(", ")} still running`}`;
  }
  const out = so.replace(frameIn(so, nonce)?.[0] ?? "\u0000", ""), err = se.replace(frameIn(se, nonce)?.[0] ?? "\u0000", "");
  const r: OneShot = { accepted: !why, why, code: end === "exited" ? p.exitCode : end === "forced process cleanup" && isFramed ? fcode : null, out, err, end,
    framed: isFramed, handles, left, gone, receipt: null, ms: Math.round(performance.now() - t0), group: g.kind };
  if (r.accepted && end === "forced process cleanup") {
    r.receipt = `[oneshot] ${label}: ${FORCED} ${JSON.stringify({ pid: p.pid, exit: r.code, graceMs, ms: r.ms, group: r.group, left: 0 })}`;
    console.log(r.receipt);
  } else if (!r.accepted) console.log(`[oneshot] ${label}: not accepted (${end}): ${why}`);
  return r;
}

// ---- its group ---------------------------------------------------------------------------------------------------------
type Group = { kind: "pgid" | "job" | "tree"; members(): Promise<number[] | null>; kill(): Promise<void>; close(): void };
function groupOf(pid: number): Group {
  if (process.platform !== "win32") return {
    kind: "pgid",
    members: async () => { try { process.kill(-pid, 0); } catch { return []; } return suiteMembers(pid, await processTableAsync()); },
    kill: async () => { try { process.kill(-pid, "SIGKILL"); } catch { /* gone */ } },
    close: () => {},
  };
  const job = winJob(pid);
  if (job) return { kind: "job", members: async () => job.members(), kill: async () => job.kill(), close: () => job.close() };
  // no job object (FFI unavailable): its process tree by parent links, as the gate walks a suite's
  return { kind: "tree", members: () => suiteMembersAsync(pid), kill: () => killSuiteAsync(pid, "SIGKILL"), close: () => {} };
}

let k32: any = undefined;
function kernel32() {
  if (k32 !== undefined) return k32;
  try {
    const { dlopen, FFIType: T } = require("bun:ffi");
    k32 = dlopen("kernel32.dll", {
      CreateJobObjectW: { args: [T.ptr, T.ptr], returns: T.u64 },
      OpenProcess: { args: [T.u32, T.i32, T.u32], returns: T.u64 },
      AssignProcessToJobObject: { args: [T.u64, T.u64], returns: T.i32 },
      QueryInformationJobObject: { args: [T.u64, T.i32, T.ptr, T.u32, T.ptr], returns: T.i32 },
      TerminateJobObject: { args: [T.u64, T.u32], returns: T.i32 },
      CloseHandle: { args: [T.u64], returns: T.i32 },
    }).symbols;
  } catch { k32 = null; }
  return k32;
}
function winJob(pid: number) {
  const k = kernel32(); if (!k) return null;
  const { ptr } = require("bun:ffi");
  const job: bigint = k.CreateJobObjectW(null, null); if (!job) return null;
  const h: bigint = k.OpenProcess(0x0101 /* TERMINATE | SET_QUOTA */, 0, pid);
  if (!h || !k.AssignProcessToJobObject(job, h)) { if (h) k.CloseHandle(h); k.CloseHandle(job); return null; }
  return {
    members(): number[] | null {   // JOBOBJECT_BASIC_PROCESS_ID_LIST: two DWORD counts, then ULONG_PTR ids
      const b = new Uint8Array(8 + 8 * 1024), v = new DataView(b.buffer);
      if (!k.QueryInformationJobObject(job, 3, ptr(b), b.length, null)) return null;
      return Array.from({ length: v.getUint32(4, true) }, (_, i) => Number(v.getBigUint64(8 + 8 * i, true)));
    },
    kill() { k.TerminateJobObject(job, 9); },
    close() { k.CloseHandle(h); k.CloseHandle(job); },
  };
}
