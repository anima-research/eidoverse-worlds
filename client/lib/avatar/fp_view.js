// fp_view — first-person view composition for a body seen from its own eyes.
//
// One module owns the snapshot renderer's answer to "where is this avatar's eye and what must be hidden so it can
// see"; other first-person render paths should reuse it rather than guess a head height. DOM- and import-free:
// callers hand in live world-space numbers and callbacks (test/client/fp-view-test.ts pins them).
//
// The contract:
//   - the eye anchors on the LIVE rig (head bone, else mesh bounds), so it follows whatever drives the root,
//     including a socket on moving furniture;
//   - the resident's whole own visual root (mesh plus labels/bubbles) is never in the frame;
//   - other bodies are untouched;
//   - a rig offering neither anchor fails with a message naming the rig, not a frame from inside its chest.

// Eye placement. FORWARD matches the local first-person eye (controller.js: 0.16 ahead of the head so geometry
// behind the eye plane can't clip); LIFT raises the head JOINT to eye height. GAZE_* reproduce the standing snap
// framing: level look, dropped 0.6 over 8 m so the frame holds ground and horizon.
export const FP_FORWARD = 0.16;
export const FP_EYE_LIFT = 0.06;
export const FP_GAZE_AHEAD = 8;
export const FP_GAZE_DROP = 0.6;

// Bounds-anchored rigs put the eye at BOUNDS_EYE of the mesh's height —
// near the top, where a head would be, without claiming to know the anatomy.
export const FP_BOUNDS_EYE = 0.85;

/** Where this rig's first-person eye is, in world space.
 *
 *  head    [x,y,z] world position of the rig's head bone, or null when the
 *          rig has none. Callers pass the LIVE bone position — that is what
 *          makes a seated body's eye sit at its seated head, and a body on a
 *          moving socket keep its eye on the socket.
 *  bounds  { min:[x,y,z], max:[x,y,z] } world bounds of the rig's own mesh,
 *          or null. The no-head fallback.
 *  name    who, for the error message.
 *
 *  Returns { eye:[x,y,z], mode:"head"|"bounds" }. Throws (legibly, naming
 *  the rig) when neither anchor exists — a caller that can't place an eye
 *  must say so, not render from inside the mesh. */
export function resolveFirstPersonAnchor({ head, bounds, name = "this body" } = {}) {
  if (head && head.length === 3 && head.every(Number.isFinite)) {
    return { eye: [head[0], head[1] + FP_EYE_LIFT, head[2]], mode: "head" };
  }
  if (bounds && bounds.min?.every(Number.isFinite) && bounds.max?.every(Number.isFinite)
    && bounds.max[1] > bounds.min[1]) {
    const h = bounds.max[1] - bounds.min[1];
    return {
      eye: [
        (bounds.min[0] + bounds.max[0]) / 2,
        bounds.min[1] + h * FP_BOUNDS_EYE,
        (bounds.min[2] + bounds.max[2]) / 2,
      ],
      mode: "bounds",
    };
  }
  throw new Error(
    `${name}: rig has no head bone and no measurable mesh bounds — first-person view unsupported for this avatar`);
}

/** Compose and render one first-person frame.
 *
 *  camera         { position:{set(x,y,z)}, lookAt(x,y,z) } — a THREE camera,
 *                 or anything shaped like one in tests.
 *  yaw            the rig's facing (root.rotation.y). For a mounted body the
 *                 root carries the SOCKET transform, so the gaze follows the
 *                 seat — including a seat mid-swing.
 *  head/bounds/name  → resolveFirstPersonAnchor.
 *  setOwnVisible  hides/shows the avatar's own visual root (mesh, nameplate,
 *                 speech bubble, typing pill — all of it is "own body" to a
 *                 first-person frame).
 *  render         synchronously produces the frame; its return value is passed
 *                 through. A Promise/thenable is rejected explicitly: async
 *                 rendering needs a separately designed re-entrant exclusion.
 *
 *  The body is hidden strictly around synchronous render() and restored in finally — an
 *  exclusion that survived a throw would leave the body invisible to every
 *  OTHER viewer of this renderer's scene. */
export function composeFirstPerson({ camera, yaw, pitch, head, bounds, name, setOwnVisible, render }) {
  const { eye } = resolveFirstPersonAnchor({ head, bounds, name });
  const fx = Math.sin(yaw), fz = Math.cos(yaw);
  const ex = eye[0] + fx * FP_FORWARD, ey = eye[1], ez = eye[2] + fz * FP_FORWARD;
  camera.position.set(ex, ey, ez);
  if (Number.isFinite(pitch)) {
    // an asked-for gaze tilt (degrees, + up): same eye, same heading
    const r = pitch * Math.PI / 180, flat = Math.cos(r) * FP_GAZE_AHEAD;
    camera.lookAt(ex + fx * flat, ey + Math.sin(r) * FP_GAZE_AHEAD, ez + fz * flat);
  } else camera.lookAt(ex + fx * FP_GAZE_AHEAD, ey - FP_GAZE_DROP, ez + fz * FP_GAZE_AHEAD);
  setOwnVisible(false);
  try {
    const frame = render();
    if (frame && typeof frame.then === 'function') {
      throw new Error(`${name ?? 'this body'}: async first-person render unsupported — exclusion is synchronous`);
    }
    return frame;
  } finally {
    setOwnVisible(true);
  }
}
