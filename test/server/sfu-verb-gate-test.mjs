// Every sfu-* verb must refuse a spectator / non-"world" surface.
//
// 🔴 This test exists because an independent reviewer found four verbs
// (sfu-answer, sfu-ice, sfu-pos, sfu-want-negotiate) that checked only
// `!c.world`, while every sibling verb — including relay-cred, which mints the
// credential these verbs then USE — also gates on spectator/surface. A
// spectator keeps the primary's c.id (server.ts:509 sets the flag, it does not
// rename), so any such socket reached a real participant's leg.
//
// sfu-pos was the sharp one: forging a distant position for another id removes
// that person from every listener's proximity gate — a remote mute for any
// connected client. 57 green tests could not see it, because the gap was in
// the verb dispatch, not in the SFU.
//
// Source-level assertion (the dispatch is inside a 1000-line switch with a live
// websocket and a world; booting all that to test a guard would test the boot).
// It reads the shipped file — it cannot pass against a copy.
import { readFileSync } from 'fs';
import { suite } from '../gate/suite.ts';
const src = readFileSync(new URL('../../server/server.ts', import.meta.url), 'utf8');

const GATE = /c\.spectator \|\| \(c\.surface \?\? "world"\) !== "world"/;
const VERBS = ['sfu-answer', 'sfu-ice', 'sfu-pos', 'sfu-want-negotiate', 'relay-cred'];

const S = suite('sfu-verb-gate');
for (const verb of VERBS) {
  const i = src.indexOf(`case "${verb}":`);
  if (i < 0) { S.check(`${verb} gates on spectator/surface`, false, 'case not found'); continue; }
  // the verb's body: up to its `return;\n        }` terminator
  const end = src.indexOf('\n        }', i);
  if (end < 0) { S.check(`${verb} gates on spectator/surface`, false, "its body's terminator not found (a re-indent would read to the end of the file)"); continue; }
  const body = src.slice(i, end);
  S.check(`${verb} gates on spectator/surface`, GATE.test(body));
}

// Negative control: prove the matcher can actually fail.
const control = 'case "sfu-pos": { if (!c.world) return; }';
const controlCaught = !GATE.test(control);
S.check('negative control — an ungated verb is detected', controlCaught);
S.done();
