/** The "was I named?" pattern, built from the names a body answers to (its id and tokens.json display name).
 *  Names arrive unvalidated from an operator-edited file: escape them, skip any that isn't a non-empty string, and
 *  use lookarounds rather than \b (which can't match after a name ending in punctuation). */

/** A trailing ` (qualifier)` on a name, the house label convention
 *  (`#name (Guild)`, `Artie (kube)`): the part people drop when they address
 *  the thing. Only a final parenthetical counts; nothing inside the name moves. */
const TRAILING_QUALIFIER = /\s*\([^()]*\)\s*$/u;

/** One pattern over every name a body answers to (id and display name, each also qualifier-dropped, so "@Artie"
 *  reaches "Artie (kube)"). Whole handles only (a hyphen is part of one); null when no usable name. Self-enrolled
 *  names pass dropQualifiers:false (owning a full name doesn't grant its alias). A qualified name's short form
 *  refuses a parenthetical after it ("@Artie (cloud)" is someone else). */
export function mentionRegexFor(names: readonly unknown[], { dropQualifiers = true }: { dropQualifiers?: boolean } = {}): RegExp | null {
  // keyed by lower case, first spelling kept (the id): `i` without `u` doesn't equate every toLowerCase() pair
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
