// Inert stand-ins for the scene-side modules remotes.js imports but the recovery path never exercises.
// Named exports only — a default export would let a typo resolve to undefined silently.
export const avatarMounts = new Map();
export function mountTransform() { return null; }
export function declareSeatState() {}
export function clearSeatState() {}
export function applyRemoteReach() {}
export function noteReachEvents() {}
export function syncClipPhase() {}
export function applyWingFoldPresence() {}
