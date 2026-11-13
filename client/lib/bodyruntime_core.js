// bodyruntime_core — the pure half of a body that brings its own runtime (§24 avatar defs: `runtime`, see
// shared/avatardefs.js). bodyruntime.js maps the declared kind to reviewed code built into Worlds; this half knows the frame order and runs
// it, with no DOM and no THREE of its own, so tools/bodyruntime.test.ts drives it headless.
//
// kind 'claude-robot-dof': Claude's reviewed hardware-DOF runtime, whose header documents its frame order
// (eidoverse/claude_robot_dof.js in the library). Retargeted human clips ask a machine for poses its joints can't
// take: a knee twist, an ankle yaw, a wrist past its stops, legs through each other. The module projects each pose
// onto the body's real joints and clamps it to their ranges. Its order, and where it lands in Avatar.update:
//   at load, before anything poses the body   initArmDOF(vrm, hinges), setupHandDOF(vrm, hinges), setupLegDOF(vrm),
//                                             setupCrown(vrm)
//   right after the clip's mixer.update       every bound value written (three's PropertyMixer.apply skips a value that
//                                             didn't change, so a held key would leave a pass reading its own output
//                                             from the frame before), then keepArmPose(vrm): the clip's arm pose
//   last before vrm.update (after every       rehomeBody, applyHardwareDOF(LEG_JOINTS), applyLegClearance, applyArmDOF,
//   other bone writer: reach, one-shot anims, XR)     applyHandDOF, applyHeadExpression, applyCrown. The body's own limits
//                                             get the final word over every pose, whoever drives it
// Every step is optional (a module exports what it has). None can break a frame: a step that throws is reported once
// and skipped from then on, and the body plays on unclamped rather than not at all.

/** Write every active binding's current value, as PropertyMixer.apply would if the value had changed. */
export function writeAll(mixer) {
  const b = mixer?._bindings;
  if (!b) return;
  const n = mixer._nActiveBindings ?? 0, k = (mixer._accuIndex ?? 0) + 1;
  for (let i = 0; i < n; i++) b[i].binding.setValue(b[i].buffer, k * b[i].valueSize);
}

// a VRM's runtime state lives in the module (per-VRM, keyed by the VRM): a pooled body worn again is already set up,
// and setting it up again would read a posed skeleton as its rest
const INITED = new WeakSet();
const TAKEN = new WeakMap();   // vrm -> the node constraints the module took over at init (handed back while limp)

/** @param {string} kind @param {Record<string, any>} mod the imported module
 *  @param {{ joints?: any, report?: (msg: string, err?: unknown) => void }} [opts]
 *  @returns {{ kind: string, init(vrm: any): void, afterMixer(vrm: any, mixer: any): void,
 *             beforeVrmUpdate(vrm: any, dt: number): void, stats: Record<string, number>, dead: Set<string> } | null} */
export function makeBodyRuntime(kind, mod, { joints = null, report = (m, e) => console.warn(m, e), skip = [] } = {}) {
  if (kind !== 'claude-robot-dof' || !mod) return null;
  const stats = {};
  const dead = new Set(skip);   // body-definition steps intentionally disabled for this authored body start skipped
  const hinges = joints?.hinges;
  const setLimpState = (vrm, on) => {
    const mgr = vrm?.nodeConstraintManager;
    const taken = TAKEN.get(vrm) ?? [];
    if (!mgr || !taken.length) return;
    for (const c of taken) {
      if (on) { if (mgr.addConstraint) mgr.addConstraint(c); else mgr.constraints.add(c); }
      else if (mgr.deleteConstraint) mgr.deleteConstraint(c);
      else mgr.constraints.delete(c);
    }
  };
  const step = (name, ...args) => {
    const fn = mod[name];
    if (dead.has(name) || typeof fn !== 'function') return;
    try { fn(...args); } catch (e) { dead.add(name); report(`body runtime: ${name} threw; skipped from now on`, e); }
  };
  return {
    kind, stats, dead,
    init(vrm) {
      if (!vrm) return;
      if (INITED.has(vrm)) { setLimpState(vrm, false); return; }
      INITED.add(vrm);
      step('initArmDOF', vrm, hinges);
      step('setupHandDOF', vrm, hinges);
      // The module takes some of the file's node constraints over and solves those nodes itself (the hip's stages:
      // setupLegDOF deletes their constraints). Which ones it took is kept, per VRM, so a ragdoll can hand them back.
      const mgr = vrm.nodeConstraintManager;
      const before = mgr ? [...mgr.constraints] : [];
      step('setupLegDOF', vrm);
      const after = new Set(mgr ? mgr.constraints : []);
      TAKEN.set(vrm, before.filter((c) => !after.has(c)));
      step('setupCrown', vrm);
    },
    /** Limp (avatar.setLimp): the sim owns the bones and this runtime stops, so the nodes it solves would be left
     *  where they were while the limbs flew (a thigh shell on a hip stage stays with the hips). The constraints it took
     *  are handed back for as long as the body is limp: three-vrm runs them inside vrm.update, which goes on while
     *  limp. Taken again when it stands. */
    setLimp(vrm, on) { setLimpState(vrm, on); },
    // Pool boundary: return constraint ownership to the runtime before the VRM
    // is reset/shelved. A new wearer also reasserts it in init above.
    dispose(vrm) { setLimpState(vrm, false); step('disposeBodyRuntime', vrm); },
    afterMixer(vrm, mixer) {
      if (!dead.has('writeAll')) {
        try { writeAll(mixer); } catch (e) { dead.add('writeAll'); report('body runtime: writeAll threw; skipped from now on', e); }
      }
      step('keepArmPose', vrm);
    },
    beforeVrmUpdate(vrm, dt) {
      step('rehomeBody', vrm, stats);
      if (mod.LEG_JOINTS) step('applyHardwareDOF', vrm, mod.LEG_JOINTS, stats);
      step('applyLegClearance', vrm, stats, dt);
      step('applyArmDOF', vrm, stats, dt);
      step('applyHandDOF', vrm, stats);
      step('applyHeadExpression', vrm, dt);
      step('applyCrown', vrm, dt);
    },
  };
}

/** The avatar def a body's library path belongs to: one declaring that `vrm`, else the one named for the file. */
export function defForBody(avatars, libPath) {
  if (!avatars || typeof libPath !== 'string') return null;
  const path = libPath.split('?')[0];
  for (const [name, d] of Object.entries(avatars)) if (d?.vrm === path) return { name, def: d };
  const name = path.split('/').pop().replace(/\.vrm$/, '');
  return avatars[name] ? { name, def: avatars[name] } : null;
}
