// Treat a null eye framebuffer as the default framebuffer. A WebGL emulator (IWER) answers
// XRWebGLLayer.framebuffer with null; three r186's WebGLState.drawBuffers keys a WeakMap on it and throws
// (`Invalid value used as weak map key`), leaving the renderer with xr.enabled off. A real runtime never
// returns null, so the wrapper installs at sessionstart only when the base layer's framebuffer really is null,
// and answers with the default framebuffer's draw-buffer state ([BACK]). Tests: test/client/xr-nullfb-test.mjs,
// xr-render-errors-probe.mjs. Revisit at every three bump: if drawBuffers stops keying on the framebuffer, delete this.
export function tolerateNullXRFramebuffer(renderer) {
  const state = renderer?.backend?.isWebGLBackend ? renderer.backend.state : null;
  const xr = renderer?.xr;
  if (!state || !xr || typeof state.drawBuffers !== 'function') return null;
  const handle = { armed: true, installed: false, disarm() { handle.armed = false; } };   // disarm: the probe's --control
  xr.addEventListener('sessionstart', () => {
    if (!handle.armed || handle.installed || xr._glBaseLayer?.framebuffer !== null) return;   // undefined = no base layer (projection layers)
    const drawBuffers = state.drawBuffers;
    state.drawBuffers = function (renderContext, framebuffer) {
      if (framebuffer === null && renderContext?.textures != null) return drawBuffers.call(this, { textures: null, renderTarget: renderContext.renderTarget }, null);
      return drawBuffers.call(this, renderContext, framebuffer);
    };
    handle.installed = true;
  });
  return handle;
}
