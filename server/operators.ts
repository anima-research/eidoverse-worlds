// server/operators.ts — who operates this server (SERVER_OPERATORS), by ACCOUNT only (security review 10-06 C3).
// A server operator holds a world owner's powers in every world and is the unban path of last resort, so the list names proven accounts —
// "human:discord:<id>", "agent:token:<id>", "aid1:<iss>:<sub>" — never a display name, which anyone can type.
// An entry with no ":" is refused loudly at boot, never silently ignored: an operator who THINKS they listed themselves must
// find out now. The server still boots with the good entries (review full-260 L10: refusing boot locked everyone out of every
// world), and with none left it mints the setup link as a server with no operator does.
// WORLD_ADMIN is the legacy name, read and merged for one release with a warning (R 10-27; docs/TRANSLATING-OLD-WORLDS.md).
// First run (R 10-28): with no operator at all, the server mints a one-use setup link; whoever opens it signed in becomes the
// operator, stored in OPERATORS_FILE and merged with the env at every boot (docs/TRANSLATING-OLD-WORLDS.md, "Becoming the operator").
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes, createHash, timingSafeEqual } from "node:crypto";
import { WORLDS_DIR } from "./config.ts";
import { writePrivate } from "./fsutil.ts";

/** The operators the setup link made: beside the worlds' other server files (.bans.json), 0600. */
export const OPERATORS_FILE = join(WORLDS_DIR, ".operators.json");
const list = (v: string | undefined) => (v ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const current = list(process.env.SERVER_OPERATORS), legacy = list(process.env.WORLD_ADMIN);
let unreadable: string | null = null;   // an operators file that doesn't parse: kept aside (claimSetup) before it is ever replaced
const stored: string[] = existsSync(OPERATORS_FILE) ? (() => {
  try { const j = JSON.parse(readFileSync(OPERATORS_FILE, "utf8")); return Array.isArray(j?.operators) ? j.operators.map(String) : []; }
  catch (e) { unreadable = readFileSync(OPERATORS_FILE, "utf8");
    console.error(`[operators] REFUSED ${OPERATORS_FILE}: it doesn't read (${(e as Error).message}), so it names no operator this boot. Fix it and restart; a setup-link claim keeps a copy of it as ${OPERATORS_FILE}.unreadable`); return []; }
})() : [];
const bad = [...current, ...legacy, ...stored].filter((s) => !s.includes(":"));
if (bad.length) {
  const from = [current.some((s) => bad.includes(s)) && "SERVER_OPERATORS", legacy.some((s) => bad.includes(s)) && "WORLD_ADMIN (its old name)", stored.some((s) => bad.includes(s)) && OPERATORS_FILE].filter(Boolean).join(" and ");
  console.error(`[operators] REFUSED: ${from} lists ${bad.map((s) => `"${s}"`).join(", ")}, which ${bad.length > 1 ? "aren't accounts" : "isn't an account"}, so ${bad.length > 1 ? "they operate" : "it operates"} nothing here: `
    + `a server operator is named by account (human:discord:<id>, agent:token:<id>, aid1:<iss>:<sub>), never by a display name anyone can type. `
    + `Write it as SERVER_OPERATORS=human:discord:123456789012345678 (sign in, then open /whoami: its "sub" is your account); WORLD_ADMIN is its old name, read the same way until it is removed. `
    + `With no operator left, this server prints a one-use setup link below, and whoever opens it signed in becomes the operator`);
}
const raw = [...current, ...legacy, ...stored].filter((s) => s.includes(":"));
if (legacy.length) console.warn(`[operators] WORLD_ADMIN is deprecated and will stop being read: rename it to SERVER_OPERATORS (same accounts, comma-separated)`);
/** Every operator, live: the env's and the stored ones (a setup-link claim adds here, no restart). */
export const OPERATORS: Set<string> = new Set(raw);
/** Is this connection's proven account a server operator here? */
export const isOperator = (account: string | null | undefined): boolean => !!account && OPERATORS.has(account);

// ---- the first-run setup link: in memory only, one use, never logged but in the one boot line ----
let setupToken: Buffer | null = null;   // its sha256: equal-length, constant-time compare
const digest = (s: string) => createHash("sha256").update(s).digest();
/** At boot: no operator → a fresh token (256 bits) to print once; else null and none exists. */
export function mintSetupToken(): string | null {
  if (OPERATORS.size) { setupToken = null; return null; }
  const t = randomBytes(32).toString("base64url"); setupToken = digest(t); return t;
}
/** Is a setup link open (no operator yet, a token minted)? */
export const setupOpen = () => !!setupToken && OPERATORS.size === 0;
/** Claim with the token: the account is stored first, then is the operator; the token dies. Synchronous: two claims can't both win. */
export function claimSetup(token: string, account: string): "ok" | "refused" | "unsaved" {
  if (!setupOpen() || !account.includes(":") || !timingSafeEqual(digest(token), setupToken!)) return "refused";
  try { if (unreadable) writePrivate(`${OPERATORS_FILE}.unreadable`, unreadable);
    writePrivate(OPERATORS_FILE, JSON.stringify({ operators: [...stored, account] }, null, 1) + "\n"); }
  catch (e) { console.log(`[operators] couldn't store the new operator in ${OPERATORS_FILE}: ${(e as Error).message}`); return "unsaved"; }
  stored.push(account); OPERATORS.add(account); setupToken = null;
  console.log(`[operators] ${account} claimed this server with the setup link: it is the operator now (stored in ${OPERATORS_FILE})`);
  return "ok";
}
