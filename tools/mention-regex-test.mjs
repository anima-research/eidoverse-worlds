// The mention pattern is built from a body's id and display name, which
// arrive UNVALIDATED in tokens.json. Before names were escaped, an id with
// regex metacharacters threw inside a catch-all — so the agent silently never
// heard its own name again, for the life of the process, with a single log
// line and no other symptom.
import { mentionRegexFor } from '../mcpl/mention.ts';
let pass = 0, fail = 0;
const check = (n, c) => { c ? (pass++, console.log(`ok   ${n}`)) : (fail++, console.log(`FAIL ${n}`)); };

// 1. Normal ids still match the way they always did.
check('plain name matches @mention', mentionRegexFor(['hesperus']).test('hey @hesperus hi'));
check('plain name matches bare word', mentionRegexFor(['hesperus']).test('hesperus, look'));
check('plain name does not match a substring',
  !mentionRegexFor(['hes']).test('hesperus is here'));

// 2. Metacharacter ids must not throw — this is the regression.
for (const id of ['a(', 'x[', 'b+', 'c.d', 'e|f', 'g*', 'h$', 'i^', 'j\\', 'k?']) {
  let threw = false, matched = false;
  try { matched = mentionRegexFor([id]).test(`hi @${id} there`); } catch { threw = true; }
  check(`id ${JSON.stringify(id)} does not throw`, !threw);
  if (!threw) check(`id ${JSON.stringify(id)} still matches itself`, matched);
}

// 3. Escaping must be LITERAL, not merely non-throwing: `b+` must not match `bbb`.
check('metacharacters are literal, not operators', !mentionRegexFor(['b+']).test('bbb here'));
check('a dot does not match any character', !mentionRegexFor(['c.d']).test('cxd here'));

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
  check('an explicit different qualifier does not match the short alias', !rx.test('@Artie (cloud), over here'));
  check('a bare qualified name also requires the right qualifier', !rx.test('Artie (cloud) is here'));
  check('an equal unqualified id cannot bypass qualifier matching', !mentionRegexFor(['artie', 'Artie (kube)']).test('@Artie (cloud)'));
  check('a later valid mention still matches after another qualified name', rx.test('@Artie (cloud), ask @Artie (kube)'));
  // The short form refuses a parenthetical after it, which can't be told from
  // another resident's qualifier: the trade this body's alias keeps.
  check('the short form with an aside after it stays unheard (the kept trade)', !rx.test('@Artie (quick question) can you look?'));
  check('an unclosed parenthesis is no qualifier: the short form before it is heard', rx.test('@Artie (quick question can you look?'));
  check('a distinct id is heard with an aside after it', rx.test('@artie-kube (quick question) can you look?'));
  check('a prefix of the id is a different body', !rx.test('artie-kubernetes is a different body'));
  check('a prefix of the dropped name is a different body', !rx.test('artiest of them all'));
  check('an id with a trailing qualifier gets the same treatment', mentionRegexFor(['zed (two)']).test('@zed hi'));
  check('a name that is only a qualifier contributes no empty alternative', mentionRegexFor(['(kube)']).source.split('|').length === 1 && !mentionRegexFor(['(kube)']).test('anything at all'));
  check('a parenthetical inside the name is not a qualifier', !mentionRegexFor(['a (b) c']).test('a is here') && mentionRegexFor(['a (b) c']).test('@a (b) c is here'));
  check('duplicate names collapse', mentionRegexFor(['nova', 'Nova']).source.split('|').length === 1);
  // toLowerCase() folds the Kelvin sign into k, but the pattern's i flag
  // doesn't equate them: the first spelling listed, the id, is the one kept.
  check('a name folded into an earlier one keeps the earlier spelling', mentionRegexFor(['k', '\u212A']).test('@k'));
  check('a dropped alias folded into an earlier name keeps the earlier spelling', mentionRegexFor(['k', '\u212A (unit)']).test('@k'));
  check('the dropped form collapses with an equal id', mentionRegexFor(['artie', 'Artie (kube)']).source.split('|').length === 2);
  check('malformed entries are skipped, not fatal', mentionRegexFor([undefined, 42, 'zed']).test('@zed'));
  check('no usable name yields null', mentionRegexFor([undefined, '']) === null);
}

// A name with no qualifier is heard with an aside after it: only the short
// form of a qualified name is held to the parenthetical that follows it.
{
  const rx = mentionRegexFor(['artie', 'Artie']);
  check('a whole name is heard with an aside after it', rx.test('@Artie (quick question) can you look?'));
  check('a bare whole name is heard with an aside after it', rx.test("hey Artie (when you can), the door's stuck"));
  check('a whole qualified name is heard with an aside after it', mentionRegexFor(['artie-kube', 'Artie (kube)']).test('@Artie (kube) (when you can) look'));
  // A plain name can't tell another resident's qualifier from an aside, so it
  // hears both: the trade a plain name keeps, as two bodies answering to one
  // first name are both addressed.
  check("a plain name also hears another resident's qualified address (the plain name's trade)", rx.test('@Artie (kube) can you check the pods?'));
}

// Enrollment reserves a complete name, not every alias it could shorten to.
{
  const rx = mentionRegexFor(['antra-anything', 'Antra (anything)'], { dropQualifiers: false });
  check('self-enrolled name does not acquire another resident\'s short handle', !rx.test('@Antra, over here'));
  check('self-enrolled full display name remains mentionable', rx.test('@Antra (anything), over here'));
  check('self-enrolled id remains mentionable', rx.test('@antra-anything, over here'));
  check('self-enrolled name cannot match a different qualifier', !rx.test('@Antra (elsewhere)'));
  check('self-enrolled policy also applies to qualified ids', !mentionRegexFor(['Antra (anything)'], { dropQualifiers: false }).test('@Antra'));
  // An id that is its own name's short form is held to the parenthetical
  // after it, self-enrolled or not.
  const own = mentionRegexFor(['antra', 'Antra (anything)'], { dropQualifiers: false });
  check('a self-enrolled id equal to its short form is heard alone', own.test('@antra, over here'));
  check('a self-enrolled id equal to its short form refuses an aside', !own.test('@antra (quick question) hi'));
  check('a self-enrolled id equal to its short form refuses a different qualifier', !own.test('@Antra (elsewhere) hi'));
  check('operator-configured names retain short mentions', mentionRegexFor(['antra-anything', 'Antra (anything)']).test('@Antra'));
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
  try { out = mentionRegexFor([id]); } catch { threw = true; }
  check(`${label} id does not throw`, !threw);
  check(`${label} id returns null (degraded, not a bogus regex)`, !threw && out === null);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
