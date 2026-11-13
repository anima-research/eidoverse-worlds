// bodysim — the body-physics engine is a CHOICE, not a fact of the client.
//
// One interface (the contract is in bodyengine.js's header), two engines: the pure-JS Verlet and the Bullet
// (ammo.js) rig ported from socketteer/ragdoll-physics. Everything downstream — goLimp, drag, nails, the presence
// stream — asks this factory and cannot tell which engine answered. A world mod can swap engines through EW.bodysim.

import { Ragdoll } from './ragdoll.js';
import { report } from '../base.js';

const KEY = 'ew-bodysim';

// name → { load, cls, failed }. Verlet is the floor: always present, needs no
// wasm door, and every other engine's failure lands on it. Order here is the
// order the 🧩 panel cycles through.
const ENGINES = new Map([
  ['verlet', { load: null, cls: Ragdoll, failed: false }],
  ['ammo', {
    load: async () => {
      const [mod, load] = await Promise.all([import('./ammodoll.js'), import('./ammo-load.js')]);
      return (await load.ensureAmmo()) ? mod.AmmoRagdoll : null;
    }, cls: null, failed: false,
  }],
]);

// The DEFAULT is the Bullet engine. While the wasm warms, or if it never opens, falls run verlet; a stored choice
// always wins over the default.
const stored = localStorage.getItem(KEY);
let engine = ENGINES.has(stored) ? stored : 'ammo';

async function loadEngine(name) {
  const e = ENGINES.get(name);
  if (!e) return false;
  if (e.cls) return true;
  e.failed = false;
  try {
    const cls = await e.load();
    if (cls) { e.cls = cls; return true; }
  } catch (err) { report(`${name} load`, err); }
  // A door that never opens must SAY so: "loading" forever is indistinguishable from a broken toggle.
  e.failed = true;
  return false;
}
if (engine !== 'verlet') loadEngine(engine);   // warm the wasm before the first fall

/** Status string, not a bare id: while a wasm engine loads (or after it fails)
 *  the string says which engine actually answers the next fall. */
export const bodyEngine = () => {
  if (engine === 'verlet') return 'verlet';
  const e = ENGINES.get(engine);
  if (e?.cls) return engine;
  return e?.failed ? `${engine} FAILED TO LOAD — running verlet`
                   : `${engine} (loading — verlet meanwhile)`;
};

/** The selected engine's bare id (the status string above is for humans). */
export const currentBodyEngine = () => engine;

/** Registered engine ids, in panel-cycle order. */
export const listBodyEngines = () => [...ENGINES.keys()];

export function setBodyEngine(name) {
  engine = ENGINES.has(name) ? name : 'verlet';
  localStorage.setItem(KEY, engine);
  const e = ENGINES.get(engine);
  if (e?.load && !e.cls) loadEngine(engine);
}

/** The one door every fall goes through. Same signature as `new Ragdoll`.
 *  seedVel is LOAD-BEARING: main.js passes the drag-release handover as the 4th argument (`msg?.sim ?? dragVel`);
 *  drop it and every release restarts the body at zero velocity. The parity suites construct engines directly and
 *  would not notice. */
export function makeRagdoll(avatar, lean = null, rest = null, seedVel = null) {
  // A held pose that lowers the hips (kneeling) hands its drop to the root first (avatar.js bakeHipsIntoRoot); the
  // caller's rest map was read before that, so re-read it.
  if (avatar.bakeHipsIntoRoot?.() && rest) rest = avatar.restBonePositions();
  const e = ENGINES.get(engine);
  if (e?.cls && e.cls !== Ragdoll) {
    try { return new e.cls(avatar, lean, rest, seedVel); }
    catch (err) { report(`${engine} construct — verlet fallback`, err); }
  }
  return new Ragdoll(avatar, lean, rest, seedVel);
}
