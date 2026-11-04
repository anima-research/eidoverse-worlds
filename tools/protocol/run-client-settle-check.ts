// tools/protocol/run-client-settle-check.ts — run-client settles a file on its own exit (plus a grace for output), never
// WAITING on its pipes closing (a normal close settles it at once): a test whose grandchild keeps stdout open is reported promptly, as a pass when it passed and as a
// timeout when it hung (client-tools wedged on windows-latest until the gate's 1010 s kill, #260 run 41128035464).
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { ENGINE, scratch } from "./common.ts";

let pass = 0, fail = 0;
const ok = (c: unknown, n: string, d: unknown = "") => { if (c) { pass++; console.log(`  ok   ${n}`); } else { fail++; console.log(`  FAIL ${n}  ${JSON.stringify(d)}`); } };
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
const rc = spawn(process.execPath, [path.join(ENGINE, "tools/run-client.ts"), "--dir", dir, "--jobs", "1", "--timeout", "3"],
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
// --strict-env (the gate's client-tools row); either fails the run
const dir2 = path.join(root, "imports"); fs.mkdirSync(dir2);
fs.writeFileSync(path.join(dir2, "c-hangs-at-import-test.ts"), `await new Promise(() => {});\n`);
fs.writeFileSync(path.join(dir2, "d-missing-package-test.ts"), `import "no-such-package-zz-${Date.now()}";\n`);
const rc2 = Bun.spawnSync([process.execPath, path.join(ENGINE, "tools/run-client.ts"), "--dir", dir2, "--jobs", "1", "--timeout", "3", "--import-only", "--strict-env"],
  { cwd: ENGINE, env: { ...process.env, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" }, timeout: 45_000 });
const out2 = rc2.stdout.toString() + rc2.stderr.toString();
ok(/^SLOW\s+\S*c-hangs-at-import-test\.ts/m.test(out2), "--import-only: a hung top-level await is a timeout, not loaded", out2.slice(-400));
ok(/^RED\s+\S*d-missing-package-test\.ts/m.test(out2), "--strict-env: a missing package is a red, not an env note", out2.slice(-400));
ok(rc2.exitCode === 1, "…and the import-only run exits 1 on the missing package", { code: rc2.exitCode });
const dir3 = path.join(root, "slowonly"); fs.mkdirSync(dir3);
fs.writeFileSync(path.join(dir3, "e-slow-test.ts"), `await new Promise(() => {});\n`);
const rc3 = Bun.spawnSync([process.execPath, path.join(ENGINE, "tools/run-client.ts"), "--dir", dir3, "--jobs", "1", "--timeout", "3", "--import-only", "--strict-env"],
  { cwd: ENGINE, env: { ...process.env, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" }, timeout: 45_000 });
ok(rc3.exitCode === 0 && /^SLOW\s+\S*e-slow-test\.ts/m.test(rc3.stdout.toString()), "--import-only: a file still running is reported SLOW but doesn't fail the run (it can't tell a long test from a hang)", { code: rc3.exitCode });
console.log(`[run-client-settle] ${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
