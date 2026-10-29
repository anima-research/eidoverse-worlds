// world — the desk's world frame as a VR quad, on the same-source pattern:
// spawn the curated starters through the SAME verb build.js sends (same id
// minting, same undo entry), and preview the sky presets through the SAME
// previewSky the desk's preset buttons call. The desk's 'log to world' for
// the sky lives in a closure with the clock rules (skypanel gather()) — not
// duplicated here; the quad says 'preview' and the desk commits. owner, 09-04
// 22:02: every slot opens that frame's quad; this is the world frame's.
import * as OP from '../../shared/protocol/requests.js';
import { sendOps } from './editwrites.js';
import { bus } from './base.js';
import { myState } from './controller.js';
import { starterModels } from './catalog.js';
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
/** A model 1.5 m ahead, on the floor, facing the way you face — the hand-free place (a headset has no
 *  cursor to carry a ghost). One undo entry. Also the Create panel's VR body (editpanels.js). */
export function spawnAhead(lib) {
  const yaw = myState.yaw ?? 0;
  const p = [myState.pos.x + Math.sin(yaw) * 1.5, myState.pos.y, myState.pos.z + Math.cos(yaw) * 1.5];
  // the authority mints its id (R 10-17: writers never choose ids); resolves with the id it became
  return sendOps([OP.create('$thing', { model: lib, transform: { pos: [+p[0].toFixed(2), +p[1].toFixed(2), +p[2].toFixed(2)], q: [0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2)] } })], { what: 'place it ahead', expect: false }).then((r) => r?.ids?.$thing ?? null);
}
function dispatch(k, id) {
  if (k === 'spawn' && id) {
    spawnAhead(id);   // then grab it
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
