// `export { X } from './y.js'` forwards X to importers and creates NO LOCAL BINDING.
// So a module that re-exports a name AND uses that name itself compiles fine, passes
// every boot-level check, and throws a ReferenceError the moment the using line runs.
//
// Two shipped once (avatar.js/ANIM_CLIPS was one) past a green boot-check and product
// suite: the using line ran only when a gesture played. This finds the class.
//
//   bun test/client/reexport-binding-test.mjs
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';
import { suite } from '../gate/suite.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
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
// where a USE is looked for: also without the insides of quoted strings (a path like './markup.js' names no binding)
// and trailing comments
// (a `//` after a colon is a URL's, as in a template literal: `https://h/${X}` still uses X)
const code = (src) => src.replace(/(['"])(?:\\.|(?!\1)[^\\\n])*\1/g, '""').replace(/(^|[^:\\])\/\/.*$/gm, '$1');

const S = suite('reexport-binding');
const findings = [];

/** The names `raw` uses that it only re-exports. */
function unbound(raw) {
    const out = [];
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
      const rest = code(src.slice(0, m.index) + src.slice(m.index + m[0].length));
      for (const name of names) {
        // NB: build these from a plain string, never a template literal carrying backslash
        // escapes - a template literal reads \b as a backspace character, which is how the
        // first version of this check matched nothing and called three healthy files broken.
        const used = new RegExp('(^|[^A-Za-z0-9_$.])' + name + '([^A-Za-z0-9_$]|$)').test(rest);
        if (used && !imported.has(name)) out.push(name);
      }
    }
    return out;
}
for (const dir of SCAN) for (const file of walk(dir))
  for (const name of unbound(readFileSync(file, 'utf8'))) findings.push({ file: relative(ROOT, file).split(String.fromCharCode(92)).join('/'), name });

// self-sample: a use inside a template literal's URL still counts (the `//` there is not a comment)
S.check('self-sample: a re-exported name used in `https://h/${X}` is caught', unbound("export { X } from './x.js';\nconsole.log(`https://h/${X}`);\n").includes('X'));

S.check('no module uses a name it only re-exports', findings.length === 0,
  findings.map((f) => `${f.file} uses ${f.name}, which it only re-exports (fix: \`import { X } from ...; export { X };\` so a local binding exists)`).join('; '));
S.done();
