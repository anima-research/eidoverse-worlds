/** The "was I named?" pattern, built from the names a body answers to: its
 *  id and its display name, both from tokens.json.
 *
 *  🔴 ESCAPE THE NAME. The pattern was first built inline in three places from
 *  an id that arrives UNVALIDATED in tokens.json, so an id containing regex
 *  metacharacters produced an invalid RegExp — and the throw landed in a
 *  catch-all, meaning the agent silently never heard its own name again, for
 *  the life of the process, with one log line and no other symptom. (`a(` and
 *  `x[` throw; `b+` does not throw but silently changes what matches.) A display
 *  name arrives the same way.
 *
 *  🔴 AND \b IS WRONG AFTER A NON-WORD CHARACTER. `\b` asserts a WORD boundary,
 *  so `a\(\b` can never match: `(` is not a word character, so there is no
 *  boundary after it. The original pattern therefore failed to match any id
 *  ending in punctuation even once escaping was added — found by testing the
 *  escaped version rather than assuming it worked.
 *
 *  Lookarounds instead: "not preceded/followed by a word character" is the
 *  property actually wanted, and it holds regardless of what a name ends with.
 *
 *  🔴 AND THE TYPE IS A PROMISE, NOT A GUARANTEE (2026-08-16). `id: string` is
 *  erased at runtime, and these names come from JSON.parse of an operator-edited
 *  file — net-server's readTokens() does no shape validation at all. A tokens
 *  entry missing `id`, or with a numeric one, used to reach the builder and
 *  throw `id.replace is not a function` INSIDE the same catch-all as before: the
 *  agent deaf to its own name for the life of the process, one log line, no
 *  other symptom. That is the identical failure the escaping fixed, arriving
 *  through a different door. So a name that isn't a non-empty string is
 *  skipped, and a list with none returns null so callers can decide; a thrown
 *  regex was never a useful answer to "was I named?". */

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
 *  returns null. Self-enrolled names must pass dropQualifiers:false: ownership
 *  of a full name does not grant its alias. The short form of a qualified
 *  name, whether it is the dropped alias or the body's own id, refuses a
 *  parenthetical after it, since "@Artie (cloud)" names a different resident;
 *  every other name is heard with an aside after it ("@Artie (quick
 *  question) can you look?" reaches a body named "Artie"). That includes
 *  another resident's qualifier: "@Artie (kube)" reaches a body named plain
 *  "Artie" too, since with only its own names a body can't tell a qualifier
 *  from an aside, and two bodies that answer to one first name are both
 *  addressed, as above. */
export function mentionRegexFor(names: readonly unknown[], { dropQualifiers = true }: { dropQualifiers?: boolean } = {}): RegExp | null {
  // A name's lower case keys it, and the first spelling listed is the one
  // kept: the `i` flag (without `u`) doesn't equate every pair toLowerCase()
  // folds together, such as the Kelvin sign and `k`, so the kept spelling is
  // the one the pattern matches, and the id, listed first, is kept.
  const forms = new Map<string, string>();   // lower-cased form -> the form
  const shorts = new Set<string>();          // short forms of the qualified names
  for (const candidate of names) {
    if (typeof candidate !== "string" || !candidate) continue;
    if (!forms.has(candidate.toLowerCase())) forms.set(candidate.toLowerCase(), candidate);
    const short = candidate.replace(TRAILING_QUALIFIER, "");
    if (!short || short === candidate) continue;
    shorts.add(short.toLowerCase());
    if (dropQualifiers && !forms.has(short.toLowerCase())) forms.set(short.toLowerCase(), short);
  }
  if (forms.size === 0) return null;
  const parts = [...forms].map(([key, form]) => form.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    + (shorts.has(key) ? "(?!\\s*\\([^()]*\\))" : ""));
  return new RegExp(`(?<![\\w@-])@?(?:${parts.join("|")})(?![\\w-])`, "i");
}
