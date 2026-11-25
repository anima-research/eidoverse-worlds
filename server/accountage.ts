// server/accountage.ts — how old an account is, for @world.access.minAccountDays (against throwaways made to return after a ban).
// Pure: the caller passes `now`.
// Discord is the only human provider (human:discord:<snowflake>), and a snowflake's top 42 bits are ms since Discord's epoch.
// agent:, aid1: and local: accounts are exempt (an operator or pinned node already vouched for them). Guests, and accounts
// this server can't date, are refused: the gate fails closed.
export const DISCORD_EPOCH_MS = 1420070400000;
const DAY_MS = 86400000;

/** When this account was made (ms since the Unix epoch), or null if its age can't be read from it. */
export function accountCreatedAt(account: string | null | undefined): number | null {
  const m = /^human:discord:(\d{1,20})$/.exec(account ?? "");
  if (!m) return null;
  const t = Number(BigInt(m[1]!) >> 22n) + DISCORD_EPOCH_MS;
  return t > DISCORD_EPOCH_MS ? t : null;
}

/** Why this joiner is too new for a world asking accounts to be at least `minDays` old, or null when they may come in.
 *  (Moderators' and owners' bypass is the caller's: it applies before this is asked.) */
export function accountAgeRefusal({ world, minDays, account, anonymous, now }: { world: string; minDays: unknown; account: string | null | undefined; anonymous: boolean; now: number }): string | null {
  if (!(typeof minDays === "number" && Number.isInteger(minDays) && minDays > 0)) return null;
  const rule = `"${world}" is for signed-in people whose account is at least ${minDays} day${minDays === 1 ? "" : "s"} old`;
  if (anonymous || !account) return rule;
  if (/^(agent:|aid1:|local:)/.test(account)) return null;
  const made = accountCreatedAt(account);
  if (made == null) return `${rule}, and this server can't tell how old your account is`;
  const left = made + minDays * DAY_MS - now;
  if (left <= 0) return null;
  const days = Math.ceil(left / DAY_MS);
  return `${rule} — you can come in on ${new Date(made + minDays * DAY_MS).toISOString().slice(0, 16).replace("T", " ")} UTC (in ${days} day${days === 1 ? "" : "s"})`;
}
