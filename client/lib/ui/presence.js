// presence — present / away / busy, for the profile icon's corner dot. Automatic between present and away
// (tab hidden, or no input for AWAY_S); busy is chosen in the profile and held until changed. Rides every
// pose packet as `presence` (net.js; shared/presencewire.js validates, remotes.js applies).
import { bus } from '../base.js';

export const STATES = ['present', 'away', 'busy'];
const AWAY_S = 180;
let manual = null;            // 'busy' (or a forced 'present'/'away') — null = automatic
let auto = 'present';
let lastInput = performance.now();

export const presence = () => manual ?? auto;
export function setPresence(s) {
  // away and busy hold until you choose present, which hands control back to the clock
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
