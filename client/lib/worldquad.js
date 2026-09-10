// world — the desk's world frame as a VR quad, on the same-source pattern:
// spawn the curated starters through the SAME verb build.js sends (same id
// minting, same undo entry), and preview the sky presets through the SAME
// previewSky the desk's preset buttons call. The desk's 'log to world' for
// the sky lives in a closure with the clock rules (skypanel gather()) — not
// duplicated here; the quad says 'preview' and the desk commits. R, 09-04
// 22:02: every slot opens that frame's quad; this is the world frame's.
import { bus } from './base.js';
import { sendVerb } from './net.js';
import { myState } from './controller.js';
import { pushUndo } from './build.js';
import { starterModels } from './palette.js';
import { defsRegistry } from './defs.js';
import { previewSky, skyArgs } from './sky.js';
import { registerXRPanel } from './xrpanels.js';

let presets = {};   // name → sky args; fields() is synchronous, so cache the def
async function loadPresets() {
  try { presets = (await defsRegistry()).skyPresets ?? {}; } catch { presets = {}; }
  bus.emit('xr:repaint');
}

function fields() {
  return [
    { t: 'list', label: 'spawn', empty: 'no starters',
      rows: starterModels().map((m) => ({ id: m.path, label: m.name, actions: [{ k: 'spawn', label: 'spawn' }] })) },
    { t: 'list', label: 'sky (preview — log from the desk)', empty: 'no presets yet',
      rows: Object.keys(presets).map((name) => ({ id: name, label: name, actions: [{ k: 'sky', label: 'preview' }] })) },
  ];
}
function dispatch(k, id) {
  if (k === 'spawn' && id) {
    // 1.5 m ahead, on the floor, facing the way you face — then grab it
    const yaw = myState.yaw ?? 0;
    const p = [myState.pos.x + Math.sin(yaw) * 1.5, myState.pos.y, myState.pos.z + Math.cos(yaw) * 1.5];
    const thing = crypto.randomUUID().slice(0, 8);
    sendVerb('spawn', { id: thing, lib: id, pos: [+p[0].toFixed(2), +p[1].toFixed(2), +p[2].toFixed(2)], yaw: +yaw.toFixed(3) });
    pushUndo({ verb: 'remove', args: { id: thing } }, 'spawn');
  } else if (k === 'sky' && presets[id]) {
    previewSky({ ...skyArgs(), ...presets[id] });
    bus.emit('xr:repaint');
  }
}

export function initWorldQuad() {
  registerXRPanel({ id: 'world', title: 'world', fields, dispatch });
  loadPresets();
  bus.on('defs-updated', loadPresets);
}
