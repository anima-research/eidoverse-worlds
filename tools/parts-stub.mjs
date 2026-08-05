// Test stand-in for client/lib/world.js AND client/lib/colliders.js — see
// tools/parts-test.ts. Both resolve here so the test never drags in the
// renderer cone.
export const entities = new Map();
export const comps = new Map();
export const reindexCollider = () => {};

// motion.js itself needs only the four names above, but its import cone now
// reaches ragdoll.js (via remotes.js), which imports resolveColliders from the
// same stubbed './colliders.js' — so a stub missing it fails the whole module
// graph with "Export named 'resolveColliders' not found". Nothing under test
// here collides; return the bare terrain height, which is what an empty world
// of colliders would report.
export const resolveColliders = (pos, terrainAt) => terrainAt(pos.x, pos.z);

// remotes.js (same cone, via motion.js) reads the mount table. Nothing under
// test mounts anything, so an empty table and a "not riding" answer are the
// honest stubs — mountTransform returns null for a rider with no mount.
export const avatarMounts = new Map();
export const mountTransform = () => null;

// same contract as world.js findPart: name → node, misses retry after 1s
const _partCache = new WeakMap();
export function findPart(root, name) {
  let map = _partCache.get(root);
  if (!map) { map = new Map(); _partCache.set(root, map); }
  const hit = map.get(name);
  if (hit && (hit.obj || Date.now() - hit.at < 1000)) return hit.obj;
  let found = null;
  root.traverse((c) => { if (!found && c !== root && c.name === name) found = c; });
  map.set(name, { obj: found, at: Date.now() });
  return found;
}
