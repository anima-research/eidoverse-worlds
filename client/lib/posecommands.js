// The browser console's posing verbs (EW.pose, EW.clearPose, EW.animate in
// client/main.js), the same verbs an agent's tools have. Kept apart from
// main.js so a test can drive them without a browser: they take what they
// act through as arguments.
//
//   EW.pose({ leftUpperArm: [...] })          only these bones, over what you hold; null releases one
//   EW.pose({ ... }, { replace: true })       the WHOLE pose: every bone not named goes back to normal
//   EW.pose({ ... }, { target: 'mythos' })    ask someone else (their client decides)
//   EW.pose({ ... }, 'mythos')                a name alone is the target too
//   EW.pose(null)  /  EW.clearPose()          release the whole pose; with a target, theirs
//   EW.pose()                                 what you hold now, unchanged
//   EW.clearPose('mythos')
//   EW.animate(anim, { replace, target })     one-off animation; merge plays over your pose and any
//                                             other animation, replace ends them first
//
// A value per bone is [x,y,z,w] or {q, t, s} (shared/humanoid.js poseChannels).
//
// Each verb throws rather than guess when a call meant for someone else could
// land on the caller: a target that is given but empty or not a name, an
// option it doesn't know, options passed as undefined or null, or a target
// put inside the pose or the animation.
import { mergePose, puppetPose } from '../../shared/humanoid.js';

const name = (t) => typeof t === 'string' && t.length > 0;

/** The options of a verb that can act on someone else: an object of the
 *  verb's own keys, or a name alone as the target. Called with the verb's
 *  arguments after its first, so options passed as undefined or null throw
 *  instead of reading as none. */
export function consoleOptions(verb, rest, keys = ['replace', 'target']) {
  const want = `the second argument is { ${keys.join(', ')} }, or a target's name; leave it out to act on yourself`;
  if (!rest.length) return {};
  const opts = rest[0];
  if (typeof opts === 'string') {
    if (!name(opts)) throw new TypeError(`${verb}: an empty target; ${want}`);
    return { target: opts };
  }
  if (!opts || typeof opts !== 'object' || Array.isArray(opts)) throw new TypeError(`${verb}: ${want}`);
  const odd = Object.keys(opts).filter((k) => !keys.includes(k));
  if (odd.length) throw new TypeError(`${verb}: no option ${odd.map((k) => `"${k}"`).join(', ')}; ${want}`);
  if ('target' in opts && !name(opts.target)) throw new TypeError(`${verb}: target is ${JSON.stringify(opts.target) ?? 'undefined'}, not a name; ${want}`);
  if ('replace' in opts && typeof opts.replace !== 'boolean') throw new TypeError(`${verb}: replace is true or false`);
  return opts;
}

/** The verbs, acting through `state` (the caller's own held pose, as
 *  state.pose), `sendPuppet(target, request)` (a request to pose someone
 *  else, client/lib/net.js) and `play(anim)` (an animation on the caller's
 *  own body, played and sent). */
export function poseCommands({ state, sendPuppet, play }) {
  return {
    pose: (bones, ...rest) => {
      const { replace = false, target = null } = consoleOptions('EW.pose', rest);
      if (bones !== undefined && bones !== null && (typeof bones !== 'object' || Array.isArray(bones))) {
        throw new TypeError("EW.pose: the first argument is a map of bone name to value, or null to release; a target's name goes second");
      }
      if (bones && ('target' in bones || 'replace' in bones)) throw new TypeError("EW.pose: target and replace go in the second argument, not among the bones");
      if (bones === undefined) return target ? undefined : state.pose;   // nothing named: nothing changes
      if (target) return sendPuppet(target, puppetPose(bones, replace));
      state.pose = bones === null ? null : mergePose(replace ? null : state.pose, bones);
      return state.pose;
    },
    clearPose: (...rest) => {
      if (rest.length && !name(rest[0])) throw new TypeError("EW.clearPose: a target's name, or no argument for your own pose");
      if (rest.length) sendPuppet(rest[0], puppetPose(null)); else state.pose = null;
    },
    animate: (data, ...rest) => {
      if (data && typeof data === 'object' && 'target' in data) throw new TypeError("EW.animate: target goes in the second argument, not in the animation");
      const { replace = data?.replace === true, target = null } = consoleOptions('EW.animate', rest);   // replace may ride in the data too
      const a = { ...data, replace: !!replace };
      if (target) return sendPuppet(target, { anim: a });
      if (replace) state.pose = null;
      play(a);
    },
  };
}
