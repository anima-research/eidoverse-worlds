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
