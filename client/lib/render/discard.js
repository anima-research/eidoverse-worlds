// discard — let go of a model object that will not be drawn again (a loadGLB clone the realizer drops, or a realized
// object a swap, demote or retire takes out of the scene), so what three made per OBJECT goes with it.
//
// Why: three's renderer keeps a RenderObject per (object, material, scene, camera, ...) it has drawn or compiled
// (loadGLB warm-compiles every clone with renderer.compileAsync), and each holds bindings (uniform buffers), a share of
// its pipeline (the program's use count), and listeners on the SHARED geometry and material. It is freed by that
// object's own 'dispose' event (three r186 RenderObject.onObjectDispose), or when the geometry or material is disposed;
// three never dispatches the object event itself (Object3D has no dispose()). A dropped clone otherwise keeps its
// RenderObjects for as long as the proto lives: programs, uniform buffers and listeners grew linearly with re-tiers on
// the RTX 4080 (render lab, 11-26).
//
// What it does NOT touch: geometry, materials and textures. Those are the cached proto's, shared with every other
// placement of the same model (assets.js evictIdleProtos disposes them, once nothing wears them). Nor does it enter
// what rides the object but is not its own and is re-homed by the realizer: another entity's frame (a socket, cargo),
// the frame's mesh component, a light gizmo. Pure (no imports), so the realizer's headless suites run the real one.

/** Dispatch three's object 'dispose' on `root` and its own descendants. */
export function discardObject(root) {
  if (!root) return;
  const visit = (o) => {
    if (o !== root && (o.userData?.entityId != null || o.userData?.meshPart || o.userData?.isGizmo)) return;
    o.dispatchEvent({ type: 'dispose' });
    for (const c of o.children) visit(c);
  };
  visit(root);
}
