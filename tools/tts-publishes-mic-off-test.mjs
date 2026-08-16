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
