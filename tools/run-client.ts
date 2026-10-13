// tools/run-client.ts — every tools/*-{test,check} and tools/protocol/*-{test,check}, one command (refactor plan 2, D5).
//
//   BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun tools/run-client.ts --import-only    each file loads: no SyntaxError, no
//                                                                                 "Export named … not found", no missing module
//   BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun tools/run-client.ts                  every file run to the end, sorted pass / red /
//                                                                                 dead at import / timed out / env / skipped
//   … --jobs 4  --timeout 90  --slow (run the SLOW table too)  --unreached (list only)  <name-fragment> … (only those)
//
// A test whose stub or import graph broke dies before its first check and says nothing a person reads (six "stub missing
// export X" commits on 10-12 alone; settings-panels-test was dead for a day). Bun fails the import loudly, so loading each
// file is the whole stub-contract test. Exit 1 on any dead-at-import file (and, in the full mode, on any red one).
// Every run lists the files no other runner reaches (tools/protocol/run.ts, package.json scripts): this one is theirs.
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, relative, basename } from "node:path";
import { spawn, spawnSync } from "node:child_process";

const ROOT = join(import.meta.dir, "..");
const args = process.argv.slice(2);
const flag = (f: string) => args.includes(f);
const opt = (f: string, d: number) => { const i = args.indexOf(f); return i >= 0 ? Number(args[i + 1]) : d; };
const importOnly = flag("--import-only");
// a load failure comes before a test does any work (a stub plugin, then its import); one later than this is the full run's
const JOBS = opt("--jobs", importOnly ? 6 : 2);
const TIMEOUT_S = opt("--timeout", importOnly ? 15 : 90);
const only = args.filter((a, i) => !a.startsWith("--") && !["--jobs", "--timeout"].includes(args[i - 1]));

// longer than any sane per-file budget on this box (the 10-12 sweep: still running at 40 s); run with --slow
const SLOW: Record<string, string> = {
  "audio-upload-test.ts": "uploads through a real server and transcodes",
  "image-upload-test.ts": "uploads through a real server and runs libvips",
  "store-variants-test.ts": "builds every image variant",
  "hierarchy-test.ts": "657 cases through the real door (~60 s)",
  "look-test.ts": "a real server and agent",
  "object-lod-test.ts": "decimates real models",
  "seat-lifecycle-test.ts": "a real server, seat by seat",
  "support-lifecycle-test.ts": "a real server, support by support",
  "lite-weight-test.mjs": "a headless browser bundle",
  "transport-check.mjs": "real sockets, reconnect timers",
};

const isTest = (n: string) => /-(test|check)\.(ts|mjs|js)$/.test(n);
const files = [
  ...readdirSync(join(ROOT, "tools")).filter(isTest).map((n) => join(ROOT, "tools", n)),
  ...readdirSync(join(ROOT, "tools/protocol")).filter(isTest).map((n) => join(ROOT, "tools/protocol", n)),
].sort();
const rel = (p: string) => relative(ROOT, p);

// what the other runners reach
const reached = new Set<string>();
const runTs = readFileSync(join(ROOT, "tools/protocol/run.ts"), "utf8");
for (const m of runTs.matchAll(/\[\s*"[^"]+",\s*"([^"]+)"/g)) reached.add(rel(join(ROOT, "tools/protocol", m[1].split(" ")[0])));
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
for (const s of Object.values(pkg.scripts ?? {}) as string[]) for (const m of s.matchAll(/tools\/[\w./-]+/g)) reached.add(m[0]);
const unreached = files.map(rel).filter((p) => !reached.has(p));

if (flag("--unreached")) {
  console.log(`${unreached.length} of ${files.length} test files are reached by no other runner (tools/protocol/run.ts, package.json):`);
  for (const p of unreached) console.log(`  ${p}`);
  process.exit(0);
}

// a load failure, as bun reports it at the start of a line before a module's first line runs (or at a dynamic import
// behind a stub plugin); a JSON.parse SyntaxError is a test's own failure, not a load
const LINK = /^(SyntaxError: (?!JSON Parse).+|error: Cannot find (?:module|package) .+|error: Could not resolve.+|error: (?:Unexpected|Expected|Unterminated|Invalid assignment target|The symbol "[^"]+" has already been declared|Multiple exports|Duplicate) .*)$/m;
const linkError = (out: string) => LINK.exec(out)?.[1].split(ROOT + "/").join("") ?? null;
const mcplDeps = existsSync(join(ROOT, "mcpl/node_modules"));
const needsMcpl = (src: string) => /from\s+["'][^"']*\.\.\/mcpl\//.test(src) || /["'][^"']*mcpl\/[\w/-]+\.ts["']/.test(src);

const live = new Set<number>();
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(sig, () => { for (const pid of live) { try { process.kill(-pid, "SIGKILL"); } catch { /* gone */ } } process.exit(130); });
type Res = { file: string; kind: "pass" | "red" | "dead" | "timeout" | "env" | "skip" | "loaded" | "flaky"; why?: string; ms: number; tail?: string };
const run = (file: string): Promise<Res> => new Promise((done) => {
  const t0 = performance.now(); const name = basename(file); const src = readFileSync(file, "utf8");
  if (!importOnly && SLOW[name] && !flag("--slow")) return done({ file, kind: "skip", why: `slow: ${SLOW[name]} (--slow runs it)`, ms: 0 });
  if (needsMcpl(src) && !mcplDeps) return done({ file, kind: "env", why: "mcpl/node_modules missing: ln -s <a checkout with deps>/mcpl/node_modules mcpl/", ms: 0 });
  const ch = spawn("bun", [file], { cwd: ROOT, detached: true, env: { ...process.env, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" }, stdio: ["ignore", "pipe", "pipe"] });
  live.add(ch.pid!); let out = ""; let timedOut = false;
  ch.stdout.on("data", (d) => { out += d; }); ch.stderr.on("data", (d) => { out += d; });
  const kill = () => { try { process.kill(-ch.pid!, "SIGKILL"); } catch { /* gone */ } };
  // SIGTERM first, so a test with an exit handler cleans up what it wrote; whatever is left a moment later is killed
  const timer = setTimeout(() => { timedOut = true; try { process.kill(-ch.pid!, "SIGTERM"); } catch { /* gone */ } setTimeout(kill, 2000); }, TIMEOUT_S * 1000);
  ch.on("close", (code) => {
    clearTimeout(timer); kill(); live.delete(ch.pid!);
    const ms = performance.now() - t0; const tail = out.trim().split("\n").slice(-3).join("\n");
    const dead = linkError(out);
    if (dead && /^error: Cannot find (?:module|package) '[^./]/.test(dead)) return done({ file, kind: "env", why: `a dependency isn't installed here: ${dead.slice(7)}`, ms, tail });
    if (dead) return done({ file, kind: "dead", why: `${dead} (at ${(ms / 1000).toFixed(1)} s)`, ms, tail });
    if (importOnly) return done({ file, kind: "loaded", ms });
    if (timedOut) return done({ file, kind: "timeout", why: `still running at ${TIMEOUT_S} s`, ms, tail });
    if (code === 0) return done({ file, kind: "pass", ms });
    if (code === 2 && /no browser|no chrome|chromium|no gpu|webgpu/i.test(out)) return done({ file, kind: "env", why: tail.split("\n").pop(), ms, tail });
    done({ file, kind: "red", why: `exit ${code}`, ms, tail });
  });
});

// a test killed at its time limit can't clean up: say what the run left in the tree (nothing here deletes it)
const untracked = () => new Set(spawnSync("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: ROOT, encoding: "utf8" }).stdout.split("\n").filter((l) => l.startsWith("?? ")).map((l) => l.slice(3)));
const before = untracked();
const todo = files.filter((f) => !only.length || only.some((o) => rel(f).includes(o)));
const results: Res[] = [];
const t0 = performance.now();
let next = 0;
await Promise.all(Array.from({ length: Math.max(1, JOBS) }, async () => {
  while (next < todo.length) {
    const f = todo[next++]; const r = await run(f); results.push(r);
    const mark = { pass: "ok   ", loaded: "ok   ", red: "RED  ", dead: "DEAD ", timeout: "SLOW ", env: "ENV  ", skip: "skip ", flaky: "FLAKY" }[r.kind];
    console.log(`${mark} ${rel(f)}${r.why ? `  — ${r.why}` : ""}${r.kind === "red" && r.tail ? `\n        ${r.tail.replace(/\n/g, "\n        ")}` : ""}`);
  }
}));

// several at a time share ports and scratch files: a red or a timeout is run again alone before it counts
if (!importOnly && JOBS > 1) for (const r of results.filter((x) => x.kind === "red" || x.kind === "timeout")) {
  const again = await run(r.file);
  if (again.kind === "pass") { r.kind = "flaky"; r.why = `red beside others (${r.why}), passes alone`; console.log(`ok    ${rel(r.file)}  — alone`); }
}

const by = (k: Res["kind"]) => results.filter((r) => r.kind === k).map((r) => rel(r.file)).sort();
console.log(`\n${results.length} files in ${((performance.now() - t0) / 1000).toFixed(0)} s (${importOnly ? "import-only" : "full"}, ${JOBS} at a time, ${TIMEOUT_S} s each)`);
for (const [k, label] of [["dead", "dead at import"], ["red", "red"], ["timeout", "timed out"], ["flaky", "red only beside others (pass alone)"], ["env", "need what this host lacks"], ["skip", "skipped"]] as const) {
  const l = by(k); if (l.length) console.log(`  ${label}: ${l.length}\n    ${l.join("\n    ")}`);
}
console.log(`  ${importOnly ? "loaded" : "passed"}: ${by(importOnly ? "loaded" : "pass").length}`);
const left = [...untracked()].filter((p) => !before.has(p));
if (left.length) console.log(`\n  left in the tree by this run (a killed test's debris; check, then delete): ${left.length}\n    ${left.slice(0, 20).join("\n    ")}${left.length > 20 ? "\n    …" : ""}`);
const unRun = unreached.filter((p) => todo.some((f) => rel(f) === p));
console.log(`\n${unreached.length} of ${files.length} files are reached by no runner but this one${only.length ? ` (${unRun.length} in this run)` : ""}; --unreached lists them`);
process.exit(by("dead").length || (!importOnly && by("red").length) ? 1 : 0);
