// multimove-test substitutes this for edit/multimove.js's hosted imports (core, world, net, colliders, writes).
import * as THREE_ from 'three';
export const THREE = THREE_;
export const entities = new Map();
export const bagOf = () => null;
export const drags = [];
export const sendDrag = (...a) => { drags.push(a); };
export const reindexed = [];
export const reindexCollider = (id) => { reindexed.push(id); };
export const compsOf = (id) => ({ id });
export const reverted = [];
export const revertPose = (id) => { reverted.push(id); };
export const sendOps = () => {};
export const flashHint = () => {};
