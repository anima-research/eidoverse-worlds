// sound-guard-test — the sound editor block and a stored `guard`. It once read the
// guard by the creation-time PLACER (#190 round 2; Mica, #192 review, blocker 2);
// the guard is gone now (one lock, decided at the door), so these rows pin that
// the editor reads no guard at all: every viewer gets the form, and no line says
// anyone guards it.
//
//   bun tools/sound-guard-test.ts
//
// The fixture is still the #190 shape (bobbie placed and guarded the radio, the
// owner later changed its volume): the stranger, the placer, the owner and
// someone wearing bobbie's display id all get the same form.
import { plugin } from 'bun';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = (p: string) => join(dirname(fileURLToPath(import.meta.url)), p);
let pass = 0, fail = 0;
const check = (name: string, ok: unknown, detail = '') => {
  if (ok) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  else { fail++; console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? ` — ${detail}` : ''}`); }
};

plugin({ name: 'sound-guard-stubs', setup(b) {
  // the house stubs for the world/net/inspect/ui seams (placer.js reads them
  // exactly as the real panels do), and a three-line stub for the audio ones
  for (const m of ['core', 'base', 'world', 'net'])
    b.onResolve({ filter: new RegExp(`^\\./${m}\\.js$`) }, () => ({ path: here('./guard-label-stub.mjs') }));
  for (const m of ['inspect', 'ui', 'audioctx', 'audiounlock', 'voiceconsent', 'serverclock'])
    b.onResolve({ filter: new RegExp(`^\\./${m}\\.js$`) }, () => ({ path: here('./sound-guard-stub.mjs') }));
} });

import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register();

const stub: any = await import('./guard-label-stub.mjs');   // world / net / meta, read by placer.js as the real panels do
const seams: any = await import('./sound-guard-stub.mjs');  // the editor registry
await import('../client/lib/sounds.js');
const editor = seams.editors[0];
check('sounds.js registered its editor', typeof editor === 'function');

const SUB_BOB = 'human:discord:9002', SUB_CAROL = 'human:discord:9003', SUB_RA = 'human:discord:9001';
const PLACER = { id: 'bobbie', sub: SUB_BOB };
const radio = { userData: {} };
stub.entities.set('radio1', radio);
stub.entityMeta.set('radio1', { actor: 'ra', kind: 'model', ts: 1, placer: { ...PLACER } });   // the owner's partial update moved actor; the placer stays
stub.comps.set('radio1', { guard: true, sound: { src: 'store/audio/0123456789abcdef.mp3', look: 'rain on the awning', playing: true, volume: 0.6, radius: 12, loop: true } });
const as = (id: string, sub: string, role: string) => { const n = stub.net; n.myId = id; n.mySub = sub; n.myRights = { role }; };
const render = () => editor({ id: 'radio1', obj: radio, meta: stub.entityMeta.get('radio1'), bag: stub.bagOf('radio1'), commit() {}, esc: (t: string) => t })?.html ?? '';

// The guard is gone (one lock for everything, the authority decides at the door; the house's §5): the editor no longer
// reads a placer or a role, so a block that still carries a stored `guard` offers the same form to everyone, and nothing
// claims anyone guards it (#260 house I399: these rows expected 'guarded by bobbie', which no client code emits).
const VIEWERS = [
  { who: 'the stranger', id: 'carol', sub: SUB_CAROL, role: 'builder' },
  { who: 'the placer', id: 'bobbie', sub: SUB_BOB, role: 'builder' },
  { who: 'the owner', id: 'ra', sub: SUB_RA, role: 'owner' },
  { who: 'someone under the placer\'s display id', id: 'bobbie', sub: SUB_CAROL, role: 'builder' },
];
for (const v of VIEWERS) {
  as(v.id, v.sub, v.role);
  const html = render();
  check(`${v.who}: the form is offered (a stored guard decides nothing in the editor)`, /data-se-root/.test(html), html.slice(0, 300));
  check(`${v.who}: …and nothing says anyone guards it`, !/guarded by/.test(html), html.slice(0, 300));
}
// and without the stored guard, the same
stub.comps.set('radio1', { sound: stub.bagOf('radio1').sound });
as('carol', SUB_CAROL, 'builder');
check('no stored guard: the stranger gets the form too', /data-se-root/.test(render()));

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
