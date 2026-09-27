// The renderer decision, as a pure function. core.js calls it once at import with the real URL params and
// persisted preferences; tools/backend-choice-test.mjs calls it with every combination. No imports on purpose.
//
// ONE renderer control (R 09-07). backendPref: unset/'auto' | 'webgpu' | 'webgl'.
//   auto  — pick the backend that needs NO VR-entry reload. Headset seen here + WebGPU-XR flags (XRGPUBinding)
//           → WebGPU (VR enters on WebGPU-XR). Headset seen + no flags → WebGL (VR enters in place). No headset
//           → WebGPU if the machine can, else WebGL (best desktop). three falls back to WebGL on its own if WebGPU init fails.
//   webgpu — force WebGPU (VR uses WebGPU-XR if flags, else reloads to WebGL to enter — the panel warns).
//   webgl  — force WebGL always (guaranteed WebGL; A/B, or a machine where WebGPU misbehaves).
// ?webgl=1 / ?webgpu=1 win for the session; the persisted preference otherwise.
// ?xr=1 is a BOOT flag (xr.enabled before renderer.init so the adapter is requested xrCompatible); it is the
// VALUE that decides — `?xr=0` is a desktop boot (review 2026-09-10 #6).
// forceWebGL is true when: explicit webgl; OR auto with a headset seen but no WebGPU-XR flags (so VR enters
// without a reload); OR an XR boot that isn't going to ride WebGPU-XR.
// The tolerant render list (core.js) installs at boot only for an XR boot; a desktop session gets it from
// enterVR() right before the session request (review 2026-09-08).
export function decideBackend({ params, backendPref, headsetSeen, webgpuXR }) {
  const xrBoot = params.get('xr') === '1';
  const pref = params.get('webgl') === '1' ? 'webgl' : params.get('webgpu') === '1' ? 'webgpu' : (backendPref || 'auto');
  const xrOnWebGPU = pref !== 'webgl' && !!webgpuXR;
  const forceWebGL = pref === 'webgl'
    || (pref === 'auto' && !!headsetSeen && !webgpuXR)
    || (xrBoot && !xrOnWebGPU);
  return { xrBoot, backendPref: pref, xrOnWebGPU, forceWebGL, installTolerance: xrBoot };
}
