// material-realizer-test substitutes this for everything client/lib/realize/material.js imports from the client (base,
// world, render/materials, mediaprefs, pictures): the realizer itself and shared/material.js stay real.
const handlers = new Map();
export const bus = {
  on(t, f) { (handlers.get(t) ?? handlers.set(t, []).get(t)).push(f); },
  emit(t, p) { for (const f of handlers.get(t) ?? []) f(p); },
};
export const entities = new Map();
export const comps = new Map();
export function* bags() { yield* comps; }
export function findPart(root, name) { let found = null; root.traverse((c) => { if (!found && c !== root && c.name === name) found = c; }); return found; }
export const prepareMaterial = () => false;
export const allowUntrusted = () => false;
// the last texture load the realizer asked for: a suite awaits it, and the realizer's continuation has run by then
export let lastLoad = null;
export function imageTexture(src) { lastLoad = Promise.resolve({ isTexture: true, src }); return lastLoad; }
