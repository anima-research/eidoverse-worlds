// collider-off-bodies-test's renderer cone: everything unknown-comp-stub stands in for (core, assets, lightrig, lights,
// world's maps), with THREE's node materials mapped to their plain kin (createMesh and the structure palette build them),
// TSL as core-stub's chainable proxy, and the two imports the structure realizer adds (materials' prepareObject, defs'
// registry). colliders.js is NOT stubbed: the test reads the walker's own registry and resolveColliders.
import * as THREE_ from 'three';
export * from './unknown-comp-stub.mjs';
export { TSL } from './core-stub.mjs';
export const THREE = {
  ...THREE_,
  MeshBasicNodeMaterial: THREE_.MeshBasicMaterial,
  MeshStandardNodeMaterial: THREE_.MeshStandardMaterial,
  MeshPhysicalNodeMaterial: THREE_.MeshPhysicalMaterial,
  NodeMaterial: THREE_.MeshBasicMaterial,
};
export const prepareObject = () => {};
export const defsRegistry = () => new Promise(() => {});
