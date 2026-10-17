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

// READBACK (engine-scars 3.2/4/6c, R 10-17 02:45): the old entry fields the authority reads back for meaning. PROTOCOL §1
// says the fold never reads acts, and that stays true; the AUTHORITY does, in these places, and §12 lets an act's whole body
// be purged. So every one of these reads goes through storage.js readback(w, seq), which gives null for a purged body, and
// null is UNKNOWN: the right-hand side says what each reader does with unknown. A new readback is a new row here (and a
// reader that handles null), never a bare `entries[seq].body` read. Keys are `<kind>:<verb>` (`act:*` = any person's act).
export const READBACK = Object.freeze({
  "act:undo":    { fields: ["undoes", "rollback.acts"], where: "buildUndo depthOf/undoneBy, the act index, history rows", unknown: "undoes nothing we can name: the chain ends there and its target isn't counted undone" },
  "act:use":     { fields: ["capability.author", "capability.reaction", "request.id"], where: "rights.js entryBy (creatorOf, lastSetterOf), undo of your own use", unknown: "rights null (matches nobody); undo falls back to your own rights" },
  "act:script":  { fields: ["sponsor"], where: "rights.js entryBy (sponsorOf), the sponsor budget", unknown: "no sponsor: nothing runs on nobody's rights" },
  "act:sculpt":  { fields: ["request.brush", "clamped"], where: "buildUndo sculptInverse", unknown: "not exact: restore-before (refused if changed since)" },
  "act:*":       { fields: ["request.label", "request.id", "request.component", "request (a physics-engine build it typed)"], where: "undo {label}, undo's reply, restampEngine's chose()", unknown: "no label match; an unknown chooser of an engine build is the owner's: never restamped" },
  "act:system":  { fields: ["rest", "onto"], where: "the act index (restAfter), recentRests", unknown: "no rest link; no `onto` in the view" },
  "sim:launch":  { fields: ["id", "handled"], where: "restampEngine's in-flight walk, recentRests", unknown: "maybe in flight: no restamp; handled falls back to the launch's actor" },
  "sim:lift":    { fields: ["id"], where: "restampEngine's in-flight walk, orphanLifts", unknown: "maybe held: no restamp" },
  "sim:catch":   { fields: ["id"], where: "restampEngine's in-flight walk, orphanLifts", unknown: "maybe held: no restamp" },
});
