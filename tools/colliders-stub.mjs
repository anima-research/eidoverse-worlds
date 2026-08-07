// Separate import target for client/lib/colliders.js in the parts-test loader.
// It re-exports the same live bindings as parts-stub so motion.js and
// ragdoll.js share one empty-world collider state. Keeping a distinct resolved
// filename also avoids depending on Bun's handling of many specifiers mapped
// to one plugin path; the runtime-cache guard in parts-test is the actual
// macOS determinism fix.
export { reindexCollider, resolveColliders } from './parts-stub.mjs';
