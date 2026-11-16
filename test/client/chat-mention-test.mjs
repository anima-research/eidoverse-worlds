// chat-mention-test — a name in chat ends where the door's does (#232): `cairn` is not inside `cairn-bridge`, whatever the
// roster order, and a person's highlight agrees with an agent's ping.
//   bun test/client/chat-mention-test.mjs          the rows, against client/lib/ui/mention-rx.js
import { mentionRx, mentionPattern } from '../../client/lib/ui/mention-rx.js';
import { mentionRegexFor } from '../../mcpl/mention.ts';

const rx = mentionRx, pattern = mentionPattern;

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
  ['R11', ['helen', 'cairn'], 'xcairn and @@cairn', [], false],
  ['R12', ['helen', 'Ann', 'Ann Lee'], '@Ann Lee, hi', ['@Ann Lee'], false],
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
// R13/R14: links:false matches no link, not even a NUL; an empty roster chips nothing
{
  const groups = (text, names, o) => [...text.matchAll(mentionPattern(names, o))].map((m) => [m[1] ?? null, m[2] ?? null]);
  check('R13 links:false: a URL or a NUL is no link', !groups('see https://x.example/ and a\u0000b', ['helen'], { links: false }).some(([l]) => l != null));
  check('R14 an empty roster chips nothing, a NUL included', groups('a \u0000 b', []).length === 0);
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
process.exit(failed.length ? 1 : 0);
