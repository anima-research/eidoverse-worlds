// eidoverse-worlds sequencer — identity doors (TEL0S_NOTES §15, step 7a).
// Archipelago-home sessions (cookie ⇄ aid1 token), their persistence across
// restarts, and the per-agent bearer roster from mcpl/tokens.json. Imported
// by server.ts right after config, so the restore-at-boot block below runs
// exactly where it always did in the boot sequence.

import { existsSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { join, resolve } from "node:path";
import { JtiCache, verifyToken, aid1Slug, type Aid1Payload } from "./aid1.ts";
import { ROOT } from "./config.ts";
import { writePrivate } from "./fsutil.ts";

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

/** The account an agent credential proves, the one derivation every door uses (account shapes: server/directory.ts header):
 *  null = no credential; `refused` = one was given and isn't a verified agent's. */
export function accountOf(tok: string): { account: string; name: string } | { refused: string } | null {
  if (!tok) return null;
  const at = agentTokens();
  const enrolled = at.byToken.get(tok);
  if (enrolled) return { account: `agent:token:${enrolled.toLowerCase()}`, name: enrolled };
  const a = aid1JoinIdentity(tok);
  if (!a || a.payload.kind !== "agent") return { refused: a ? "that credential isn't an agent's — sign in as yourself instead" : "that agent credential didn't verify" };
  const via = at.bySub.get(a.payload.sub);
  return via ? { account: `agent:token:${via.toLowerCase()}`, name: via } : { account: `aid1:${a.payload.iss}:${a.payload.sub}`, name: a.slug };
}

// `native`: issued to a native client by browser-approved pairing (native-login.ts). It is an ordinary session
// for every world the account may join; the mark only stops it approving another native pairing. Sessions paired
// before native sessions became ordinary ones carry `nativeWorld` instead, which means the same thing now.
export type HnSession = { sub: string; name: string; scopes: string[]; claims?: Record<string, unknown>; exp: number; native?: true; nativeWorld?: string };
export const hnSessions = new Map<string, HnSession>();
export const hnJti = new JtiCache();
export function sessionFromCookie(cookie: string | null): HnSession | null {
  const m = /(?:^|;\s*)ew_sess=([a-f0-9]{64})/.exec(cookie ?? "");
  if (!m) return null;
  const s = hnSessions.get(m[1]!);
  if (!s) return null;
  if (s.exp < Date.now()) { hnSessions.delete(m[1]!); return null; }
  return s.sub.startsWith("human:") ? s : null;   // a cookie session is a human's: anything else proves nobody (/auth refuses to make one)
}

/** The session a request's cookie proves, as the ws join takes it — refused only from another site's page (a browser says
 *  so in Sec-Fetch-Site; SameSite=Lax lets the cookie ride from sibling subdomains). A native client sends no fetch metadata. */
export function sessionOfRequest(req: Request): HnSession | null {
  const site = req.headers.get("sec-fetch-site");
  return site === null || site === "same-origin" ? sessionFromCookie(req.headers.get("cookie")) : null;
}

// ---- session persistence ----------------------------------------------------
// Sessions used to be memory-only, so every deploy logged the whole show out
// and sent verified humans back to the door mid-event. They survive restarts
// now. The file holds bearer-equivalent session ids — 0600 and gitignored,
// same posture as mcpl/tokens.json.
// SESSIONS_PATH (or main's HN_SESSIONS_FILE): a self-contained test keeps its sessions in its scratch dir (like
// AGENT_TOKENS_PATH), never the checkout's
export const SESSIONS_FILE = resolve(process.env.SESSIONS_PATH ?? process.env.HN_SESSIONS_FILE ?? join(ROOT, ".sessions.json"));
export function saveSessions() {
  try {
    const live = [...hnSessions].filter(([, s]) => s.exp > Date.now());
    // writePrivate IS the write-then-rename: a crash mid-write never truncates
    // the live file. A second rename of the already-consumed .tmp threw on
    // every successful save and logged "session save failed" each time,
    // burying the signal for a real failure (PR #160 review).
    writePrivate(SESSIONS_FILE, JSON.stringify(Object.fromEntries(live)));
  } catch (e) { console.log(`[auth] session save failed: ${e}`); }
}
try {
  if (existsSync(SESSIONS_FILE)) {
    const raw = JSON.parse(readFileSync(SESSIONS_FILE, "utf8")) as Record<string, HnSession>;
    for (const [sid, s] of Object.entries(raw)) {
      if (/^[a-f0-9]{64}$/.test(sid) && s.exp > Date.now()) hnSessions.set(sid, s);
    }
    if (hnSessions.size) console.log(`[auth] restored ${hnSessions.size} live session(s)`);
    const odd = [...hnSessions.values()].filter((s) => !String(s.sub).startsWith("human:"));
    if (odd.length) console.log(`[auth] ${odd.length} session(s) refused (sub isn't human:…; kept on disk, proves nobody): ${odd.map((s) => s.name).join(", ")}`);
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
export const ENROLMENT_ID = /^[a-z0-9][a-z0-9_-]{0,31}$/;
export const AGENT_TOKENS_PATH = resolve(process.env.AGENT_TOKENS_PATH ?? join(ROOT, "mcpl", "tokens.json"));
let agentTokCache: { mtime: number; byToken: Map<string, string>; names: Set<string>; bySub: Map<string, string> } | null = null;
export function agentTokens() {
  try {
    const mtime = existsSync(AGENT_TOKENS_PATH) ? Math.round(Bun.file(AGENT_TOKENS_PATH).lastModified) : 0;
    if (!agentTokCache || agentTokCache.mtime !== mtime) {
      const byToken = new Map<string, string>();
      const names = new Set<string>();
      // an enrolled agent may also arrive through the home node with an aid1 credential: `subs` lists the aid1 subjects
      // that ARE this agent (security review 10-06 C2: a reserved name is satisfied by a proven subject, never by a
      // display name that happens to slug the same)
      const bySub = new Map<string, string>();
      if (mtime) {
        const raw = JSON.parse(readFileSync(AGENT_TOKENS_PATH, "utf8")) as Record<string, { id?: string; subs?: string[] }>;
        const entries = Object.entries(raw).filter(([, v]) => typeof v?.id === "string" && v.id);
        const count = new Map<string, number>(); for (const [, v] of entries) count.set(v.id!.toLowerCase(), (count.get(v.id!.toLowerCase()) ?? 0) + 1);
        // an id is the account (agent:token:<id>): well-formed and unique lowercased, or it proves nobody (its name stays reserved)
        const refused: string[] = [];
        for (const [tok, v] of entries) {
          const id = v.id!; names.add(id.toLowerCase());
          if (!ENROLMENT_ID.test(id.toLowerCase()) || count.get(id.toLowerCase())! > 1) { refused.push(id); continue; }
          byToken.set(tok, id);
          for (const s of v.subs ?? []) if (typeof s === "string") bySub.set(s, id);
        }
        if (refused.length) console.error(`[perm] mcpl/tokens.json: ${refused.length} enrolment(s) refused (an id must match ${ENROLMENT_ID.source} lowercased, and be unique lowercased): ${refused.map((i) => JSON.stringify(i)).join(", ")}`);
      }
      agentTokCache = { mtime, byToken, names, bySub };
    }
  } catch (e) {
    console.error("[perm] mcpl/tokens.json unreadable:", (e as Error).message);
    agentTokCache ??= { mtime: 0, byToken: new Map(), names: new Set(), bySub: new Map() };
  }
  return agentTokCache;
}
