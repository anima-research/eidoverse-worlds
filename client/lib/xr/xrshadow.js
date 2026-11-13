// Shadows from the sun, not the head: while presenting, three r186 swaps in xr.getCamera() for every render call,
// the shadow pass included, so the map was drawn from the eyes. xr.enabled off around the pass (render.js
// renderAside's cure). Import-free: core.js applies it at boot; test/client/xrshadow-test.mjs drives it.
export function patchShadowNodeForXR(proto) {
  const orig = proto?.updateShadow;
  if (typeof orig !== 'function' || orig.__xrPatched) return false;
  const patched = function (frame) {
    const xr = frame?.renderer?.xr;
    if (!xr?.isPresenting) return orig.call(this, frame);
    const was = xr.enabled; xr.enabled = false;
    try { return orig.call(this, frame); } finally { xr.enabled = was; }
  };
  patched.__xrPatched = true;
  proto.updateShadow = patched;
  return true;
}
