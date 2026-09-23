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

/** A trailing ` (qualifier)` on a name, the house label convention
 *  (`#name (Guild)`, `Artie (kube)`): the part people drop when they address
 *  the thing. Only a final parenthetical counts; nothing inside the name moves. */
const TRAILING_QUALIFIER = /\s*\([^()]*\)\s*$/u;

/** The same pattern over every name a body answers to: its id (the mention
 *  handle) and its token display name (tokens.json `name`, e.g. "Artie (kube)"
 *  for id `artie-kube`), each also in its qualifier-dropped form, so "@Artie"
 *  reaches the body whose handle is longer than the name people actually use.
 *  Uniqueness is deliberately not required here, unlike channel-label
 *  resolution: two bodies that both answer to "Artie" are both addressed,
 *  which is what a room full of people does with a shared first name. Each
 *  alternative still matches only as a whole handle: a hyphen counts as part
 *  of one (`artie-kube` handles exist), so neither `artie` nor `artie-kube`
 *  matches inside `artie-kubernetes`. Malformed or empty entries are skipped,
 *  duplicates collapse case-insensitively, and a list with no usable name
 *  returns null exactly like `mentionRegex`. */
export function mentionRegexFor(names: readonly unknown[]): RegExp | null {
  const seen = new Set<string>();
  const parts: string[] = [];
  const add = (form: string) => {
    const key = form.toLowerCase();
    if (!form || seen.has(key)) return;
    seen.add(key);
    parts.push(form.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  };
  for (const candidate of names) {
    if (typeof candidate !== "string" || !candidate) continue;
    add(candidate);
    add(candidate.replace(TRAILING_QUALIFIER, ""));
  }
  if (parts.length === 0) return null;
  return new RegExp(`(?<![\\w@-])@?(?:${parts.join("|")})(?![\\w-])`, "i");
}
