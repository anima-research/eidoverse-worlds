// test/gate/mv-module-test.ts — tools/mv-module.ts does what its header says, in scratch git trees: --check is green on the
// engine's own tree and red on an unlisted or stale row; page- and root-relative specifiers are resolved, not rewritten;
// READ rows for what it can't rewrite; and a git that fails to run or is killed is fatal, never a short file list.
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

// MV1: the engine's own tree (every row it can't resolve is in tools/mv-module-unresolved.json with why)
{ const r = spawnSync(process.execPath, [TOOL, "--check"], { cwd: ENGINE, encoding: "utf8" });
  check("MV1 --check is green on the engine's own committed tree", r.status === 0, (r.stdout ?? "").split("\n").slice(-4).join(" | ")); }

// MV2: an unlisted row is red, a listed one green, a listed one that resolves now is stale (red)
{ const d = tree("known", { "b.ts": `import "./gone.js";\n` });
  const r1 = run(d, ["--check"]);
  check("MV2a an unresolved specifier not in the known list fails --check", r1.status === 1 && r1.out.includes("UNRESOLVED b.ts:1 ./gone.js"), r1.out);
  fs.writeFileSync(path.join(d, "tools/mv-module-unresolved.json"), JSON.stringify({ "b.ts ./gone.js": "fixture" }));
  const r2 = run(d, ["--check"]);
  check("MV2b the same row in the known list passes", r2.status === 0, r2.out);
  fs.writeFileSync(path.join(d, "gone.js"), "");
  const r3 = run(d, ["--check"]);
  check("MV2c a known row that resolves now fails as stale", r3.status === 1 && r3.out.includes("STALE b.ts ./gone.js"), r3.out); }

// MV9: a specifier that leaves the checkout is unresolved even when the file exists beside it (a sibling library is on
// one machine and not another), so it must be listed
{ const d = tree("outside", { "a/b.ts": `import "../../outside-mv9.js";\n` });
  fs.writeFileSync(path.join(path.dirname(d), "outside-mv9.js"), "");
  try {
    const r1 = run(d, ["--check"]);
    check("MV9a a specifier outside the checkout fails --check unlisted, though the file exists there", r1.status === 1 && r1.out.includes("UNRESOLVED a/b.ts:1 ../../outside-mv9.js"), r1.out);
    fs.writeFileSync(path.join(d, "tools/mv-module-unresolved.json"), JSON.stringify({ "a/b.ts ../../outside-mv9.js": "outside the checkout" }));
    const r2 = run(d, ["--check"]);
    check("MV9b listed, it passes and is not stale while the file exists", r2.status === 0, r2.out);
  } finally { fs.rmSync(path.join(path.dirname(d), "outside-mv9.js"), { force: true }); } }

// MV3–MV4, MV6–MV7: one tree, moved step by step
{ const d = tree("move", {
    "client/lib/core.js": "export const c = 1;\n",
    "client/lib/ui/x.js": "export const x = 1;\n",
    "client/lib/a.js": "export const a = 1;\n",
    "client/main.js": `import { c } from "./lib/core.js";\n`,
    "server/s.ts": "export const s = 1;\n",
    "test/p-probe.mjs": "await page.evaluate(async () => { await import(\"./lib/core.js\"); });\nBun.spawnSync([\"bun\", \"-e\", `await import(\"./server/s.ts\")`], { cwd: ENGINE });\n",
    "test/url-probe.mjs": "const u = '/lib/a.js';\n",
    "tools/u.ts": `const L = "client/lib/"; export const p = L + "ui/x.js";\n`,
  });
  const r0 = run(d, ["--check"]);
  check("MV3 a page-relative ./lib/ URL and a root-relative ./server/ specifier in a test resolve under --check", r0.status === 0, r0.out);
  const r1 = run(d, ["test/p-probe.mjs", "test/sub/p-probe.mjs"]), p1 = read(d, "test/sub/p-probe.mjs");
  check("MV4a a moved test keeps its page- and root-relative specifiers (not rewritten as file-relative)", r1.status === 0 && p1.includes(`import("./lib/core.js")`) && p1.includes(`import("./server/s.ts")`), r1.out + p1);
  const r2 = run(d, ["client/lib/core.js", "client/lib/render/core.js"]);
  check("MV4b a moved lib file: its importer and its page-relative URL follow it", r2.status === 0 && read(d, "client/main.js").includes(`"./lib/render/core.js"`) && read(d, "test/sub/p-probe.mjs").includes(`import("./lib/render/core.js")`), r2.out);
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
