// The gate finds and kills a suite's processes on Linux, macOS and Windows (review #260, rereview blocker 2; procgroup.ts).
// PG1 runs for real on whatever OS this is. PG2 proves the macOS path (ps) on any POSIX host by checking it agrees with
// what the OS reports. PG3/PG4 prove the Windows path's parsing and tree walk on fixed tables, including an orphan whose
// parent already exited (Windows keeps the dead parent's id on the child).
//   bun tools/protocol/procgroup-check.ts
import { spawn, spawnSync } from "node:child_process";
import { processTable, parsePsTable, parseWinTable, suiteMembers, killSuite } from "./procgroup.ts";
let pass = 0, fail = 0;
const check = (name: string, ok: unknown, info?: unknown) => { if (ok) { pass++; console.log(`ok   ${name}`); } else { fail++; console.log(`FAIL ${name}`); if (info !== undefined) console.log("     ", JSON.stringify(info)); } };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const win = process.platform === "win32";

// PG1: a detached child that starts a grandchild; both are found, then both are gone after killSuite
{
  const script = "const {spawn}=require('node:child_process'); spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'}); setInterval(()=>{},1000);";
  const child = spawn(process.execPath, ["-e", script], { detached: true, stdio: "ignore" });
  await sleep(1500);
  const before = suiteMembers(child.pid!);
  killSuite(child.pid!, "SIGKILL");
  let after = suiteMembers(child.pid!); for (let i = 0; i < 20 && after.length; i++) { await sleep(150); after = suiteMembers(child.pid!); }
  check(`PG1 (${process.platform}) a suite's process and the one it started are both found (${before.length}), and none is left after the kill`, before.length >= 2 && after.length === 0, { before, after });
}

// PG2: on POSIX, the ps reading (the macOS path) agrees with the OS's own table for a live group
if (!win && spawnSync("ps", ["-A", "-o", "pid="]).status === 0) {
  const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { detached: true, stdio: "ignore" });
  await sleep(800);
  const viaOs = suiteMembers(child.pid!, processTable(process.platform), process.platform).sort();
  const viaPs = suiteMembers(child.pid!, parsePsTable(spawnSync("ps", ["-A", "-o", "pid=,pgid=,ppid=,stat="], { encoding: "utf8" }).stdout), "darwin").sort();
  killSuite(child.pid!, "SIGKILL");
  check("PG2 the macOS reading (ps -A -o pid,pgid,ppid,stat) finds the same group members as this OS's own table", viaPs.length >= 1 && JSON.stringify(viaPs) === JSON.stringify(viaOs), { viaOs, viaPs });
} else check("PG2 (Windows host) the POSIX ps path is not this OS's; PG3/PG4 cover Windows", true);

// PG3: the Windows table parses CRLF output from Win32_Process
const W = parseWinTable("100 4\r\n200 100\r\n300 200\r\n400 999\r\n\r\n");
check("PG3 the Windows process table parses (pid, parent) rows from CRLF output", W.length === 4 && W[2].pid === 300 && W[2].ppid === 200, W);

// PG4: the Windows tree walk finds children and grandchildren, keeps orphans of a root that already exited, and nothing else
{
  const live = suiteMembers(100, W, "win32").sort((a, b) => a - b);
  const orphaned = suiteMembers(100, W.filter((r) => r.pid !== 100), "win32").sort((a, b) => a - b);
  check("PG4 on Windows a suite is the tree under its root: root, child, grandchild — and after the root exits its orphans still count; an unrelated process never does",
    JSON.stringify(live) === "[100,200,300]" && JSON.stringify(orphaned) === "[200,300]", { live, orphaned });
}

// PG5: the POSIX ps parse skips zombies (their group id stays, but they hold nothing)
check("PG5 a zombie in the group is not counted as left running", suiteMembers(7, parsePsTable(" 7 7 1 S\n 8 7 7 Z+\n 9 7 7 R\n 10 10 1 S\n"), "darwin").join() === "7,9");

console.log(`[procgroup-check] ${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
