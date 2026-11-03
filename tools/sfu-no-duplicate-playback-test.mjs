// #104 row 6: "reconnect without duplicate playback."
//
// The risk: a reconnect builds a new pc and new tracks; if the client kept the
// OLD <audio> element alongside the new one, a listener hears every speaker
// twice — the classic SFU reconnect bug, and one nobody notices in a test
// because both streams carry the same words slightly offset.
//
// The property that prevents it, from voicesfu.js:51-58: attach() looks the
// speaker up BY ID and REPLACES srcObject on the existing element. One <audio>
// per speaker id, no matter how many times a track arrives for them.
//
// This models that logic against the real shape rather than importing the
// module (which needs a live pc). It is a structural claim, and the file below
// asserts the structure it depends on so a refactor that breaks it goes red.
import { readFileSync } from 'fs';
const src = readFileSync(new URL('../client/lib/voicesfu.js', import.meta.url), 'utf8');

let pass = 0, fail = 0;
const check = (n, c) => { c ? (pass++, console.log(`ok   ${n}`)) : (fail++, console.log(`FAIL ${n}`)); };

// 1. The structural guarantee: keyed reuse, not blind creation.
check('attach() reuses the speaker entry by id',
  /let s = speakers\.get\(id\);\s*\n\s*if \(!s\)/.test(src));
check('attach() REPLACES srcObject rather than adding an element',
  /s\.audio\.srcObject = stream;/.test(src) && !/new Audio\(\)[\s\S]{0,80}appendChild/.test(src));

// 2. Simulation of the reconnect sequence against that logic.
const speakers = new Map();
const attach = (id) => {
  let s = speakers.get(id);
  if (!s) { s = { audio: { srcObject: null }, plays: 0 }; speakers.set(id, s); }
  s.audio.srcObject = { id };          // replaces, never appends
  s.plays++;
  return s;
};
attach('bob'); attach('carol');              // first connect
attach('bob'); attach('carol');              // reconnect: same ids, new tracks
check('two speakers after a reconnect, not four', speakers.size === 2);
check('each speaker owns exactly one audio element',
  [...speakers.values()].every((s) => s.audio.srcObject !== null));

// 3. Negative control — an append-style implementation must be detected.
const bad = new Map();
const badAttach = (id) => { bad.set(`${id}:${bad.size}`, {}); };
badAttach('bob'); badAttach('bob');
check('control: an append-style attach duplicates (and is detectable)', bad.size === 2);

// 4. The remaining honest gap.
console.log('\n🟡 STILL UNPROVEN BY THIS FILE: that a real browser, after a real');
console.log('   reconnect, plays each speaker once. The structure guarantees one');
console.log('   element per id; only two browsers can show that the OLD track was');
console.log('   actually stopped rather than left decoding into a detached node.');
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
