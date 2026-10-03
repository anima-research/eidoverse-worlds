// vrmic-policy-test — WHEN the microphone is asked for around VR (client/lib/vrmic_policy.js), every state × choice.
// Pure: the policy has no imports, so there is nothing to stub. The browser half (the 2D step, getUserMedia, the
// in-headset note, the exit) is tools/vrmic-probe.mjs.
//
// Run: BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun tools/vrmic-policy-test.mjs
//
// Mutations that must turn a named check red:
//   'unknown' treated as straight-in              → "never asked + unknown asks"
//   remembered checked before pending             → "a VR promise outranks an earlier not-now"
//   denied asked instead of hinted                → "denied goes straight in, with the settings hint"
//   in-VR 'try' on granted                        → "granted in VR just toggles"
//   inVrAfterTry ignores micOn                    → "a live mic after the try is ok whatever the state says"
import { preVrStep, inVrMicPlan, inVrAfterTry, afterExitStep, MIC_CHOICE_KEY, MIC_PENDING_KEY } from '../client/lib/vrmic_policy.js';
// a local check(): probe-harness.mjs would pull in Playwright for a test that needs none
let pass = 0, fail = 0;
const check = (name, ok, extra = '') => { console.log(`  ${ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${name}${ok ? '' : '  ' + extra}`); ok ? pass++ : fail++; };
const done = () => { console.log(`\n${fail ? '\x1b[31m' : '\x1b[32m'}${pass} passed, ${fail} failed\x1b[0m`); process.exit(fail ? 1 : 0); };
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ── pre-VR: the full table ──
const STATES = ['granted', 'denied', 'prompt', 'unknown'];
const CHOICES = [null, 'allow', 'later'];
const expectPre = (state, remembered, pending) => {
  if (state === 'granted') return { step: 'straight', hint: null };
  if (state === 'denied') return { step: 'straight', hint: 'denied' };
  if (pending) return { step: 'ask', hint: null };
  return remembered ? { step: 'straight', hint: null } : { step: 'ask', hint: null };
};
const bad = [];
for (const s of STATES) for (const r of CHOICES) for (const p of [false, true]) {
  const got = preVrStep({ state: s, remembered: r, pending: p });
  if (!eq(got, expectPre(s, r, p))) bad.push(`${s}/${r}/${p} → ${JSON.stringify(got)}`);
}
check('pre-VR: all 24 state × choice × pending cases match the table', bad.length === 0, bad.join('; '));
check('pre-VR: granted goes straight in, no step', eq(preVrStep({ state: 'granted' }), { step: 'straight', hint: null }));
check('pre-VR: denied goes straight in, with the settings hint', eq(preVrStep({ state: 'denied' }), { step: 'straight', hint: 'denied' }));
check('pre-VR: never asked + prompt asks', preVrStep({ state: 'prompt', remembered: null }).step === 'ask');
check('pre-VR: never asked + unknown asks', preVrStep({ state: 'unknown', remembered: null }).step === 'ask');
check('pre-VR: a remembered "not now" is not re-asked', preVrStep({ state: 'prompt', remembered: 'later' }).step === 'straight');
check('pre-VR: a remembered "allow" (prompt dismissed since) is not re-asked', preVrStep({ state: 'prompt', remembered: 'allow' }).step === 'straight');
check('pre-VR: a VR promise outranks an earlier not-now', preVrStep({ state: 'prompt', remembered: 'later', pending: true }).step === 'ask');
check('pre-VR: a garbage remembered value counts as never asked', preVrStep({ state: 'prompt', remembered: 'yes' }).step === 'ask');

// ── in VR ──
check('in VR: turning the mic OFF is never gated', inVrMicPlan({ turningOn: false, presenting: true, state: 'prompt' }) === 'proceed');
check('in VR: outside a session nothing is gated', inVrMicPlan({ turningOn: true, presenting: false, state: 'prompt' }) === 'proceed');
check('in VR: granted in VR just toggles', inVrMicPlan({ turningOn: true, presenting: true, state: 'granted' }) === 'proceed');
check('in VR: denied is blocked (no request at all)', inVrMicPlan({ turningOn: true, presenting: true, state: 'denied' }) === 'blocked');
check('in VR: prompt / unknown get one bounded try', ['prompt', 'unknown'].every((s) => inVrMicPlan({ turningOn: true, presenting: true, state: s }) === 'try'));
check('after the try: a live mic is ok whatever the state says', STATES.every((s) => inVrAfterTry({ micOn: true, state: s }) === 'ok'));
check('after the try: granted but not live is not a permission problem', inVrAfterTry({ micOn: false, state: 'granted' }) === 'ok');
check('after the try: denied → blocked', inVrAfterTry({ micOn: false, state: 'denied' }) === 'blocked');
check('after the try: still open → later (ask on the flat page)', ['prompt', 'unknown'].every((s) => inVrAfterTry({ micOn: false, state: s }) === 'later'));

// ── after exit ──
check('after exit: no promise → nothing', STATES.every((s) => afterExitStep({ pending: false, state: s }) === 'none'));
check('after exit: answered on the way out → clear', afterExitStep({ pending: true, state: 'granted' }) === 'clear');
check('after exit: denied → clear with the settings hint', afterExitStep({ pending: true, state: 'denied' }) === 'clear-denied');
check('after exit: still open → ask', ['prompt', 'unknown'].every((s) => afterExitStep({ pending: true, state: s }) === 'ask'));
check('keys are distinct and namespaced', MIC_CHOICE_KEY !== MIC_PENDING_KEY && [MIC_CHOICE_KEY, MIC_PENDING_KEY].every((k) => k.startsWith('ew-vr-mic-')));
done();
