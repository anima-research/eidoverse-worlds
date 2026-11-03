// breath — the period, and nothing else.
//
// 3.4 seconds is the house's breath: the wing idle beats on it, the stamina
// tick counts in it, and the falling-leaf oscillation swings on it (spec §5,
// §2, T8). It lived in shared/flight.js because flight was the first thing to
// need it, and the comment there already said what it really is -- "the
// house's breath ... everything that needs a period reads it".
//
// It moved HERE the day something outside flight needed it. avatar.js's wing
// idle is Mythos's body, not Mythos's flying, and importing the integrator to
// learn a number made the client a fourth importer of the flight core -- which
// the isolation gate caught, correctly, because that gate is how we know who
// can reach flight. Widening the gate to admit a constant would have traded a
// real authorization property for a convenience. Moving the constant costs
// nothing and keeps both files honest.
//
// PURE, per shared/README.md: no imports, no clock, no DOM.

/** Seconds. The period. See spec T8. */
export const BREATH = 3.4;

/** Hz. The same number, as a rate -- what a flap or a sway wants. */
export const BREATH_HZ = 1 / BREATH;
