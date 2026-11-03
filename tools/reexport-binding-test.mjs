// `export { X } from './y.js'` forwards X to importers and creates NO LOCAL BINDING.
// So a module that re-exports a name AND uses that name itself compiles fine, passes
// every boot-level check, and throws a ReferenceError the moment the using line runs.
//
// This branch shipped two of them (avatar.js/EMOTES, models.js/PORTED) while splitting
// data out from behind engine imports. Both survived a green boot-check and a green
// 40-check product suite, because one only fires when a person plays an emote and the
// other only when a ported verb arrives. A phone found the first. This finds the class.
//
//   node tools/reexport-binding-test.mjs
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCAN = [join(ROOT, 'client')];

function* walk(dir) {
  for (const e of readdirSync(dir)) {
    if (e === 'node_modules' || e === 'vendor') continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) yield* walk(p);
    else if (p.endsWith('.js')) yield p;
  }
}

const strip = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');

let pass = 0, fail = 0;
const findings = [];

for (const dir of SCAN) {
  for (const file of walk(dir)) {
    const raw = readFileSync(file, 'utf8');
    const src = strip(raw);
    // Names this file IMPORTS anywhere. A name both imported and re-exported HAS a
    // local binding and is correct - that is the fix's own spelling, so it must never
    // be reported as the defect.
    const imported = new Set();
    for (const im of src.matchAll(/import\s*\{([^}]+)\}\s*from/g)) {
      for (const n of im[1].split(',')) {
        const t = n.trim().split(/\s+as\s+/).pop().trim();
        if (t) imported.add(t);
      }
    }

    const re = /export\s*\{([^}]+)\}\s*from\s*['"][^'"]+['"]\s*;?/g;
    let m;
    while ((m = re.exec(src))) {
      const names = m[1].split(',')
        .map((n) => n.trim().split(/\s+as\s+/)[0].trim())
        .filter(Boolean);
      // everything in the file EXCEPT the re-export statement itself
      const rest = src.slice(0, m.index) + src.slice(m.index + m[0].length);
      for (const name of names) {
        // NB: build these from a plain string, never a template literal carrying backslash
        // escapes - a template literal reads  as a backspace character, which is how the
        // first version of this check matched nothing and called three healthy files broken.
        const used = new RegExp('(^|[^A-Za-z0-9_$.])' + name + '([^A-Za-z0-9_$]|$)').test(rest);
        if (used && !imported.has(name)) {
          findings.push({ file: relative(ROOT, file).split(String.fromCharCode(92)).join('/'), name });
        }
      }
    }
  }
}

if (findings.length === 0) {
  pass++;
  console.log('  ok    no module uses a name it only re-exports');
} else {
  fail++;
  console.log('  FAIL  a re-exported name is used locally, where it has no binding:');
  for (const f of findings) {
    console.log(`          ${f.file} uses ${f.name}, which it only re-exports`);
    console.log('          fix: `import { X } from ...; export { X };` so a local binding exists');
  }
}

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
