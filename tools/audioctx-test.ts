/** audioctx: one AudioContext for the page, proven rather than asserted.
 *
 *  Mica's review of #86 asked for a focused executable receipt for the
 *  foundational module — with a fake AudioContext constructor, prove that
 *  repeated calls yield exactly one instance. That is the whole contract, and
 *  it is the kind of claim that is easy to state and easy to quietly break: a
 *  later refactor that reintroduces `new AudioContext()` anywhere would not fail
 *  any existing test, it would just start silencing pages again after six
 *  toggles.
 *
 *  Run: bun tools/audioctx-test.ts
 */

let made = 0;
let resumed = 0;

class FakeAudioContext {
  state = 'suspended';
  sampleRate = 48000;
  destination = { __fake: 'destination' };
  constructor() { made++; }
  resume() { resumed++; this.state = 'running'; return Promise.resolve(); }
  close() { this.state = 'closed'; return Promise.resolve(); }
  createGain() { return { gain: { value: 1, setTargetAtTime() {} }, connect() {}, disconnect() {} }; }
  createAnalyser() { return { fftSize: 2048, connect() {}, disconnect() {}, getByteTimeDomainData() {} }; }
  createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
  createMediaStreamDestination() { return { stream: { getTracks: () => [] } }; }
}

(globalThis as any).window = globalThis;
(globalThis as any).AudioContext = FakeAudioContext;
(globalThis as any).webkitAudioContext = FakeAudioContext;

let pass = 0, fail = 0;
function check(name: string, ok: boolean, detail = '') {
  if (ok) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  else { fail++; console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? ' — ' + detail : ''}`); }
}

const mod = await import('../client/lib/audioctx.js');
const audioCtx = mod.audioContext;   // the module's own name, checked against its exports

// ── the contract ──────────────────────────────────────────────────────────────

check('no context is constructed at import time', made === 0, `made=${made}`);

const a = audioCtx();
check('first call constructs exactly one', made === 1, `made=${made}`);

const b = audioCtx();
const c = audioCtx();
check('repeated calls construct no more', made === 1, `made=${made} after 3 calls`);
check('every call returns the SAME instance', a === b && b === c);

// The leak this module exists to fix: micAnalyserLevel made a fresh context on
// every mic-stream change. Simulate that shape — many calls, as from a toggle
// loop — and prove the count does not track the calls.
for (let i = 0; i < 40; i++) audioCtx();
check('40 further calls (the mic-toggle loop) still one context', made === 1, `made=${made}`);

// A suspended context is the default before a gesture; the module should be able
// to resume it without building a second one.
check('audioContextState() reports the shared instance', mod.audioContextState() === a.state,
      `${mod.audioContextState()} vs ${a.state}`);

// ── the regression guard ──────────────────────────────────────────────────────
// The failure mode is not "audioctx.js breaks" — it is "somebody adds a direct
// construction somewhere else and this module stops being the only door."
// Reading the source is the only way to see that from here.
const src = await Bun.file(new URL('../client/lib/micstate.js', import.meta.url)).text();
const direct = [...src.matchAll(/new\s+(?:\(window\.)?(?:webkit)?AudioContext/g)].length;
check('micstate.js constructs no AudioContext directly', direct === 0,
      `${direct} direct construction(s) — they must go through audioctx.js`);

console.log(`\n  ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
