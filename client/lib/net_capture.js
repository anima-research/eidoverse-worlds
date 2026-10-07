// The world can ask a client for a rendered view of someone ('capture'). That is the
// one thing in the wire protocol which genuinely needs a renderer, so it lives here
// rather than in net.js — lifting it out is what lets net.js carry the protocol for a
// client that has no scene at all (lite.js). net.js keeps the socket: this returns a
// result and never sends, so there is no import cycle and one file still owns the wire.
import { THREE, camera } from './core.js';
import { remotes } from './remotes.js';
import { composeFirstPerson } from './fp_view.js';
import { captureFrame, captureFrom } from './capture.js';
import { entities } from './world.js';

const _snapHead = new THREE.Vector3();
const _snapBox = new THREE.Box3();

/** @returns {Promise<{dataUrl: string} | {error: string}>} */
export async function capture(msg) {
  // Three framings:
  //   first  — the target's own eyes: the eye anchors on their LIVE head bone
  //            (mesh bounds when the rig has none) and their own body is
  //            hidden for the frame, the same exclusion the local
  //            first-person applies to `me` (#75). The root carries the
  //            socket transform while mounted, so the eye rides the seat.
  //   third  — chase cam over the shoulder: their body AND what it faces.
  //   selfie — from in front, facing them: the avatar itself is the subject.
  try {
    const r = remotes.get(msg.follow);
    if (!r?.avatar) throw new Error(`${msg.follow} not in local scene (still loading?)`);
    const root = r.avatar.root;
    const fwd = new THREE.Vector3(Math.sin(root.rotation.y), 0, Math.cos(root.rotation.y));
    let dataUrl;
    if (msg.at) {
      // a placed thing, seen from where the asker stands, fitted to its bounds: an agent checks what it built
      // without walking over (gap list 2026-10-04: framing used to need the client's internals)
      const obj = entities.get(msg.at);
      // a picture of the grey stand-in would be a confident lie about what was built: say it is loading instead
      if (obj === null || obj?.userData?.placeholder) throw new Error(`"${msg.at}" is still loading — try again in a moment`);
      if (!obj) throw new Error(`"${msg.at}" is not a placed thing in this scene`);
      _snapBox.setFromObject(obj);
      if (_snapBox.isEmpty()) _snapBox.setFromCenterAndSize(obj.getWorldPosition(new THREE.Vector3()), new THREE.Vector3(1, 1, 1));
      const center = _snapBox.getCenter(new THREE.Vector3());
      const radius = Math.max(0.3, _snapBox.getSize(new THREE.Vector3()).length() / 2);
      const from = root.position.clone().sub(center).setY(0);
      if (from.lengthSq() < 1e-6) from.set(0, 0, 1);
      from.normalize();
      const dist = radius / Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2) * 1.1;
      const eye = center.clone().addScaledVector(from, dist).add(new THREE.Vector3(0, radius * 0.25, 0));
      dataUrl = captureFrom(eye, center);
    } else if (msg.view === 'third') {
      const eye = root.position.clone().add(new THREE.Vector3(0, 2.1, 0)).addScaledVector(fwd, -3.4);
      dataUrl = captureFrom(eye,
        root.position.clone().add(new THREE.Vector3(0, 1.2, 0)).addScaledVector(fwd, 4));
    } else if (msg.view === 'selfie') {
      const eye = root.position.clone().add(new THREE.Vector3(0, 1.6, 0)).addScaledVector(fwd, 2.6);
      dataUrl = captureFrom(eye, root.position.clone().add(new THREE.Vector3(0, 1.25, 0)));
    } else {
      const head = r.avatar.headWorldPosition(_snapHead);
      const box = head ? null : r.avatar.visualBounds(_snapBox);
      dataUrl = composeFirstPerson({
        camera,
        yaw: root.rotation.y,
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
