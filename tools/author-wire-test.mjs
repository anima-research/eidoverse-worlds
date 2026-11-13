// The wire contract for "who said this" when a token's display name differs
// from its id: `author.name` carries the display name, the rendered text keeps
// the id as its prefix, and world lines render bare. Today every registry id
// equals its name, so a revert of either half is invisible to the rest of the
// suite; these cases go red on their own.
import { displayNameIndex, wireAuthors } from '../mcpl/token-registry.ts';
let pass = 0, fail = 0;
const check = (n, c) => { c ? (pass++, console.log(`ok   ${n}`)) : (fail++, console.log(`FAIL ${n}`)); };

const registry = {
  'secret-1': { id: 'artie-kube', name: 'Artie (kube)', world: 'commons', avatar: '' },
  'secret-2': { id: 'hesperus', name: 'hesperus', world: 'commons', avatar: '' },
  'secret-3': { id: 'nameless', world: 'commons', avatar: '' },
};
const index = displayNameIndex(registry);
check('index maps an id to its distinct display name', index.get('artie-kube') === 'Artie (kube)');
check('index omits an id whose name equals the id', !index.has('hesperus'));
check('index omits an id with no name', !index.has('nameless'));
check('index is keyed by id, never by the secret', ![...index.keys()].some((k) => k.startsWith('secret-')));

const wire = wireAuthors(index);
const artie = wire.authorOf('artie-kube');
check('author.name is the token display name', artie.name === 'Artie (kube)');
check('author.id is the addressing handle', artie.id === 'artie-kube');
check('an unnamed id falls back to itself', wire.authorOf('hesperus').name === 'hesperus');
check('an id the registry does not know renders as itself', wire.authorOf('stranger').name === 'stranger');

const line = wire.renderLine(artie, 'over here');
check('the rendered prefix is the id, not the display name', line === 'artie-kube: over here');
check('the display name never reaches the rendered text', !line.includes('Artie'));
check('world lines render bare', wire.renderLine({ id: 'world', name: 'commons' }, 'the sun sets') === 'the sun sets');

for (const names of [['First', 'Second'], ['First', 'shared'], ['shared', 'First'], ['First', 'Second', 'First']]) {
  const duplicates = Object.fromEntries(names.map((name, i) => [`key-${i}`, { id: 'shared', name }]));
  check(`conflicting registry names fall back to id (${names.join(', ')})`, wireAuthors(displayNameIndex(duplicates)).authorOf('shared').name === 'shared');
}
check('duplicate credentials with the same name remain unambiguous', displayNameIndex({
  a: { id: 'shared', name: 'Same' }, b: { id: 'shared', name: 'Same' },
}).get('shared') === 'Same');

wire.rememberAuthor({ id: 'visitor-anywhere', name: 'Visitor (anywhere)' });
check('admitted aid1 name is available without a registry entry', wire.authorOf('visitor-anywhere').name === 'Visitor (anywhere)');
wire.rememberAuthor({ id: 'artie-kube', name: 'Artie (admitted)' });
check('the actual admitted credential takes precedence over registry names', wire.authorOf('artie-kube').name === 'Artie (admitted)');
wire.refreshIndex(new Map());
check('failed reload preserves admitted legacy names', wire.authorOf('artie-kube').name === 'Artie (admitted)');
check('failed reload preserves admitted aid1 names', wire.authorOf('visitor-anywhere').name === 'Visitor (anywhere)');
wire.refreshIndex(new Map([['artie-kube', 'Other credential'], ['offline', 'Offline Resident']]));
check('registry reload cannot relabel an admitted identity', wire.authorOf('artie-kube').name === 'Artie (admitted)');
check('registry hints still name residents not yet admitted', wire.authorOf('offline').name === 'Offline Resident');
wire.rememberAuthor({ id: 'artie-kube', name: 'Artie (reconnected)' });
check('a new admission updates the identity used for live and replayed authors', wire.authorOf('artie-kube').name === 'Artie (reconnected)');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
