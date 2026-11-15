// test/gate/hygiene-check.ts — patterns that broke the gate one site at a time, refused as a class.
//
// Each rule names a shape that failed somewhere real (CI on Windows or a slow runner, 10-19..22). The checked tree is the
// gate's own code: every suite run.ts runs, with the local files it imports (not a runner's file argument, as bun-test.ts
// x-test.ts: that file gets only the all-files rules), plus server/, shared/ and mcpl/. Counts are
// per file and per rule, against test/gate/hygiene-baseline.json, which may only go DOWN: a file over its count fails,
// a file under it fails too until the baseline is lowered (`--write`, which refuses to raise anything while a baseline file exists). A file not in the
// baseline is allowed 0. So existing debt is visible and shrinking, and new debt can't land.
//
//   bare-wait     a fixed sleep (setTimeout-in-a-Promise, Bun.sleep, sleep()/delay(), waitForTimeout) in a suite. Wait on
//                 the condition with wait.ts `until`; a wait where elapsed time IS the test uses `pause(why, ms)`.
//   own-until     a suite defining its own until/waitFor/poll loop instead of importing wait.ts (30 copies, none scaled).
//   url-path      `new URL(…, import.meta.url).pathname` used as a file path: "/D:/…" on Windows. Use fileURLToPath.
//   shell-interp  a value pasted into an `sh -c` script: a Windows path's backslashes are escapes. Pass it as an argument
//                 (common.ts archiveTo shows how).
//   raw-symlink   symlinkSync outside common.ts: EPERM on Windows without Developer Mode. Use common.ts linkInto.
//   colon-list    a list of directories split on ":": `C:\\…` splits at its drive letter. Use common.ts pathList.
//   version-regex a version floor written as a regex of digits (`@(1[4-9]|[2-9][0-9])`): it breaks at the next decade. Parse
//                 the number (translate-v1.js translatorVersion) and compare.
//   slash-path    a resolved filesystem path tested with a `/`-only pattern (`/\/tools\//.test(p)`): never matches on
//                 Windows, so the check quietly does nothing there. Also a path-suffix regex (`/mcpl\/agent\.ts$/`) on a line
//                 that doesn't convert the path first, and a regex built as `'/' + file` (a bun plugin filter sees the native
//                 path): CI 42190828916, flight and voice-wire-mutation. Use common.ts slashed / pathEnd.
//   chrome-flags  a Chromium launched with its own flag list (a quoted headless or remote-debugging-port flag) instead of
//                 chrome.ts chromeArgs: five launchers each had a different list, and an OS's flag lived in a workflow's env.
//                 Checked over all of tools/, bench/ and test/, where the benches that launch browsers outside the gate live.
//   lab-clock     the authority's clock env set or deleted by hand: 124 inline "advance then pin" copies in 34 files (10-22),
//                 where a helper that forgot to advance (or two sharing one counter) could run time backwards silently. Use
//                 test/gate/clock.ts (labClock().advance, pin, unpinned).
//   agent-url     a WorldAgent built without `url`: it falls back to 127.0.0.1:8940, whatever runs there (or a closed port,
//                 which hangs ~2 min on a mirrored-network host). Pass the test's own server: test/harness/no-world.ts noWorldUrl().
//                 Checked over tools/ and bench/ only.
//   own-ok        a suite counting its own rows (`let pass = 0, fail = 0`) instead of importing suite.ts.
//   posix-mode    a file's mode asserted equal to an octal literal (`=== 0o600`) on a line that doesn't say what Windows does:
//                 NTFS has no POSIX modes (stat says 666), so the row fails there or passes vacuously. Use suite.ts `mode()`,
//                 which reports the row not applicable on Windows (CI 42190828916: native-login W10, mkconfig).
//   ungated       a test-named file (-test, -check, -probe, .test, -bench, -mutants) directly in tools/, tools/water/, bench/ or mcpl/ (not their
//                 subfolders), or anywhere in test/ but harness/stubs/fixtures/labs, that no SUITES row runs or imports: every
//                 test is in the gate or gone (R 10-29). The ones still out
//                 are listed in test/gate/ungated.json with one line why; that list is meant to shrink (review's to hold: nothing here diffs it against the base).
//   redaction-parse  a redaction's targets read by hand (`.body.values`) outside fold.js: four parsers drifted apart when
//                 {seq, op} became {seq, index}, and undo wrote a redacted value back (review 11-05 B1). Use fold.js
//                 redactionsIn / redactedBodies.
//   role-words    WORLD_ADMIN / "world admin" / "world operator" for the server's operator (R 10-27): say "server operator".
//   authority-async  `async` or `await` under shared/protocol/authority*: UP and CTX are sound only because the authority never
//                 yields mid-request (tel0s #260 11-06). Zero, no baseline.
//   prod-imports-test  server/, shared/, mcpl/ or client/ importing from test/: a deploy without test/ loses the feature
//                 silently (server/geometry.ts's topGrid, review 11-08). Zero, no baseline.
//   whole-body    `await req.text()/json()/arrayBuffer()/formData()` in server/: the whole body is buffered before any size
//                 check (Bun's only bound is 128 MB). Read through server/request-body.ts readCapped / readCappedBytes. Zero.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { ENGINE } from "./common.ts";
import { SUITES, localImports, suitePath } from "./suites.ts";
import { suite } from "./suite.ts";

export const RULES: Record<string, RegExp> = {
  "bare-wait": /new Promise\(\s*\(?\s*(?:r|res|resolve|ok|done)\s*\)?\s*=>\s*setTimeout\(\s*(?:r|res|resolve|ok|done)\b|\bBun\.sleep(?:Sync)?\(|\bawait\s+(?:sleep|delay|nap|snooze)\(|\.waitForTimeout\(/g,
  "own-until": /(?:\bfunction\s+|\b(?:const|let)\s+)(?:until|waitFor|waitUntil|eventually|pollUntil)\b\s*(?:<[^>]*>)?\s*(?:\(|=\s*(?:async\b|\())/g,
  "url-path": /import\.meta\.url\s*\)\s*\.pathname/g,
  "shell-interp": /\[\s*["']sh["']\s*,\s*["']-c["']\s*,\s*`[^`]*\$\{/g,
  "raw-symlink": /\bsymlinkSync\s*\(/g,
  "colon-list": /[^\n]*(?:process\.env\.\w+|\broots\b|\bdirs\b)[^\n]*\.split\(\s*["']:["']\s*\)/g,
  "version-regex": /@\(\d\[\d-\d\]\|/g,
  "lab-clock": /\bdelete\s+process\.env(?:\.PROTOCOL_NOW|\[\s*["'`]PROTOCOL_NOW["'`]\s*\])|process\.env(?:\.PROTOCOL_NOW|\[\s*["'`]PROTOCOL_NOW["'`]\s*\])\s*=(?!=)/g,
  "slash-path": /[^\n]*\\\/(?:tools|test|shared|server|client|mcpl|spec|worlds?)\\\/[^\n]*\.test\(\s*(?:p|f|file|abs|full|dir|d)\s*\)|^(?![^\n]*(?:\.replace\(\/\\\\\/g|\bslashed\(|\bfwd\(|\[\\\\\/\]))[^\n]*(?<!\\)\/[A-Za-z_][\w-]*\\\/(?:[^\/\n\\]|\\.)*\\\.(?:ts|js|mjs|json)\$\/[^\n]*|\bnew RegExp\(\s*(?:(["'])\/\1\s*\+|`\/\$\{)/gm,
  "chrome-flags": /["'`]--(?:headless\b|remote-debugging-port\b)/g,
  // the gate runs under Bun, and under Bun on Windows playwright neither launches (its pipe descriptors don't pass through
  // Bun's spawn) nor connects over CDP: browser-check hung to its timeout on every Windows run until 10-22. Gate suites drive
  // Chrome with chrome.ts cdpPage / harness scratchBench. Benches run under node may use it.
  "agent-url": /\bnew\s+WorldAgent\s*\(\s*(?:\{(?![^{}]*\burl\b)[^{}]*\})?\s*\)/g,
  "own-ok": /\blet\s+(?:pass|passes|passed)\s*=\s*0\s*,\s*(?:fail|fails|failed)\s*=\s*0\b|\blet\s+(?:fail|fails|failed)\s*=\s*0\s*,\s*(?:pass|passes|passed)\s*=\s*0\b/g,
  "redaction-parse": /\.body\??\.values\b/g,
  "posix-mode": /^(?![^\n]*(?:win32|\bWIN\b|NO_MODES))[^\n]*===?\s*0o[0-7]{3}\b[^\n]*/gm,
  "playwright": /\bfrom\s+["']playwright(?:-core)?["']|\b(?:require|import)\(\s*["']playwright(?:-core)?["']/g,
};
const SELF = "test/gate/hygiene-check.ts";   // its fixtures are the bad shapes on purpose
const EXEMPT: Record<string, string[]> = { "chrome-flags": ["test/gate/chrome.ts"], "raw-symlink": ["test/gate/common.ts"], "bare-wait": ["test/gate/wait.ts"], "own-until": ["test/gate/wait.ts"], "lab-clock": ["test/gate/clock.ts"], "own-ok": ["test/gate/suite.ts"], "agent-url": ["test/harness/dummy.ts"], "redaction-parse": ["shared/protocol/fold.js"] };   // dummy is the show host's service: WORLD_URL is how it is told where to connect
const SUITE_ONLY = new Set(["bare-wait", "own-until", "playwright", "own-ok", "posix-mode"]);   // the waiting rules are about tests; server code may wait on purpose
const ALL_TOOLS = new Set(["chrome-flags", "agent-url", "slash-path"]);   // slash-path: a --preload file is no import, so the gate set misses it
const TOOLS_ONLY = new Set(["agent-url"]);   // mcpl/ has its own owner and its server builds its agent from the env on purpose

export function scan(text: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, re] of Object.entries(RULES)) { const n = [...text.matchAll(re)].length; if (n) out[k] = n; }
  return out;
}

const ROLE_WORDS = /WORLD_ADMIN|\bworld[- ]admins?\b|\bworld operators?\b/gi;
export const roleWords = (text: string) => [...text.matchAll(ROLE_WORDS)].length;
// where the legacy name stays (R 10-27): its reader, its compatibility test, the migration notes; and dated records kept verbatim
const ROLE_WORDS_OK = new Set([SELF, "server/operators.ts", "test/protocol/identity-check.ts", "docs/operator/TRANSLATING-OLD-WORLDS.md", "docs/operator/SHOW-RUNBOOK.md", "docs/history/INCIDENTS.md", "docs/history/TEL0S_NOTES.md"]);
/** "file:line" for each role-word hit in the repo's text outside ROLE_WORDS_OK (frozen/ is history, never edited). */
export function roleWordHits(root = ENGINE): string[] {
  const out: string[] = [];
  const go = (dir: string) => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name === ".git" || e.name === "frozen") continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) go(p);
    else if (/\.(ts|js|mjs|md|sh|conf|service|html|json|jsonl|yml|yaml|toml|txt|py|ps1|env|example|patch|css)$/.test(e.name) && !ROLE_WORDS_OK.has(relTo(root, p)))   // every text kind in the tree (bot #677)
      fs.readFileSync(p, "utf8").split("\n").forEach((l, n) => { if (roleWords(l)) out.push(`${relTo(root, p)}:${n + 1}`); });
  } };
  go(root); return out;
}
const relTo = (root: string, p: string) => path.relative(root, p).split(path.sep).join("/");
const rel = (p: string) => relTo(ENGINE, p);
/** `async`/`await` as words in the authority's code (comments included: a word there is a plan to use it). */
export const authorityAsync = (text: string) => [...text.matchAll(/\b(?:async|await)\b/g)].length;
export function authorityAsyncHits(root = ENGINE): string[] {
  const dir = path.join(root, "shared/protocol"); const files = [path.join(dir, "authority.js"), ...walk(path.join(dir, "authority"), [])].filter((p) => fs.existsSync(p));
  return files.flatMap((p) => fs.readFileSync(p, "utf8").split("\n").flatMap((l, n) => (authorityAsync(l) ? [`${relTo(root, p)}:${n + 1}`] : [])));
}
/** An import or path into test/ from production code: a quoted relative `../…/test/` (an absolute `/test/…` URL isn't matched). */
export const prodImportsTest = (text: string) => [...text.matchAll(/["'`](?:\.\.\/)+test\//g)].length;
export function prodImportsTestHits(root = ENGINE): string[] {
  return ["server", "shared", "mcpl", "client"].flatMap((d) => walk(path.join(root, d), [])).filter((p) => /\.(?:[cm]?[jt]s)$/.test(p))
    .flatMap((p) => fs.readFileSync(p, "utf8").split("\n").flatMap((l, n) => (prodImportsTest(l) ? [`${relTo(root, p)}:${n + 1}`] : [])));
}
/** A request body read whole, before any cap. */
export const wholeBody = (text: string) => [...text.matchAll(/\bawait\s+req\.(?:text|json|arrayBuffer|formData|blob)\(\s*\)/g)].length;
export function wholeBodyHits(root = ENGINE): string[] {
  return walk(path.join(root, "server"), []).filter((p) => !p.endsWith("request-body.ts"))
    .flatMap((p) => fs.readFileSync(p, "utf8").split("\n").flatMap((l, n) => (wholeBody(l) ? [`${relTo(root, p)}:${n + 1}`] : [])));
}
/** A spawn of the mcpl server with no MCPL_STATE writes mcpl/state.json in the checkout (CI 40956937323: client-tools imports
 *  every test, so a top-level spawn runs). True when the text spawns net-server.ts without naming MCPL_STATE. */
export const spawnsMcplStateless = (text: string) => /spawn\([^)]*mcpl\/net-server\.ts/.test(text) && !/MCPL_STATE/.test(text);
export function mcplStatelessHits(): string[] {
  return ["tools", "bench", "test"].flatMap((d) => walk(path.join(ENGINE, d), [])).filter((p) => spawnsMcplStateless(fs.readFileSync(p, "utf8"))).map(rel);
}
function walk(dir: string, acc: string[]) {
  if (!fs.existsSync(dir)) return acc;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name.startsWith(".")) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, acc); else if (/\.(ts|js|mjs)$/.test(e.name)) acc.push(p);
  }
  return acc;
}

/** file (repo-relative, `/`) → rule → count, over the gate's code. */
export function measure(): Record<string, Record<string, number>> {
  const suites = new Set<string>();
  for (const [, file] of SUITES) for (const f of localImports(suitePath(file))) suites.add(rel(f));
  const gate = new Set<string>(suites);
  for (const d of ["server", "shared", "mcpl"]) for (const f of walk(path.join(ENGINE, d), [])) gate.add(rel(f));
  const files = new Set<string>([...gate, ...["tools", "bench", "test"].flatMap((d) => walk(path.join(ENGINE, d), [])).map(rel)]);
  const out: Record<string, Record<string, number>> = {};
  for (const f of [...files].sort()) {
    const counts = scan(fs.readFileSync(path.join(ENGINE, f), "utf8"));
    for (const k of Object.keys(counts)) {
      if (f === SELF || EXEMPT[k]?.includes(f) || (SUITE_ONLY.has(k) && !suites.has(f)) || (TOOLS_ONLY.has(k) && !/^(tools|bench)\//.test(f)) || (!ALL_TOOLS.has(k) && !gate.has(f))) continue;
      (out[f] ??= {})[k] = counts[k];
    }
  }
  return out;
}

const BASE = path.join(ENGINE, "test/gate/hygiene-baseline.json");

/** Test-named files no SUITES row reaches (ungated.json lists the ones still out, each with its reason). */
export const TEST_NAME = /(?:-test|-check|-probe|\.test|-bench|-mutants)\.(?:ts|mjs|js)$/;
const UNGATED = path.join(ENGINE, "test/gate/ungated.json");
const US_LIST = path.join(ENGINE, "test/gate/underscore-names.json");
/** A tracked source file whose name has an underscore (vendored code and node_modules aside; Python keeps its own convention). */
export const underscoreName = (f: string): boolean => /\.(?:js|mjs|ts)$/.test(f) && !/(?:^|\/)(?:vendor|node_modules)\//.test(f) && path.posix.basename(f).includes("_");
export function underscoreNames(): string[] {
  const r = Bun.spawnSync(["git", "ls-files", "-z", "--", "client", "server", "shared", "mcpl", "tools", "test", "services", "bench", "deploy", "scripting"], { cwd: ENGINE });
  return r.stdout.toString().split("\0").filter((f) => f && underscoreName(f)).sort();
}
export function ungatedTests(): string[] {
  const gated = new Set<string>();
  for (const [, file] of SUITES) {
    for (const f of localImports(suitePath(file))) gated.add(rel(f));
    for (const a of file.split(" ").slice(1)) if (/\.(?:ts|mjs|js)$/.test(a)) for (const f of localImports(path.join(ENGINE, a))) gated.add(rel(f));   // a runner's file argument (bun-test.ts tools/x-test.ts)
  }
  const out: string[] = [];
  const NOT_TESTS = new Set(["harness", "stubs", "fixtures", "labs", "node_modules"]);
  const scan = (d: string): void => { for (const e of fs.readdirSync(path.join(ENGINE, d), { withFileTypes: true }))
    if (e.isDirectory()) { if (d.startsWith("test") && !NOT_TESTS.has(e.name)) scan(`${d}/${e.name}`); }
    else if (e.isFile() && TEST_NAME.test(e.name) && !gated.has(`${d}/${e.name}`)) out.push(`${d}/${e.name}`); };
  for (const d of ["tools", "tools/water", "bench", "mcpl", "test"]) scan(d);
  return out.sort();
}
export function compare(now: Record<string, Record<string, number>>, base: Record<string, Record<string, number>>) {
  const over: string[] = [], under: string[] = [];
  for (const f of new Set([...Object.keys(now), ...Object.keys(base)])) for (const k of Object.keys(RULES)) {
    const n = now[f]?.[k] ?? 0, b = base[f]?.[k] ?? 0;
    if (n > b) over.push(`${f}: ${k} ${n} (baseline ${b})`); else if (n < b) under.push(`${f}: ${k} ${n} (baseline ${b})`);
  }
  return { over, under };
}

if (import.meta.main) {
  const { check, done } = suite("hygiene-check", { cap: Infinity });

  // H1…: each rule catches the shape it names, and leaves the right way alone
  const bad: Record<string, string> = {
    "bare-wait": "await new Promise((r) => setTimeout(r, 500)); await Bun.sleep(20); await sleep(100); await page.waitForTimeout(50);",
    "own-until": "async function until(fn) {}  const waitFor = async (e) => {};",
    "url-path": 'const d = new URL("../fixtures/", import.meta.url).pathname;',
    "shell-interp": 'Bun.spawnSync(["sh", "-c", `git archive ${c} | tar -x -C ${d}`]);',
    "raw-symlink": 'fs.symlinkSync(target, at);',
    "colon-list": "const roots = (process.env.PROTOCOL_WORLDS ?? \"\").split(\":\");",
    "version-regex": "ok(/@(1[4-9]|[2-9][0-9])$/.test(TRANSLATOR));",
    "lab-clock": 'T += 100; process.env.PROTOCOL_NOW = String(T); process.env["PROTOCOL_NOW"] = "1"; delete process.env.PROTOCOL_NOW;',
    "slash-path": 'if (/\\/tools\\/[^/]+\\.(ts|mjs)$|\\/tools\\/protocol\\//.test(p)) walk(p);\nconst ALLOWED = [/mcpl\\/agent\\.ts$/, /client\\/lib\\/controller\\.js$/];\nb.onLoad({ filter: new RegExp(\'/\' + m.file + \'$\') }, f);',
    // split: the whole flag in this file would make suites.ts read the hygiene suite as one that launches a browser
    "chrome-flags": 'Bun.spawn([CHROME, "--headless=new", `--remote-' + 'debugging-port=${port}`, url]);',
    // split, like chrome-flags: the whole import in this file would make suites.ts read hygiene as a browser suite
    "agent-url": 'new WorldAgent({ name: "a", world: "w" }); new WorldAgent(); new WorldAgent({\n  name: "b",\n  avatar: "",\n});',
    "own-ok": "let pass = 0, fail = 0; let fails = 0, passes = 0;",
    "redaction-parse": 'if (e.kind === "redaction") for (const t of e.body.values) p.add(t.seq); const v = e.body?.values;',
    "playwright": 'import { chromium } from "play' + 'wright"; const { chromium: c2 } = await import("playwright-core");',
    "posix-mode": 'check("W10 private", (statSync(f).mode & 0o777) === 0o600);\nok(st.mode == 0o644, "D9");',
  };
  const want: Record<string, number> = { "bare-wait": 4, "own-until": 2, "url-path": 1, "shell-interp": 1, "raw-symlink": 1, "colon-list": 1, "version-regex": 1, "slash-path": 3, "chrome-flags": 2, "lab-clock": 3, "redaction-parse": 2, "playwright": 2, "agent-url": 3, "own-ok": 2, "posix-mode": 2 };
  const good = 'const ALLOWED = ["mcpl/agent.ts"]; ALLOWED.includes(slashed(f));\nb.onLoad({ filter: new RegExp(pathEnd(m.file)) }, f);\n(/\\/client\\/lib\\/x\\.js$/.test(a.importer.replace(/\\\\/g, "/")));\nS.mode("W10 private", f, 0o600);\nok(WIN ? isFile : st.mode === 0o600);\nok(process.platform === "win32" || m === 0o600);\nawait until("the crate rests", () => crate.rest); await pause("the 2 s refractory window", 2000); const d = fileURLToPath(new URL("../f/", import.meta.url)); Bun.spawnSync(["sh", "-c", \'git archive "$1"\', "sh", c]); linkInto(t, at); if (/[\\\\/]tools[\\\\/]/.test(p)) walk(p); const poll = (p) => post("/native/poll", p); const r = pathList(process.env.PROTOCOL_WORLDS); ok(translatorVersion(TRANSLATOR) >= 14); Bun.spawn([CHROME, ...chromeArgs({ port, profile }), url]); const n = rows.filter((r) => /chrom(e|ium).*--headless/.test(r)); // a --headless Chrome clock.advance(100); pin(LAB_EPOCH); const t = pinned(); if (process.env.PROTOCOL_NOW === "1") unpinned(f); const { ok, done } = suite("x"); let pass = rows.length; new WorldAgent({ name: "a", url: noWorldUrl() }); new WorldAgent({ url, name }); new WorldAgent(opts); const red = redactionsIn(E); const body = redactedBodies(E, red); const values = Object.values(body);';
  let i = 1;
  for (const k of Object.keys(RULES)) check(`H${i++} ${k}: caught in its known-bad form (${want[k]}), and not in the right way`, (scan(bad[k])[k] ?? 0) === want[k] && !(scan(good)[k] ?? 0), { bad: scan(bad[k]), good: scan(good) });
  // own-until has one false friend in the tree ('const poll = (p: any) => post(...)', native-login-test); it's a request, not a loop
  // and isn't a gate suite. The good string carries it so a broadened pattern shows up here first.

  // role words (R 10-27): the server's operator is a "server operator", never an admin or world admin; the legacy variable
  // is named only where it's read, its compatibility test, and the migration notes. Checked over every text file.
  const bareWords = ["only a world admin can ban", "remove them from WORLD_ADMIN", "a world operator", "(WORLD_ADMIN)"].join(" ");
  const fineWords = "SERVER_OPERATORS=human:discord:1; a server operator; the world's owner";
  check(`H${i++} role-words: caught in its known-bad form (4), and not in the right way`, roleWords(bareWords) === 4 && roleWords(fineWords) === 0, [roleWords(bareWords), roleWords(fineWords)]);
  // the scan reads every text kind, not only code and prose (bot #677): a planted .json and .yml are found, a .png is not
  { const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hyg-677-")); fs.mkdirSync(path.join(tmp, ".github")); for (const f of ["a.json", "b.yml", "c.png", ".github/d.yml"]) fs.writeFileSync(path.join(tmp, f), '{"who": "WORLD_ADMIN"}\n');
    const hits = roleWordHits(tmp); fs.rmSync(tmp, { recursive: true, force: true });   // hits come in the filesystem's order (ext4 isn't sorted)
    check(`H${i++} role-words: a .json, a .yml and a .github/ file saying WORLD_ADMIN are found by the tree scan (a binary kind is not)`, JSON.stringify([...hits].sort()) === '[".github/d.yml:1","a.json:1","b.yml:1"]', hits); }
  const wordHits = roleWordHits();
  check(`H${i++} role-words: no file outside the legacy reader, its test and the migration notes says WORLD_ADMIN, world admin or world operator`, wordHits.length === 0, wordHits.join("\n      "));
  // mcpl state (10-29): a test that spawns the mcpl server names MCPL_STATE, or it writes the repository's state file
  check(`H${i++} mcpl-state: caught in its known-bad form, and not with the override`, spawnsMcplStateless('Bun.spawn(["bun", "mcpl/net-server.ts"], { env: { MCPL_TOKENS: t } })') && !spawnsMcplStateless('Bun.spawn(["bun", "mcpl/net-server.ts"], { env: { MCPL_STATE: s } })'), "pattern");
  const mcplHits = mcplStatelessHits();
  check(`H${i++} mcpl-state: no test spawns the mcpl server without MCPL_STATE`, mcplHits.length === 0, mcplHits.join("\n      "));

  // every test is in the gate or gone (R 10-29): a test-named file no suite reaches is listed in ungated.json with its reason
  const listed: Record<string, string> = fs.existsSync(UNGATED) ? JSON.parse(fs.readFileSync(UNGATED, "utf8")) : {};
  const out = ungatedTests();
  const unlisted = out.filter((f) => !listed[f]?.trim());
  check(`H${i++} ungated: every test-named file runs in the gate, or ungated.json says in one line why not`, unlisted.length === 0, unlisted.join("\n      "));
  const stale = Object.keys(listed).filter((f) => !out.includes(f));
  check(`H${i++} ungated: ungated.json names only files that exist and are still out of the gate (a gated or deleted one comes off)`, stale.length === 0, stale.join("\n      "));
  console.log(`[hygiene] tests still out of the gate: ${out.length}`);

  // underscore-names: new files are lowercase-hyphen (CONTRIBUTING); underscore-names.json is today's exceptions, and it only shrinks
  check(`H${i++} underscore-names: caught in its known-bad form, and not in hyphen names, vendored code or Python`, underscoreName("client/lib/foo_bar.js") && !underscoreName("client/lib/foo-bar.js") && !underscoreName("client/vendor/a/b_c.js") && !underscoreName("spec/x/test_vectors.py"));
  const usNow = underscoreNames(), usListed: string[] = JSON.parse(fs.readFileSync(US_LIST, "utf8"));
  check(`H${i++} underscore-names: no new file name with an underscore (name it with hyphens)`, usNow.every((f) => usListed.includes(f)), usNow.filter((f) => !usListed.includes(f)).join("\n      "));
  check(`H${i++} underscore-names: the list names only files that still exist (a renamed one comes off)`, usListed.every((f) => usNow.includes(f)), usListed.filter((f) => !usNow.includes(f)).join("\n      "));

  // authority-async (tel0s #260 11-06): nothing under shared/protocol/authority* yields, so UP and CTX stay sound
  check(`H${i++} authority-async: caught in its known-bad form (3), and not in words that only contain it`, authorityAsync("async function f() { await g(); } const h = async () => 1;") === 3 && authorityAsync("// it awaits nothing; asynchronous work stays outside") === 0, "pattern");
  const asyncHits = authorityAsyncHits();
  check(`H${i++} authority-async: no async or await under shared/protocol/authority* (${asyncHits.length ? "found" : "none"})`, asyncHits.length === 0 && fs.existsSync(path.join(ENGINE, "shared/protocol/authority.js")), asyncHits.join("\n      "));

  // prod-imports-test (review 11-08): production code never reaches into test/
  check(`H${i++} prod-imports-test: caught in its known-bad form (2), and not in a path that only mentions a test`, prodImportsTest(`import("../test/stubs/x.mjs"); new URL("../../test/a.ts", u)`) === 2 && prodImportsTest(`// see test/server/x-test.ts; "./latest/"`) === 0, "pattern");
  const prodTestHits = prodImportsTestHits();
  check(`H${i++} prod-imports-test: server/, shared/, mcpl/ and client/ import nothing from test/ (${prodTestHits.length ? "found" : "none"})`, prodTestHits.length === 0 && fs.existsSync(path.join(ENGINE, "server/server.ts")), prodTestHits.join("\n      "));

  // whole-body (review 11-08): every request body in server/ is read under a cap
  check(`H${i++} whole-body: caught in its known-bad form (3), and not in a capped read`, wholeBody("await req.json(); await req.text(); await req.arrayBuffer();") === 3 && wholeBody("await readCapped(req, 1024); req.json") === 0, "pattern");
  const bodyHits = wholeBodyHits();
  check(`H${i++} whole-body: server/ reads no request body whole (${bodyHits.length ? "found" : "none"})`, bodyHits.length === 0 && fs.existsSync(path.join(ENGINE, "server/request-body.ts")), bodyHits.join("\n      "));

  // then the gate's code against the baseline (may only go down: --write refuses a raise; a hand-edited raise is review's to catch)
  const now = measure();
  const base = fs.existsSync(BASE) ? JSON.parse(fs.readFileSync(BASE, "utf8")) : {};
  if (process.argv.includes("--write")) {
    const { over } = compare(now, base);
    if (Object.keys(base).length && over.length) { console.log(`refused: --write would raise the baseline:\n  ${over.join("\n  ")}`); process.exit(1); }
    fs.writeFileSync(BASE, JSON.stringify(now, null, 1) + "\n"); console.log(`wrote ${rel(BASE)}`);
  }
  const { over, under } = compare(now, JSON.parse(fs.existsSync(BASE) ? fs.readFileSync(BASE, "utf8") : "{}"));
  check(`H${i++} no file is over its baseline (new debt of a known class can't land)`, over.length === 0, over.join("\n      "));
  check(`H${i++} no file is under its baseline without the baseline following (\`hygiene-check --write\` locks in what was paid off)`, under.length === 0, under.join("\n      "));
  const tot: Record<string, number> = {}; for (const f of Object.values(now)) for (const [k, n] of Object.entries(f)) tot[k] = (tot[k] ?? 0) + n;
  console.log(`[hygiene] debt still in the tree: ${Object.entries(tot).map(([k, n]) => `${k} ${n}`).join(", ") || "none"}`);
  done();
}
