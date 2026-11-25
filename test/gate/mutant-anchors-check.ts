// test/gate/mutant-anchors-check.ts — every mutant table's find text occurs exactly once in its file (cheap and static: it
// reads the tables, runs no mutant). A find that moved makes its `--mutants` arm print "not found exactly once", and most
// arms run outside the gate, so 22 anchors died unseen (#333 H1). Every file under test/ with a `const MUTANTS` table must be listed in TABLES.
//   bun test/gate/mutant-anchors-check.ts
import fs from "node:fs";
import path from "node:path";
import { ENGINE, readLF } from "./common.ts";
import { editsOf, type Mutant } from "./mutants.ts";
import { suite } from "./suite.ts";

const { check, done } = suite("mutant-anchors");
// [suite file, table name, where its file names live under the tree ("" = the root)]
const TABLES: [string, string, string][] = [
  ["test/protocol/batch2-check.ts", "MUTANTS", ""], ["test/protocol/build-check.ts", "MUTANTS", ""],
  ["test/protocol/climb-env-check.ts", "MUTANTS", "shared"], ["test/protocol/describe-particles-check.ts", "MUTANTS", ""],
  ["test/protocol/drive-check.ts", "MUTANTS", "shared"], ["test/protocol/force-check.ts", "MUTANTS", "shared"],
  ["test/protocol/grab-check.ts", "MUTANTS", "shared"], ["test/protocol/names-check.ts", "MUTANTS", ""],
  ["test/protocol/parity-check.ts", "MUTANTS", ""], ["test/protocol/physics-volume-check.ts", "MUTANTS", "shared"],
  ["test/protocol/r8-check.ts", "MUTANTS", "shared"], ["test/protocol/r9-check.ts", "MUTANTS", ""],
  ["test/protocol/r10-check.ts", "MUTANTS", ""], ["test/protocol/r11-check.ts", "MUTANTS", ""],
  ["test/protocol/roles-check.ts", "MUTANTS", "shared"], ["test/protocol/scale-check.ts", "MUTANTS", ""],
  ["test/protocol/scars-check.ts", "MUTANTS", "shared"], ["test/protocol/scripts-check.ts", "MUTANTS", "shared/protocol"],
  ["test/protocol/shiplist-check.ts", "MUTANTS", ""], ["test/protocol/shove-check.ts", "MUTANTS", "shared"],
  ["test/protocol/txn-check.ts", "MUTANTS", ""], ["test/protocol/zone-water-check.ts", "MUTANTS", "shared"],
  ["test/protocol/video-check.ts", "MUTANTS", ""],
  // object rows ({file, find} or {file, from}), all from the root
  ["test/protocol/modserver-mutants.ts", "M", ""], ["test/protocol/blockers-mutants.ts", "M", ""],
  ["test/mcpl/body-state-mutation-test.ts", "cases", ""], ["test/server/voice-wire-mutation-test.ts", "cases", ""],
  ["test/client/contact-mutation-test.ts", "cases", ""],
];

/** The array literal `const <name>… = [ … ];` in src, as text: brackets matched outside strings, templates and comments. */
function literal(src: string, name: string): string | null {
  const m = new RegExp(`^const ${name}\\b[^=\\n]*=\\s*\\[`, "m").exec(src); if (!m) return null;
  const start = m.index + m[0].length - 1; let depth = 0;
  for (let i = start; i < src.length; i++) {
    const c = src[i];
    if (c === "/" && src[i + 1] === "/") { i = src.indexOf("\n", i); if (i < 0) return null; continue; }
    if (c === "/" && src[i + 1] === "*") { i = src.indexOf("*/", i) + 1; if (i <= 0) return null; continue; }
    if (c === '"' || c === "'" || c === "`") { for (i++; i < src.length && src[i] !== c; i++) if (src[i] === "\\") i++; continue; }
    if (c === "[") depth++;
    else if (c === "]" && --depth === 0) return src.slice(start, i + 1);
  }
  return null;
}
// a row as Mutant: object rows ({file, find|from, repl|to}) put in the tuple's places
const asMutant = (r: any): Mutant => (Array.isArray(r) ? r : [r.name ?? r.id, r.file, r.find ?? r.from, r.repl ?? r.to, []]) as Mutant;

// a table may spell a word through the file's own string constants (names-check's EM, body-state's BODY): those come along
const STR = String.raw`(?:"[^"\\\n]*"|'[^'\\\n]*')`;
const CONST = new RegExp(String.raw`^const [A-Z][A-Z0-9_]* = ${STR}(?: \+ ${STR})*(?:, [A-Z][A-Z0-9_]* = ${STR}(?: \+ ${STR})*)*;`, "gm");
const constsOf = (src: string) => (src.match(CONST) ?? []).join("\n");

let rows = 0, dead = 0;
for (const [file, name, base] of TABLES) {
  const src = readLF(path.join(ENGINE, file)), text = literal(src, name);
  let table: unknown[] = [];
  try { table = text ? new Function(`${constsOf(src)}\nreturn ${text};`)() : []; } catch (e) { check(`${file}: its ${name} table reads as plain data`, false, String(e)); continue; }
  check(`${file}: has a ${name} table`, table.length > 0);
  for (const r of table) for (const [f, find] of editsOf(asMutant(r), base)) {
    rows++; const at = path.join(ENGINE, f);
    const n = fs.existsSync(at) ? readLF(at).split(find).length - 1 : -1;
    if (n !== 1) dead++, check(`${file} '${asMutant(r)[0]}': its find text occurs exactly once in ${f}`, false, n < 0 ? "no such file" : `${n}×: ${JSON.stringify(find).slice(0, 90)}`);
  }
}
check(`every find text occurs exactly once (${rows} read, ${dead} not)`, rows > 0 && !dead);
// a new mutant table can't hide: every `const MUTANTS` under test/ is listed above
const listed = new Set(TABLES.map(([f]) => f));
const walk = (d: string): string[] => fs.readdirSync(path.join(ENGINE, d), { withFileTypes: true }).flatMap((e) => e.name === "node_modules" || e.name.startsWith(".") ? [] : e.isDirectory() ? walk(`${d}/${e.name}`) : /\.(ts|mjs|js)$/.test(e.name) ? [`${d}/${e.name}`] : []);
const unlisted = walk("test").filter((f) => !listed.has(f) && /^const MUTANTS\b/m.test(readLF(path.join(ENGINE, f))));
check("every MUTANTS table under test/ is listed here", !unlisted.length, unlisted.join(", "));
done();
