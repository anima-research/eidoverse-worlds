// tools/protocol/run-client-settle-check.ts — run-client settles a file on its own exit (plus a grace for output), never
// on its pipes closing: a test whose grandchild keeps stdout open is reported promptly, as a pass when it passed and as a
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

const t0 = performance.now();
const rc = spawn(process.execPath, [path.join(ENGINE, "tools/run-client.ts"), "--dir", dir, "--jobs", "1", "--timeout", "3"],
  { cwd: ENGINE, env: { ...process.env, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" }, stdio: ["ignore", "pipe", "pipe"] });
let out = ""; rc.stdout.on("data", (d) => { out += d; }); rc.stderr.on("data", (d) => { out += d; });
const finished = await new Promise<boolean>((res) => { const t = setTimeout(() => res(false), 45_000); rc.on("exit", () => { clearTimeout(t); res(true); }); });
const s = (performance.now() - t0) / 1000;
if (!finished) rc.kill("SIGKILL");
rc.stdout.destroy(); rc.stderr.destroy();
for (const p of fs.readFileSync(pids, "utf8").split("\n").filter(Boolean)) try { process.kill(Number(p), "SIGKILL"); } catch { /* gone */ }

ok(finished, `run-client finished while both grandchildren still held the pipes (${s.toFixed(1)} s; they live 90 s)`, out.slice(-400));
ok(/^ok\s+\S*a-holds-pipes-passes-test\.ts/m.test(out), "the file that exited 0 is a pass", out.slice(-400));
ok(/^SLOW\s+\S*b-holds-pipes-hangs-test\.ts/m.test(out), "the file that hung is a timeout", out.slice(-400));
console.log(`[run-client-settle] ${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
