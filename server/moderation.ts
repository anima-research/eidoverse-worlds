// eidoverse-worlds sequencer — ban DATA (TEL0S_NOTES §15, step 7a).
// The instance-wide ban list and its persistence, plus the one lookup both
// doors share. Only the data lives here: `expel` (the act of removing a live
// body) stays in server.ts with the session's client maps — moderation owns
// what is REMEMBERED, not what is done. Imported by server.ts right after
// auth, so the restore-at-boot block runs exactly where it always did.

import { existsSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { WORLDS_DIR } from "./config.ts";

// ---- global bans ------------------------------------------------------------
// Per-world bans live in each world's log (the `ban` verb — event-sourced,
// auditable, fork-copied, like roles). There is no global log, so the
// instance-wide list is a JSON file INSIDE WORLDS_DIR (not ROOT): bans are
// world data, and a dev sequencer pointed at a scratch WORLDS_DIR must get a
// scratch ban list too — same doctrine as the logs themselves. Keyed by
// lowercased display id, carrying the durable principal `sub` when it was
// known at ban time (a name is evadable by /name; a sub is not).
export type BanRec = { by: string; ts: number; reason?: string; sub?: string };
export const BANS_FILE = join(WORLDS_DIR, ".bans.json");
export const globalBans: Record<string, BanRec> = {};
export function saveGlobalBans() {
  try {
    writeFileSync(`${BANS_FILE}.tmp`, JSON.stringify(globalBans, null, 2), { mode: 0o600 });
    renameSync(`${BANS_FILE}.tmp`, BANS_FILE);
  } catch (e) { console.log(`[mod] global ban save failed: ${e}`); }
}
try {
  if (existsSync(BANS_FILE)) {
    const raw = JSON.parse(readFileSync(BANS_FILE, "utf8")) as Record<string, BanRec>;
    for (const [id, b] of Object.entries(raw)) if (b && typeof b.by === "string") globalBans[id.toLowerCase()] = b;
    if (Object.keys(globalBans).length) console.log(`[mod] ${Object.keys(globalBans).length} global ban(s) loaded`);
  }
} catch (e) { console.log(`[mod] global ban restore failed (starting empty): ${e}`); }

/** Does this ban list hit this identity? Checked under both handles, same
 *  doctrine as rightsOf: the display id (case-insensitive) and the durable
 *  principal sub. Ban lists are small; the sub scan is nothing. */
export function findBan(map: Record<string, BanRec> | undefined, id: string, sub?: string): BanRec | null {
  if (!map) return null;
  const hit = map[id.toLowerCase()];
  if (hit) return hit;
  if (sub) for (const b of Object.values(map)) if (b.sub === sub) return b;
  return null;
}
