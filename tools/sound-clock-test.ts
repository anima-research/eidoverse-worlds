// sound-clock-test — the shared playhead runs on the SERVER clock, not the
// machine's, and the editor leaves `t0` to the authority, which stamps it on
// its own clock.
//
//   bun tools/sound-clock-test.ts
//
// #192's clock note says every client seeks to the same playhead from `t0`.
// It did — against Date.now(), while motion (Hesperus finding #4, #192's own
// tickMotion) runs on the estimated server clock (client/lib/serverclock.js). Two listeners
// whose clocks disagree by Δ heard the same radio Δ apart, and an author whose
// clock was off shifted everyone by their own skew (I.M., instruments findings,
// 2026-09-23). This loads the real sounds.js under stubs, skews Date.now()
// from the server clock by a known amount, and checks that the seek reads the
// server clock (mutating it back to Date.now() turns that case red), and that
// the editor's play sends no `t0` of its own: the authority stamps it when the
// sound starts playing (shared/sound.js THE CLOCK), so no machine's clock is
// ever the playhead's origin. (tools/protocol/soundclock-check.ts holds the
// playhead arithmetic itself.)
import { plugin } from 'bun';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const here = (p: string) => join(dirname(fileURLToPath(import.meta.url)), p);
let pass = 0, fail = 0;
const check = (name: string, ok: unknown, detail = '') => {
  if (ok) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  else { fail++; console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? ` — ${detail}` : ''}`); }
};
plugin({ name: 'sound-clock-stubs', setup(b) {
  for (const m of ['core', 'base', 'world', 'net'])
    b.onResolve({ filter: new RegExp(`^\\./${m}\\.js$`) }, () => ({ path: here('./guard-label-stub.mjs') }));
  for (const m of ['inspect', 'ui', 'audioctx', 'audiounlock', 'voiceconsent', 'serverclock'])
    b.onResolve({ filter: new RegExp(`^\\./${m}\\.js$`) }, () => ({ path: here('./sound-clock-stub.mjs') }));
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

const stub: any = await import('./guard-label-stub.mjs');
const seams: any = await import('./sound-clock-stub.mjs');
const sounds: any = await import('../client/lib/sounds.js');

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
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
