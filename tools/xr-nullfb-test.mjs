// xr-nullfb-test — client/lib/xr_nullfb.js against a fake renderer: the wrapper installs ONLY for a session whose
// base layer's framebuffer is null (an emulator), never on hardware (an opaque WebGLFramebuffer) or without a base
// layer (projection layers), and once however many sessions follow. tools/xr-render-errors-probe.mjs covers the null
// branch in a real browser; nothing there can show the hardware branch, which this does.
//
// Run: BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun tools/xr-nullfb-test.mjs
//
// Mutations that must turn a named check red:
//   `framebuffer !== null` → `framebuffer`        → "no base layer: not installed"
//   `framebuffer !== null` dropped (always install) → "hardware: not installed, drawBuffers untouched"
//   `handle.installed ||` dropped                 → "two null sessions: wrapped once"
import { EventDispatcher } from 'three';
import { tolerateNullXRFramebuffer } from '../client/lib/xr_nullfb.js';
import { checker } from './probe-harness.mjs';
const { check, done } = checker();

function rig(baseLayer) {
  const calls = [];
  const drawBuffers = function (rc, fb) { calls.push({ rc, fb, self: this }); };
  const state = { drawBuffers };
  const xr = new EventDispatcher(); xr._glBaseLayer = baseLayer;
  const renderer = { backend: { isWebGLBackend: true, state }, xr };
  const handle = tolerateNullXRFramebuffer(renderer);
  return { calls, drawBuffers, state, xr, handle, start: () => xr.dispatchEvent({ type: 'sessionstart' }) };
}
const rc = { textures: ['t'], renderTarget: 'rt' };

{ const r = rig({ framebuffer: {} });   // hardware: an opaque WebGLFramebuffer
  check('armed before any session, nothing installed', r.handle?.armed === true && r.handle.installed === false && r.state.drawBuffers === r.drawBuffers);
  r.start();
  check('hardware (non-null framebuffer): not installed, drawBuffers untouched', r.handle.installed === false && r.state.drawBuffers === r.drawBuffers);
  const fb = {}; r.state.drawBuffers(rc, fb);
  check('hardware: a draw passes its arguments through as given', r.calls.length === 1 && r.calls[0].rc === rc && r.calls[0].fb === fb); }

{ const r = rig({ framebuffer: null });   // IWER / the Immersive Web Emulator
  r.start();
  check('emulator (null framebuffer): installed', r.handle.installed === true && r.state.drawBuffers !== r.drawBuffers);
  r.state.drawBuffers(rc, null);
  check('emulator: a null-target draw gets the default framebuffer\'s state (no textures), same render target',
    r.calls.length === 1 && r.calls[0].fb === null && r.calls[0].rc.textures === null && r.calls[0].rc.renderTarget === 'rt' && r.calls[0].self === r.state);
  const fb = {}; r.state.drawBuffers(rc, fb);
  check('emulator: a draw to a real framebuffer passes through as given', r.calls[1].rc === rc && r.calls[1].fb === fb);
  const once = r.state.drawBuffers;
  r.start();
  r.calls.length = 0; r.state.drawBuffers(rc, null);
  check('two null sessions in a row: wrapped once', r.state.drawBuffers === once && r.calls.length === 1); }

{ const r = rig(undefined); r.start();   // a session with projection layers has no XRWebGLLayer
  check('no base layer: not installed', r.handle.installed === false && r.state.drawBuffers === r.drawBuffers); }
{ const r = rig(null); r.start();
  check('a null base layer: not installed', r.handle.installed === false && r.state.drawBuffers === r.drawBuffers); }

{ const r = rig({ framebuffer: null }); r.handle.disarm(); r.start();
  check('disarmed (the probe\'s --control): never installs', r.handle.installed === false && r.state.drawBuffers === r.drawBuffers); }

check('not the WebGL backend: no handle, nothing to patch', tolerateNullXRFramebuffer({ backend: { isWebGLBackend: false, state: {} }, xr: new EventDispatcher() }) === null);
done();
