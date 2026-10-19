// The world can ask a client for a rendered view of someone ('snap'). That is the
// one thing in the wire protocol which genuinely needs a renderer, so it lives here
// rather than in net.js — lifting it out is what lets net.js carry the protocol for a
// client that has no scene at all (lite.js). net.js keeps the socket: this returns a
// result and never sends, so there is no import cycle and one file still owns the wire.
import { THREE, camera } from './core.js';
import { remotes } from './remotes.js';
import { composeFirstPerson } from './fp_view.js';
import { captureFrame, captureFrom } from './capture.js';
import { normalizeSnapFrame } from '../../shared/snapframe.js';

const _snapHead = new THREE.Vector3();
const _snapBox = new THREE.Box3();

// NO PARTIAL WORLDS. A renderer that has just arrived (a roaming one sent here for this shot) streams the world in
// over seconds: a frame taken early shows half a build, and an agent would conclude its work is broken. So before a
// capture the renderer moves its camera to the followed body — residency loads what is near the camera — and waits
// until the world is REALIZED there: the body in the scene, the world's builds (terrain, water, grass) done, no model
// loading or standing in — steady for a second. Not ready in time → an explicit error with
// the counts, never a partial image. A settled renderer passes straight through.
const SETTLE_MS = 20_000, STEADY_CHECKS = 4, CHECK_MS = 250;
// The probe is INJECTED (main.js wires the real one: the body, the world's builds, the model realizer), so this module
// keeps its browser boundary narrow — a client or test without it treats the world as ready, exactly as before.
let readiness = async () => ({ ready: true });
export function setSnapReadiness(fn) { readiness = fn; }
function aimAt(p) {
  if (!p || !camera?.position) return;
  camera.position.set(p.x, p.y + 2, p.z + 3); camera.lookAt(p); camera.updateMatrixWorld();
}
async function settle(follow) {
  let last = await readiness(follow);
  if (last.ready) return;                     // a settled renderer: no wait at all
  const near = remotes.get(follow)?.avatar?.root?.position;
  aimAt(near);
  const t0 = performance.now();
  let steady = 0;
  while (performance.now() - t0 < SETTLE_MS) {
    last = await readiness(follow);
    if (last.ready) { if (++steady >= STEADY_CHECKS) return; } else steady = 0;
    // the body may have arrived only now: keep the camera (and so residency) on it
    if (!near) aimAt(remotes.get(follow)?.avatar?.root?.position);
    await new Promise((res) => setTimeout(res, CHECK_MS));
  }
  const why = !last?.body ? `${follow} has not loaded yet`
    : `${last.loading} model${last.loading === 1 ? '' : 's'} still loading (${last.models} in)${last.builds ? ', the ground still building' : ''}${last.compiling ? `, ${last.compiling} shader${last.compiling === 1 ? '' : 's'} compiling` : ''}`;
  throw new Error(`the renderer is still loading this world — ${why}; try again in a few seconds`);
}

/** @returns {Promise<{dataUrl: string} | {error: string}>} */
export async function snapshot(msg) {
  // Three framings:
  //   first  — the target's own eyes: the eye anchors on their LIVE head bone
  //            (mesh bounds when the rig has none) and their own body is
  //            hidden for the frame, the same exclusion the local
  //            first-person applies to `me` (#75). The root carries the
  //            socket transform while mounted, so the eye rides the seat.
  //   third  — chase cam over the shoulder: their body AND what it faces.
  //   selfie — from in front, facing them: the avatar itself is the subject.
  try {
    // A renderer that has just arrived (a roaming one, sent here for this shot) may not have the body or the world
    // built yet: wait for both, bounded, instead of failing a frame too early.
    await settle(msg.follow);
    const r = remotes.get(msg.follow);
    if (!r?.avatar) throw new Error(`${msg.follow} not in local scene (still loading?)`);
    const root = r.avatar.root;
    const fwd = new THREE.Vector3(Math.sin(root.rotation.y), 0, Math.cos(root.rotation.y));
    // Optional framing (shared/snapframe.js), nested as msg.frame, so no field
    // of the message itself is read as the camera's. Absent fields keep the
    // fixed defaults below, so a request without them frames exactly as before.
    const frame = normalizeSnapFrame(msg.frame);
    let dataUrl;
    if (msg.view === 'third') {
      // The aim's look-ahead scales with the camera's distance: 4 m ahead at
      // the default 3.4 m, proportionally less closer in, so a near camera
      // still tilts down far enough to keep the body in frame from below 1 m up.
      const dist = frame.dist ?? 3.4;
      const eye = root.position.clone().add(new THREE.Vector3(0, frame.height ?? 2.1, 0)).addScaledVector(fwd, -dist);
      dataUrl = captureFrom(eye,
        root.position.clone().add(new THREE.Vector3(0, 1.2, 0)).addScaledVector(fwd, 4 * dist / 3.4));
    } else if (msg.view === 'selfie') {
      const eye = root.position.clone().add(new THREE.Vector3(0, frame.height ?? 1.6, 0)).addScaledVector(fwd, frame.dist ?? 2.6);
      dataUrl = captureFrom(eye, root.position.clone().add(new THREE.Vector3(0, 1.25, 0)));
    } else {
      const head = r.avatar.headWorldPosition(_snapHead);
      const box = head ? null : r.avatar.visualBounds(_snapBox);
      dataUrl = composeFirstPerson({
        camera,
        yaw: root.rotation.y,
        pitch: frame.pitch,
        head: head ? [head.x, head.y, head.z] : null,
        bounds: box ? { min: box.min.toArray(), max: box.max.toArray() } : null,
        name: msg.follow,
        setOwnVisible: (v) => { root.visible = v; },
        render: captureFrame,
      });
    }
    return { dataUrl };
  } catch (e) {
    return { error: e.message };
  }
}
