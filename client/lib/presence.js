// presence — present / away / busy, for the profile icon's corner dot
// (bottom-right, the Discord/Slack convention; R, 09-05). Automatic between
// present and away (tab hidden, or no input for AWAY_S); busy is a choice made
// in the profile and held until you change it. Local only for now — nothing
// is sent over the wire until the server grows a field for it.
import { bus } from './base.js';

export const STATES = ['present', 'away', 'busy'];
const AWAY_S = 180;
let manual = null;            // 'busy' (or a forced 'present'/'away') — null = automatic
let auto = 'present';
let lastInput = performance.now();

export const presence = () => manual ?? auto;
export function setPresence(s) {
  // away and busy are CHOICES and hold until you choose present (which hands
  // control back to the clock). The first cut nulled 'away' too, so it could
  // never be set by hand — R caught it live on 09-05 ("away doesn't work").
  manual = (s === 'away' || s === 'busy') ? s : null;
  emit();
}
let last = null;
function emit() { const v = presence(); if (v !== last) { last = v; bus.emit('presence:me', v); } }

const seen = () => { lastInput = performance.now(); if (auto !== 'present') { auto = 'present'; emit(); } };
export const markActive = seen;   // for inputs that never reach the DOM (XR sticks and buttons)
for (const ev of ['pointerdown', 'keydown', 'pointermove']) addEventListener(ev, seen, { passive: true });
document.addEventListener('visibilitychange', () => { auto = document.hidden ? 'away' : 'present'; emit(); });
setInterval(() => { if (!document.hidden && performance.now() - lastInput > AWAY_S * 1000 && auto !== 'away') { auto = 'away'; emit(); } }, 5000);
