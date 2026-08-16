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
