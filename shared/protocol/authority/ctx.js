// shared/protocol/authority/ctx.js — the authority's per-call state, ONE object. request() and withAuthority() set it
// for one synchronous call through enter(), which saves the whole object and restores it on exit, so a nested call
// (leave → request(drop), a host callback) never resets the outer call's state. Nothing in the authority awaits, so
// calls can't interleave. A leaf on purpose: it imports nothing, so every layer can read the call's state.
//   cat      the world's model catalogue ({get, list}); NO_CATALOGUE at load (catalogue.js), request() the world's
//   through  the request's throughLock flag
//   isAnon   is this identity a guest (the directory's kind "anon")? from w.kindOf
//   knownId  the directory knows this identity (a world without a directory, as in the lab, knows everyone)
//   nameOf   a person's name as they spell it (io.nameOf), for a refusal's words
//   mintW    the world whose ids a mint must avoid (§3d H7)
//   work     the call's work budget {left, until, k}; outside any call (a test reading the index): no budget
//   forking  the server's own fork copy is in progress (forkCopy → request("fork-copy")); set outside enter(), carried through it
//   operator the identity whose recorded operator repair is in progress, else false (operatorRepair → request): only @world's door components
//            (roles:*, access, default-role, role-defs) and lifting a ban or kick pass without the world's own rights;
//            set outside enter(), carried through it
export const CTX = {
  cat: null, through: false, isAnon: () => false, knownId: (_id) => true, nameOf: null, mintW: null,
  work: { left: Infinity, until: Infinity, k: 0 }, forking: false, operator: false,
};
// UP: the functions a leaf calls in a layer ABOVE it (the gate, or a leaf split out of authority.js after it). A leaf may not
// import those (authority-layers-check: the import graph can't cycle), so each such leaf names them through a one-line
// forwarder over UP, and authority.js binds UP once, at load, after every module has evaluated.
// Not per-call state: enter() saves and restores CTX, never UP.
export const UP = {};
