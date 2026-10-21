// Shape rules shared by wire authoring and sandbox emission. These validate
// new intent only; historical entries still use the tolerant shared fold.

/** Why a light is refused: the rule in the words every surface uses (the
 *  SDK doc, the MCPL tool's description, spec/PROTOCOL.md). */
export const LIGHT_ID_REASON =
  "light needs an id: a string with at least one non-whitespace character (use the existing light's id for a partial update)";

export function lightArgsError(args: unknown): string | null {
  const id = args && typeof args === "object" && !Array.isArray(args)
    ? (args as Record<string, unknown>).id : undefined;
  return typeof id === "string" && id.trim().length > 0 ? null : LIGHT_ID_REASON;
}
