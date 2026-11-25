// xr-prefs — the headset preferences (Settings › VR, vrpanel.js), persisted per browser, and the eye-resolution scale.
import { CONFIG, bus } from '../base.js';
import { POINTER_VIS_DEFAULT } from './xrpointer.js';

// ---- VR preferences (Settings › VR, vrpanel.js), persisted per browser
const PREF_XR = 'ew-xr-prefs';
const XR_PREF_DEFAULTS = { turn: 'smooth', vignette: false, mirror: 'first', seated: false, res: 'auto', pointerVisibility: POINTER_VIS_DEFAULT, dotVisibility: POINTER_VIS_DEFAULT };
export const xrPrefs = (() => { try { return { ...XR_PREF_DEFAULTS, ...JSON.parse(localStorage.getItem(PREF_XR) || '{}') }; } catch { return { ...XR_PREF_DEFAULTS }; } })();
{ const m = CONFIG.params.get('mirror'); if (m === 'off' || m === 'first' || m === 'third') xrPrefs.mirror = m; }   // URL override for A/B
// eye resolution as WebXR framebufferScaleFactor ('auto' = 1.0), read once at session start; ?xrres=0.2..1 overrides
export const XR_RES_SCALES = { auto: 1, 85: 0.85, 70: 0.7, 50: 0.5 };
export function xrResScale() {
  const q = +CONFIG.params.get('xrres');
  if (q >= 0.2 && q <= 1) return q;
  return XR_RES_SCALES[xrPrefs.res] ?? 1;
}
export function setXrPref(k, v) { xrPrefs[k] = v; try { localStorage.setItem(PREF_XR, JSON.stringify(xrPrefs)); } catch {} bus.emit('xr:prefs', xrPrefs); }
