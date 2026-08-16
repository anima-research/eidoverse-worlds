// Test stand-in for client/lib/assets.js — see tools/avatar-test.ts. The real
// one owns GLTF/VRMA loading and a renderer-bound texture cache; the limp and
// clip lifecycle under test touches none of it.
export const CLIP_SLOTS = ['idle', 'walk', 'run', 'jump', 'climb', 'sit', 'lie', 'sitchair'];
export const CLIP_SPEED = { walk: 1.4, run: 3.6 };
export const VRMUtils = { deepDispose() {}, rotateVRM0() {} };
export const loadVRM = async () => { throw new Error('stub'); };
export const clipFor = async () => null;
export const vrmaBytes = async () => null;
export const vrmaShaLoaded = () => null;   // #101: no clip bytes in the stub world — seats read declared-approximate
export const loadTrack = async () => null;
export const loadDone = () => true;
