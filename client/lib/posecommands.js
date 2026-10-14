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
import { mergePose, puppetPose } from '../../shared/humanoid.js';

/** The options of a verb that can act on someone else: an object of the
 *  verb's own keys, or a name alone as the target. A misspelled key, or a
 *  value of another kind, throws: either used to leave the target unset, so
 *  a pose or release meant for someone else landed on the caller, silently. */
export function consoleOptions(verb, opts, keys = ['replace', 'target']) {
  if (opts == null) return {};
  if (typeof opts === 'string') return { target: opts };
  const want = `the second argument is { ${keys.join(', ')} }, or a target's name`;
  if (typeof opts !== 'object' || Array.isArray(opts)) throw new TypeError(`${verb}: ${want}`);
  const odd = Object.keys(opts).filter((k) => !keys.includes(k));
  if (odd.length) throw new TypeError(`${verb}: no option ${odd.map((k) => `"${k}"`).join(', ')}; ${want}`);
  return opts;
}

/** The verbs, acting through `state` (the caller's own held pose, as
 *  state.pose), `sendPuppet(target, request)` (a request to pose someone
 *  else, client/lib/net.js) and `play(anim)` (an animation on the caller's
 *  own body, played and sent). */
export function poseCommands({ state, sendPuppet, play }) {
  return {
    pose: (bones, opts) => {
      const { replace = false, target = null } = consoleOptions('EW.pose', opts);
      if (bones === undefined) return target ? undefined : state.pose;   // nothing named: nothing changes
      if (target) return sendPuppet(target, puppetPose(bones, replace));
      state.pose = bones === null ? null : mergePose(replace ? null : state.pose, bones);
      return state.pose;
    },
    clearPose: (target = null) => {
      if (target != null && typeof target !== 'string') throw new TypeError("EW.clearPose: the argument is a target's name, or nothing for your own pose");
      if (target) sendPuppet(target, puppetPose(null)); else state.pose = null;
    },
    animate: (data, opts) => {
      const { replace = data?.replace === true, target = null } = consoleOptions('EW.animate', opts);   // replace may ride in the data too
      const a = { ...data, replace: !!replace };
      if (target) return sendPuppet(target, { anim: a });
      if (replace) state.pose = null;
      play(a);
    },
  };
}
