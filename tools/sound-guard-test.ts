// sound-guard-test — the sound editor block reads a guard the way the rest of
// the house does: authority and label are the immutable creation-time PLACER
// (meta.placer, by subject), never `meta.actor`, which an owner's later
// partial update moves while the placer stays (#190 round 2; the sound block
// had reintroduced the actor shortcut — Mica, #192 review, blocker 2).
//
//   bun tools/sound-guard-test.ts
//
// The fixture is the #190 shape: bobbie placed and guarded the radio, the
// owner (ra) later changed its volume, so meta.actor is 'ra' and meta.placer
// is bobbie. The stranger gets a read-only line naming bobbie; the placer and
// the owner get the form; nothing anywhere says the owner guards it; an
// impostor wearing bobbie's display id under another subject is refused; and
// bobbie under a new display id keeps the form. Mutating the block back to
// `meta.actor` turns the placer's own case red.
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
  for (const m of ['inspect', 'ui', 'audioctx', 'audiounlock', 'voiceconsent'])
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
const render = () => editor({ id: 'radio1', obj: radio, meta: stub.entityMeta.get('radio1'), bag: stub.comps.get('radio1'), commit() {}, esc: (t: string) => t })?.html ?? '';

const VIEWERS = [
  { who: 'the stranger', id: 'carol', sub: SUB_CAROL, role: 'builder', may: false },
  { who: 'the placer', id: 'bobbie', sub: SUB_BOB, role: 'builder', may: true },
  { who: 'the owner', id: 'ra', sub: SUB_RA, role: 'owner', may: true },
];
for (const v of VIEWERS) {
  as(v.id, v.sub, v.role);
  const html = render();
  if (!v.may) {
    check(`${v.who}: the block says guarded by bobbie, and offers no form`, /🔊 sound — guarded by bobbie/.test(html) && !/data-se-root/.test(html), html.slice(0, 300));
    check(`${v.who}: …and still says what is playing`, /playing: rain on the awning/.test(html), html.slice(0, 300));
  } else {
    check(`${v.who}: the form is offered (authorized by ${v.role === 'owner' ? 'role' : 'subject'})`, /data-se-root/.test(html) && !/guarded by/.test(html), html.slice(0, 300));
  }
  check(`${v.who}: nothing says the owner guards it`, !/guarded by ra\b/.test(html), html.slice(0, 300));
}
// the deed follows the SUBJECT
as('bobbie', SUB_CAROL, 'builder');
let html = render();
check('an impostor under the placer\'s display id is refused by subject', /guarded by bobbie/.test(html) && !/data-se-root/.test(html), html.slice(0, 300));
as('bobbie-renamed', SUB_BOB, 'builder');
html = render();
check('the placer under a new display id keeps the form', /data-se-root/.test(html), html.slice(0, 300));
// no guard at all: everyone gets the form
stub.comps.set('radio1', { sound: stub.comps.get('radio1').sound });
as('carol', SUB_CAROL, 'builder');
check('unguarded: the stranger gets the form too', /data-se-root/.test(render()));

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
