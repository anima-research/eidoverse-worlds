// chat-mention-test — a name in chat ends where the door's does (#232): `cairn` is not inside `cairn-bridge`, whatever the
// roster order, and a person's highlight agrees with an agent's ping.
//   bun tools/chat-mention-test.mjs          the rows, against client/lib/mention-rx.js
//   bun tools/chat-mention-test.mjs --base   the control: the same rows against a2644dc1's patterns; passes only if exactly
//                                            the rows predicted below fail there
import { mentionRx, mentionPattern } from '../client/lib/mention-rx.js';
import { mentionRegexFor } from '../mcpl/mention.ts';

const BASE = process.argv.includes('--base');
// a2644dc1's client/lib/chat.js mentionRx (:58) and renderBody pattern (:86), verbatim
const escapeRx = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const baseRx = (name) => new RegExp(`(@${escapeRx(name)}\\b|\\b${escapeRx(name)}\\b)`, 'i');
const basePattern = (names) => new RegExp(`(https?://[^\\s]+)|(@?\\b(?:${names.map(escapeRx).join('|') || '\\u0000'})\\b)`, 'gi');
const rx = BASE ? baseRx : mentionRx;
const pattern = BASE ? basePattern : mentionPattern;

const failed = [];
let pass = 0;
const check = (id, ok, note = '') => {
  if (ok) { pass++; console.log(`ok   ${id}`); } else { failed.push(id); console.log(`FAIL ${id}${note ? `  -- ${note}` : ''}`); }
};
const chips = (text, names) => [...text.matchAll(pattern(names))].filter((m) => m[2]).map((m) => m[2]);
const links = (text, names) => [...text.matchAll(pattern(names))].filter((m) => m[1]).length;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const line = (x) => `Take one more step with it, ${x}, please`;

// [id, roster, text, the chips expected, is `cairn` pinged]: expectations computed by hand from the issue's table
const ROWS = [
  ['R1', ['helen', 'cairn', 'cairn-bridge'], line('cairn-bridge'), ['cairn-bridge'], false],
  ['R2', ['helen', 'cairn-bridge', 'cairn'], line('cairn-bridge'), ['cairn-bridge'], false],
  ['R3', ['helen', 'cairn', 'bridge-cairn'], line('bridge-cairn'), ['bridge-cairn'], false],
  ['R4', ['helen', 'cairn', 'cairnbridge'], line('cairnbridge'), ['cairnbridge'], false],
  ['R5', ['helen', 'cairn', 'cairn2'], line('cairn2'), ['cairn2'], false],
  ['R6', ['helen', 'cairn', 'cairn-bridge'], '@cairn-bridge and @cairn', ['@cairn-bridge', '@cairn'], true],
  ['R7a', ['helen', 'cairn', 'cairn-bridge'], 'a word (cairn-bridge) aside', ['cairn-bridge'], false],
  ['R7b', ['helen', 'cairn', 'cairn-bridge'], 'that one goes to cairn-bridge.', ['cairn-bridge'], false],
  ['R8', ['helen', 'cairn', 'mythos'], 'cairn, mythos: hi', ['cairn', 'mythos'], true],
  ['R10', ['helen', 'cairn', 'cairn-0042'], line('cairn-0042'), ['cairn-0042'], false],
];
for (const [id, roster, text, want, pinged] of ROWS) {
  const got = chips(text, roster);
  check(`${id} chips`, same(got, want), `got ${JSON.stringify(got)}`);
  check(`${id} ping`, rx('cairn').test(text) === pinged, `cairn pinged: ${!pinged}`);
}
// R9: a link that contains a name is only a link
{
  const text = 'see https://eidoverse.animalabs.ai/?who=cairn now';
  check('R9 link only', links(text, ['helen', 'cairn']) === 1 && chips(text, ['helen', 'cairn']).length === 0);
}

// Parity: for a plain name, the client and the door hear the same lines
const TEXTS = [...ROWS.map((r) => r[2]), 'see https://eidoverse.animalabs.ai/?who=cairn now'];
const NAMES = [...new Set(ROWS.flatMap((r) => r[1]))];
for (const name of NAMES) {
  const door = mentionRegexFor([name]);
  const differ = TEXTS.filter((t) => rx(name).test(t) !== door.test(t));
  check(`P ${name}`, differ.length === 0, `differs on ${JSON.stringify(differ)}`);
}

console.log(`\n${pass} passed, ${failed.length} failed`);
if (!BASE) process.exit(failed.length ? 1 : 0);
// The control: the base fails exactly these, predicted by hand before this ran
const PREDICTED = ['R1 chips', 'R1 ping', 'R2 ping', 'R3 ping', 'R6 chips', 'R7a chips', 'R7a ping', 'R7b chips', 'R7b ping', 'R10 chips', 'R10 ping', 'P cairn'];
const ok = same([...failed].sort(), [...PREDICTED].sort());
console.log(ok ? 'control: the base fails exactly the predicted rows' : `control MISMATCH: predicted ${JSON.stringify(PREDICTED)}, got ${JSON.stringify(failed)}`);
process.exit(ok ? 0 : 1);
