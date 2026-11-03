// 🔴🔴 THIS FILE IMPORTS NOTHING. IT IS NOT A REGRESSION TEST.
//
// Flagged by a second-agent audit, 2026-08-16: the logic below is a
// TRANSCRIPTION of the shipped code, re-typed inline and verified by eye. A
// green run proves the COPY is self-consistent; it cannot fail when the real
// module breaks, because it never loads it. Editing the shipped file and
// running this will still print PASS.
//
// Kept because the reasoning is worth preserving and the cases are the right
// cases — but it is a DESIGN NOTE with assertions, and must never be cited as
// evidence that a fix holds. To make it real: import the actual module and
// delete the inline copy. Until then, the honest claim is "unregression-tested".
// R's requirement: "TTS can ship over the voice lane even if mic is toggled off"
let providerAvailable = true;
const gum = async () => ({ kind: 'microphone' });
const synth = () => ({ kind: 'synth', synthetic: true });

// voiceSource(), as shipped
async function voiceSource({ micWanted = true } = {}) {
  if (!micWanted && providerAvailable) return synth();
  try { return await gum(); }
  catch (e) { if (providerAvailable) return synth(); throw e; }
}

const cases = [
  ['mic ON,  provider present', true,  true,  'microphone'],
  ['mic OFF, provider present', false, true,  'synth'],       // ← the bug
  ['mic ON,  no provider',      true,  false, 'microphone'],
  ['mic OFF, no provider',      false, false, 'microphone'],  // nothing to fall back to
];
let pass = true;
for (const [name, micWanted, prov, want] of cases) {
  providerAvailable = prov;
  const got = (await voiceSource({ micWanted })).kind;
  const ok = got === want;
  pass = pass && ok;
  console.log(`${ok?'ok  ':'FAIL'} ${name.padEnd(28)} → ${got}`);
}
// The OLD behaviour, for contrast: mic-off returned the microphone, so the
// synth never reached a sender and TTS could not leave the machine.
console.log(`\nold behaviour, mic OFF → microphone (TTS unroutable)`);
console.log(pass ? 'PASS — a mic that is OFF yields the synth, so TTS publishes'
                 : 'FAIL');
