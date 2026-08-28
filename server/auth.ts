// eidoverse-worlds sequencer — identity doors (TEL0S_NOTES §15, step 7a).
// Archipelago-home sessions (cookie ⇄ aid1 token), their persistence across
// restarts, and the per-agent bearer roster from mcpl/tokens.json. Imported
// by server.ts right after config, so the restore-at-boot block below runs
// exactly where it always did in the boot sequence.

import { existsSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { join, resolve } from "node:path";
import { JtiCache, verifyToken, aid1Slug, type Aid1Payload } from "./aid1.ts";
import { ROOT } from "./config.ts";

// ---- archipelago-home identity (docs/home-node.md §7) ----------------------
// The second door, alongside JOIN_TOKEN: humans log in with Discord at the
// home node, arrive at /auth with an aid1 token in the URL fragment, swap it
// for a session cookie here, and join with a VERIFIED identity. Verification
// is offline (issuer pubkey below); the home node down = existing sessions
// and the JOIN_TOKEN door keep working.
//   HN_ISSUER_KEY   pinned issuer pubkey `ed25519:…` — unset disables the door
//   HN_ISS          issuer domain            (default id.animalabs.ai)
//   HN_AUD          token audience to verify (default eidoverse; staging uses eidoverse2)
//   HN_LOGIN_URL    where "Login with Discord" sends people
//   HN_REQUIRE_LOGIN=1  browser clients without a session are sent to login
//                       (JOIN_TOKEN joins still pass — invite links keep working)
export const HN_ISSUER_KEY = process.env.HN_ISSUER_KEY ?? "";
export const HN_ISS = process.env.HN_ISS ?? "id.animalabs.ai";
export const HN_AUD = process.env.HN_AUD ?? "eidoverse";
export const HN_LOGIN_URL = process.env.HN_LOGIN_URL ?? `https://${HN_ISS}/login?audience=${HN_AUD}`;
export const HN_REQUIRE_LOGIN = process.env.HN_REQUIRE_LOGIN === "1";
export const SESSION_TTL_MS = 12 * 60 * 60_000; // event-length; re-login is two clicks

/** Verify a forwarded aid1 credential at a join-scoped door and hand back
 *  the identity it vouches for (§24l R1): the ws join and the upload door
 *  each hand-rolled this verify-then-slug pair; the MCPL door (its own
 *  process, its own HN_* env) shares aid1Slug and keeps its own verify. */
export function aid1JoinIdentity(tok: string): { slug: string; payload: Aid1Payload } | null {
  if (!HN_ISSUER_KEY || !tok.startsWith("aid1.")) return null;
  const v = verifyToken(tok, { issuerId: HN_ISSUER_KEY, iss: HN_ISS, aud: HN_AUD, requireScopes: ["worlds:join"] });
  return v.ok ? { slug: aid1Slug(v.payload), payload: v.payload } : null;
}

export type HnSession = { sub: string; name: string; scopes: string[]; claims?: Record<string, unknown>; exp: number };
export const hnSessions = new Map<string, HnSession>();
export const hnJti = new JtiCache();
export function sessionFromCookie(cookie: string | null): HnSession | null {
  const m = /(?:^|;\s*)ew_sess=([a-f0-9]{64})/.exec(cookie ?? "");
  if (!m) return null;
  const s = hnSessions.get(m[1]!);
  if (!s) return null;
  if (s.exp < Date.now()) { hnSessions.delete(m[1]!); return null; }
  return s;
}

// ---- session persistence ----------------------------------------------------
// Sessions used to be memory-only, so every deploy logged the whole show out
// and sent verified humans back to the door mid-event. They survive restarts
// now. The file holds bearer-equivalent session ids — 0600 and gitignored,
// same posture as mcpl/tokens.json.
export const SESSIONS_FILE = join(ROOT, ".sessions.json");
export function saveSessions() {
  try {
    const live = [...hnSessions].filter(([, s]) => s.exp > Date.now());
    writeFileSync(`${SESSIONS_FILE}.tmp`, JSON.stringify(Object.fromEntries(live)), { mode: 0o600 });
    renameSync(`${SESSIONS_FILE}.tmp`, SESSIONS_FILE); // atomic — a crash mid-write never truncates the live file
  } catch (e) { console.log(`[auth] session save failed: ${e}`); }
}
try {
  if (existsSync(SESSIONS_FILE)) {
    const raw = JSON.parse(readFileSync(SESSIONS_FILE, "utf8")) as Record<string, HnSession>;
    for (const [sid, s] of Object.entries(raw)) {
      if (/^[a-f0-9]{64}$/.test(sid) && s.exp > Date.now()) hnSessions.set(sid, s);
    }
    if (hnSessions.size) console.log(`[auth] restored ${hnSessions.size} live session(s)`);
  }
} catch (e) { console.log(`[auth] session restore failed (starting empty): ${e}`); }

// Agent identity: the MCPL door (mcpl/tokens.json) already holds per-agent
// bearer tokens. The sequencer reads the same file so (a) an agent's name is
// RESERVED — a plain browser join cannot claim it — and (b) a join carrying
// the right token is a verified agent. Hot-reloaded by mtime, like the MCPL
// server does.
// Path is env-overridable so a self-contained test can own its credential
// fixture (a scratch tokens.json) without mutating the checkout — same posture
// as WORLDS_DIR. Production leaves it unset and reads the real mcpl/tokens.json.
export const AGENT_TOKENS_PATH = resolve(process.env.AGENT_TOKENS_PATH ?? join(ROOT, "mcpl", "tokens.json"));
let agentTokCache: { mtime: number; byToken: Map<string, string>; names: Set<string> } | null = null;
export function agentTokens() {
  try {
    const mtime = existsSync(AGENT_TOKENS_PATH) ? Math.round(Bun.file(AGENT_TOKENS_PATH).lastModified) : 0;
    if (!agentTokCache || agentTokCache.mtime !== mtime) {
      const byToken = new Map<string, string>();
      const names = new Set<string>();
      if (mtime) {
        const raw = JSON.parse(readFileSync(AGENT_TOKENS_PATH, "utf8")) as Record<string, { id?: string }>;
        for (const [tok, v] of Object.entries(raw)) {
          if (!v?.id) continue;
          byToken.set(tok, v.id);
          names.add(v.id.toLowerCase());
        }
      }
      agentTokCache = { mtime, byToken, names };
    }
  } catch (e) {
    console.error("[perm] mcpl/tokens.json unreadable:", (e as Error).message);
    agentTokCache ??= { mtime: 0, byToken: new Map(), names: new Set() };
  }
  return agentTokCache;
}
