// server/v4/operators.ts — who operates this door (WORLD_ADMIN), by ACCOUNT only (security review 10-06 C3).
// An operator is owner everywhere and the unban path of last resort, so the list names proven accounts —
// "human:discord:<id>", "agent:token:<id>", "aid1:<iss>:<sub>" — never a display name, which anyone can type.
// An entry with no ":" is refused at boot rather than silently ignored: an operator who THINKS they listed
// themselves must find out now, not when they're locked out.
const raw = (process.env.WORLD_ADMIN ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const bad = raw.filter((s) => !s.includes(":"));
if (bad.length) {
  throw new Error(`WORLD_ADMIN lists ${bad.map((s) => `"${s}"`).join(", ")}, which ${bad.length > 1 ? "aren't accounts" : "isn't an account"}: `
    + `an operator is named by account (human:discord:<id>, agent:token:<id>, aid1:<iss>:<sub>), never by a display name anyone can type`);
}
export const OPERATORS: ReadonlySet<string> = new Set(raw);
/** Is this connection's proven account an operator here? */
export const isOperator = (account: string | null | undefined): boolean => !!account && OPERATORS.has(account);
