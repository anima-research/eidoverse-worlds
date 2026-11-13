// vrmic_policy — WHEN to ask for the microphone around VR, as pure functions. vrmic.js owns the effects (the 2D step,
// getUserMedia, the in-headset message); this file owns the decisions, so a suite can drive every state × choice
// without a browser (tools/vrmic-policy-test.mjs).
//
// Why any of this exists (R, 09-30): a browser's permission prompt cannot be relied on to show DURING an immersive
// session. Someone whose first mic use happens in the headset gets no voice and no explanation. So the question is
// asked on the flat page, where the browser can show its own prompt, before the headset goes on — once per browser,
// and only when the answer is actually unknown.
//
// Inputs:
//   state       the Permissions API's answer for 'microphone', read WITHOUT prompting:
//               'granted' | 'denied' | 'prompt' | 'unknown' (no Permissions API / no 'microphone' name / it threw)
//   remembered  what this browser chose at the 2D step before: null (never asked) | 'allow' | 'later'
//   pending     VR could not get an answer and promised "you'll be asked when you leave VR" (the in-VR fallback)

export const MIC_CHOICE_KEY = 'ew-vr-mic-choice';     // 'allow' | 'later' — the 2D step's remembered answer
export const MIC_PENDING_KEY = 'ew-vr-mic-pending';   // '1' — VR owes the person a flat-page ask

/** The Enter VR press. → { step: 'ask' | 'straight', hint: null | 'denied' }
 *  A browser-level answer (granted / denied) always wins: there is nothing to ask, and a denial is fixed in the
 *  browser's site settings, not by us. 'unknown' is treated like 'prompt' — asking is a no-op prompt-wise when the
 *  permission is in fact granted, and it is asked at most once per browser. */
export function preVrStep({ state, remembered = null, pending = false }) {
  if (state === 'granted') return { step: 'straight', hint: null };
  if (state === 'denied') return { step: 'straight', hint: 'denied' };
  // A promise VR made outranks an earlier "not now": the person tried to talk in the headset since then.
  if (pending) return { step: 'ask', hint: null };
  if (remembered === 'allow' || remembered === 'later') return { step: 'straight', hint: null };
  return { step: 'ask', hint: null };
}

/** The ring's mic press while presenting. → 'proceed' | 'blocked' | 'try'
 *  Turning the mic OFF, or pressing it outside a session, is never this module's business. */
export function inVrMicPlan({ turningOn, presenting, state }) {
  if (!turningOn || !presenting) return 'proceed';
  if (state === 'granted') return 'proceed';
  if (state === 'denied') return 'blocked';
  return 'try';   // prompt / unknown: ONE attempt, bounded by a timeout, never awaited by the exit
}

/** After the one bounded attempt in VR (it settled, or the timeout fired first). → 'ok' | 'blocked' | 'later'
 *  'ok' covers a granted permission whose mic still is not live (no relay yet, a gate refusal): those say their own
 *  words elsewhere and are not a permission problem. */
export function inVrAfterTry({ micOn, state }) {
  if (micOn) return 'ok';
  if (state === 'granted') return 'ok';
  if (state === 'denied') return 'blocked';
  return 'later';
}

/** The first flat-page moment after leaving VR with a promise outstanding. → 'ask' | 'clear' | 'clear-denied' | 'none' */
export function afterExitStep({ pending, state }) {
  if (!pending) return 'none';
  if (state === 'granted') return 'clear';          // the person answered the browser's own prompt on the way out
  if (state === 'denied') return 'clear-denied';
  return 'ask';
}
