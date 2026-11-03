// A shared gain node means a slider move reaches audio ALREADY scheduled.
let slider = 1;
const node = { gain: { value: null } };
const apply = () => { node.gain.value = 0.8 * slider; };

// chunk 1 scheduled at slider 1.0
apply(); const atSchedule = node.gain.value;
// user drags to 0.25 while chunk 1 is still queued
slider = 0.25; apply();
console.log(`scheduled at ${atSchedule}, now ${node.gain.value}`);
const shared = node.gain.value === 0.2;

// OLD behaviour: a per-chunk node captured 0.8 and never changed
const perChunk = 0.8 * 1;
console.log(`per-chunk node would still be ${perChunk} (one utterance late)`);

console.log(shared && node.gain.value !== perChunk
  ? 'PASS — the live node follows the slider; the per-chunk one could not'
  : 'FAIL');
