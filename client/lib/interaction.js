// One contextual action shared by keyboard, gamepad, and touch/button input.
// Components declare data; the existing use/behavior protocol owns effects.
import { THREE, camera } from './core.js';
import { bus, CONFIG } from './base.js';
import { myState, photoMode } from './controller.js';
import { isEditing } from './build.js';
import { isOverlayOpen } from './ui.js';
import { state } from './state.js';
import { entities } from './world.js';
import { structureObject } from './realize/structure.js';
import { raySegment } from './colliders.js';
import { net, sendVerb } from './net.js';
import { interactionAction } from '../../shared/interaction.js';
import { requestAction, usePrompt, setInputAvailable, noteInput } from './input.js';

setInputAvailable(() => net.joined && !CONFIG.renderer);

const point = new THREE.Vector3(), eye = new THREE.Vector3(), direction = new THREE.Vector3();
let button = null, current = null, lastScan = -Infinity;
const blocked = () => !net.joined || CONFIG.spectate || CONFIG.renderer || photoMode || isEditing() || isOverlayOpen()
  || document.visibilityState === 'hidden'
  || Boolean(document.activeElement?.closest('input, textarea, select, [contenteditable="true"], [role="dialog"]'));

function choose() {
  if (blocked()) return null;
  camera.updateMatrixWorld();
  let best = null, nearest = 3;
  eye.copy(myState.pos); eye.y += 1;
  for (const [id, entity] of Object.entries(state.st.entities)) {
    const action = interactionAction(entity);
    const object = structureObject(id) || entities.get(id);
    if (!action || !object?.visible || object.userData.placeholder) continue;
    object.updateWorldMatrix(true, false);
    object.getWorldPosition(point);
    point.y += 1;
    const distance = point.distanceTo(eye);
    if (distance > nearest) continue;
    direction.copy(point).sub(eye);
    if (distance > 0.01 && raySegment(eye, direction.normalize(), distance, id) !== null) continue;
    // Only something on screen can be used; approaching from behind still
    // works when the camera can see it, including third-person views.
    const projected = point.clone().project(camera);
    if (projected.z < -1 || projected.z > 1 || Math.abs(projected.x) > 1 || Math.abs(projected.y) > 1) continue;
    nearest = distance;
    best = { id, ...action };
  }
  return best;
}

function activate() {
  // Re-evaluate at the actual press: a stale prompt cannot use a moved object.
  const target = choose();
  if (!target) return;
  sendVerb('use', { id: target.id, action: target.action });
}

bus.on('input-action', action => { if (action === 'use') activate(); });

export function tickInteraction(now = performance.now()) {
  if (!button) {
    button = document.createElement('button');
    button.type = 'button';
    button.className = 'ew-interaction';
    button.style.cssText = 'position:fixed;bottom:110px;left:50%;transform:translateX(-50%);z-index:6;max-width:calc(100vw - 32px);min-height:44px;padding:10px 18px;border:1px solid #a7e8d5;border-radius:10px;background:#102425ee;color:#e8fff7;font:600 14px/1.4 sans-serif;cursor:pointer';
    button.addEventListener('click', event => { event.stopPropagation(); requestAction('use'); });
    button.addEventListener('pointerdown', event => noteInput(event.pointerType === 'touch' ? 'touch' : 'keyboard'));
    for (const type of ['pointerdown', 'mousedown', 'keydown']) button.addEventListener(type, event => event.stopPropagation());
    document.body.append(button);
  }
  if (blocked()) { button.hidden = true; return; }
  if (now - lastScan < 100) return;
  lastScan = now;
  current = choose();
  button.hidden = !current;
  if (current) button.textContent = `${usePrompt()} · ${current.label}`;
}
