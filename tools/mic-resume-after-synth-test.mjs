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
// Turning the mic back ON after a synth swap must ACQUIRE a device, not
// re-enable the synthesizer's track.
let micStream = null, acquired = 0;
const acquire = (kind) => { acquired++; return { synthetic: kind === 'synth',
  tracks: [{ enabled: true, stop(){} }], getTracks(){ return this.tracks; } }; };

function micOn() {
  if (micStream && !micStream.synthetic) { micStream.getTracks().forEach(t=>t.enabled=true); return 'reused mic'; }
  if (micStream?.synthetic) { micStream = null; }
  micStream = acquire('mic');
  return 'acquired mic';
}
function micOff({ providerAvailable }) {
  if (providerAvailable) { micStream = acquire('synth'); return 'swapped to synth'; }
  micStream?.getTracks().forEach(t=>t.enabled=false); return 'muted';
}

console.log('1. mic on        →', micOn(), `(acquires=${acquired})`);
console.log('2. mic off (tts) →', micOff({providerAvailable:true}), `synthetic=${micStream.synthetic}`);
const before = acquired;
console.log('3. mic on again  →', micOn(), `(acquires=${acquired})`);
const ok = acquired === before + 1 && micStream.synthetic === false;
console.log(ok ? 'PASS — a real device is re-acquired after a synth swap'
                : 'FAIL — the synth track was re-enabled as if it were the mic');
