// lifecycle — what the realizer holds, and the one word every registry built on a realized object listens for.
//
// Four registries used to decide "is this id real right now" each by its own presence test: world.js `entities`,
// the realizer's `tracked`, colliders.js, lightrig.js casters (+ its lamp owners). They stayed aligned only because
// retire/demote/tier-swap each remembered to call every release. Now the realizer says it ONCE — `release(id, phase)`
// — and the modules that built something on the object let go on that word, synchronously, before anything else
// runs: colliders.js drops the collider, lightrig.js the caster and the lamps owned by the entity. A registry that
// forgets to subscribe is a registry that leaks; tools/realized-lifecycle-test.ts pins all four at every seam.
//
// `tracked` is the realizer's own record of what it has handled ({kind, lib?, gen, …}); gen guards an async load
// completion against acting for a reservation retired and re-created while its bytes flew.
import { bus } from '../base.js';

/** id → {kind, lib?, gen, loading?, failedAt?, retierAt?} */
export const tracked = new Map();
let nextGen = 1;

/** Record that the realizer now holds `id` as `rec`; the gen returned is the handle an async completion checks. */
export function reserve(id, rec) {
  const gen = nextGen++;
  tracked.set(id, { ...rec, gen });
  return gen;
}
/** A new load for a standing id (a promote, a re-tier): the gen moves on, so the completion still in flight no-ops. */
export function regen(id) { const t = tracked.get(id); if (t) t.gen = nextGen++; return t?.gen; }
export const untrack = (id) => tracked.delete(id);
/** The owner key under which everything the realizer requests for an entity (loads, lamps, lights) is held. */
export const ownerOf = (id) => `entity:${id}`;

/** The realized object for `id` is going: 'retire' (the thing left the world), 'demote' (a stand-in replaces it),
 *  'swap' (another tier replaces it). Everything built on that object releases now. */
export function release(id, phase) {
  bus.emit('realized', { id, phase, owner: ownerOf(id) });
}
