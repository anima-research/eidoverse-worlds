// SHADOWS FROM THE SUN, NOT THE HEAD (R 09-07 18:48): while presenting, three's Renderer.render() swaps in
// xr.getCamera() for EVERY render call (r186 'use XR camera for rendering') — including the shadow pass's own
// render from shadow.camera — so in VR the map was drawn from the eyes: a full extra scene pass per frame that
// produced no usable shadow. Same cure as render.js renderAside: xr OFF around the pass so the sun camera is
// honoured, restored on every exit. Lives here, import-free, so core.js applies it once at boot and
// tools/xrshadow-test.mjs drives it against a recording prototype.
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
