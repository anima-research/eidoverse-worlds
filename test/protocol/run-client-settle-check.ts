// test/protocol/run-client-settle-check.ts — run-client settles a file on its own exit (plus a grace for output), never
// WAITING on its pipes closing (a normal close settles it at once): a test whose grandchild keeps stdout open is reported promptly, as a pass when it passed and as a
// timeout when it hung (never wedged until the gate's kill).
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { ENGINE, scratch } from "../gate/common.ts";
import { suite } from "../gate/suite.ts";
import { SUITES } from "../gate/suites.ts";

const { ok, done } = suite("run-client-settle");
const root = scratch("rcsettle"), dir = path.join(root, "tests"); fs.mkdirSync(dir);
const pids = path.join(root, "grandchildren.txt"); fs.writeFileSync(pids, "");
// a grandchild in its own process group (beyond the runner's group kill) that inherits the test's stdout and stderr
const fixture = (tail: string) => `import { spawn } from "node:child_process"; import fs from "node:fs";
const g = spawn(process.execPath, ["-e", "setTimeout(() => {}, 90000)"], { detached: true, stdio: ["ignore", "inherit", "inherit"] }); g.unref();
fs.appendFileSync(${JSON.stringify(pids)}, g.pid + "\\n");
console.log("fixture ran");
${tail}
`;
fs.writeFileSync(path.join(dir, "a-holds-pipes-passes-test.ts"), fixture("process.exit(0);"));
fs.writeFileSync(path.join(dir, "b-holds-pipes-hangs-test.ts"), fixture("setInterval(() => {}, 1 << 30);"));
fs.writeFileSync(path.join(dir, "c-browser-test.ts"), `// ${"pup" + "peteer"}: the mark suites.ts reads as "launches a browser" (bot #412: the report counts it after its lane drained the queue)\nconsole.log("fixture ran"); process.exit(0);\n`);

const t0 = performance.now();
const rc = spawn(process.execPath, [path.join(ENGINE, "test/harness/run-client.ts"), "--dir", dir, "--jobs", "1", "--timeout", "3"],
  { cwd: ENGINE, env: { ...process.env, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" }, stdio: ["ignore", "pipe", "pipe"] });
let out = ""; rc.stdout.on("data", (d) => { out += d; }); rc.stderr.on("data", (d) => { out += d; });
const finished = await new Promise<boolean>((res) => { const t = setTimeout(() => res(false), 45_000); rc.on("exit", () => { clearTimeout(t); res(true); }); });
const s = (performance.now() - t0) / 1000;
if (!finished) rc.kill("SIGKILL");
rc.stdout.destroy(); rc.stderr.destroy();
const alive = fs.readFileSync(pids, "utf8").split("\n").filter(Boolean).filter((p) => { try { process.kill(Number(p), 0); return true; } catch { return false; } });
for (const p of alive) try { process.kill(Number(p), "SIGKILL"); } catch { /* gone */ }
// win32: the timeout's tree kill (taskkill /T) also reaches the hung fixture's detached grandchild; the passing fixture's survivor still holds the pipes
const want = process.platform === "win32" ? 1 : 2;
ok(alive.length >= want, `${want === 2 ? "both grandchildren were" : "the passing fixture's grandchild was"} still alive when run-client settled (the pipes really were held)`, alive);

ok(finished, `run-client finished while both grandchildren still held the pipes (${s.toFixed(1)} s; they live 90 s)`, out.slice(-400));
ok(/^ok\s+\S*a-holds-pipes-passes-test\.ts/m.test(out), "the file that exited 0 is a pass", out.slice(-400));
ok(/^SLOW\s+\S*b-holds-pipes-hangs-test\.ts/m.test(out), "the file that hung is a timeout", out.slice(-400));
ok(/^ok\s+\S*c-browser-test\.ts \[browser, alone\]/m.test(out) && /; 1 launch a browser/.test(out), "the browser-marked file is reported [browser, alone] and counted once the lanes have drained the queue (bot #412)", out.slice(-600));
// --import-only: a file whose top-level await never resolves is a timeout, not loaded; a missing package is a red under
// --strict-env (the gate's client-tools row) and fails the run; a timeout alone doesn't (rc3 below)
const dir2 = path.join(root, "imports"); fs.mkdirSync(dir2);
fs.writeFileSync(path.join(dir2, "c-hangs-at-import-test.ts"), `await new Promise(() => {});\n`);
fs.writeFileSync(path.join(dir2, "d-missing-package-test.ts"), `import "no-such-package-zz-${Date.now()}";\n`);
const rc2 = Bun.spawnSync([process.execPath, path.join(ENGINE, "test/harness/run-client.ts"), "--dir", dir2, "--jobs", "1", "--timeout", "3", "--import-only", "--strict-env"],
  { cwd: ENGINE, env: { ...process.env, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" }, timeout: 45_000 });
const out2 = rc2.stdout.toString() + rc2.stderr.toString();
ok(/^SLOW\s+\S*c-hangs-at-import-test\.ts/m.test(out2), "--import-only: a hung top-level await is a timeout, not loaded", out2.slice(-400));
ok(/^RED\s+\S*d-missing-package-test\.ts/m.test(out2), "--strict-env: a missing package is a red, not an env note", out2.slice(-400));
ok(rc2.exitCode === 1, "…and the import-only run exits 1 on the missing package", { code: rc2.exitCode });
// the mcpl pre-check is the same missing dependency: under --strict-env a red too (#474); RUN_CLIENT_NO_MCPL stands in for its absence
const dir4 = path.join(root, "mcpl"); fs.mkdirSync(dir4);
fs.writeFileSync(path.join(dir4, "f-mcpl-test.ts"), `import "../../mcpl/agent.ts";\n`);
const rc4 = Bun.spawnSync([process.execPath, path.join(ENGINE, "test/harness/run-client.ts"), "--dir", dir4, "--jobs", "1", "--timeout", "3", "--import-only", "--strict-env"],
  { cwd: ENGINE, env: { ...process.env, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0", RUN_CLIENT_NO_MCPL: "1" }, timeout: 45_000 });
const out4 = rc4.stdout.toString() + rc4.stderr.toString();
ok(rc4.exitCode === 1 && /^RED\s+\S*f-mcpl-test\.ts/m.test(out4), "--strict-env: missing mcpl/node_modules is a red too, and fails the run", { code: rc4.exitCode, out: out4.slice(-400) });
// --import-only: a file that loaded but whose stubs never applied (test/harness/stub.ts verifyStubs prints FAIL and exits 1)
// is dead at import, not loaded (bot #333 r2 157)
const dir5 = path.join(root, "deadstub"); fs.mkdirSync(dir5);
fs.writeFileSync(path.join(dir5, "f-dead-stub-test.ts"), `console.log("FAIL stub never applied: /x\\.js$/ (registered at here); its module moved or the import is gone"); process.exitCode = 1;\n`);
const rc5 = Bun.spawnSync([process.execPath, path.join(ENGINE, "test/harness/run-client.ts"), "--dir", dir5, "--jobs", "1", "--timeout", "10", "--import-only", "--strict-env"],
  { cwd: ENGINE, env: { ...process.env, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" }, timeout: 45_000 });
const out5 = rc5.stdout.toString() + rc5.stderr.toString();
ok(/^DEAD\s+\S*f-dead-stub-test\.ts/m.test(out5) && rc5.exitCode === 1, "--import-only: a stub that never applied is dead at import and fails the run, not loaded", { code: rc5.exitCode, out: out5.slice(-300) });
const dir3 = path.join(root, "slowonly"); fs.mkdirSync(dir3);
fs.writeFileSync(path.join(dir3, "e-slow-test.ts"), `await new Promise(() => {});\n`);
const rc3 = Bun.spawnSync([process.execPath, path.join(ENGINE, "test/harness/run-client.ts"), "--dir", dir3, "--jobs", "1", "--timeout", "3", "--import-only", "--strict-env"],
  { cwd: ENGINE, env: { ...process.env, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" }, timeout: 45_000 });
ok(rc3.exitCode === 0 && /^SLOW\s+\S*e-slow-test\.ts/m.test(rc3.stdout.toString()), "--import-only: a file still running is reported SLOW but doesn't fail the run (it can't tell a long test from a hang)", { code: rc3.exitCode });
// --import-only: an uncaught TypeError before the first check (an incomplete stub's missing function) is dead, not loaded;
// a file that ran its checks and exited 1 is a red for the full run, still loaded here (#333 backlog G4-223)
const dir6 = path.join(root, "toperr"); fs.mkdirSync(dir6);
fs.writeFileSync(path.join(dir6, "g-top-typeerror-test.ts"), `const stubbed: any = {};\nstubbed.notExported();\n`);
// …and throws a TypeError after its first check line: the crash comes too late to be an import failure
fs.writeFileSync(path.join(dir6, "h-red-checks-test.ts"), `console.log("  ✗ a row that failed");\nconst late: any = {};\nlate.notExported();\n`);
const rc6 = Bun.spawnSync([process.execPath, path.join(ENGINE, "test/harness/run-client.ts"), "--dir", dir6, "--jobs", "1", "--timeout", "10", "--import-only", "--strict-env"],
  { cwd: ENGINE, env: { ...process.env, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" }, timeout: 45_000 });
const out6 = rc6.stdout.toString() + rc6.stderr.toString();
ok(/^DEAD\s+\S*g-top-typeerror-test\.ts\s+—\s+TypeError/m.test(out6) && rc6.exitCode === 1, "--import-only: a top-level uncaught TypeError is dead at import and fails the run", { code: rc6.exitCode, out: out6.slice(-400) });
ok(/^ok\s+\S*h-red-checks-test\.ts/m.test(out6), "--import-only: …while a file that ran a check and then threw a TypeError still loaded", out6.slice(-400));
// the full run: a bun:test file (test() blocks) runs under `bun test`, as the gate's harness/bun-test.ts runs it; `bun <file>`
// refuses test() outside the runner, so a passing file read red (#333 backlog G4-112)
const dir7 = path.join(root, "buntest"); fs.mkdirSync(dir7);
fs.writeFileSync(path.join(dir7, "i-buntest-passes-test.ts"), `import { test, expect } from "bun:test";\ntest("one", () => { expect(1).toBe(1); });\n`);
fs.writeFileSync(path.join(dir7, "j-buntest-fails-test.ts"), `import { test, expect } from "bun:test";\ntest("one", () => { expect(1).toBe(2); });\n`);
const rc7 = Bun.spawnSync([process.execPath, path.join(ENGINE, "test/harness/run-client.ts"), "--dir", dir7, "--jobs", "1", "--timeout", "20"],
  { cwd: ENGINE, env: { ...process.env, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" }, timeout: 60_000 });
const out7 = rc7.stdout.toString() + rc7.stderr.toString();
ok(/^ok\s+\S*i-buntest-passes-test\.ts/m.test(out7), "full run: a passing bun:test file is a pass", out7.slice(-500));
ok(/^RED\s+\S*j-buntest-fails-test\.ts/m.test(out7) && rc7.exitCode === 1, "full run: …and a failing one is red", { code: rc7.exitCode, out: out7.slice(-300) });
// --skip-suites: a row's runner file argument (bun-test.ts test/server/screenshots-test.ts) is the gate's too, so
// client-tools skips it rather than running its tests a second time (cold review of hep/pkg-test-infra F1)
const argRows = SUITES.flatMap(([n, f]) => f.split(" ").slice(1).filter((a) => /\.(?:ts|mjs|js)$/.test(a)).map((a) => [n, a] as const));
ok(argRows.length > 0, "some gate row passes its runner a test file (else this check has no subject)", argRows);
for (const [n, a] of argRows) {
  const rc8 = Bun.spawnSync([process.execPath, path.join(ENGINE, "test/harness/run-client.ts"), "--import-only", "--skip-suites", "--strict-env", path.basename(a).replace(/\.\w+$/, "")],
    { cwd: ENGINE, env: { ...process.env, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" }, timeout: 45_000 });
  const out8 = rc8.stdout.toString() + rc8.stderr.toString();
  ok(new RegExp(`^skip\\s+\\S*${path.basename(a).replace(/[.]/g, "\\.")}\\s+—\\s+the gate runs it in full as ${n}$`, "m").test(out8) && /^\s*loaded: 0$/m.test(out8), `--skip-suites: ${a}, the ${n} row's runner argument, is skipped as gated, not loaded again`, out8.slice(-400));
}
done();
