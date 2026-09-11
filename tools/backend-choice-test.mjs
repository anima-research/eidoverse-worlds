// Renderer selection is a pure function (client/lib/backend_choice.js) so the matrix core.js acts on at
// import can be checked without a GPU. Review 2026-09-10 #6: `?xr=0` used to boot XR (presence-only flag).
import { decideBackend } from '../client/lib/backend_choice.js';

let pass = 0, fail = 0;
const check = (name, ok, note = '') => { if (ok) { pass++; console.log(`  ok    ${name}`); } else { fail++; console.log(`  FAIL  ${name}${note ? `  -- ${note}` : ''}`); } };
const d = (q, o = {}) => decideBackend({ params: new URLSearchParams(q), backendPref: null, headsetSeen: false, webgpuXR: false, ...o });

console.log('BACKEND CHOICE');
check('?xr=1 is an XR boot', d('xr=1').xrBoot === true);
check('?xr=0 is NOT an XR boot', d('xr=0').xrBoot === false);
check('bare ?xr is NOT an XR boot', d('xr').xrBoot === false);
check('no ?xr is not an XR boot', d('').xrBoot === false);
check('XR boot without WebGPU-XR forces WebGL', d('xr=1').forceWebGL === true);
check('XR boot with WebGPU-XR flags stays on WebGPU', d('xr=1', { webgpuXR: true }).forceWebGL === false && d('xr=1', { webgpuXR: true }).xrOnWebGPU === true);
check('?xr=0 on a WebGPU desktop does not force WebGL', d('xr=0', { webgpuXR: false }).forceWebGL === false);
check('tolerant render list installs at boot only for an XR boot', d('xr=1').installTolerance === true && d('xr=0').installTolerance === false && d('').installTolerance === false);
check('?webgl=1 forces WebGL', d('webgl=1').forceWebGL === true && d('webgl=1').backendPref === 'webgl');
check('?webgpu=1 wins over a persisted webgl preference', d('webgpu=1', { backendPref: 'webgl' }).backendPref === 'webgpu');
check('persisted webgl preference forces WebGL', d('', { backendPref: 'webgl' }).forceWebGL === true);
check('auto + headset seen + no WebGPU-XR flags → WebGL (VR enters without a reload)', d('', { headsetSeen: true }).forceWebGL === true);
check('auto + headset seen + WebGPU-XR flags → WebGPU', d('', { headsetSeen: true, webgpuXR: true }).forceWebGL === false);
check('auto + no headset → WebGPU', d('').forceWebGL === false);
check('explicit webgpu + headset seen + no flags stays on WebGPU (the panel warns; no silent override)', d('', { backendPref: 'webgpu', headsetSeen: true }).forceWebGL === false);
check('explicit webgpu + XR boot + no flags forces WebGL (XR cannot ride WebGPU here)', d('xr=1', { backendPref: 'webgpu' }).forceWebGL === true);
check('tolerant render list does NOT install for a headset-seen desktop boot', d('', { headsetSeen: true }).installTolerance === false && d('', { headsetSeen: true, webgpuXR: true }).installTolerance === false);
check('explicit webgl + XR boot with flags still forces WebGL', d('xr=1&webgl=1', { webgpuXR: true }).forceWebGL === true && d('xr=1&webgl=1', { webgpuXR: true }).xrOnWebGPU === false);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
