// The gate finds and kills a suite's processes on Linux, macOS and Windows (review #260, rereview blocker 2;
// server/procgroup.ts, under the gate's name test/gate/procgroup.ts).
// PG1 runs for real on whatever OS this is. PG2 checks the macOS path (ps) agrees with what the OS reports, on any POSIX
// host (on macOS the OS's table IS ps, so there it's no independent proof). PG3/PG4 prove the Windows path's parsing and tree walk on fixed tables, including an orphan whose
// parent already exited (Windows keeps the dead parent's id on the child). PG5–PG12, PG14, PG16 and PG17: zombies, the async
// table and kill, and the Windows sweep after a root exited. PG13, PG15 and PG18–PG22 are the gate's own habits: a FAIL's
// evidence kept, leftover files set aside, sibling builds, the output cut, OPTIONAL rows, the preflight. PG23: deploy retries.
// PG24–PG26: the Windows table comes from the kernel's snapshot in process (PowerShell's was ~0.5 s a read, twice per suite).
// PG27–PG33: on Windows the gate keeps each suite in a job object (winJob): what the suite left is what the kernel says is
// in the job, and the kill is the job's. A process id and a parent id are not proof of ancestry there (ids are reused, a
// parent id is never updated): CI run 46055310133 read 127 processes as one suite's leftovers.
//   bun test/protocol/procgroup-check.ts
import { spawn, spawnSync } from "node:child_process";
import { processTable, parsePsTable, parseWinTable, suiteMembers, killSuite } from "../gate/procgroup.ts";
import * as PG from "../gate/procgroup.ts";
import { tryUntil } from "../gate/wait.ts";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
// PG33's stand-in suite, under the real run.ts: it leaves a process no walk by parent ids reaches, then exits or hangs. Never a pass (exit 3)
if (process.env.PG33_STANDIN) {
  const mid = "const {spawn}=require('node:child_process'); const g=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',detached:true,windowsHide:true}); require('node:fs').writeFileSync(process.env.PG33_OUT,String(g.pid)); setTimeout(()=>process.exit(0),300);";
  const m = spawn(process.execPath, ["-e", mid], { stdio: "ignore", detached: true, windowsHide: true });
  await new Promise((r) => m.on("exit", r));
  if (process.env.PG33_STANDIN === "hang") { setInterval(() => {}, 1000); await new Promise(() => {}); }
  process.exit(3);
}
const { check, na, done } = suite("procgroup-check", { cap: Infinity });
import { suite } from "../gate/suite.ts";
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
} else na("PG2 the macOS reading (ps -A -o pid,pgid,ppid,stat)", "the POSIX ps path is not this OS's; PG3/PG4 cover Windows");

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
// meanwhile (a synchronous WMI query in the kill path freezes the gate past every timeout it has)
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
  if (after.length && (process.platform !== "win32" || after.includes(child.pid!))) killSuite(child.pid!, "SIGKILL");   // on Windows only from a root that still lives: a walk from a dead id can reach a stranger (the row is red either way)
  check(`PG7 (${process.platform}) the async kill ends a suite's process and the one it started`, before.length >= 2 && after.length === 0, { before, after });
}

// PG8: the gate's kill path is asynchronous end to end: run.ts never calls the synchronous killSuite or suiteMembers
{
  const run = fs.readFileSync(new URL("../gate/run.ts", import.meta.url), "utf8");
  const sync = run.split("\n").map((l, i) => [i + 1, l] as const).filter(([, l]) => /\b(killSuite|suiteMembers)\(/.test(l) && !/^\s*\/\//.test(l)).map(([n, l]) => `${n}: ${l.trim().slice(0, 90)}`);
  check("PG8 run.ts's kill path never blocks: no synchronous killSuite/suiteMembers call, and a suite that won't die is left behind after a bound (a watchdog), not waited on forever",
    sync.length === 0 && /killSuiteAsync/.test(run) && /stillRunning\(/.test(run) && /wouldn't die/.test(run), { sync });
}

// PG9–PG12, PG14: the gate sweeps every suite's tree AFTER the suite
// exited, and Windows reuses process ids, so a tree kill aimed at the dead root's id can land on whoever holds it now.
{
  const plan = (PG as any).winKillPlan as undefined | ((root: number, t: { pid: number; ppid: number; pgid: number; zombie: boolean }[], exited: boolean) => number[]);
  const T = parseWinTable("4 0\r\n50 4\r\n100 50\r\n200 100\r\n300 200\r\n");          // 100 (the root) is alive, with 200 → 300 under it
  const reused = parseWinTable("4 0\r\n50 4\r\n100 50\r\n777 100\r\n");                  // the root exited; 100 now belongs to someone else, with 777 under it
  const gone = parseWinTable("4 0\r\n50 4\r\n200 100\r\n300 200\r\n");                   // the root exited and its id is free; 200 → 300 are its orphans
  check("PG9 a live suite's tree is killed children first, the root last", !!plan && JSON.stringify(plan(100, T, false)) === JSON.stringify([300, 200, 100]), plan && plan(100, T, false));
  check("PG10 after the suite exited, an id that's in the table again is someone else's: nothing is killed", !!plan && plan(100, reused, true).length === 0, plan && plan(100, reused, true));
  check("PG11 after the suite exited, its orphans are killed and the dead root's id never is", !!plan && JSON.stringify(plan(100, gone, true)) === JSON.stringify([300, 200]), plan && plan(100, gone, true));
  // PG14: the gate (900) was started by a shell (60)
  // whose own parent id is 100 — a long-dead process's number, now the dead suite root's too. 60 → 900 → 950 look like
  // 100's orphans; the gate and its shell must never be in the plan, and neither must anything below them
  const stale = parseWinTable("4 0\r\n60 100\r\n900 60\r\n950 900\r\n200 100\r\n");
  const plan14 = plan && (plan as any)(100, stale, true, 900);
  check("PG14 an exited root's sweep never kills the gate, its shell, or anything under them (a reused id as a stale parent)",
    !!plan14 && JSON.stringify(plan14) === JSON.stringify([200]), plan14);
  const pg = fs.readFileSync(new URL("../../server/procgroup.ts", import.meta.url), "utf8"), rs = fs.readFileSync(new URL("../gate/run.ts", import.meta.url), "utf8");
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
  const siblingBuiltAt = (await import("../gate/common.ts") as any).siblingBuiltAt ?? (() => "no helper"); const at = fs.mkdtempSync(path.join(os.tmpdir(), "pg14-")), pin = "e17f773a9247c41d5c872d760aac7f243748d134";
  fs.mkdirSync(path.join(at, "dist")); const bare = siblingBuiltAt(at);
  fs.writeFileSync(path.join(at, "dist", ".built-at"), "0000000000000000000000000000000000000000\n"); const other = siblingBuiltAt(at);
  fs.writeFileSync(path.join(at, "dist", ".built-at"), pin + "\n"); const same = siblingBuiltAt(at); fs.rmSync(at, { recursive: true, force: true });
  const rs = fs.readFileSync(new URL("../gate/run.ts", import.meta.url), "utf8");
  check("PG18 a sibling's dist/ counts as built only at the pin (dist/.built-at): none or another commit's is rebuilt by --siblings, and preflight refuses a consumer's node_modules copy built elsewhere",
    bare === null && other !== pin && same === pin && /if \(build && siblingBuiltAt\(at\) !== commit\)/.test(rs) && /\.built-at"\), commit/.test(rs) && /const builtCopy = \(c: [^)]*\) => siblingBuiltAt\(path\.join\(ENGINE, c\.pkg, "node_modules", c\.name\)\)/.test(rs) && /else if \(c\.build && builtCopy\(c\) !== c\.commit\)/.test(rs), { bare, other, same });
}
{ let answered = false, readAfter: boolean | null = null;
  await (PG as any).killSuiteAsync(100, "SIGKILL", "win32", { exited: () => { readAfter = answered; return true; }, query: async () => { answered = true; return "4 0\r\n50 4\r\n100 50\r\n777 100\r\n"; } });
  const src = (f: string) => fs.readFileSync(new URL(f, import.meta.url), "utf8");
  const pg = src("../../server/procgroup.ts"), rs = src("../gate/run.ts"), rc = src("../harness/run-client.ts");
  const kc = pg.slice(pg.indexOf("export function killChild")), kcBody = kc.slice(0, kc.indexOf("\n}") + 2);
  const live = {
    killChild: /exited: \(\) => p\.exitCode != null \|\| p\.signalCode != null/.test(kcBody),
    gate: /const gone = \(\) => child\.exitCode != null \|\| child\.signalCode != null/.test(rs) && (rs.match(/killGroup\(child\.pid!?, "SIG(?:TERM|KILL)", \{ exited: (?:gone|\(\) => !stuck \|\| gone\(\)) \}\)/g) ?? []).length === 3,
    client: /const gone = \(\) => ch\.exitCode != null \|\| ch\.signalCode != null/.test(rc) && /"SIGTERM", process\.platform, \{ exited: gone \}/.test(rc) && /\(exited: boolean \| \(\(\) => boolean\) = gone\)/.test(rc),
  };
  check("PG16 a Windows sweep reads whether its suite has exited once the process table has answered, and each caller hands it a reading of its own child (killChild, the gate's three sweeps, run-client's two)",
    readAfter === true && Object.values(live).every(Boolean), { readAfter, live }); }

// PG13: the gate keeps what a failed check SAW, not only its name;
// a verdict the output cut dropped keeps only its own line (outputKeeper, PG19)
{ const { failLines } = await import("../gate/suites.ts");
  const out = ["ok   A1 fine", "FAIL I2   a whole request", '       {"said":true,"ms":1400}', "ok   I3 next", "  \u2717 HIS1 history", "    History\u2715 reading the log", "[x] 1 passed, 2 failed"];
  const kept = failLines(out);
  check("PG13 the gate keeps the evidence line under each FAIL / \u2717 (and not the next ok row or the tally)",
    kept.length === 4 && kept[1].includes('"ms":1400') && kept[3].includes("reading the log") && !kept.some((l) => /^ok|passed,/.test(l.trim())), kept); }

{ const { setAside } = (await import("../gate/suites.ts")) as any;
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
  const { outputKeeper, failLines } = (await import("../gate/suites.ts")) as any; const k = typeof outputKeeper === "function" ? outputKeeper(4000, 2000) : null;
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
  const r = spawnSync(process.execPath, [fileURLToPath(new URL("../gate/run.ts", import.meta.url)), "conformance"], { cwd: fileURLToPath(new URL("../../", import.meta.url)), env: e as any, encoding: "utf8", timeout: 120000 });
  const out = (r.stdout ?? "") + (r.stderr ?? ""); fs.rmSync(d, { recursive: true, force: true });
  check("PG21 a python3 whose cryptography lacks what the suites import (ed25519, serialization) is refused by the preflight, before any suite runs",
    r.status === 1 && /FAILED before any suite ran/.test(out) && /can't import what the suites need from 'cryptography'/.test(out), out.slice(-600)); }
{ // the siblings are the gate's: every file: spec that takes one points into .siblings/ (gitignored), the lockfiles
  // agree, run.ts never resolves beside the checkout, and the deploy installs through the same --siblings
  const src = (f: string) => fs.readFileSync(new URL(f, import.meta.url), "utf8"), root = fileURLToPath(new URL("../../", import.meta.url));
  const dirs = ["agent-framework", "mcpl-core-ts", "voice-kit"], bad: string[] = [];
  for (const pkg of ["mcpl", "services/captionbot"]) { const j = JSON.parse(src(`../../${pkg}/package.json`));
    for (const [name, spec] of Object.entries({ ...j.dependencies, ...j.optionalDependencies } as Record<string, string>)) if (spec.startsWith("file:") && dirs.includes(path.basename(spec))
      && path.resolve(root, pkg, spec.slice(5)) !== path.join(root, ".siblings", path.basename(spec))) bad.push(`${pkg}: ${name} ${spec}`);
    if (/file:(?:\.\.\/)+(?:agent-framework|mcpl-core-ts|voice-kit)\b/.test(src(`../../${pkg}/bun.lock`))) bad.push(`${pkg}/bun.lock still names a sibling beside the checkout`); }
  const rs = src("../gate/run.ts"), dv = src("../../deploy/deploy-vps.sh");
  check("PG22 mcpl/ and services/captionbot/ take the siblings from .siblings/ (gitignored), never beside the checkout, and deploy-vps.sh installs mcpl/ through run.ts --siblings",
    !bad.length && !/path\.resolve\(ENGINE, "\.\."/.test(rs) && /^\/\.siblings\/$/m.test(src("../../.gitignore"))
    && /^"\$BUN" test\/gate\/run\.ts --siblings$/m.test(dv) && !/cd mcpl && "\$BUN" install/.test(dv), bad); }

{ // PG23: deploy installs are keyed to the last deploy that finished, so a retry after a failed install redoes it
  const dv = fs.readFileSync(new URL("../../deploy/deploy-vps.sh", import.meta.url), "utf8");
  const fn = dv.match(/^changed\(\) \{.*\}$/m)?.[0];
  if (win || !fn) { if (win) na("PG23 deploy installs keyed to the last finished deploy", "bash and a POSIX git fixture"); else check("PG23 deploy-vps.sh defines changed()", false); }
  else {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pg23-"));
    const sh = (c: string) => spawnSync("bash", ["-c", c], { cwd: dir, encoding: "utf8" });
    sh("git init -q && echo a>package.json && git add . && git -c user.email=t@t -c user.name=t commit -qm a && echo b>package.json && git -c user.email=t@t -c user.name=t commit -qam b");
    const B = sh("git rev-parse --short HEAD").stdout.trim(), A = sh("git rev-parse --short HEAD~1").stdout.trim();
    const run = (done_at: string, p = "package.json") => sh(`${fn}\nafter=${B}; done_at='${done_at}'; changed ${p} && echo changed || echo same`).stdout.trim();
    const got = { none: run(""), same: run(B), older: run(A), unknown: run("deadbee"), untouched: run(A, "other.txt") };
    fs.rmSync(dir, { recursive: true, force: true });
    const installs = (dv.match(/^if changed /gm) ?? []).length, stamp = /^git rev-parse --short HEAD > \.deploy-done$/m.test(dv.split("\n").slice(-4).join("\n"));
    check("PG23 deploy installs are keyed to the last finished deploy (.deploy-done, written last): none or an unknown stamp installs, a matching one skips",
      got.none === "changed" && got.same === "same" && got.older === "changed" && got.unknown === "changed" && got.untouched === "same" && installs === 3 && stamp,
      { got, installs, stamp });
  }
}

{ // PG24: a PROCESSENTRY32W is read at the documented offsets (pid 8, parent 32), whatever the fields around them hold
  const dv = new DataView(new ArrayBuffer(568)); dv.setUint32(0, 568, true);
  for (const [at, v] of [[4, 11], [8, 4242], [16, 13], [24, 17], [28, 19], [32, 777], [36, 23], [40, 29]] as const) dv.setUint32(at, v, true);
  const r = (PG as any).decodeEntry?.(dv);
  check("PG24 a Windows snapshot entry (PROCESSENTRY32W, 568 bytes) is read as its own pid (offset 8) and parent (offset 32), not a neighbouring field",
    (PG as any).PE32W?.size === 568 && r?.pid === 4242 && r?.ppid === 777, r); }
{ // PG26: a snapshot walk that stops on an error other than ERROR_NO_MORE_FILES is no table (the caller then asks PowerShell), never a short one
  const walk = (PG as any).walkSnapshot, fake = (n: number, err: number) => { let i = 0; return walk(() => (i++ < n ? 1 : 0), () => (i++ < n ? 1 : 0), () => err, () => ({ pid: i, ppid: 0, pgid: 0, zombie: false })); };
  const whole = walk && fake(3, 18), cut = walk && fake(2, 5), none = walk && fake(0, 18);
  check("PG26 a Windows process walk counts only when it ends on ERROR_NO_MORE_FILES: stopped by another error after 2 entries, or listing none, it is no table (the caller asks PowerShell), never a short one",
    whole?.rows?.length === 3 && cut?.rows === null && /error 5/.test(cut?.why) && none?.rows === null, { whole: whole?.rows?.length, cut, none }); }
if (win) { // PG25: the in-process snapshot is what answers on Windows, and it sees a suite's tree as Win32_Process does
  // the child names the process it started once it has: the tree is whole from then on (its console host may still be arriving)
  const script = "const {spawn}=require('node:child_process'); const g=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'}); console.log('grandchild '+g.pid); setInterval(()=>{},1000);";
  const child = spawn(process.execPath, ["-e", script], { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
  let said = ""; child.stdout!.on("data", (b) => { said += b.toString(); });
  await tryUntil("the suite's process has started its own", () => /grandchild \d+/.test(said), { ms: 10_000 });
  const grand = Number(said.match(/grandchild (\d+)/)?.[1] ?? NaN);   // NaN when it never said: the row then fails below, after the kill
  // the snapshot itself, never [] standing in for a table that didn't answer: a read that fails is no evidence of anything
  const table = () => { const t = PG.toolhelpTable(); if (!t?.some((r) => r.pid === process.pid)) throw new Error("the snapshot gave no table with this process in it"); return t; };
  const tree = (t: PG.Row[]) => suiteMembers(child.pid!, t, "win32").sort((a, b) => a - b);
  await tryUntil("the snapshot sees the process the suite started", () => tree(table()).includes(grand), { ms: 5000 });
  const t0 = performance.now(); const snap = await PG.processTableAsync("win32"); const ms = performance.now() - t0, source = PG.winTable.source;
  const viaSnap = tree(snap);
  const ps = spawnSync("powershell.exe", ["-NoProfile", "-Command", "Get-CimInstance Win32_Process | ForEach-Object { \"$($_.ProcessId) $($_.ParentProcessId)\" }"], { encoding: "utf8", timeout: 60_000 });
  const viaWmi = tree(parseWinTable(ps.stdout ?? ""));
  // read after WMI's. Nothing here kills any of the tree, so it only grows (a console host may join between any two reads):
  // snapshot ⊆ WMI ⊆ the next snapshot holds exactly when neither reader misses a process the other sees
  let later: number[] = []; try { later = tree(table()); } catch { /* later stays [], and the row fails */ }
  const me = snap.find((r) => r.pid === process.pid), within = (x: number[], y: number[]) => x.every((p) => y.includes(p));
  await PG.killSuiteAsync(child.pid!, "SIGKILL", "win32");
  let after: number[] | null = null; await tryUntil("none of the suite's processes is left", () => !(after = tree(table())).length, { ms: 5000, step: 200 });
  check("PG25 (win32) the process table is the kernel's snapshot, read in process (not PowerShell); it finds a suite's whole tree as Win32_Process does (snapshot ⊆ WMI ⊆ the next snapshot), and the kill it drives leaves none of it in a snapshot that answered",
    source === "toolhelp32" && viaSnap.includes(child.pid!) && viaSnap.includes(grand) && within(viaSnap, viaWmi) && within(viaWmi, later) && me?.ppid === process.ppid && after !== null && (after as number[]).length === 0,
    { source, ms: Math.round(ms), grand, viaSnap, viaWmi, later, after, me, ppid: process.ppid });
} else na("PG25 the Windows process table read in process", "Windows only; PG24 checks the entry's layout here");

{ // PG27: what a suite left running is asked again until it is gone or `ms` is up (a process still leaving is not a leftover)
  const S = (PG as any).stillRunning as undefined | ((read: () => number[] | null | Promise<number[] | null>, o?: { ms?: number; step?: number }) => Promise<number[]>);
  const reads = (seq: (number[] | null)[]) => { let n = 0; return { read: () => seq[Math.min(n++, seq.length - 1)], n: () => n }; };
  const going = reads([[7, 8], [8], []]), staying = reads([[9]]), clean = reads([[]]), unread = reads([null]);
  const t0 = performance.now(), a = await S?.(going.read, { ms: 2000, step: 5 }), aMs = performance.now() - t0;
  const t1 = performance.now(), b = await S?.(staying.read, { ms: 150, step: 5 }), bMs = performance.now() - t1;
  const c = await S?.(clean.read, { ms: 2000, step: 5 }), d = await S?.(unread.read, { ms: 2000, step: 5 }), once = await S?.(reads([[7, 8], []]).read, { ms: 0 });
  check("PG27 a suite's leftovers are read again until none is left or the wait is up: a process on its way out as the suite ends is not one, a process that stays is; a suite that left nothing is asked once, a group that can't be read counts none, and with no wait (POSIX) the first reading stands",
    a?.length === 0 && going.n() === 3 && aMs < 1000 && JSON.stringify(b) === "[9]" && bMs >= 150 && c?.length === 0 && clean.n() === 1 && d?.length === 0 && unread.n() === 1 && JSON.stringify(once) === "[7,8]",
    { a, asked: going.n(), aMs: Math.round(aMs), b, bMs: Math.round(bMs), cleanAsked: clean.n(), d, once }); }

// ---- PG28–PG32: the job object, on real Windows processes ----
const J = (PG as any).winJob as undefined | ((pid: number, o?: { killOnClose?: boolean }) => null | { members(): number[] | null; kill(): void; close(): void });
const snapshot = () => { const t = PG.toolhelpTable(); if (!t?.some((r) => r.pid === process.pid)) throw new Error("the snapshot gave no table with this process in it"); return t; };
const running = (pid: number) => snapshot().some((r) => r.pid === pid);
const IDLE = "setInterval(()=>{},1000)";
/** A stand-in suite: starts `kid` detached, says its id, and exits after `ms` (or stays, ms 0). */
const suiteScript = (kid: string, ms: number) => `const {spawn}=require('node:child_process'); const g=spawn(process.execPath,['-e',${JSON.stringify(kid)}],{stdio:'ignore',detached:true,windowsHide:true}); console.log('kid '+g.pid); ${ms ? `setTimeout(()=>process.exit(0),${ms})` : IDLE};`;
const startSuite = (script: string) => { const c = spawn(process.execPath, ["-e", script], { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
  let said = ""; c.stdout!.on("data", (b) => { said += b.toString(); }); const closed = new Promise((r) => c.on("close", r));
  return { c, closed, kid: () => Number(said.match(/kid (\d+)/)?.[1] ?? NaN), say: () => said }; };
if (win) { // PG28: a process still leaving as its suite exits is in the job at once and not a leftover once gone; one that stays is, and the job's kill takes it
  const S = (PG as any).stillRunning as (read: () => number[] | null, o?: { ms?: number; step?: number }) => Promise<number[]>;
  const leaving = startSuite(suiteScript("setTimeout(()=>{},3000)", 300)), lj = J?.(leaving.c.pid!); await leaving.closed;
  const atOnce = lj?.members() ?? null, settled = lj ? await S?.(() => lj.members(), { ms: 20_000 }) : undefined; lj?.close();
  const staying = startSuite(suiteScript(IDLE, 300)), sj = J?.(staying.c.pid!); await staying.closed;
  const left = sj ? await S?.(() => sj.members(), { ms: 400 }) : undefined; sj?.kill();
  const gone = await tryUntil("the process that stayed is killed", () => !running(staying.kid()), { ms: 5000, step: 100 }); sj?.close();
  if (!gone && Number.isFinite(staying.kid())) spawnSync("taskkill", ["/PID", String(staying.kid()), "/F"], { stdio: "ignore" });   // the row has failed; nothing of it outlives the suite
  check("PG28 (win32) a process still leaving as its suite exits is in the suite's job at once and is not a leftover once it has gone; one that stays is, and the job's kill takes it",
    !!atOnce?.includes(leaving.kid()) && settled?.length === 0 && JSON.stringify(left) === JSON.stringify([staying.kid()]) && !!gone, { leaving: leaving.kid(), atOnce, settled, staying: staying.kid(), left, gone });
} else na("PG28 a leaving process is not a leftover, on real Windows processes", "Windows only; PG27 checks the rule here");

if (win) { // PG29: the suite exits, the process it started exits, and what THAT started stays: no walk by parent ids from the suite reaches it
  const mid = `const {spawn}=require('node:child_process'); const g=spawn(process.execPath,['-e',${JSON.stringify(IDLE)}],{stdio:'ignore',detached:true,windowsHide:true}); require('node:fs').writeFileSync(process.env.PG29_OUT,String(g.pid)); setTimeout(()=>process.exit(0),300);`;
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "pg29-")), "pid"); process.env.PG29_OUT = out;
  const s = startSuite(suiteScript(mid, 200)), job = J?.(s.c.pid!); await s.closed;
  await tryUntil("the process the suite started has started its own and left", () => fs.existsSync(out) && !running(s.kid()), { ms: 10_000, step: 100 });
  const great = Number(fs.existsSync(out) ? fs.readFileSync(out, "utf8") : NaN), byWalk = suiteMembers(s.c.pid!, snapshot(), "win32"), inJob = job?.members() ?? null, alive = running(great);
  job?.kill(); const gone = await tryUntil("the job's kill takes it", () => !running(great), { ms: 5000, step: 100 }); job?.close();
  if (!gone && Number.isFinite(great)) spawnSync("taskkill", ["/PID", String(great), "/F"], { stdio: "ignore" });
  check("PG29 (win32) a process whose parent and grandparent (the suite) have both exited is still in the suite's job, though the walk by parent ids from the suite no longer reaches it; the job's kill takes it",
    alive && !byWalk.includes(great) && JSON.stringify(inJob) === JSON.stringify([great]) && !!gone, { suite: s.c.pid, kid: s.kid(), great, byWalk, inJob, alive, gone });
} else na("PG29 a leftover out of reach of the parent-id walk is in the job", "Windows only");

if (win) { // PG30: a bystander whose parent id is a dead process's. A suite that came to hold that id would own it by the walk; it is in no suite's job
  const launcher = startSuite(suiteScript(IDLE, 200)); await launcher.closed;   // not a suite: it starts the bystander and exits, leaving its id on it
  const bystander = launcher.kid(), deadId = launcher.c.pid!;
  const s = startSuite(suiteScript(IDLE, 0)), job = J?.(s.c.pid!);
  await tryUntil("the suite has started its own process", () => Number.isFinite(s.kid()), { ms: 10_000 });
  const t = snapshot(), claimedByWalk = suiteMembers(deadId, t, "win32"), inJob = [...(job?.members() ?? [])].sort((a, b) => a - b), want = [s.c.pid!, s.kid()].sort((a, b) => a - b);
  // (the job may also hold a console host the suite's process was given: the suite's two are in it, the bystander is not)
  job?.kill(); const suiteGone = await tryUntil("the job's kill takes the suite and what it started", () => !running(s.c.pid!) && !running(s.kid()), { ms: 5000, step: 100 }); job?.close();
  const bystanderAlive = running(bystander);
  for (const p of [...(bystanderAlive ? [bystander] : []), ...(suiteGone ? [] : [s.c.pid!, s.kid()].filter(running))]) if (Number.isFinite(p)) spawnSync("taskkill", ["/PID", String(p), "/F"], { stdio: "ignore" });   // by its own id: this row started each of them
  check("PG30 (win32) a process that was running before the suite, whose parent id is a dead process's, is what a walk from that id calls its own; it is not in the suite's job and the job's kill leaves it running",
    claimedByWalk.includes(bystander) && want.every((p) => inJob.includes(p)) && !inJob.includes(bystander) && !!suiteGone && bystanderAlive, { deadId, bystander, claimedByWalk, inJob, want, suiteGone, bystanderAlive });
} else na("PG30 a bystander under a dead parent id is not the suite's", "Windows only");

if (win) { // PG31: a gate that dies takes its suite with it: the job is killed when its last handle closes
  const holder = `const PG=require(${JSON.stringify(fileURLToPath(new URL("../gate/procgroup.ts", import.meta.url)))}); const {spawn}=require('node:child_process'); const c=spawn(process.execPath,['-e',${JSON.stringify(IDLE)}],{stdio:'ignore',windowsHide:true,detached:true}); console.log('kid '+c.pid); let j=null; try { j=PG.winJob(c.pid,{killOnClose:process.argv[1]==='close'}); } catch {} console.log('job '+!!j); setTimeout(()=>process.exit(0),300);`;
  const run1 = async (mode: string) => { const c = spawn(process.execPath, ["-e", holder, mode], { stdio: ["ignore", "pipe", "ignore"], windowsHide: true }); let said = ""; c.stdout!.on("data", (b) => { said += b.toString(); });
    await new Promise((r) => c.on("close", r)); const kid = Number(said.match(/kid (\d+)/)?.[1] ?? NaN), made = /job true/.test(said);
    const gone = Number.isFinite(kid) && !!(await tryUntil("the suite goes with its gate", () => !running(kid), { ms: 3000, step: 100 }).catch(() => false));
    if (Number.isFinite(kid) && !gone) spawnSync("taskkill", ["/PID", String(kid), "/F"], { stdio: "ignore" }); return { kid, made, gone }; };
  const withLimit = await run1("close"), without = await run1("keep");
  check("PG31 (win32) a job made with killOnClose is killed when the process holding it exits (a gate that dies takes its suite with it); made without, as the server's one-shots are, its processes are left running",
    withLimit.made && withLimit.gone && without.made && !without.gone, { withLimit, without });
} else na("PG31 a dying gate's job is killed with it", "Windows only");

if (win) { // PG33: the real run.ts on a stand-in suite (top of this file) whose leftover's parent has exited: the count and both kills are the job's
  const RUN = fileURLToPath(new URL("../gate/run.ts", import.meta.url)), root = fileURLToPath(new URL("../../", import.meta.url));
  const launcher = startSuite(suiteScript(IDLE, 200)); await launcher.closed; const bystander = launcher.kid();   // running before either gate, under a dead parent id
  const gate = async (mode: "exit" | "hang") => {
    const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "pg33-")), "pid");
    const c = spawn(process.execPath, [RUN, "procgroup"], { cwd: root, env: { ...process.env, PG33_STANDIN: mode, PG33_OUT: out, PROTOCOL_TIMEOUT_SCALE: "0.04" }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let said = ""; c.stdout!.on("data", (b) => { said += b.toString(); }); c.stderr!.on("data", (b) => { said += b.toString(); });
    const code = await new Promise((r) => c.on("close", r));
    const left = Number(fs.existsSync(out) ? fs.readFileSync(out, "utf8") : NaN), line = said.split("\n").find((l) => /^== procgroup /.test(l))?.trim() ?? said.slice(-300);
    const gone = Number.isFinite(left) && !!(await tryUntil("what the stand-in left is gone once its gate has ended", () => !running(left), { ms: 5000, step: 100 }));
    if (Number.isFinite(left) && !gone) spawnSync("taskkill", ["/PID", String(left), "/F"], { stdio: "ignore" });   // the row has failed; nothing of it outlives the suite
    return { code, left, gone, line, counted: Number(line.match(/killed (\d+) leftover/)?.[1] ?? 0), noJob: /no job object could be made/.test(said) };
  };
  const ended = await gate("exit"), hung = await gate("hang"), bystanderAlive = running(bystander);
  if (Number.isFinite(bystander) && bystanderAlive) spawnSync("taskkill", ["/PID", String(bystander), "/F"], { stdio: "ignore" });   // only while it lives: a dead id may already be someone else's
  check("PG33 (win32) under the real run.ts, a suite that exits leaving a process whose parent has gone has it counted as a leftover and killed; one that hangs has it killed with it at the timeout, so none is left to count; neither run says it had no job, and a process that ran before both is still running",
    ended.gone && ended.counted >= 1 && / FAIL \(exit 3\)/.test(ended.line) && hung.gone && hung.counted === 0 && /timed out after/.test(hung.line) && !ended.noJob && !hung.noJob && bystanderAlive, { ended, hung, bystander, bystanderAlive });
} else na("PG33 the real run.ts counts and kills a leftover through the suite's job", "Windows only; PG32 checks run.ts's text here");

{ // PG32: run.ts keeps each suite in a job on Windows, and with no job does what main does. Each pin is a whole statement, so one left in a dead branch doesn't pass
  const rs = fs.readFileSync(new URL("../gate/run.ts", import.meta.url), "utf8"), pg = fs.readFileSync(new URL("../../server/procgroup.ts", import.meta.url), "utf8"), os1 = fs.readFileSync(new URL("../../server/oneshot.ts", import.meta.url), "utf8");
  const pins: [string, boolean][] = [
    ["the job is made right after the spawn (Windows, killOnClose)", /const child = spawn\([^\n]*\n\s*const job = process\.platform === "win32" && child\.pid \? winJob\(child\.pid, \{ killOnClose: true \}\) : null;/.test(rs)],
    ["a suite with no job says so", rs.split("no job object could be made").length === 2 && /\n  currentJob = job;\n  if \(!job && process\.platform === "win32" && child\.pid\) console\.log\(`\[gate\] \$\{name\}: no job object could be made/.test(rs)],
    ["the timeout's kill is the job's, and only with no job the walk's", /setTimeout\(\(\) => \{ timedOut = true; if \(job\) return job\.kill\(\); void killGroup\(child\.pid!, "SIGTERM", \{ exited: gone \}\);/.test(rs)],
    ["the gate's own exit kills the job, and only with no job starts a kill by the suite's id", /if \(current && current\.exitCode == null && current\.signalCode == null\) \{ if \(currentJob\) currentJob\.kill\(\); else killSuiteAtExit\(current\.pid\); \}/.test(rs)],
    ["the leftovers are the job's members, and only with no job the walk's", /const left = !child\.pid \? \[\] : job \? await stillRunning\(\(\) => job\.members\(\)\) : await stillRunning\(\(\) => suiteMembersAsync\(child\.pid!\), /.test(rs)],
    ["the job is killed, closed and forgotten in one step; with no job the sweep is main's", /\n  if \(job\) \{ job\.kill\(\); job\.close\(\); currentJob = current = null; \}[^\n]*\n  else if \(child\.pid\) await killGroup\(child\.pid, "SIGKILL", \{ exited: \(\) => !stuck \|\| gone\(\) \}\);/.test(rs)],
    ["nothing kills a leftover by an id of its own", !/killGroup\(p,/.test(rs) && !/startedSince|before: was/.test(rs + pg)],
    ["the server's one-shots use the same winJob", /export function winJob\(/.test(pg) && /import \{[^}]*\bwinJob\b[^}]*\} from "\.\/procgroup\.ts"/.test(os1) && !/function winJob/.test(os1)],
  ];
  check("PG32 run.ts makes the job right after the spawn (Windows, killOnClose) and says so when it can't; the timeout's kill, the gate's own exit, the leftover count and the last kill are the job's, which is forgotten as it is closed; with no job each is main's, from the suite's id, and nothing kills a leftover by an id of its own; the server's one-shots use the same winJob",
    pins.every(([, ok]) => ok), { missing: pins.filter(([, ok]) => !ok).map(([what]) => what) });
}

done();
