// tools/keyhints-check.ts — no hidden keys in edit mode (R 10-04: "SOOOO much hidden knowledge… needs to be tooltipped
// somewhere for it to matter"). Fails when:
//   1. edit-mode code reads a modifier (e.shiftKey / ctrlKey / altKey / metaKey, key === 'Control'…) on a line without a
//      `// keys: <id>` tag naming an entry in client/lib/keyhints.js;
//   2. an entry has no words to show (`before` empty);
//   3. an entry is never shown: no engage('<id>'), withKeys(…, '<id>') or KEYHINTS.<id> outside keyhints.js and outside
//      the `// keys:` tags themselves (a tag names the key; it doesn't show it to anyone).
//   bun tools/keyhints-check.ts
import fs from "node:fs";
import path from "node:path";
import { KEYHINTS } from "../client/lib/keyhints.js";

const ROOT = path.resolve(import.meta.dir, "..");
const FILES = ["build", "gizmo", "panels", "editpanels", "editlayout", "seatedit", "structure_ui", "edittabs", "editpaint", "widgets"]
  .map((f) => `client/lib/${f}.js`).filter((f) => fs.existsSync(path.join(ROOT, f)));
const MOD = /\be\.(shiftKey|ctrlKey|altKey|metaKey)\b|\bkey\s*===\s*['"](Control|Shift|Alt|Meta)['"]/;
let pass = 0, fail = 0;
const ok = (c: any, what: string, d?: any) => { if (c) pass++; else { fail++; console.log(`  ✗ ${what}${d !== undefined ? ` — ${JSON.stringify(d).slice(0, 300)}` : ""}`); } };

const untagged: string[] = []; const badIds: string[] = []; const shownIds = new Set<string>();
for (const f of FILES) {
  const lines = fs.readFileSync(path.join(ROOT, f), "utf8").split("\n");
  lines.forEach((line, i) => {
    const tag = /\/\/\s*keys:\s*([A-Za-z]+)/.exec(line)?.[1];
    if (MOD.test(line)) { if (!tag) untagged.push(`${f}:${i + 1}: ${line.trim().slice(0, 100)}`); else if (!(tag in KEYHINTS)) badIds.push(`${f}:${i + 1}: ${tag}`); }
    const code = line.replace(/\/\/\s*keys:.*$/, "");
    for (const m of code.matchAll(/engage\(\s*['"](\w+)['"]|withKeys\([^)]*['"](\w+)['"]\s*\)|KEYHINTS\.(\w+)/g)) shownIds.add(m[1] ?? m[2] ?? m[3]);
    // a map of tool → id feeding withKeys (editlayout's rail): every quoted id inside it counts
    if (/withKeys\(/.test(code)) {
      for (const m of code.matchAll(/,\s*['"](\w+)['"]\s*\)/g)) shownIds.add(m[1]);                              // nested: withKeys(withKeys(…), 'id')
      if (/\{[^}]*:\s*'\w+'/.test(code)) for (const m of code.matchAll(/:\s*'(\w+)'/g)) shownIds.add(m[1]);   // a tool → id map
    }
  });
}
ok(untagged.length === 0, "1 every modifier read in edit-mode code is tagged `// keys: <id>`", untagged);
ok(badIds.length === 0, "1b …and every tag names a keyhints.js entry", badIds);
const empty = Object.entries(KEYHINTS).filter(([, h]: any) => !h.before).map(([k]) => k);
ok(empty.length === 0, "2 every entry has words to show (before)", empty);
const never = Object.keys(KEYHINTS).filter((k) => !shownIds.has(k));
ok(never.length === 0, "3 every entry is shown somewhere (a tooltip via withKeys/KEYHINTS, or the status line via engage)", never);
console.log(`[keyhints-check] ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
