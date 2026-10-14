// tools/unknown-comp-stub.mjs — the cone for tools/unknown-comp-test.ts.
//
// Everything tools/lod-client-stub.mjs stands in for (core, assets, colliders,
// lightrig, lights, world's maps), plus the one export motion.js needs from
// remotes.js (serverNow). The realizer, the fold, state.js and the bus stay
// REAL; this file only removes the renderer and the network.
export * from './lod-client-stub.mjs';
export const serverNow = () => Date.now();

// materials.js: the mesh thing (realize/models.js createMesh) hands its material to the factory; nothing to prepare here
export const prepareMaterial = () => {};
