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
  return mentionRegexFor([id]);
}

/** The same pattern over every name a body answers to: its id (the mention
 *  handle) and its token display name (tokens.json `name`, e.g. "Artie (kube)"
 *  for id `artie-kube`), so "@Artie" reaches the body whose handle is longer
 *  than the name people actually use. Malformed or
 *  empty entries are skipped, duplicates collapse case-insensitively, and a
 *  list with no usable name returns null exactly like `mentionRegex`. */
export function mentionRegexFor(names: readonly unknown[]): RegExp | null {
  const seen = new Set<string>();
  const parts: string[] = [];
  for (const candidate of names) {
    if (typeof candidate !== "string" || !candidate) continue;
    const key = candidate.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    parts.push(candidate.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  }
  if (parts.length === 0) return null;
  return new RegExp(`(?<![\\w@])@?(?:${parts.join("|")})(?![\\w])`, "i");
}
