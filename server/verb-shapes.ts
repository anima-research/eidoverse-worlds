// Shape rules shared by wire authoring and sandbox emission. These validate
// new intent only; historical entries still use the tolerant shared fold.
export function lightArgsError(args: unknown): string | null {
  const id = args && typeof args === "object" && !Array.isArray(args)
    ? (args as Record<string, unknown>).id : undefined;
  return typeof id === "string" && id.trim().length > 0 ? null
    : "light needs a non-empty string id (use the existing light's id for a partial update)";
}
