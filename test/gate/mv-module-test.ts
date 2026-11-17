// test/gate/mv-module-test.ts — tools/mv-module.ts does what its header says, in scratch git trees: READ rows for what it
// can't rewrite; and a git that fails to run or is killed is fatal, never a short file list.
//   BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun test/gate/mv-module-test.ts      (RED=MV5: the old `if (r.status)` guard; MV5 goes red)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { suite } from "./suite.ts";
import { ENGINE } from "./common.ts";
const { check, na, red, done } = suite("mv-module");
const TOOL = path.join(ENGINE, "tools/mv-module.ts");

const scratch = (n: string) => fs.mkdtempSync(path.join(process.env.PROTOCOL_SCRATCH ?? os.tmpdir(), `mv-module-${n}-`));
const git = (dir: string, ...a: string[]) => { const r = spawnSync("git", ["-C", dir, ...a], { encoding: "utf8" }); if (r.status !== 0) throw new Error(`git ${a.join(" ")}: ${r.stderr}`); };
/** A git tree holding the tool, an empty known list and `files`, all added. */
function tree(n: string, files: Record<string, string>, known: Record<string, string> = {}) {
  const dir = scratch(n);
  let src = fs.readFileSync(TOOL, "utf8");
  if (red("MV5")) src = src.replace("if (r.error || r.status !== 0)", "if (r.status)");
  files = { "tools/mv-module.ts": src, "tools/mv-module-unresolved.json": JSON.stringify(known), ...files };
  for (const [f, s] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), s); }
  git(dir, "init", "-q"); git(dir, "add", "-A");
  return dir;
}
const run = (dir: string, args: string[], env: Record<string, string> = {}) => {
  const r = spawnSync(process.execPath, [path.join(dir, "tools/mv-module.ts"), ...args], { cwd: dir, encoding: "utf8", env: { ...process.env, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0", ...env } });
  return { status: r.status, out: (r.stdout ?? "") + (r.stderr ?? "") };
};
const read = (dir: string, f: string) => fs.readFileSync(path.join(dir, f), "utf8");

// MV6–MV7: one tree, moved step by step
{ const d = tree("move", {
    "client/lib/ui/x.js": "export const x = 1;\n",
    "client/lib/a.js": "export const a = 1;\n",
    "test/url-probe.mjs": "const u = '/lib/a.js';\n",
    "tools/u.ts": `const L = "client/lib/"; export const p = L + "ui/x.js";\n`,
  });
  const r3 = run(d, ["client/lib/ui/x.js", "client/lib/ux/x.js"]);
  check("MV6 a directory-qualified lib-relative string (L + \"ui/x.js\") is a READ row", r3.out.includes("READ  lib-relative x.js  tools/u.ts:1"), r3.out);
  const r4 = run(d, ["client/lib/a.js", "client/xr/a.js"]);
  check("MV7 a file moved out of /lib/ leaves its old URL as a READ row, not rewritten", r4.out.includes("READ  served URL /lib/a.js  test/url-probe.mjs:1") && read(d, "test/url-probe.mjs").includes("'/lib/a.js'"), r4.out); }

// MV5: a git killed part way (status null) is fatal; the old `if (r.status)` read its partial stdout as the whole tree
if (process.platform === "win32") na("MV5 a git killed after a partial file list is fatal", "the fake git is a POSIX shell script");
else {
  const d = tree("killed", { "a.ts": "export {};\n", "b.ts": `import "./gone.js";\n` });
  const bin = path.join(d, "fakebin"); fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "git"), "#!/bin/sh\nprintf 'a.ts\\000'\nkill -9 $$\n", { mode: 0o755 });
  const r = run(d, ["--check"], { PATH: `${bin}${path.delimiter}${process.env.PATH}` });
  check("MV5 a git killed after a partial file list is fatal", r.status !== 0 && /git ls-files -z: killed by SIGKILL/.test(r.out), r.out);
}
// MV8: no git at all
{ const d = tree("nogit", { "a.ts": "export {};\n" });
  const r = run(d, ["--check"], { PATH: path.join(d, "nowhere"), Path: path.join(d, "nowhere") });
  check("MV8 a git that can't be spawned is fatal, with the git command in the error", r.status !== 0 && r.out.includes("git ls-files -z: "), r.out); }

done();
