// VRMUtils.combineSkeletons returns void. Choosing it with ?? therefore also
// runs removeUnnecessaryJoints, which warns and walks the rig a second time.
// Pick by presence. An older library that has only the deprecated function
// still gets that one pass. Neither function is an error.

export function optimizeVrmSkeleton(utils, scene) {
  if (typeof utils?.combineSkeletons === 'function') {
    utils.combineSkeletons(scene);
    return;
  }
  if (typeof utils?.removeUnnecessaryJoints === 'function') utils.removeUnnecessaryJoints(scene);
}
