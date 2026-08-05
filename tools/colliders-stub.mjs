// Test stand-in for client/lib/colliders.js — a re-export shim over
// parts-stub.mjs, NOT a second stub. It exists so that no two import
// specifiers ever resolve to the same plugin-returned path.
//
// parts-test used to map BOTH './world.js' and './colliders.js' onto
// parts-stub.mjs (which the test also imports directly, a third route to the
// same file). That many-to-one shape is the one plugin configuration in this
// suite that fails on macOS Bun 1.3.14 — ENOENT on a malformed
// "file:/private/..." path for exactly the shared file — while every
// one-to-one mapping (avatar-test's three stubs, collider-test's one) passes
// on the same machine. Consistent with module-cache keying tripping over a
// duplicate resolved path; this shim removes the duplicate rather than
// betting on the upstream behavior.
//
// A re-export keeps module identity: motion.js's reindexCollider and
// ragdoll.js's resolveColliders land on the SAME live bindings the test
// manipulates through parts-stub.
export { reindexCollider, resolveColliders } from './parts-stub.mjs';
