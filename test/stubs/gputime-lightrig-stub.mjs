// lightrig.js for gputime-test: the shadow preference, reduced to what gputime calls (reassertShadowPref puts the
// preference's uniform half back on every caster, as applyShadowPref does).
import { lights } from './gputime-core-stub.mjs';
export const pref = { on: true, calls: 0 };
export const reassertShadowPref = () => { pref.calls++; for (const l of lights) if (l.shadow) l.shadow.autoUpdate = pref.on; };
