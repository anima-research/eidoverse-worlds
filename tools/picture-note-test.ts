// picture-note-test — the editor block's status line has a lifecycle, and
// this pins it without a browser (happy-dom + the guard-label stubs; the
// owned-browser leg is picture-editor-probe F/G).
//
//   bun tools/picture-note-test.ts
//
// A line is about ONE entity and ONE bag (Mica, #191 round 2):
//   1. it survives a repaint (the round-1 fix; nothing here may undo it);
//   2. it survives a demote/promote — the SAME entity leaving and re-entering
//      residency (`entity` kind 'demote' then 'spawn');
//   3. it does NOT survive a true remove: a later spawn under the same id is
//      another thing and opens with no line;
//   4. a picture echo that disagrees with the bag the line was about retires
//      it (someone else's hand moved the world past it);
//   5. an echo that AGREES keeps it — the hang's own echo, a repeat of it, or
//      the null echo after `take down`.
import { plugin } from 'bun';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = (p: string) => join(dirname(fileURLToPath(import.meta.url)), p);
let pass = 0, fail = 0;
const check = (name: string, ok: unknown, detail = '') => {
  if (ok) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  else { fail++; console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? ` — ${detail}` : ''}`); }
};

plugin({ name: 'picture-note-stubs', setup(b) {
  for (const m of ['core', 'base', 'assets', 'world', 'inspect', 'ui', 'net'])
    b.onResolve({ filter: new RegExp(`^\\./${m}\\.js$`) }, () => ({ path: here('./guard-label-stub.mjs') }));
} });

import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register();

const stub: any = await import('./guard-label-stub.mjs');
const pics: any = await import('../client/lib/pictures.js');
const editor = stub.editors[0];
check('pictures.js registered its editor', typeof editor === 'function');

// a placed, unguarded model with one named part (the block offers itself only there)
const part = { isMesh: true, name: 'screenplane', material: {} };
const model = { userData: {}, traverse(f: (c: unknown) => void) { f(this); f(part); } };
stub.entities.set('console', model);
stub.entityMeta.set('console', { actor: 'ra', kind: 'model', ts: 1 });
stub.comps.set('console', {});
const committed: any[] = [];
const ctx = () => ({ id: 'console', obj: model, meta: stub.entityMeta.get('console'), bag: stub.bagOf('console'), commit: (v: string, a: unknown) => committed.push([v, a]), esc: (t: string) => t });
const host = document.createElement('div'); document.body.appendChild(host);
/** the scene panel's repaint: a fresh block from a fresh render */
const paint = () => { const r = editor(ctx()); host.innerHTML = r.html; r.wire(host); return host.querySelector('[data-pe="msg"]')?.textContent ?? ''; };
const q = (k: string) => host.querySelector(`[data-pe="${k}"]`) as any;
/** the world moving: comps first, then the echo, as world.js does */
const echo = (data: unknown) => { const bag = stub.bagOf('console'); if (data == null) delete bag.picture; else bag.picture = data; stub.bus.emit('comp', { id: 'console', type: 'picture', data }); };
const refuse = () => { q('src').value = 'http://example.com/x.png'; q('hang').click(); return q('msg').textContent; };

console.log('\n1. a line survives a repaint');
paint();
check('an http link is refused in the block', /only https/.test(refuse()));
check('…and the line is still there after a repaint', /only https/.test(paint()));

console.log('\n2. …and a demote/promote (same entity)');
stub.bus.emit('entity', { id: 'console', kind: 'demote' });
stub.bus.emit('entity', { id: 'console', kind: 'spawn' });
check('after demote + promote the line is still there', /only https/.test(paint()));

console.log('\n3. …but not a remove');
stub.bus.emit('entity', { id: 'console', kind: 'remove' });
check('after a remove the next block has no line', paint() === '', JSON.stringify(paint()));

console.log('\n4. a disagreeing echo retires the line');
paint(); refuse();
check('the refusal is back (about: no picture)', /only https/.test(paint()));
echo({ src: 'store/images/0123456789abcdef.png', description: 'someone else hung this' });
check('someone else hangs a picture: the line is gone', paint() === '', JSON.stringify(paint()));

console.log('\n5. an agreeing echo keeps it');
committed.length = 0;
q('src').value = 'store/images/fedcba9876543210.png'; q('description').value = 'mine'; q('hang').click();
check('hang commits one picture and says so', committed.length === 1 && committed[0][0] === 'picture' && /^hung$/.test(q('msg').textContent), JSON.stringify(committed));
const mine = committed[0][1];
echo({ ...mine });
check('the hang\'s own echo keeps "hung" through the repaint', /^hung$/.test(paint()));
const { width: _w, lit: _l, ...bare } = mine;
echo(bare);
check('…a repeat that leaves the defaults unsaid still agrees', /^hung$/.test(paint()));
echo({ ...mine, description: 'changed by another hand' });
check('…an echo that changed the description retires it', paint() === '', JSON.stringify(paint()));
q('down').click();
check('take down says so', /taken down/.test(q('msg').textContent));
echo(null);
check('the null echo agrees: "taken down" survives the repaint', /taken down/.test(paint()));
echo({ src: 'store/images/0123456789abcdef.png' });
check('a later hang by someone else retires "taken down"', paint() === '', JSON.stringify(paint()));

console.log('\n6. update keeps what the block doesn\'t show');
echo({ src: 'store/images/0123456789abcdef.png', width: 4, lit: 'scene', description: 'four metres wide' });
paint(); committed.length = 0;
q('description').value = 'four metres wide, still'; q('hang').click();
const kept = committed.at(-1)?.[1];
check('updating a hung picture keeps its stored width', (kept?.data ?? kept)?.width === 4, JSON.stringify(committed));

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
