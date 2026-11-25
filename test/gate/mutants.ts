// test/gate/mutants.ts — the `--mutants` arm the protocol suites share: remove one gate in a copy of the tree, run the suite
// there, and its named rows must go red (a no-op CONTROL row, cases [], must stay green). mutant-anchors-check reads the
// same tables statically: every find text must occur exactly once in its file.
import fs from "node:fs";
import path from "node:path";
import { readLF } from "./common.ts";

/** [name, file, find, replace, rows that must turn red]; find may be [find, replace, file?][] for a gate held in two places. */
export type Mutant = [string, string, string | [string, string, string?][], string, string[]];
type Run = { code: number | null; out: string };

/** A row's edits as [file from the tree root, find, replace]; `base` is where the table's file names live ("" = the root). */
export const editsOf = ([, file, find, repl]: Mutant, base = ""): [string, string, string][] =>
  (Array.isArray(find) ? find : [[find, repl] as [string, string]]).map(([a, b, g]) => [path.join(base, g ?? file), a, b]);

/** Runs every row (or those --only names: a row naming one of them, or CONTROL for the no-op), prints one line per row and
 *  the `[tag --mutants] N mutations run, M wrong` summary, and exits 1 when any row is wrong. */
export async function runMutants(tag: string, table: Mutant[], o: {
  base?: string;
  tree: () => string;                                                  // a fresh copy of the tree to mutate
  run: (tree: string, only: string[] | null) => Run | Promise<Run>;   // the suite, against that tree
  also?: (m: Mutant, tree: string) => { good: boolean; note: string } | null;   // a row's extra proof (grab M1: other suites go red too)
}): Promise<never> {
  const argv = process.argv.slice(2), i = argv.indexOf("--only");
  const only = i >= 0 ? (argv[i + 1] ?? "").split(",") : null;
  let bad = 0, ran = 0;
  for (const m of table) {
    const [name, , , , cases] = m;
    if (only && !cases.some((c) => only.includes(c)) && !(only.includes("CONTROL") && !cases.length)) continue;
    ran++; const d = o.tree();
    const edits = editsOf(m, o.base).map(([f, a, b]) => [path.join(d, f), a, b] as const);
    const miss = edits.find(([f, a]) => readLF(f).split(a).length !== 2);
    if (miss) { bad++; console.log(`FAIL mutant '${name}': its text isn't found exactly once in ${path.relative(d, miss[0])} (the gate moved?)`); fs.rmSync(d, { recursive: true, force: true }); continue; }
    for (const [f, a, b] of edits) fs.writeFileSync(f, readLF(f).replace(a, () => b));
    const r = await o.run(d, cases.length ? cases : null);
    const red = [...r.out.matchAll(/^FAIL (\S+)/gm)].map((x) => x[1]);
    let good = cases.length ? r.code !== 0 && cases.every((c) => red.includes(c)) : r.code === 0;
    const more = o.also?.(m, d) ?? null; if (more && !more.good) good = false;
    if (!good) bad++;
    console.log(`${good ? "ok  " : "FAIL"} mutant '${name}' → ${cases.length ? `red: ${red.join(",") || "(none)"} (want ${cases.join(",")})` : `exit ${r.code} (want 0)`}${more ? ` · ${more.note}` : ""}`);
    if (!good) console.log(r.out.split("\n").slice(-12).join("\n"));
    fs.rmSync(d, { recursive: true, force: true });
  }
  console.log(`[${tag} --mutants] ${ran} mutations run, ${bad} wrong (each must turn its cases red; the control must stay green)`);
  process.exit(bad || !ran ? 1 : 0);
}
