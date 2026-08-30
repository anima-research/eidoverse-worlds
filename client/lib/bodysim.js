// bodysim — the body-physics engine is a CHOICE, not a fact of the client.
//
// Engines, one interface (the contract prose lives in ammodoll.js's header;
// it descends from the retired rapierdoll's — §24j retirement, survey B2):
// the pure-JS Verlet that shipped first, and the Bullet (ammo.js) rig ported
// from socketteer/ragdoll-physics. The Rapier articulated solver is RETIRED
// (2026-08-27): panel-only reachability, no hair/finger/wing parity, flat
// ground, and a permanent two-way divergence tax on every physics fix — its
// one unshipped capability (decaying tone motors) is recoverable from git
// history and tools/rapier-spike.ts if ever wanted. Everything
// downstream — goLimp, drag, nails, the presence stream — asks this factory
// and cannot tell which engine answered. A world mod can swap engines through
// EW.bodysim: the lease thesis applied to our own house physics.

import { Ragdoll } from './ragdoll.js';
import { report } from './base.js';

const KEY = 'ew-bodysim';

// name → { load, cls, failed }. Verlet is the floor: always present, needs no
// wasm door, and every other engine's failure lands on it. Order here is the
// order the 🧩 panel cycles through.
const ENGINES = new Map([
  ['verlet', { load: null, cls: Ragdoll, failed: false }],
  ['ammo', {
    load: async () => {
      const mod = await import('./ammodoll.js');
      return (await mod.ensureAmmo()) ? mod.AmmoRagdoll : null;
    }, cls: null, failed: false,
  }],
]);

// The DEFAULT is the Bullet engine (antra, after a day of live falls across
// old and new avatars: "these physics are just plainly better than anything
// else we had so far"). The ladder below keeps every promise the old default
// made: while the wasm warms — or if it never opens — falls run verlet, and
// a stored choice always wins over the default.
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
  // A door that never opens must SAY so. Reporting "loading" forever is
  // indistinguishable from a toggle that does not work, and that ambiguity
  // cost a full round of debugging the wrong engine.
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
 *
 *  seedVel is LOAD-BEARING and was silently dropped here until 2026-08-04:
 *  main.js hands the drag-release handover through this door as the 4th
 *  argument (`msg?.sim ?? dragVel`), and a 3-parameter signature ate it. Both
 *  engines' snapshot()/seed paths were therefore unreachable in the shipped
 *  client — every release reset the body to zero velocity and re-baked the
 *  rendered bone positions as the new sim's shape, which is what "really bad
 *  with drags" was. A dropped optional argument is invisible in JS; the
 *  parity suites never saw it because they construct the engines directly. */
export function makeRagdoll(avatar, lean = null, rest = null, seedVel = null) {
  const e = ENGINES.get(engine);
  if (e?.cls && e.cls !== Ragdoll) {
    try { return new e.cls(avatar, lean, rest, seedVel); }
    catch (err) { report(`${engine} construct — verlet fallback`, err); }
  }
  return new Ragdoll(avatar, lean, rest, seedVel);
}
