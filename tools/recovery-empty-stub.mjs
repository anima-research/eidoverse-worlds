// Inert stand-ins for the scene-side modules remotes.js's import cone reaches but the capsule
// recovery path never exercises. Named exports only — a default export would let a typo resolve to
// undefined silently.
//
// The list is taken from every `import { … } from './<module>.js'` across client/lib for the five
// modules this file replaces, not discovered one SyntaxError at a time: a stub that grows by
// trial-and-error ends up shaped like the errors rather than like the modules.
//
// world.js
export const avatarMounts = new Map();
export const entities = new Map();
export const comps = new Map();
export const bagOf = (id) => comps.get(id) ?? null;
export function* bags() { yield* comps; }
export const metaOf = () => null;
export const behaviors = new Map();
export const editHolds = new Map();
export function mountTransform() { return null; }
export function setBodySeat() {}
export function entityMeta() { return null; }
export function findPart() { return null; }
export function socketWorldPos() { return null; }
export function seatSocket() { return null; }   // world.js: the seat socket child of a thing, or null (sockets merge 10-14)
export function socketsOn() { return []; }
export function parentIdOf() { return null; }
// seats.js
export function declareSeatState() {}
export function clearSeatState() {}
export function seatCorrectionFor() { return null; }
// reachnet.js
export function applyRemoteReach() {}
export function noteReachEvents() {}
export function clearMyReach() {}
export const myReachBag = null;
// poseclips.js — reached through assets.js in the composed tree (#197 normalises pose clips through
// it); the recovery path never parses one, so these only need to exist.
export function syncClipPhase() {}
export async function parsePoseAnimation() { return null; }
export function retargetPoseAnimation() { return null; }
// shared/wingpresence.js
export function applyWingFoldPresence() {}
export function applyOwnedWingFold() {}
export function wingFoldPresence() { return null; }
// xrbody.js — #197 has remotes.js apply remote XR poses. It reaches windows.js (and a DOM) through
// its own cone, and the capsule recovery path never applies a pose, so it is replaced wholesale.
export function applyRemoteXR() {}
export function xrHandWorld() { return null; }   // seatbody.js: a socket's vr policy asks where a tracked hand is
export function resetFingers() {}
export const xrBodyDebug = () => null;
// shared/presencewire.js — same: #197 wires presence through it; recovery never sends one.
export function applyPresenceWire() {}
export function applyVoiceWire() {}   // mic / hear ride the same packet (platecard.js); recovery never reads them
export function presenceWire() { return null; }
export function applyBodyWire() { return false; }   // this body's size / plate lift — recovery applies nothing
export function bodyWire() { return {}; }
// remotes.js stamps each sample with sampleTime (the one time base, PHYSICS §5.1). It is pure, so it is the real body,
// not an inert one: a sample's own capture time when it is sane against its frame's, else the frame's.
export const SAMPLE_STALE_MS = 1000;
export function sampleTime(pose, frameT) {
  const t = pose?.t;
  return typeof t === 'number' && Number.isFinite(t) && typeof frameT === 'number' && t <= frameT && t >= frameT - SAMPLE_STALE_MS ? t : frameT;
}
