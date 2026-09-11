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
import { requestAction, usePrompt, setInputAvailable, noteInput, typing } from './input.js';

setInputAvailable(() => net.joined && !CONFIG.renderer);

const point = new THREE.Vector3(), eye = new THREE.Vector3(), direction = new THREE.Vector3();
const projected = new THREE.Vector3();
let button = null, current = null, lastScan = -Infinity;
// "Is the keyboard someone else's right now" has one definition, in input.js —
// a second copy of the selector here drifted (it missed bare `contenteditable`).
const blocked = () => !net.joined || CONFIG.spectate || CONFIG.renderer || photoMode || isEditing() || isOverlayOpen()
  || document.visibilityState === 'hidden' || typing();

function choose() {
  if (blocked()) return null;
  camera.updateMatrixWorld();
  let best = null, nearest = 3;
  eye.copy(myState.pos); eye.y += 1;
  for (const id in state.st.entities) {
    const action = interactionAction(state.st.entities[id]);
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
    projected.copy(point).project(camera);
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
    button.tabIndex = -1;      // never in the tab order: see the focus note below
    button.className = 'ew-interaction';
    button.style.cssText = 'position:fixed;bottom:110px;left:50%;transform:translateX(-50%);z-index:6;max-width:calc(100vw - 32px);min-height:44px;padding:10px 18px;border:1px solid #a7e8d5;border-radius:10px;background:#102425ee;color:#e8fff7;font:600 14px/1.4 sans-serif;cursor:pointer';
    // A prompt you can click must never own the keyboard. A focused button
    // swallows every keydown before the window listener in controller.js —
    // the only source of `keys` — so all keyboard play dies until you click
    // the canvas again, and Enter/Space on it fire `click` (a `use` verb)
    // instead of opening chat. Declining mousedown's default is what declines
    // the focus; the click still fires. blur() covers the browsers that focus
    // on the click itself, and tabIndex keeps it out of the tab order.
    button.addEventListener('mousedown', event => event.preventDefault());
    button.addEventListener('click', event => { event.stopPropagation(); button.blur(); requestAction('use'); });
    button.addEventListener('pointerdown', event => noteInput(event.pointerType === 'touch' ? 'touch' : 'keyboard'));
    // Pointer presses stop here (a look-drag must not start under the prompt);
    // keydown deliberately does not — it belongs to the window.
    for (const type of ['pointerdown', 'mousedown']) button.addEventListener(type, event => event.stopPropagation());
    document.body.append(button);
  }
  if (blocked()) { button.hidden = true; return; }
  if (now - lastScan < 100) return;
  lastScan = now;
  current = choose();
  button.hidden = !current;
  if (current) button.textContent = `${usePrompt()} · ${current.label}`;
}
