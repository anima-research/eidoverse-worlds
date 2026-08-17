// The mention pattern is built from an id that arrives UNVALIDATED in
// tokens.json. Before this was escaped, an id with regex metacharacters threw
// inside a catch-all — so the agent silently never heard its own name again,
// for the life of the process, with a single log line and no other symptom.
import { mentionRegex } from '../mcpl/mention.ts';
let pass = 0, fail = 0;
const check = (n, c) => { c ? (pass++, console.log(`ok   ${n}`)) : (fail++, console.log(`FAIL ${n}`)); };

// 1. Normal ids still match the way they always did.
check('plain name matches @mention', mentionRegex('hesperus').test('hey @hesperus hi'));
check('plain name matches bare word', mentionRegex('hesperus').test('hesperus, look'));
check('plain name does not match a substring',
  !mentionRegex('hes').test('hesperus is here'));

// 2. Metacharacter ids must not throw — this is the regression.
for (const id of ['a(', 'x[', 'b+', 'c.d', 'e|f', 'g*', 'h$', 'i^', 'j\\', 'k?']) {
  let threw = false, matched = false;
  try { matched = mentionRegex(id).test(`hi @${id} there`); } catch { threw = true; }
  check(`id ${JSON.stringify(id)} does not throw`, !threw);
  if (!threw) check(`id ${JSON.stringify(id)} still matches itself`, matched);
}

// 3. Escaping must be LITERAL, not merely non-throwing: `b+` must not match `bbb`.
check('metacharacters are literal, not operators', !mentionRegex('b+').test('bbb here'));
check('a dot does not match any character', !mentionRegex('c.d').test('cxd here'));

// 4. Negative control — the OLD unescaped construction must be shown to break.
let oldThrew = false;
try { new RegExp(`(@a(\\b|\\ba(\\b)`, 'i'); } catch { oldThrew = true; }
check('control: the unescaped form does throw', oldThrew);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
