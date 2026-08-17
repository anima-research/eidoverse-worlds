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

// ── the tick-enable flow, pinned after THREE rounds of reload-and-see ──────
// (source-level; the closure is unreachable from outside. Each has a negative
// control inline: the regex must fail on the pre-fix shape.)
{
  const { readFileSync } = await import('fs');
  const src = readFileSync(new URL('../client/lib/ttsrow.js', import.meta.url), 'utf8');
  const t = (n, c) => { console.log(`${c ? 'ok  ' : 'FAIL'} ${n}`); if (!c) process.exit(1); }
  // 1. the tick handler enables AFTER its own successful pick — pickInner
  //    cannot (wantedSpeech is captured after this path clears _needVoice).
  const tick = src.slice(src.indexOf('await pick(pickId)'), src.indexOf('await pick(pickId)') + 2600);
  t('tick path enables after a successful load', /setTtsEnabled\(true\)/.test(tick));
  // 2. _tickPending is cleared in a finally — the leak that stuck the box faded.
  t('_tickPending cleared on EVERY exit (finally)', /finally \{[^}]*_tickPending = false/.test(tick));
  // 3. both head-sync writers agree on checked (two copies of one truth). One
  //    assigns the expression inline, the other through a wantChecked local —
  //    so collect every assignment RHS, resolving one level of indirection.
  const rhs = [...src.matchAll(/box\.checked = ([^;\n]+);/g)].map((m) => m[1].trim());
  const defs = Object.fromEntries([...src.matchAll(/const (\w+) = ([^;\n]+);/g)].map((m) => [m[1], m[2]]));
  const resolved = rhs.map((r) => defs[r] ?? r);
  t(`both checked-writers consult loading state (${rhs.length} writers)`,
    rhs.length >= 2 && resolved.every((w) => /_loadingId|_tickPending|loadingNow/.test(w)));
}
