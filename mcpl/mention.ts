/** The "was I named?" pattern, built from an id.
 *
 *  🔴 ESCAPE THE NAME. This was built inline in three places from an id that
 *  arrives UNVALIDATED in tokens.json, so an id containing regex metacharacters
 *  produced an invalid RegExp — and the throw landed in a catch-all, meaning the
 *  agent silently never heard its own name again, for the life of the process,
 *  with one log line and no other symptom. (`a(` and `x[` throw; `b+` does not
 *  throw but silently changes what matches.)
 *
 *  🔴 AND \b IS WRONG AFTER A NON-WORD CHARACTER. `\b` asserts a WORD boundary,
 *  so `a\(\b` can never match: `(` is not a word character, so there is no
 *  boundary after it. The original pattern therefore failed to match any id
 *  ending in punctuation even once escaping was added — found by testing the
 *  escaped version rather than assuming it worked.
 *
 *  Lookarounds instead: "not preceded/followed by a word character" is the
 *  property actually wanted, and it holds regardless of what the id ends with.
 *
 *  🔴 AND THE TYPE IS A PROMISE, NOT A GUARANTEE (2026-08-16). `id: string` is
 *  erased at runtime, and this id comes from JSON.parse of an operator-edited
 *  file — net-server's readTokens() does no shape validation at all. A tokens
 *  entry missing `id`, or with a numeric one, reaches here and throws
 *  `id.replace is not a function` INSIDE the same catch-all as before: the agent
 *  is deaf to its own name for the life of the process, one log line, no other
 *  symptom. That is the identical failure the escaping fixed, arriving through a
 *  different door. Returns null so callers can decide; a thrown regex was never
 *  a useful answer to "was I named?". */
export function mentionRegex(id: unknown): RegExp | null {
  if (typeof id !== "string" || !id) return null;
  const safe = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![\\w@])@?${safe}(?![\\w])`, "i");
}
