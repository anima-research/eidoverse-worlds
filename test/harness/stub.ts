// test/harness/stub.ts: a Bun plugin resolver stub that must apply. One that never applied, or that stubbed a relative import
// naming no file, FAILs its suite at exit, naming where it was registered (nock's scope.done(): a stub whose file moved, or
// whose regex still accepts the old path, would otherwise pass vacuously). test/harness/stub-test.ts holds both.
//   stubResolve(b, /^(\.\.?\/)+core\.js$/, () => ({ path: STUB }))     in place of b.onResolve({ filter }, cb), inside plugin({ setup(b) {…} })
//   stubResolve(b, re, cb, { optional: "why" })                  a stub that may not apply in every run; the why is the one-line reason
// "Applied" = the resolver returned a result (an importer-conditional resolver that returned undefined did not apply).
import type { OnResolveArgs, OnResolveResult, PluginBuilder } from "bun";
import path from "node:path";
import { appendFileSync, existsSync } from "node:fs";

type Resolve = (args: OnResolveArgs) => OnResolveResult | undefined | null | Promise<OnResolveResult | undefined | null>;
const ROOT = path.resolve(import.meta.dir, "../..");
const stubs: { filter: RegExp; where: string; hits: number; optional?: string }[] = [];

export function stubResolve(build: PluginBuilder, filter: RegExp, resolve: Resolve, o: { optional?: string } = {}): void {
  const frame = (new Error().stack ?? "").split("\n").slice(1).find((l) => !/[\\/]harness[\\/]stub\.ts:/.test(l)) ?? "";
  const at = frame.match(/\(?((?:[A-Za-z]:)?[^():]+):(\d+):\d+\)?\s*$/);
  const s = { filter, where: at ? `${path.relative(ROOT, at[1]).split(path.sep).join("/")}:${at[2]}` : "?", hits: 0, optional: o.optional };
  if (!stubs.length) process.on("exit", verifyStubs);
  stubs.push(s);
  build.onResolve({ filter }, (args) => {
    const r = resolve(args);
    if (r instanceof Promise) return r.then((x) => { if (x) hit(s, args); return x ?? undefined; });
    if (r) hit(s, args);
    return r ?? undefined;
  });
}

// STUB_TRACE=<file>: append one line per application, `where <tab> importer <tab> specifier`, so a run before and after a
// module move can be diffed: which importer, by basename, still gets which stub
const TRACE = process.env.STUB_TRACE;
const stale: string[] = [];
// a relative specifier names a file: one that isn't there is an import a move left behind, which the stub would hide
const names = (a: OnResolveArgs) => { const p = path.resolve(path.dirname(a.importer), a.path.replace(/[?#].*$/, ""));
  return [p, p.replace(/\.js$/, ".ts"), p.replace(/\.js$/, ".mjs"), `${p}.js`, `${p}.ts`, path.join(p, "index.js")].some((f) => existsSync(f)); };
function hit(s: { hits: number; where: string }, a: OnResolveArgs) {
  s.hits++;
  if (/^\.\.?\//.test(a.path) && a.importer && !names(a)) stale.push(`${a.path} from ${path.relative(ROOT, a.importer).split(path.sep).join("/")} (stub registered at ${s.where})`);
  if (TRACE) appendFileSync(TRACE, `${s.where}\t${path.relative(ROOT, a.importer).split(path.sep).join("/")}\t${a.path}\n`);
}

/** At exit: a non-optional stub that never applied, or one that stubbed a relative import naming no file, prints a FAIL line
 *  and turns a 0 exit into 1. */
export function verifyStubs(): void {
  const dead = stubs.filter((s) => !s.hits && !s.optional);
  for (const s of dead) console.log(`FAIL stub never applied: ${s.filter} (registered at ${s.where}); its module moved or the import is gone`);
  for (const s of new Set(stale)) console.log(`FAIL stub applied to a path that isn't there: ${s}; the import is stale, or the stub's regex still accepts an old path`);
  if ((dead.length || stale.length) && !process.exitCode) process.exitCode = 1;
}
