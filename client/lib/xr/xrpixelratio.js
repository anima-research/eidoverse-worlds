// XR pixel-ratio guard (#32: the right eye painted over part of the left). three r186 multiplies every eye's
// viewport by renderer.getPixelRatio(), and nothing stops a setPixelRatio mid-session, so when the frame governor
// shed pixels the right eye's viewport moved. While presenting the ratio belongs to the XR layer: callers are
// deferred, not refused, and the last value asked for is handed back at exit via takeDeferred().
// Applied by core.js; test/client/xrpixelratio-test.mjs.
export function guardPixelRatioInXR(renderer) {
  if (!renderer || renderer.__xrPixelRatioGuard) return null;
  const apply = renderer.setPixelRatio.bind(renderer);
  let deferred = null;
  renderer.setPixelRatio = function setPixelRatio(value = 1) {
    if (renderer.xr?.isPresenting) {
      // writing the value already in force (XR's pinned 1) is the end of a save/change/restore (grassdiag.js) and
      // clears the request; a genuine request for exactly that value is lost too, until the caller asks again
      deferred = value === renderer.getPixelRatio() ? null : value;
      return;
    }
    apply(value);
  };
  const handle = {
    takeDeferred() { const v = deferred; deferred = null; return v; },
    get deferred() { return deferred; },
  };
  renderer.__xrPixelRatioGuard = handle;
  return handle;
}
