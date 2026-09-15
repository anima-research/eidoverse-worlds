// The mention pattern is built from an id that arrives UNVALIDATED in
// tokens.json. Before this was escaped, an id with regex metacharacters threw
// inside a catch-all — so the agent silently never heard its own name again,
// for the life of the process, with a single log line and no other symptom.
import { mentionRegex, mentionRegexFor } from '../mcpl/mention.ts';
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

// ── a body answers to its id AND its token display name ────────────
// A display name's trailing ` (qualifier)` is the part people drop when they
// address the body (the `#name (Guild)` label convention), so "@Artie" must
// reach the body named "Artie (kube)". Uniqueness is not required: two bodies
// that both answer to "Artie" are both addressed.
{
  const rx = mentionRegexFor(['artie-kube', 'Artie (kube)']);
  check('"@Artie, over here" reaches artie-kube', rx.test('@Artie, over here'));
  check('"Artie, over here" reaches artie-kube', rx.test('Artie, over here'));
  check('"@Artie (kube), over here" reaches artie-kube', rx.test('@Artie (kube), over here'));
  check('"hey artie-kube" reaches artie-kube', rx.test('hey artie-kube'));
  check('"artie is over there" reaches artie-kube (the qualifier-dropped name is the feature)', rx.test('artie is over there'));
  check('the full display name still matches in any case', rx.test('artie (KUBE) are you there'));
  check('a prefix of the id is a different body', !rx.test('artie-kubernetes is a different body'));
  check('a prefix of the dropped name is a different body', !rx.test('artiest of them all'));
  check('an id with a trailing qualifier gets the same treatment', mentionRegexFor(['zed (two)']).test('@zed hi'));
  check('a name that is only a qualifier contributes no empty alternative', mentionRegexFor(['(kube)']).source.split('|').length === 1 && !mentionRegexFor(['(kube)']).test('anything at all'));
  check('a parenthetical inside the name is not a qualifier', !mentionRegexFor(['a (b) c']).test('a is here') && mentionRegexFor(['a (b) c']).test('@a (b) c is here'));
  check('duplicate names collapse', mentionRegexFor(['nova', 'Nova']).source.split('|').length === 1);
  check('the dropped form collapses with an equal id', mentionRegexFor(['artie', 'Artie (kube)']).source.split('|').length === 2);
  check('malformed entries are skipped, not fatal', mentionRegexFor([undefined, 42, 'zed']).test('@zed'));
  check('no usable name yields null', mentionRegexFor([undefined, '']) === null);
}

// ── malformed ids must DEGRADE, never throw ────────────────────────────────
// The id comes from JSON.parse of an operator-edited tokens.json, and
// `id: string` is erased at runtime. A missing or numeric id used to throw
// `id.replace is not a function` inside the same catch-all that swallowed the
// unescaped-regex throw — same deafness, different door.
for (const [label, id] of [['undefined', undefined], ['null', null],
                           ['number', 42], ['empty string', ''],
                           ['object', {}]]) {
  let threw = false, out;
  try { out = mentionRegex(id); } catch { threw = true; }
  check(`${label} id does not throw`, !threw);
  check(`${label} id returns null (degraded, not a bogus regex)`, !threw && out === null);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
