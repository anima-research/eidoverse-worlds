// Browser lifetime/focus boundary shared by keyboard, touch, and gamepad.
import { bus } from './base.js';
import { isOverlayOpen } from './ui.js';
import { createPadInput, movement } from '../../shared/input.js';

export const keys = new Set();
export const touchState = { moveX: 0, moveZ: 0, lookId: null, lastX: 0, lastY: 0 };
export let activeInput = 'keyboard';
const padInput = createPadInput();
let available = () => true;
let pad = padInput.sample([]);
export function setInputAvailable(fn) { available = fn; }
export const typing = () => Boolean(document.activeElement?.closest(
  'input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="dialog"], dialog'));
export const inputBlocked = () => !available() || document.hidden || !document.hasFocus() || typing() || isOverlayOpen();
export function noteInput(kind) {
  if (kind === activeInput) return;
  activeInput = kind;
  bus.emit('input-device', kind);
}
export function clearInput() {
  keys.clear();
  touchState.moveX = touchState.moveZ = 0; touchState.lookId = null;
  padInput.clear(); pad = padInput.sample([]);
  bus.emit('input-clear');
}
addEventListener('blur', clearInput);
addEventListener('pagehide', clearInput);
addEventListener('gamepaddisconnected', () => { clearInput(); noteInput('keyboard'); });
document.addEventListener('visibilitychange', clearInput);
document.addEventListener('focusin', () => { if (inputBlocked()) clearInput(); });
bus.on('net', net => { if (!net.joined) clearInput(); });

export function pollInput() {
  const blocked = inputBlocked();
  if (blocked) clearInput();
  let pads = [];
  // Missing API, insecure context, and Permissions Policy denial all retain
  // keyboard/touch operation. Never let SecurityError escape the frame loop.
  try { pads = navigator.getGamepads?.() ?? []; } catch { /* unavailable */ }
  pad = padInput.sample(pads, !blocked);
  if (pad.active) noteInput('gamepad');
  if (!pad.connected && activeInput === 'gamepad') noteInput('keyboard');
  if (pad.edges.cancel) bus.emit('input-action', 'cancel');
  else if (pad.edges.use) bus.emit('input-action', 'use');
  return pad;
}
export function movementInput() { return movement(keys, touchState, pad); }
export function requestAction(action) {
  if (!inputBlocked()) bus.emit('input-action', action);
}
export function usePrompt() { return activeInput === 'gamepad' ? 'X / □' : activeInput === 'touch' ? 'Tap' : 'E'; }
