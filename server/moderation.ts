// eidoverse-worlds sequencer — ban DATA (TEL0S_NOTES §15, step 7a).
// The instance-wide ban list and its persistence, plus the one lookup both
// doors share. Only the data lives here: `expel` (the act of removing a live
// body) stays in server.ts with the session's client maps — moderation owns
// what is REMEMBERED, not what is done. Imported by server.ts right after
// auth, so the restore-at-boot block runs exactly where it always did.

import { existsSync, readFileSync } from "node:fs";
import { atomicWrite } from "./fsutil.ts";
import { join } from "node:path";
import { WORLDS_DIR } from "./config.ts";

// ---- global bans ------------------------------------------------------------
// The door's own list, across all its worlds (each world's own bans are its door's moderator log). There is no global
// log, so it is a JSON file INSIDE WORLDS_DIR (bans are world data: a scratch WORLDS_DIR gets a scratch list).
// Keyed by ACCOUNT (security review 10-06 H4/L4): a display name is typed, not proven, so banning a name hit every
// namesake and missed the person the moment they picked another. A guest has no account: their ban names their
// connection's address (hashed, never stored raw) and expires (ADDR_BAN_MS) — an address is shared and reassigned.
export type BanRec = { by: string; ts: number; reason?: string; name?: string; account?: string; addr?: string; until?: number; world?: string };
export const ADDR_BAN_MS = 24 * 3600 * 1000;
export const BANS_FILE = join(WORLDS_DIR, ".bans.json");
export const globalBans: Record<string, BanRec> = {};
export function saveGlobalBans() {
  try {
    atomicWrite(BANS_FILE, JSON.stringify(globalBans, null, 2), { mode: 0o600 });
  } catch (e) { console.log(`[mod] global ban save failed: ${e}`); }
}
try {
  if (existsSync(BANS_FILE)) {
    const raw = JSON.parse(readFileSync(BANS_FILE, "utf8")) as Record<string, BanRec>;
    // a name-keyed record from before accounts can't be honoured safely (it would hit namesakes): kept only if it
    // carried the account it was made against
    for (const [k, b] of Object.entries(raw)) if (b && typeof b.by === "string" && (b.account || (b as any).sub || b.addr)) globalBans[k] = { ...b, account: b.account ?? (b as any).sub };
    if (Object.keys(globalBans).length) console.log(`[mod] ${Object.keys(globalBans).length} global ban(s) loaded`);
  }
} catch (e) { console.log(`[mod] global ban restore failed (starting empty): ${e}`); }

/** Does a ban list hit this connection? By its account; a guest (no account) by its hashed address while unexpired. */
export function findBan(map: Record<string, BanRec> | undefined, account: string | null | undefined, addr?: string | null, now = Date.now(), world: string | null = null): BanRec | null {
  if (!map) return null;
  for (const b of Object.values(map)) {
    if (b.world && b.world !== world) continue;   // a guest's ban in one world (the door's world ban can't name a guest)
    if (account && b.account === account) return b;
    if (!account && addr && b.addr === addr && (b.until ?? 0) > now) return b;
  }
  return null;
}
/** The key a ban is filed under. */
export const banKey = (account: string | null | undefined, addr?: string | null, world?: string | null) => `${world ? `world:${world}:` : ""}${account ? `acct:${account}` : `addr:${addr}`}`;
