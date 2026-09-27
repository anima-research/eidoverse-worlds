// Renderer-free VRMA parsing and retargeting, shared by the browser loader
// and headless body perception. No core/scene/fixture module is imported.
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { VRMAnimationLoaderPlugin, createVRMAnimationClip } from '@pixiv/three-vrm-animation';

export async function parsePoseAnimation(bytes) {
  const loader = new GLTFLoader();
  loader.register(parser => new VRMAnimationLoaderPlugin(parser));
  const gltf = await new Promise((resolve, reject) => loader.parse(bytes.slice(0), '', resolve, reject));
  const animation = gltf.userData.vrmAnimations?.[0];
  if (!animation) throw new Error('VRMA has no humanoid animation');
  return animation;
}
export const retargetPoseAnimation = (animation, vrm) => createVRMAnimationClip(animation, vrm);

export function syncClipPhase(avatar, sample, stamp) {
  const slot = sample.clipTimeSlot ?? sample.clip;
  if (!Number.isFinite(sample.clipTime) || sample.clipTime < 0 || avatar.currentSlot !== slot || !avatar.current) return false;
  const rate = Number.isFinite(sample.clipRate) && sample.clipRate >= 0 && sample.clipRate <= 3.2 ? sample.clipRate : null;
  if (rate !== null) avatar.current.timeScale = rate;
  if (stamp.time === sample.clipTime && stamp.slot === slot && stamp.rate === rate) return false;
  const duration = avatar.current.getClip().duration;
  avatar.current.time = duration > 0 ? sample.clipTime % duration : 0;
  stamp.time = sample.clipTime; stamp.slot = slot; stamp.rate = rate;
  return true;
}
