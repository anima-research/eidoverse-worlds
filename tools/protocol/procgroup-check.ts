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
import { fileURLToPath } from "node:url";
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
  const pg = fs.readFileSync(new URL("../../server/procgroup.ts", import.meta.url), "utf8"), rs = fs.readFileSync(new URL("./run.ts", import.meta.url), "utf8");
  const kc = pg.slice(pg.indexOf("export function killChild")), kcBody = kc.slice(0, kc.indexOf("\n}") + 2);
  check("PG12 the sweep after a suite exits says so (exited), and killChild never blocks or kills an exited child",
    /killGroup\(child\.pid, "SIGKILL", \{ exited: \(\) => !stuck \|\| gone\(\) \}\)/.test(rs) && !/killSuite\(/.test(kcBody) && /exitCode/.test(kcBody), kcBody);
}

{ // a table that never answers falls back to the running root's tree (taskkill /T), and to nothing once it exited
  const calls: string[][] = [], never = () => new Promise<string | null>(() => {}), rec = async (a: string[]) => { calls.push(a); };
  await (PG as any).killSuiteAsync(100, "SIGKILL", "win32", { exited: false, ms: 300, query: never, taskkill: rec }); const live = calls.splice(0);
  await (PG as any).killSuiteAsync(100, "SIGKILL", "win32", { exited: true, ms: 300, query: never, taskkill: rec }); const dead = calls.splice(0);
  check("PG17 the Windows table timing out kills the still-running root's tree (taskkill /PID root /T /F); an exited root's id is left alone",
    JSON.stringify(live) === JSON.stringify([["/PID", "100", "/T", "/F"]]) && dead.length === 0, { live, dead });
}
{ // --siblings rebuilds a dist/ made at another commit, and preflight reads the build's own commit, not dist/'s presence
  const siblingBuiltAt = (await import("./common.ts") as any).siblingBuiltAt ?? (() => "no helper"); const at = fs.mkdtempSync(path.join(os.tmpdir(), "pg14-")), pin = "e17f773a9247c41d5c872d760aac7f243748d134";
  fs.mkdirSync(path.join(at, "dist")); const bare = siblingBuiltAt(at);
  fs.writeFileSync(path.join(at, "dist", ".built-at"), "0000000000000000000000000000000000000000\n"); const other = siblingBuiltAt(at);
  fs.writeFileSync(path.join(at, "dist", ".built-at"), pin + "\n"); const same = siblingBuiltAt(at); fs.rmSync(at, { recursive: true, force: true });
  const rs = fs.readFileSync(new URL("./run.ts", import.meta.url), "utf8");
  check("PG18 a sibling's dist/ counts as built only at the pin (dist/.built-at): none or another commit's is rebuilt by --siblings, and preflight refuses a consumer's node_modules copy built elsewhere",
    bare === null && other !== pin && same === pin && /if \(build && siblingBuiltAt\(at\) !== commit\)/.test(rs) && /\.built-at"\), commit/.test(rs) && /const builtCopy = \(c: [^)]*\) => siblingBuiltAt\(path\.join\(ENGINE, c\.pkg, "node_modules", c\.name\)\)/.test(rs) && /else if \(c\.build && builtCopy\(c\) !== c\.commit\)/.test(rs), { bare, other, same });
}
{ let answered = false, readAfter: boolean | null = null;
  await (PG as any).killSuiteAsync(100, "SIGKILL", "win32", { exited: () => { readAfter = answered; return true; }, query: async () => { answered = true; return "4 0\r\n50 4\r\n100 50\r\n777 100\r\n"; } });
  const src = (f: string) => fs.readFileSync(new URL(f, import.meta.url), "utf8");
  const pg = src("../../server/procgroup.ts"), rs = src("./run.ts"), rc = src("../run-client.ts");
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

{ // a suite's early FAIL / SKIP survives the output cut; the gate reads them from the kept lines
  const { outputKeeper, failLines } = (await import("./suites.ts")) as any; const k = typeof outputKeeper === "function" ? outputKeeper(4000, 2000) : null;
  k?.add("ok   A1 fine\nFAIL B2 early red\n       {\"saw\":1}\nSKIP C3 not here\n"); for (let i = 0; i < 400; i++) k?.add("ok   filler row ".padEnd(40, "x") + "\n");
  const lines: string[] = k?.lines() ?? [];
  check("PG19 the gate's output keeper drops the middle, never a FAIL or SKIP line: an early red is still in the lines the gate greps and in its evidence",
    !!k && k.out.length <= 4000 && !k.out.includes("B2 early red") && lines.some((l) => /^FAIL B2/.test(l)) && lines.some((l) => /^SKIP C3/.test(l)) && failLines(lines).some((l) => /^FAIL B2/.test(l)) && !lines.some((l) => /^xx/.test(l)),
    { tail: k?.out.length, dropped: k?.dropped }); }
{ // an isolation row a host can't run is OPTIONAL on the receipt (run.ts `optional`), never a silent n/a
  const r = spawnSync(process.execPath, [path.join(path.dirname(fileURLToPath(import.meta.url)), "scripts-check.ts"), "--only", "I1", "--no-server"], { encoding: "utf8", env: { ...process.env, EIDO_SANDBOX: "inprocess", BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" }, timeout: 120_000 });
  const out = (r.stdout ?? "") + (r.stderr ?? ""), optional = out.split("\n").filter((l) => /^\s*OPTIONAL\b/.test(l));
  check("PG20 scripts-check without isolation (EIDO_SANDBOX=inprocess) prints its I rows as OPTIONAL lines the gate's receipt keeps, not n/a",
    r.status === 0 && optional.some((l) => /OPTIONAL I1\b/.test(l)) && !/^n\/a/m.test(out), { status: r.status, optional, tail: out.slice(-300) }); }

// PG21/PG22 (tel0s #260 11-06): the preflight's word holds for what the suites then do
{ // a python3 whose `cryptography` imports but lacks ed25519 was "accepted", and conformance then died on ModuleNotFoundError
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "pg21-")); fs.mkdirSync(path.join(d, "cryptography")); fs.writeFileSync(path.join(d, "cryptography", "__init__.py"), '__version__ = "0.0-pg21"\n');
  const e: Record<string, string | undefined> = { ...process.env, PYTHONPATH: d }; delete e.PYTHON;
  const r = spawnSync(process.execPath, [fileURLToPath(new URL("./run.ts", import.meta.url)), "conformance"], { cwd: fileURLToPath(new URL("../../", import.meta.url)), env: e as any, encoding: "utf8", timeout: 120000 });
  const out = (r.stdout ?? "") + (r.stderr ?? ""); fs.rmSync(d, { recursive: true, force: true });
  check("PG21 a python3 whose cryptography lacks what the suites import (ed25519, serialization) is refused by the preflight, before any suite runs",
    r.status === 1 && /FAILED before any suite ran/.test(out) && /can't import what the suites need from 'cryptography'/.test(out), out.slice(-600)); }
{ // the siblings are the gate's: every file: spec that takes one points into tools/protocol/.siblings/ (gitignored), the lockfiles
  // agree, run.ts never resolves beside the checkout, and the deploy installs through the same --siblings
  const src = (f: string) => fs.readFileSync(new URL(f, import.meta.url), "utf8"), root = fileURLToPath(new URL("../../", import.meta.url));
  const dirs = ["agent-framework", "mcpl-core-ts", "voice-kit"], bad: string[] = [];
  for (const pkg of ["mcpl", "tools/captionbot"]) { const j = JSON.parse(src(`../../${pkg}/package.json`));
    for (const [name, spec] of Object.entries({ ...j.dependencies, ...j.optionalDependencies } as Record<string, string>)) if (spec.startsWith("file:") && dirs.includes(path.basename(spec))
      && path.resolve(root, pkg, spec.slice(5)) !== path.join(root, "tools", "protocol", ".siblings", path.basename(spec))) bad.push(`${pkg}: ${name} ${spec}`);
    if (/file:(?:\.\.\/)+(?:agent-framework|mcpl-core-ts|voice-kit)\b/.test(src(`../../${pkg}/bun.lock`))) bad.push(`${pkg}/bun.lock still names a sibling beside the checkout`); }
  const rs = src("./run.ts"), dv = src("../../deploy/deploy-vps.sh");
  check("PG22 mcpl/ and tools/captionbot/ take the siblings from tools/protocol/.siblings/ (gitignored), never beside the checkout, and deploy-vps.sh installs mcpl/ through run.ts --siblings",
    !bad.length && !/path\.resolve\(ENGINE, "\.\."/.test(rs) && /^tools\/protocol\/\.siblings\/$/m.test(src("../../.gitignore"))
    && /^"\$BUN" tools\/protocol\/run\.ts --siblings$/m.test(dv) && !/cd mcpl && "\$BUN" install/.test(dv), bad); }

console.log(`[procgroup-check] ${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
