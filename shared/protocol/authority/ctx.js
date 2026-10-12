// shared/protocol/authority/ctx.js — the authority's per-call state, ONE object (refactor C4, 2026-10-12; was nine
// module-level lets in authority.js). request() and withAuthority() set it for the duration of one synchronous call
// through enter(), which saves the whole object and restores it on exit, so a nested call (leave → request(drop), a
// host callback re-entering the authority from a script's activation) never resets the outer call's state under it:
// review 10-06 S3 found two hand-written save/restore copies that already disagreed. Nothing in the authority awaits,
// so calls can't interleave. A leaf on purpose: it imports nothing, so the split the plan foresees (math/spatial →
// rights → physics → gate) can read the call's state without reaching the gate.
//   cat      the world's model catalogue ({get, list}); authority.js sets the lab's at load, request() the world's
//   through  the request's throughLock flag
//   isAnon   is this identity a guest (the directory's kind "anon")? from w.kindOf (security review 10-06 H4)
//   knownId  the directory knows this identity (a world without a directory, as in the lab, knows everyone)
//   nameOf   a person's name as they spell it (io.nameOf), for a refusal's words
//   mintW    the world whose ids a mint must avoid (§3d H7)
//   work     the call's work budget {left, until, k}; outside any call (a test reading the index): no budget
//   forking  the server's own fork copy is in progress (forkCopy → request("fork-copy")); set outside enter(), carried through it
export const CTX = {
  cat: null, through: false, isAnon: () => false, knownId: (_id) => true, nameOf: null, mintW: null,
  work: { left: Infinity, until: Infinity, k: 0 }, forking: false,
};
