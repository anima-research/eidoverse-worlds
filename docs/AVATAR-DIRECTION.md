# Avatars: direction

Not protocol. `spec/PROTOCOL.md` ("Body ownership (avatars)") keeps the one
rule that binds today: when body parts become entities, **every write to a
body goes through the one request path, and the body's owner decides**.
What follows is how we expect to build that, kept here until avatars are
shared and the first implementation tests it (the house's markup on #260,
2026-10-20, item D). The names it uses are reserved in the registry now.

- **B4 (precedence between consent, the body's owner and the world) was
  taken out**, as the markup asked: a rule that fixes an order between a
  world and the person in the body is a policy, not the bone. What a world
  may do about a body it doesn't want (refuse it at arrival, remove the
  person, hide them, set budgets) and what it may not (edit or lock it) is
  for the avatar design to settle.

- **B1. The body's owner is its wearer, stamped by the authority at wear.**
  When a person arrives wearing an avatar (`arrive {wearing: {avatar,
  hash}}`, presence like any arrival: B6), the authority stamps the body
  root's owner (`body-owner`, never set by a request). It is the wearer, or the world for a body the world
  lends. It MUST NOT be derived from the log's history (who created which
  part) or from a role. Every entity under the root is the owner's, whoever
  authored it.
- **B2. One predicate, in `admit`, on every op.** It runs for **every** op
  `admit` sees on a body root or anything under one: the asker's, a
  handler's or script's, and the authority's own follow-ups and system
  writes (PROTOCOL §7's consequences table), which otherwise skip the asker's rights
  and locks. It comes before the owner short-circuit, before `editOthers`
  and before any handler's or script's rights: the body's owner and their
  live grantees MAY write it without `build`; everyone else MUST be
  refused, the world owner included. **No authority consequence writes a
  body part**: a deletion's set-down and a resettle pass a body part by,
  and a reference from a body part to a world thing that is gone is nulled
  **at read time** (it reads as naming nothing, as any dangling reference
  does), never cleared by a write, since the world authority can't write
  into the wearer's log (B6) atomically with its own. The refusal is code
  `body` and one sentence ("that's part of <person>'s body"): no ids, no
  creator, no locker, no did-you-mean.
- **B3. The same predicate on every path to a body part:** the hand path
  (grab, put, throw, drop, punt), `publish`, and `create {from}` (a
  duplicate) MUST run it on the *source* parts, not only on what they write.
  A world script's `scope` never covers a body part; a script on a body
  part is sponsored only by the body's owner.
- **B5. Co-editing is the owner's grant.** `edit-grant:<identity> {until?,
  scope?: "subtree" | [ids]}` on the body root, in the wearer's log. It
  ends when the owner deletes it or when `until` passes (read against entry
  timestamps, so a replay decides alike). It does **not** end when the
  grantee leaves: leaving is presence and never logged (PROTOCOL §5), so a rule keyed
  on it couldn't be replayed from the wearer's log, and writing every leave
  into that log as a revoke would make it an attendance list. An owner who
  wants a grant for one visit gives it an `until`, or deletes it. It is never copied by a duplicate or a
  publish, and no world script reads it. Revoking stops future edits, never
  past ones: what a co-editor did stays in history, and the owner may revert
  it. A co-editor gets attribution (history and the inspector say who
  edited what), never rights.
- **B6. Body edits live in the wearer's log.** The body is live in the
  world's hierarchy and edited with the same verbs, but its authored writes
  are stored in the wearer's log, never the world's. **The world's log
  records nothing about a body**: arriving wearing one (`arrive {wearing:
  {avatar, hash}}`, a reserved request) is presence like any arrival (PROTOCOL §5),
  never logged, so the permanent log never becomes an attendance list. The
  body's hash names the exact body and is moderation's evidence, so it
  reaches the **moderator log** only when someone acts about it: a report,
  a kick, a ban, or an arrival refused by `avatar-deny` (VRChat captures the
  avatar id at report time). A world founded with body writes in its log
  could never take them out again.
