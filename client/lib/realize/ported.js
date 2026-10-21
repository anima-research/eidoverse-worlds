// Which verbs the models realizer owns. A Set of strings and nothing else.
//
// Split out of models.js because causes.js — the module that turns world entries into
// CHAT LINES — needs this taxonomy while needing nothing else from the realizer, and
// models.js reaches the engine. Without the split a client with no renderer could not
// narrate its own chat, which is most of what a lite client is for. models.js
// re-exports it, so its public surface is unchanged.
export const PORTED = new Set(['spawn', 'place', 'remove', 'light', 'comp', 'motion', 'mount', 'dismount']);
