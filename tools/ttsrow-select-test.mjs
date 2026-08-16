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
// Selecting a radio must NOT load while TTS is off; it MUST load when on.
let loads = 0, selected = null, stored = null;
const pick = (id) => { loads++; selected = id; return true; };
let ttsEnabled = false;
const localStorage = { setItem: (_, v) => { stored = v; }, getItem: () => stored };
const build = () => {};

const select = (id) => {
  if (id === '__pending') return pick(id);
  if (ttsEnabled) return pick(id);
  selected = id;
  try { localStorage.setItem('eido.tts.lastVoice', id); } catch {}
  build();
};

// 1. TTS OFF: marking must not load
select('voice-a');
console.log(`off  → loads=${loads} selected=${selected} remembered=${stored}`);
const a = loads === 0 && selected === 'voice-a' && stored === 'voice-a';

// 2. TTS ON: switching voices must load immediately
ttsEnabled = true;
select('voice-b');
console.log(`on   → loads=${loads} selected=${selected}`);
const b = loads === 1 && selected === 'voice-b';

// 3. __pending resumes regardless
ttsEnabled = false;
select('__pending');
console.log(`pend → loads=${loads}`);
const c = loads === 2;

console.log(a && b && c
  ? 'PASS — marking is free, live switching still loads, pending still resumes'
  : `FAIL a=${a} b=${b} c=${c}`);
