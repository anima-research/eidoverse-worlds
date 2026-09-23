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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
