// The gate finds and kills a suite's processes on Linux, macOS and Windows (review #260, rereview blocker 2; procgroup.ts).
// PG1 runs for real on whatever OS this is. PG2 proves the macOS path (ps) on any POSIX host by checking it agrees with
// what the OS reports. PG3/PG4 prove the Windows path's parsing and tree walk on fixed tables, including an orphan whose
// parent already exited (Windows keeps the dead parent's id on the child).
//   bun tools/protocol/procgroup-check.ts
import { spawn, spawnSync } from "node:child_process";
import { processTable, parsePsTable, parseWinTable, suiteMembers, killSuite } from "./procgroup.ts";
import * as PG from "./procgroup.ts";
import { tryUntil } from "./wait.ts";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
let pass = 0, fail = 0;
const check = (name: string, ok: unknown, info?: unknown) => { if (ok) { pass++; console.log(`ok   ${name}`); } else { fail++; console.log(`FAIL ${name}`); if (info !== undefined) console.log("     ", JSON.stringify(info)); } };
const win = process.platform === "win32";

// PG1: a detached child that starts a grandchild; both are found, then both are gone after killSuite
{
  const script = "const {spawn}=require('node:child_process'); spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'}); setInterval(()=>{},1000);";
  const child = spawn(process.execPath, ["-e", script], { detached: true, stdio: "ignore" });
  await tryUntil("the suite's process and the one it starts are both running", () => suiteMembers(child.pid!).length >= 2, { ms: 7500 });
  const before = suiteMembers(child.pid!);
  killSuite(child.pid!, "SIGKILL");
  let after = suiteMembers(child.pid!); await tryUntil("none of the suite's processes is left", () => !(after = suiteMembers(child.pid!)).length, { ms: 3000, step: 150 });
  check(`PG1 (${process.platform}) a suite's process and the one it started are both found (${before.length}), and none is left after the kill`, before.length >= 2 && after.length === 0, { before, after });
}

// PG2: on POSIX, the ps reading (the macOS path) agrees with the OS's own table for a live group
if (!win && spawnSync("ps", ["-A", "-o", "pid="]).status === 0) {
  const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { detached: true, stdio: "ignore" });
  await tryUntil("the child is in the OS's table", () => suiteMembers(child.pid!, processTable(process.platform), process.platform).length >= 1, { ms: 4000 });
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

// PG6: the Windows table, asked asynchronously, gives up within its bound when the query never answers, and the event loop runs
// meanwhile (CI 10-21: a synchronous WMI query in the kill path froze the gate for two hours, past every timeout it had)
{
  let ticks = 0; const tick = setInterval(() => ticks++, 50);
  const t0 = Date.now(); const hung = await (PG as any).processTableAsync?.("win32", { ms: 600, query: () => new Promise(() => {}) });
  const took = Date.now() - t0; clearInterval(tick);
  check("PG6 the async Windows table gives up within its bound on a query that never answers (an empty table, not a hang), and the gate's loop keeps ticking meanwhile",
    Array.isArray(hung) && hung.length === 0 && took < 1500 && ticks >= 5, { hung, took, ticks });
}

// PG7: the async kill ends a suite and the process it started, on this OS, without blocking
{
  const script = "const {spawn}=require('node:child_process'); spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'}); setInterval(()=>{},1000);";
  const child = spawn(process.execPath, ["-e", script], { detached: true, stdio: "ignore" });
  await tryUntil("the suite's process and the one it starts are both running", async () => ((await (PG as any).suiteMembersAsync?.(child.pid!)) ?? []).length >= 2, { ms: 7500 });
  const before = await (PG as any).suiteMembersAsync?.(child.pid!) ?? [];
  await (PG as any).killSuiteAsync?.(child.pid!, "SIGKILL");
  let after = await (PG as any).suiteMembersAsync?.(child.pid!) ?? ["none"]; if (after.length) await tryUntil("none of the suite's processes is left", async () => !(after = await (PG as any).suiteMembersAsync(child.pid!)).length, { ms: 3000, step: 150 });
  if (after.length) killSuite(child.pid!, "SIGKILL");
  check(`PG7 (${process.platform}) the async kill ends a suite's process and the one it started`, before.length >= 2 && after.length === 0, { before, after });
}

// PG8: the gate's kill path is asynchronous end to end: run.ts never calls the synchronous killSuite or suiteMembers
{
  const run = fs.readFileSync(new URL("./run.ts", import.meta.url), "utf8");
  const sync = run.split("\n").map((l, i) => [i + 1, l] as const).filter(([, l]) => /\b(killSuite|suiteMembers)\(/.test(l) && !/^\s*\/\//.test(l)).map(([n, l]) => `${n}: ${l.trim().slice(0, 90)}`);
  check("PG8 run.ts's kill path never blocks: no synchronous killSuite/suiteMembers call, and a suite that won't die is left behind after a bound (a watchdog), not waited on forever",
    sync.length === 0 && /killSuiteAsync/.test(run) && /suiteMembersAsync/.test(run) && /wouldn't die/.test(run), { sync });
}

// PG9–PG12 (CI 10-22: the Windows runner "lost communication" mid-gate): the gate sweeps every suite's tree AFTER the suite
// exited, and Windows reuses process ids, so a tree kill aimed at the dead root's id can land on whoever holds it now.
{
  const plan = (PG as any).winKillPlan as undefined | ((root: number, t: { pid: number; ppid: number; pgid: number; zombie: boolean }[], exited: boolean) => number[]);
  const T = parseWinTable("4 0\r\n50 4\r\n100 50\r\n200 100\r\n300 200\r\n");          // 100 (the root) is alive, with 200 → 300 under it
  const reused = parseWinTable("4 0\r\n50 4\r\n100 50\r\n777 100\r\n");                  // the root exited; 100 now belongs to someone else, with 777 under it
  const gone = parseWinTable("4 0\r\n50 4\r\n200 100\r\n300 200\r\n");                   // the root exited and its id is free; 200 → 300 are its orphans
  check("PG9 a live suite's tree is killed children first, the root last", !!plan && JSON.stringify(plan(100, T, false)) === JSON.stringify([300, 200, 100]), plan && plan(100, T, false));
  check("PG10 after the suite exited, an id that's in the table again is someone else's: nothing is killed", !!plan && plan(100, reused, true).length === 0, plan && plan(100, reused, true));
  check("PG11 after the suite exited, its orphans are killed and the dead root's id never is", !!plan && JSON.stringify(plan(100, gone, true)) === JSON.stringify([300, 200]), plan && plan(100, gone, true));
  // PG14 (CI 10-23, run 40054616217: the gate died mid-lane, exit 1, no tally): the gate (900) was started by a shell (60)
  // whose own parent id is 100 — a long-dead process's number, now the dead suite root's too. 60 → 900 → 950 look like
  // 100's orphans; the gate and its shell must never be in the plan, and neither must anything below them
  const stale = parseWinTable("4 0\r\n60 100\r\n900 60\r\n950 900\r\n200 100\r\n");
  const plan14 = plan && (plan as any)(100, stale, true, 900);
  check("PG14 an exited root's sweep never kills the gate, its shell, or anything under them (a reused id as a stale parent)",
    !!plan14 && JSON.stringify(plan14) === JSON.stringify([200]), plan14);
  const pg = fs.readFileSync(new URL("./procgroup.ts", import.meta.url), "utf8"), rs = fs.readFileSync(new URL("./run.ts", import.meta.url), "utf8");
  const kc = pg.slice(pg.indexOf("export function killChild")), kcBody = kc.slice(0, kc.indexOf("\n}") + 2);
  check("PG12 the sweep after a suite exits says so (exited), and killChild never blocks or kills an exited child",
    /killGroup\(child\.pid, "SIGKILL", \{ exited: \(\) => !stuck \|\| gone\(\) \}\)/.test(rs) && !/killSuite\(/.test(kcBody) && /exitCode/.test(kcBody), kcBody);
}

{ let answered = false, readAfter: boolean | null = null;
  await (PG as any).killSuiteAsync(100, "SIGKILL", "win32", { exited: () => { readAfter = answered; return true; }, query: async () => { answered = true; return "4 0\r\n50 4\r\n100 50\r\n777 100\r\n"; } });
  const src = (f: string) => fs.readFileSync(new URL(f, import.meta.url), "utf8");
  const pg = src("./procgroup.ts"), rs = src("./run.ts"), rc = src("../run-client.ts");
  const kc = pg.slice(pg.indexOf("export function killChild")), kcBody = kc.slice(0, kc.indexOf("\n}") + 2);
  const live = {
    killChild: /exited: \(\) => p\.exitCode != null \|\| p\.signalCode != null/.test(kcBody),
    gate: /const gone = \(\) => child\.exitCode != null \|\| child\.signalCode != null/.test(rs) && (rs.match(/killGroup\(child\.pid!?, "SIG(?:TERM|KILL)", \{ exited: (?:gone|\(\) => !stuck \|\| gone\(\)) \}\)/g) ?? []).length === 3,
    client: /const gone = \(\) => ch\.exitCode != null \|\| ch\.signalCode != null/.test(rc) && /"SIGTERM", process\.platform, \{ exited: gone \}/.test(rc) && /\(exited: boolean \| \(\(\) => boolean\) = gone\)/.test(rc),
  };
  check("PG16 a Windows sweep reads whether its suite has exited once the process table has answered, and each caller hands it a reading of its own child (killChild, the gate's three sweeps, run-client's two)",
    readAfter === true && Object.values(live).every(Boolean), { readAfter, live }); }

// PG13: the gate keeps what a failed check SAW, not only its name (scripts I2 failed twice in gate logs with no values, 10-22)
{ const { failLines } = await import("./suites.ts");
  const out = ["ok   A1 fine", "FAIL I2   a whole request", '       {"said":true,"ms":1400}', "ok   I3 next", "  \u2717 HIS1 history", "    History\u2715 reading the log", "[x] 1 passed, 2 failed"];
  const kept = failLines(out);
  check("PG13 the gate keeps the evidence line under each FAIL / \u2717 (and not the next ok row or the tally)",
    kept.length === 4 && kept[1].includes('"ms":1400') && kept[3].includes("reading the log") && !kept.some((l) => /^ok|passed,/.test(l.trim())), kept); }

{ const { setAside } = (await import("./suites.ts")) as any;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pg15-")), root = path.join(tmp, "checkout"), base = path.join(tmp, "residue");
  fs.mkdirSync(path.join(root, "client"), { recursive: true });
  for (const [f, s] of [["a.txt", "one"], ["client/b.txt", "two"], ["client/c.txt", "three"]]) fs.writeFileSync(path.join(root, f), s);
  const fd = fs.openSync(path.join(root, "a.txt"), "a");
  const r = typeof setAside === "function" ? setAside(root, ["a.txt", "client/b.txt", "gone.txt"], base, "suite-") : null;
  fs.writeSync(fd, " and more"); fs.closeSync(fd);
  fs.writeFileSync(path.join(tmp, "a-file"), "");
  const r2 = typeof setAside === "function" ? setAside(root, ["client/c.txt"], path.join(tmp, "a-file", "residue"), "suite-") : null;
  const read = (d: string, f: string) => { try { return fs.readFileSync(path.join(d, f), "utf8"); } catch { return null; } };
  const a = r?.moved?.includes("a.txt") ? read(r.dir, "a.txt") : read(root, "a.txt");
  check("PG15 a suite's leftover files are moved out of the checkout by rename, each keeping its path and what's written to it later; one that can't be moved stays and is named, and one already gone is in neither list",
    !!r && a === "one and more" && read(r.dir, "client/b.txt") === "two" && read(root, "client/b.txt") === null && !r.moved.includes("gone.txt") && !r.failed.includes("gone.txt")
      && !!r2 && r2.moved.length === 0 && JSON.stringify(r2.failed) === '["client/c.txt"]' && read(root, "client/c.txt") === "three",
    { r, r2, a });
  fs.rmSync(tmp, { recursive: true, force: true }); }

console.log(`[procgroup-check] ${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
