// sound-editor-test — client/lib/realize/sounds.js under the house stubs: the shared playhead runs on the SERVER clock, not the
// machine's; the editor leaves `t0` to the authority, which stamps it on its own clock; and the editor reads no guard.
//
//   bun test/client/sound-editor-test.ts
//
// The seek reads the server clock: Date.now() is skewed from it by a known amount, and a seek on Date.now() goes red.
// Play sends no `t0`: the authority stamps it (shared/sound.js THE CLOCK). test/protocol/soundclock-check.ts holds
// the playhead arithmetic.
import { plugin } from 'bun';
import { stubResolve } from '../harness/stub.ts';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const here = (p: string) => join(dirname(fileURLToPath(import.meta.url)), p);
let pass = 0, fail = 0;
const check = (name: string, ok: unknown, detail = '') => {
  if (ok) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  else { fail++; console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? ` — ${detail}` : ''}`); }
};
plugin({ name: 'sound-editor-stubs', setup(b) {
  for (const m of ['core', 'base', 'world'])
    stubResolve(b, new RegExp(`^(\\.\\.?/)+${m}\\.js$`), () => ({ path: here('../stubs/guard-label-stub.mjs') }));
  for (const m of ['edit/inspect', 'ui', '(audio/)?audioctx', '(audio/)?audiounlock', '(audio/)?voiceconsent', 'serverclock'])
    stubResolve(b, new RegExp(`^(\\.\\.?/)+${m}\\.js$`), () => ({ path: here('../stubs/sound-clock-stub.mjs') }));
} });
import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register();

// A media element whose duration is known up front, so seekTo applies at once.
class FakeAudio {
  src: string; duration = 60; currentTime = 0; loop = false; paused = true; crossOrigin = ''; preload = '';
  constructor(src: string) { this.src = src; }
  play() { this.paused = false; return Promise.resolve(); }
  pause() { this.paused = true; }
  load() {}
  removeAttribute() {}
  addEventListener() {}
}
(globalThis as any).Audio = FakeAudio;

const stub: any = await import('../stubs/guard-label-stub.mjs');
const seams: any = await import('../stubs/sound-clock-stub.mjs');
const sounds: any = await import('../../client/lib/realize/sounds.js');

// The machine's clock is 5 s AHEAD of the server's. A listener seeking on
// Date.now() lands 5 s late; on serverNow() it lands where everyone else is.
const SKEW_MS = 5_000;
const T0 = 1_760_000_000_000;                        // the author's stamp, server time
seams.clock.server = T0 + 12_000;                    // 12 s into the loop, by the server
const realNow = Date.now;
Date.now = () => seams.clock.server + SKEW_MS;

console.log('\n— the seek reads the server clock —\n');
stub.bus.emit('comp', { id: 'radio1', type: 'sound', data: { src: 'store/audio/0123456789abcdef.mp3', playing: true, loop: true, t0: T0 } });
const h = sounds._playing.get('radio1');
check('a playing sound built its graph', !!h);
check('seeks to (serverNow − t0) mod duration = 12 s, not the skewed 17 s',
  h && Math.abs(h.el.currentTime - 12) < 1e-9, h ? `currentTime=${h.el.currentTime}` : 'no handle');

console.log('\n— the editor leaves t0 to the authority —\n');
const editor = seams.editors[0];
check('sounds.js registered its editor', typeof editor === 'function');
stub.entities.set('radio1', { userData: {} });
stub.entityMeta.set('radio1', { actor: 'ra', kind: 'model', ts: 1, placer: { id: 'ra', sub: 'human:discord:9001' } });
stub.net.myId = 'ra'; stub.net.mySub = 'human:discord:9001'; stub.net.myRights = { role: 'owner' };
const committed: any[] = [];
const block = editor({ id: 'radio1', obj: { userData: {} }, meta: stub.entityMeta.get('radio1'), bag: {}, commit: (component: string, value: any) => committed.push({ component, value }), esc: (t: string) => t });
check('the editor offered the form', !!block?.html && typeof block.wire === 'function');
document.body.innerHTML = block.html;
block.wire(document.body);
const src = document.querySelector('[data-se="src"]') as HTMLInputElement;
src.value = 'store/audio/0123456789abcdef.mp3';
(document.querySelector('[data-se="play"]') as HTMLElement).click();
const play = committed.find((c) => c.component === 'sound');
check('play committed a playing sound', !!play && play.value?.playing === true, JSON.stringify(committed));
check('…with no t0 of its own: neither the machine\'s clock nor its estimate of the server\'s is the playhead\'s origin',
  play && !('t0' in (play.value ?? {})), play ? `t0=${play.value?.t0} server=${seams.clock.server} machine=${Date.now()}` : '');

Date.now = realNow;

console.log('\n— the editor reads no guard —\n');
// the #190 fixture shape: bobbie placed and guarded the radio, the owner later changed its volume
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

// R 10-28 (item 18): 32 world sounds heard at once (was 8), and the editor's radius goes to the 200 m cap
{ const S: any = await import('../../client/lib/realize/sounds.js'); const { SOUND_MAX_RADIUS } = await import('../../shared/sound.js');
  check('VOICES: 32 world sounds are heard at once', S.VOICES === 32, String(S.VOICES));
  check('the editor\'s radius field goes to SOUND_MAX_RADIUS (200 m)', new RegExp(`data-se="radius"[^>]*max="${SOUND_MAX_RADIUS}"`).test(render()) && SOUND_MAX_RADIUS === 200, render().match(/data-se="radius"[^>]*/)?.[0]); }

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
