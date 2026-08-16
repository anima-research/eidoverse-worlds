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
