// server/operators.ts — who operates this server (SERVER_OPERATORS), by ACCOUNT only (security review 10-06 C3).
// A server operator is owner everywhere and the unban path of last resort, so the list names proven accounts —
// "human:discord:<id>", "agent:token:<id>", "aid1:<iss>:<sub>" — never a display name, which anyone can type.
// An entry with no ":" is refused at boot rather than silently ignored: an operator who THINKS they listed
// themselves must find out now, not when they're locked out.
// WORLD_ADMIN is the legacy name, read and merged for one release with a warning (R 10-27; docs/TRANSLATING-OLD-WORLDS.md).
const list = (v: string | undefined) => (v ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const current = list(process.env.SERVER_OPERATORS), legacy = list(process.env.WORLD_ADMIN);
const raw = [...current, ...legacy];
const bad = raw.filter((s) => !s.includes(":"));
if (bad.length) {
  const from = [current.some((s) => bad.includes(s)) && "SERVER_OPERATORS", legacy.some((s) => bad.includes(s)) && "WORLD_ADMIN (its old name)"].filter(Boolean).join(" and ");
  throw new Error(`${from} lists ${bad.map((s) => `"${s}"`).join(", ")}, which ${bad.length > 1 ? "aren't accounts" : "isn't an account"}: `
    + `a server operator is named by account (human:discord:<id>, agent:token:<id>, aid1:<iss>:<sub>), never by a display name anyone can type. `
    + `Write it as SERVER_OPERATORS=human:discord:123456789012345678 (sign in, then open /whoami: its "sub" is your account); WORLD_ADMIN is its old name, read the same way until it is removed`);
}
if (legacy.length) console.warn(`[operators] WORLD_ADMIN is deprecated and will stop being read: rename it to SERVER_OPERATORS (same accounts, comma-separated)`);
export const OPERATORS: ReadonlySet<string> = new Set(raw);
/** Is this connection's proven account a server operator here? */
export const isOperator = (account: string | null | undefined): boolean => !!account && OPERATORS.has(account);
