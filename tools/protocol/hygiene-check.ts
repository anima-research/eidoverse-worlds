// tools/protocol/hygiene-check.ts — patterns that broke the gate one site at a time, refused as a class.
//
// Each rule names a shape that failed somewhere real (CI on Windows or a slow runner, 10-19..22). The checked tree is the
// gate's own code: every suite run.ts runs, with the local files it imports, plus server/, shared/ and mcpl/. Counts are
// per file and per rule, against tools/protocol/hygiene-baseline.json, which may only go DOWN: a file over its count fails,
// a file under it fails too until the baseline is lowered (`--write`, which refuses to raise anything). A file not in the
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
//                 Windows, so the check quietly does nothing there.
import fs from "node:fs";
import path from "node:path";
import { ENGINE } from "./common.ts";
import { SUITES, localImports, suitePath } from "./suites.ts";

export const RULES: Record<string, RegExp> = {
  "bare-wait": /new Promise\(\s*\(?\s*(?:r|res|resolve|ok|done)\s*\)?\s*=>\s*setTimeout\(\s*(?:r|res|resolve|ok|done)\b|\bBun\.sleep(?:Sync)?\(|\bawait\s+(?:sleep|delay|nap|snooze)\(|\.waitForTimeout\(/g,
  "own-until": /(?:\bfunction\s+|\b(?:const|let)\s+)(?:until|waitFor|waitUntil|eventually|pollUntil)\b\s*(?:<[^>]*>)?\s*(?:\(|=\s*(?:async\b|\())/g,
  "url-path": /import\.meta\.url\s*\)\s*\.pathname/g,
  "shell-interp": /\[\s*["']sh["']\s*,\s*["']-c["']\s*,\s*`[^`]*\$\{/g,
  "raw-symlink": /\bsymlinkSync\s*\(/g,
  "colon-list": /[^\n]*(?:process\.env\.\w+|\broots\b|\bdirs\b)[^\n]*\.split\(\s*["']:["']\s*\)/g,
  "version-regex": /@\(\d\[\d-\d\]\|/g,
  "slash-path": /[^\n]*\\\/(?:tools|shared|server|client|mcpl|spec|worlds?)\\\/[^\n]*\.test\(\s*(?:p|f|file|abs|full|dir|d)\s*\)/g,
};
const SELF = "tools/protocol/hygiene-check.ts";   // its fixtures are the bad shapes on purpose
const EXEMPT: Record<string, string[]> = { "raw-symlink": ["tools/protocol/common.ts"], "bare-wait": ["tools/protocol/wait.ts"], "own-until": ["tools/protocol/wait.ts"] };
const SUITE_ONLY = new Set(["bare-wait", "own-until"]);   // the waiting rules are about tests; server code may wait on purpose

export function scan(text: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, re] of Object.entries(RULES)) { const n = [...text.matchAll(re)].length; if (n) out[k] = n; }
  return out;
}

const rel = (p: string) => path.relative(ENGINE, p).split(path.sep).join("/");
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
  const files = new Set<string>(suites);
  for (const d of ["server", "shared", "mcpl"]) for (const f of walk(path.join(ENGINE, d), [])) files.add(rel(f));
  const out: Record<string, Record<string, number>> = {};
  for (const f of [...files].sort()) {
    const counts = scan(fs.readFileSync(path.join(ENGINE, f), "utf8"));
    for (const k of Object.keys(counts)) {
      if (f === SELF || EXEMPT[k]?.includes(f) || (SUITE_ONLY.has(k) && !suites.has(f))) continue;
      (out[f] ??= {})[k] = counts[k];
    }
  }
  return out;
}

const BASE = path.join(ENGINE, "tools/protocol/hygiene-baseline.json");
export function compare(now: Record<string, Record<string, number>>, base: Record<string, Record<string, number>>) {
  const over: string[] = [], under: string[] = [];
  for (const f of new Set([...Object.keys(now), ...Object.keys(base)])) for (const k of Object.keys(RULES)) {
    const n = now[f]?.[k] ?? 0, b = base[f]?.[k] ?? 0;
    if (n > b) over.push(`${f}: ${k} ${n} (baseline ${b})`); else if (n < b) under.push(`${f}: ${k} ${n} (baseline ${b})`);
  }
  return { over, under };
}

if (import.meta.main) {
  let pass = 0, fail = 0;
  const check = (name: string, ok: boolean, info?: unknown) => { if (ok) { pass++; console.log(`ok   ${name}`); } else { fail++; console.log(`FAIL ${name}`); if (info !== undefined) console.log("     ", typeof info === "string" ? info : JSON.stringify(info)); } };

  // H1–H6: each rule catches the shape it names, and leaves the right way alone
  const bad: Record<string, string> = {
    "bare-wait": "await new Promise((r) => setTimeout(r, 500)); await Bun.sleep(20); await sleep(100); await page.waitForTimeout(50);",
    "own-until": "async function until(fn) {}  const waitFor = async (e) => {};",
    "url-path": 'const d = new URL("../fixtures/", import.meta.url).pathname;',
    "shell-interp": 'Bun.spawnSync(["sh", "-c", `git archive ${c} | tar -x -C ${d}`]);',
    "raw-symlink": 'fs.symlinkSync(target, at);',
    "colon-list": "const roots = (process.env.PROTOCOL_WORLDS ?? \"\").split(\":\");",
    "version-regex": "ok(/@(1[4-9]|[2-9][0-9])$/.test(TRANSLATOR));",
    "slash-path": 'if (/\\/tools\\/[^/]+\\.(ts|mjs)$|\\/tools\\/protocol\\//.test(p)) walk(p);',
  };
  const want: Record<string, number> = { "bare-wait": 4, "own-until": 2, "url-path": 1, "shell-interp": 1, "raw-symlink": 1, "colon-list": 1, "version-regex": 1, "slash-path": 1 };
  const good = 'await until("the crate rests", () => crate.rest); await pause("the 2 s refractory window", 2000); const d = fileURLToPath(new URL("../f/", import.meta.url)); Bun.spawnSync(["sh", "-c", \'git archive "$1"\', "sh", c]); linkInto(t, at); if (/[\\\\/]tools[\\\\/]/.test(p)) walk(p); const poll = (p) => post("/native/poll", p); const r = pathList(process.env.PROTOCOL_WORLDS); ok(translatorVersion(TRANSLATOR) >= 14);';
  let i = 1;
  for (const k of Object.keys(RULES)) check(`H${i++} ${k}: caught in its known-bad form (${want[k]}), and not in the right way`, (scan(bad[k])[k] ?? 0) === want[k] && !(scan(good)[k] ?? 0), { bad: scan(bad[k]), good: scan(good) });
  // own-until has one false friend in the tree ('const poll = (p: any) => post(...)', native-login-test); it's a request, not a loop
  // and isn't a gate suite. The good string carries it so a broadened pattern shows up here first.

  // H7: the gate's code against the baseline (may only go down)
  const now = measure();
  const base = fs.existsSync(BASE) ? JSON.parse(fs.readFileSync(BASE, "utf8")) : {};
  if (process.argv.includes("--write")) {
    const { over } = compare(now, base);
    if (Object.keys(base).length && over.length) { console.log(`refused: --write would raise the baseline:\n  ${over.join("\n  ")}`); process.exit(1); }
    fs.writeFileSync(BASE, JSON.stringify(now, null, 1) + "\n"); console.log(`wrote ${rel(BASE)}`);
  }
  const { over, under } = compare(now, JSON.parse(fs.existsSync(BASE) ? fs.readFileSync(BASE, "utf8") : "{}"));
  check("H7 no file is over its baseline (new debt of a known class can't land)", over.length === 0, over.join("\n      "));
  check("H8 no file is under its baseline without the baseline following (`hygiene-check --write` locks in what was paid off)", under.length === 0, under.join("\n      "));
  const tot: Record<string, number> = {}; for (const f of Object.values(now)) for (const [k, n] of Object.entries(f)) tot[k] = (tot[k] ?? 0) + n;
  console.log(`[hygiene] debt still in the tree: ${Object.entries(tot).map(([k, n]) => `${k} ${n}`).join(", ") || "none"}`);
  console.log(`[hygiene-check] ${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
}
