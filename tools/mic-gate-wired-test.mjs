// Does each transport GATE the mic before publishing it?
//
// 🔴 The SFU did not, from its first day until 2026-08-16: it published the raw
// device stream while the mesh gated at voice.js:615. The sensitivity slider
// drove nothing on the transport we actually ship. R: "It *should* be working?"
// It should have been.
//
// Source-level (the graph needs a live AudioContext and a device), but it
// follows the indirection: a transport may gate directly via gateStream() or
// through micstate.gateFor(). An earlier version of this check counted only
// gateStream and reported the FIXED code as still broken — a checker that
// cannot see the fix would not have seen the bug either.
import { readFileSync } from 'fs';
const R = (p) => readFileSync(new URL(`../client/lib/${p}`, import.meta.url), 'utf8');

const GATE = /\b(gateStream|gateFor)\s*\(/;
const cases = [
  ['sfu   publish path', R('voicesfu.js'), /const s = gateFor\(raw\)/],
  ['micstate gates',     R('micstate.js'), /gateStream\(rawStream, micAnalyserLevel\)/],
];

let pass = 0, fail = 0;
for (const [name, src, specific] of cases) {
  const ok = GATE.test(src) && specific.test(src);
  ok ? pass++ : fail++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}`);
}

// The synthetic bypass must survive: a generator track has no room noise and
// the gate graph cannot run on a headless stalled clock.
const ms = R('micstate.js');
const bypass = /rawStream\.synthetic/.test(ms);
bypass ? pass++ : fail++;
console.log(`${bypass ? 'ok  ' : 'FAIL'} synthetic sources bypass the gate`);

// Never publish ungated without explicit consent.
const refuses = /gateIsUnavailable\(\) && !ungatedAllowed\(\)/.test(R('voicesfu.js'));
refuses ? pass++ : fail++;
console.log(`${refuses ? 'ok  ' : 'FAIL'} refuses to publish ungated without opt-in`);

// Negative control — the pre-fix code must be detected as broken.
const old = 'const s = await voiceSource({ micWanted: wantMic }); micStream = s;';
const caught = !GATE.test(old);
caught ? pass++ : fail++;
console.log(`${caught ? 'ok  ' : 'FAIL'} negative control — ungated publish is detected`);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
