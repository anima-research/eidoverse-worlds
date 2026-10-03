// namereveal — HOLD to see every name (owner, 09-30). While held, every nameplate in range draws through everything,
// at full legibility, out to ~60 m (platesize.js says how); release, and they ease back. Hold, not toggle: it is a
// glance ("who is that, over there?"), and a toggle left on is a wall of labels you forgot you asked for.
//
// Sources are independent — the desktop key, a VR button, a timed pulse from the action list — and the reveal is on
// while ANY of them is; the level ramps from wherever it was, so a quick tap-release-tap never snaps.
//
// THE KEY: N ("names"). Alt was the first wish and is taken three times over: walk slowly (controller.js creeping),
// fine look in photo mode, and grabbing a panel from anywhere (ui.js altgrab) — and a bare Alt release focuses the
// menu bar in Windows browsers. Tab is People Here. N is bound nowhere in the client, is bare (no chord), and says
// what it does. Ignored while typing (any text field or contenteditable) and on autorepeat; released on blur, since a
// keyup never arrives when focus leaves with the key down (mictoggle.js's stuck-key class).
import { revealRamp, revealEase } from './platesize.js';
import { register } from './actions.js';

const sources = new Set();
let held = false, t0 = -1e9, k0 = 0;
const nowMs = () => performance.now();

/** The raw ramp level at `now` (0..1). */
const rawAt = (now) => revealRamp(held, t0, k0, now);

/** Turn one source on or off. The level continues from where it is. */
export function setReveal(source, on, now = nowMs()) {
  if (on) sources.add(source); else sources.delete(source);
  const want = sources.size > 0;
  if (want === held) return;
  k0 = rawAt(now); t0 = now; held = want;
}
/** The eased reveal level every plate reads this frame, 0..1. */
export const revealLevel = (now = nowMs()) => revealEase(rawAt(now));
export const revealHeld = () => held;
export const revealSources = () => [...sources];

// a timed reveal for surfaces that can't hold (the action list: choose "show every name" and they come up briefly)
let pulseTimer = null;
export function pulseReveal(ms = 2000) {
  setReveal('pulse', true);
  clearTimeout(pulseTimer);
  pulseTimer = setTimeout(() => setReveal('pulse', false), ms);
}

// Only a place where N would insert a character is a reason to ignore it (mictoggle.js's rule, same shape).
const TEXT_INPUT = /^(text|search|url|email|password|number|tel|)$/i;
export const typingTarget = () => {
  const el = globalThis.document?.activeElement;
  if (!el) return false;
  if (el.isContentEditable) return true;
  if (el.tagName === 'TEXTAREA') return true;
  return el.tagName === 'INPUT' && TEXT_INPUT.test(el.type ?? '');
};
export const REVEAL_CODE = 'KeyN';
/** keydown → should it start the reveal? (exported for the test) */
export const revealKeyDown = (e) => e.code === REVEAL_CODE && !e.repeat && !e.ctrlKey && !e.metaKey && !e.altKey && !typingTarget();

if (typeof addEventListener === 'function') {
  addEventListener('keydown', (e) => { if (revealKeyDown(e)) setReveal('key', true); });
  addEventListener('keyup', (e) => { if (e.code === REVEAL_CODE) setReveal('key', false); });
  addEventListener('blur', () => setReveal('key', false));
}

register({ id: 'key:names', title: 'show every name (hold)', key: 'N', group: 'view',
  keywords: ['names', 'nameplates', 'labels', 'tags', 'who', 'reveal', 'through walls'],
  detail: 'hold N — every name in range, through walls', run: () => pulseReveal(2000) });
