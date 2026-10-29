// server/operators.ts — who operates this server (SERVER_OPERATORS), by ACCOUNT only (security review 10-06 C3).
// A server operator holds a world owner's powers in every world and is the unban path of last resort, so the list names proven accounts —
// "human:discord:<id>", "agent:token:<id>", "aid1:<iss>:<sub>" — never a display name, which anyone can type.
// An entry with no ":" is refused at boot rather than silently ignored: an operator who THINKS they listed
// themselves must find out now, not when they're locked out.
// WORLD_ADMIN is the legacy name, read and merged for one release with a warning (R 10-27; docs/TRANSLATING-OLD-WORLDS.md).
// First run (R 10-28): with no operator at all, the server mints a one-use setup link; whoever opens it signed in becomes the
// operator, stored in OPERATORS_FILE and merged with the env at every boot (docs/TRANSLATING-OLD-WORLDS.md, "Becoming the operator").
import { chmodSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes, createHash, timingSafeEqual } from "node:crypto";
import { WORLDS_DIR } from "./config.ts";
import { atomicWrite } from "./fsutil.ts";

/** The operators the setup link made: beside the worlds' other server files (.bans.json), 0600. */
export const OPERATORS_FILE = join(WORLDS_DIR, ".operators.json");
const list = (v: string | undefined) => (v ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const current = list(process.env.SERVER_OPERATORS), legacy = list(process.env.WORLD_ADMIN);
const stored: string[] = existsSync(OPERATORS_FILE) ? (() => {
  try { const j = JSON.parse(readFileSync(OPERATORS_FILE, "utf8")); return Array.isArray(j?.operators) ? j.operators.map(String) : []; }
  catch (e) { throw new Error(`${OPERATORS_FILE} doesn't read (${(e as Error).message}): fix or remove it; it lists this server's operators`); }
})() : [];
const raw = [...current, ...legacy, ...stored];
const bad = raw.filter((s) => !s.includes(":"));
if (bad.length) {
  const from = [current.some((s) => bad.includes(s)) && "SERVER_OPERATORS", legacy.some((s) => bad.includes(s)) && "WORLD_ADMIN (its old name)", stored.some((s) => bad.includes(s)) && OPERATORS_FILE].filter(Boolean).join(" and ");
  throw new Error(`${from} lists ${bad.map((s) => `"${s}"`).join(", ")}, which ${bad.length > 1 ? "aren't accounts" : "isn't an account"}: `
    + `a server operator is named by account (human:discord:<id>, agent:token:<id>, aid1:<iss>:<sub>), never by a display name anyone can type. `
    + `Write it as SERVER_OPERATORS=human:discord:123456789012345678 (sign in, then open /whoami: its "sub" is your account); WORLD_ADMIN is its old name, read the same way until it is removed. `
    + `Or list nobody: a server with no operator prints a one-use setup link at boot, and whoever opens it signed in becomes the operator`);
}
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
  try { atomicWrite(OPERATORS_FILE, JSON.stringify({ operators: [...stored, account] }, null, 1) + "\n", { mode: 0o600 }); chmodSync(OPERATORS_FILE, 0o600); }
  catch (e) { console.log(`[operators] couldn't store the new operator in ${OPERATORS_FILE}: ${(e as Error).message}`); return "unsaved"; }
  stored.push(account); OPERATORS.add(account); setupToken = null;
  console.log(`[operators] ${account} claimed this server with the setup link: it is the operator now (stored in ${OPERATORS_FILE})`);
  return "ok";
}
