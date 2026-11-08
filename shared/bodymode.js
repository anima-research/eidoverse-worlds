// bodymode — what a body is doing as a whole, on the presence plane (R 10-17 15:34–15:39: was "posture", the clip label).
//
// The body's OWNER publishes it in its own presence packet as `bodyMode` (relayed as sent, remembered for late joiners
// like the rest of the settled pose, never logged; the server's fence checks only the grammar). Values:
//   stand | sit | lie | swim | fly | fall — every one DECLARABLE by the body's owner, for looks (R 15:45: declare fly and the
//   hover set plays while the capsule walks); an anim may ask for one (the built-in sit and lie do), and its end is stand.
//   The mover sets it on REAL transitions (into water → swim, an actual take-off → fly, airborne → fall, landing → stand),
//   so ordinary bodies never manage it: a declaration holds until the next real transition or the next declaration
//   (bodyModeTracker). Nothing here moves a body.
// It is separate from the anim: the presence `clip` is what plays; bodyMode is the mode. It is a SELF-DECLARED
// description and nothing more (PROTOCOL §5): no authority rule, consent check or permission is granted or relaxed
// because of it; a rule that depends on state checks what the authority can verify on the act (the water at the
// position, the fly permission at take-off).

export const BODY_MODES = Object.freeze(['stand', 'sit', 'lie', 'swim', 'fly', 'fall']);
export const SETTABLE_MODES = BODY_MODES;   // R 15:45: all six are declarable
export const isBodyMode = (m) => typeof m === 'string' && BODY_MODES.includes(m);

/** The mode the mover's own states say (flying, then swimming, then falling: in the air past a step's grace), else what
 *  was chosen. Stateless: a body with a declaration to keep across transitions uses bodyModeTracker. */
export function bodyModeOf({ flying = false, swimming = false, falling = false, chosen = 'stand' } = {}) {
  if (flying) return 'fly';
  if (swimming) return 'swim';
  if (falling) return 'fall';
  return isBodyMode(chosen) ? chosen : 'stand';
}
/** The owner's body-mode over time: declare(m) holds until the next REAL transition (the mover's state changing:
 *  water, take-off, airborne, landing) or the next declaration; step(states) returns the mode to publish. */
export function bodyModeTracker() {
  let real = 'stand', declared = null;
  return {
    declare(m) { declared = m == null ? null : isBodyMode(m) ? m : declared; },
    get declared() { return declared; },
    step({ flying = false, swimming = false, falling = false } = {}) {
      const r = flying ? 'fly' : swimming ? 'swim' : falling ? 'fall' : 'stand';
      if (r !== real) { real = r; declared = null; }   // a real transition ends any declaration
      return declared ?? real;
    },
  };
}

/** A sample written before bodyMode existed carried the mode in its clip (the posture label): read it from there. */
export function modeFromClip(clip) {
  const c = String(clip ?? '');
  if (c === 'sit' || c === 'sitchair' || /^sitting/.test(c)) return 'sit';
  if (c === 'lie' || /^lying/.test(c)) return 'lie';
  if (c === 'swim' || c === 'tread') return 'swim';
  if (c === 'fly' || c === 'glide' || c === 'flap' || c === 'hover') return 'fly';
  if (c === 'fall' || c === 'jump') return 'fall';
  return 'stand';
}

/** What a received sample says the body's mode is: its bodyMode, else (an older sample) its clip's. */
export function readBodyMode(sample) {
  if (!sample || typeof sample !== 'object') return null;
  return isBodyMode(sample.bodyMode) ? sample.bodyMode : (typeof sample.clip === 'string' ? modeFromClip(sample.clip) : null);
}
