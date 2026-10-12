// shared/protocol/verbclasses.js — the verb classes the authority and the wire agree on. Pure data, no imports: the
// authority (shared/protocol/authority.js) admits by them, the server's ws door (server/requestwire.ts) gates a spectator
// and meters reads by them. They were four literals in two files that had drifted (DEBT-SURVEY 10-12 #10); the pin is
// tools/protocol/verbclasses-check.ts, which holds each class as it stood on 2026-10-12. Changing a class is a decision.

// verbs that write nothing to the log (the custody guard lets them through: a world you can't sign for can still be read)
export const READ_ONLY = new Set(["help", "look", "inspect", "measure", "find", "lint", "history", "schema", "scripts", "modlog", "bans", "effect"]);

// what a ghost may still do: read the world (not its chat: history hides says from a ghost), walk, leave, end a chosen ghost.
// The moderation reads (modlog, bans) are not here and never will be: a ghost has no powers by definition — ghost+moderator
// is an oxymoron (R, 2026-10-12). A moderator who wants the modlog un-ghosts first.
export const GHOST_OK = new Set(["help", "look", "inspect", "measure", "find", "lint", "history", "schema", "scripts", "move", "leave", "wait", "ghost", "inbox", "effect"]);

// the authority's reads a SPECTATOR is refused at the door. Empty since 2026-10-12: a world's scripts and effects are part
// of what a spectator is looking at, and reading changes nothing (Hesperus's call, R deferred). Kept as a class so a
// future gate is one entry here, not a second literal.
export const SPECTATOR_GATED = new Set([]);

// the door's reads: metered as reads and the only requests a spectator may send. The authority's reads less the gated
// two, plus the door's own answers that write nothing: `wait` (the presence long-poll) and `whois` (the server's
// directory, answered before the authority). `inbox` is a ghost's but not a spectator's (a spectator has no body to be asked).
export const WIRE_READS = new Set([...[...READ_ONLY].filter((v) => !SPECTATOR_GATED.has(v)), "wait", "whois"]);

// acts on a person: after one succeeds the server sweeps (expels, re-rolls badges) — not the authority's concern
export const PERSON_ACTS = new Set(["warn", "mute", "unmute", "kick", "ban", "unban", "ghost", "unghost"]);
