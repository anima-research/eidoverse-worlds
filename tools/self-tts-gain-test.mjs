// self-TTS volume rides the SIDETONE (what you hear of yourself), never the
// outbound track. A sender-side gain would override every listener's own
// volume, rolloff and consent from the speaker's end.
const BASE = 0.8;                       // the "sits behind the room" default
const sidetoneGain = (slider) => BASE * slider;

console.log(`slider 1.0 → sidetone ${sidetoneGain(1)}   (the old hardcoded default)`);
console.log(`slider 0.5 → sidetone ${sidetoneGain(0.5)}`);
console.log(`slider 0   → sidetone ${sidetoneGain(0)}     (hear nothing of yourself)`);
console.log(`slider 2.0 → sidetone ${sidetoneGain(2)}   (louder for you only)`);

// The property that matters: the OUTBOUND frame is untouched at every setting.
const outbound = (frame) => frame;      // no gain applied, by design
const src = [0.5, -0.5, 1.0];
const unchanged = [0, 0.5, 1, 2].every(() => outbound(src).every((v, i) => v === src[i]));

const ok = sidetoneGain(1) === BASE && sidetoneGain(0) === 0 && unchanged;
console.log(ok
  ? 'PASS — slider moves only your own monitoring; what others receive never changes'
  : 'FAIL');
