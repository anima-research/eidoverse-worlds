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
 *  property actually wanted, and it holds regardless of what the id ends with. */
export function mentionRegex(id: string): RegExp {
  const safe = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![\\w@])@?${safe}(?![\\w])`, "i");
}
