// Identity doors: archipelago-home sessions (cookie ⇄ aid1 token), their persistence across restarts, and the per-agent
// bearer roster from mcpl/tokens.json. Imported by server.ts right after config: the restore-at-boot block runs there.

import { existsSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { join, resolve } from "node:path";
import { JtiCache, verifyToken, aid1Slug, type Aid1Payload } from "./aid1.ts";
import { ROOT } from "./config.ts";
import { writePrivate } from "./fsutil.ts";
import { readTokenRegistry } from "../mcpl/token-registry.ts";

// ---- archipelago-home identity ----------------------
// The second door, beside JOIN_TOKEN: people log in with Discord at the home node, arrive at /auth with an aid1 token in the
// URL fragment and swap it for a session cookie. Verification is offline, so the home node being down costs nothing here.
//   HN_ISSUER_KEY, HN_ISS, HN_AUD   the trusted issuer (aid1-issuer.ts)
//   HN_LOGIN_URL    where "Login with Discord" sends people
//   HN_REQUIRE_LOGIN=1  browser clients without a session are sent to login
//                       (JOIN_TOKEN joins still pass — invite links keep working)
import { HN_ISSUER_KEY, HN_ISS, HN_AUD } from "./aid1-issuer.ts";
export { HN_ISSUER_KEY, HN_ISS, HN_AUD };
export const HN_LOGIN_URL = process.env.HN_LOGIN_URL ?? `https://${HN_ISS}/login?audience=${HN_AUD}`;
export const HN_REQUIRE_LOGIN = process.env.HN_REQUIRE_LOGIN === "1";
export const SESSION_TTL_MS = 12 * 60 * 60_000; // event-length; re-login is two clicks

/** Verify a forwarded aid1 credential at a join-scoped door (ws join, upload) and hand back the identity it vouches
 *  for. The MCPL door (its own process and HN_* env) shares aid1Slug and keeps its own verify. */
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
/** The session id an `ew_sess` cookie carries, or null. */
export const sessionIdOf = (cookie: string | null): string | null => /(?:^|;\s*)ew_sess=([a-f0-9]{64})/.exec(cookie ?? "")?.[1] ?? null;
export function sessionFromCookie(cookie: string | null): HnSession | null {
  const sid = sessionIdOf(cookie);
  if (!sid) return null;
  const s = hnSessions.get(sid);
  if (!s) return null;
  if (s.exp < Date.now()) { hnSessions.delete(sid); return null; }
  return s.sub.startsWith("human:") ? s : null;   // a cookie session is a human's: anything else proves nobody (/auth refuses to make one)
}

/** The session a request's cookie proves: only from this server's own page (Sec-Fetch-Site same-origin; a sibling subdomain
 *  is refused too), or with no fetch metadata (a native client). */
export function sessionOfRequest(req: Request): HnSession | null {
  const site = req.headers.get("sec-fetch-site");
  return site === null || site === "same-origin" ? sessionFromCookie(req.headers.get("cookie")) : null;
}

/** A browser upgrade from a page that isn't this server's (cross-site WebSocket hijacking): Sec-Fetch-Site decides when sent;
 *  else the Origin must equal ownOrigin exactly. No Origin: a native client. */
export function crossSiteUpgrade(req: Request): boolean {
  const site = req.headers.get("sec-fetch-site"); if (site !== null) return site !== "same-origin";
  const origin = req.headers.get("origin"); if (origin === null) return false;
  try { return new URL(origin).origin !== ownOrigin(req); } catch { return true; }   // "null" (an opaque origin) too
}
/** This server's one public origin (scheme, host, port): HN_NATIVE_ORIGIN when set (behind a proxy), else the request's own. */
export function ownOrigin(req: Request): string {
  const conf = process.env.HN_NATIVE_ORIGIN, url = new URL(req.url);
  return new URL(conf || `${url.protocol}//${req.headers.get("host") ?? url.host}`).origin;
}

// ---- session persistence ----------------------------------------------------
// Sessions survive restarts. The file holds bearer-equivalent ids: 0600 and gitignored. SESSIONS_PATH (or the older
// HN_SESSIONS_FILE) lets a test keep its sessions in a scratch dir.
const SESSIONS_FILE = resolve(process.env.SESSIONS_PATH ?? process.env.HN_SESSIONS_FILE ?? join(ROOT, ".sessions.json"));
export function saveSessions() {
  try {
    const live = [...hnSessions].filter(([, s]) => s.exp > Date.now());
    // writePrivate is the write-then-rename
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
    if (odd.length) console.log(`[auth] ${odd.length} session(s) refused (sub isn't human:…; proves nobody; kept on disk until it expires): ${odd.map((s) => s.name).join(", ")}`);
  }
} catch (e) { console.log(`[auth] session restore failed (starting empty): ${e}`); }

// Agent identity: the MCPL door's per-agent bearers (mcpl/tokens.json, hot-reloaded by mtime), so an agent's name is reserved
// against plain browser joins and a join carrying the right token is a verified agent. AGENT_TOKENS_PATH: a test's scratch copy.
const ENROLMENT_ID = /^[a-z0-9][a-z0-9_-]{0,31}$/;
export const AGENT_TOKENS_PATH = resolve(process.env.AGENT_TOKENS_PATH ?? join(ROOT, "mcpl", "tokens.json"));
const AGENT_TOKENS_EXAMPLE = resolve(process.env.MCPL_TOKENS_EXAMPLE ?? join(ROOT, "mcpl", "tokens.example.json"));
let agentTokCache: { mtime: string; byToken: Map<string, string>; names: Set<string>; bySub: Map<string, string> } | null = null;
export function agentTokens() {
  let mtime = "";
  try {
    // keyed on both files: a key the public example gains is refused without a touch of tokens.json
    const stamp = (p: string) => existsSync(p) ? Math.round(Bun.file(p).lastModified) : 0;
    const live = stamp(AGENT_TOKENS_PATH); mtime = `${live}:${stamp(AGENT_TOKENS_EXAMPLE)}`;
    if (!agentTokCache || agentTokCache.mtime !== mtime) {
      const byToken = new Map<string, string>();
      const names = new Set<string>();
      // `subs`: the aid1 subjects that are this agent, for one arriving through the home node
      const bySub = new Map<string, string>();
      if (live) {
        // as mcpl/token-registry.ts: a key copied from the public example proves nobody
        const accepted = readTokenRegistry(AGENT_TOKENS_PATH, AGENT_TOKENS_EXAMPLE);
        const raw = JSON.parse(readFileSync(AGENT_TOKENS_PATH, "utf8")) as Record<string, { id?: string; subs?: string[] }>;
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("not an object of tokens");
        const entries = Object.entries(raw).filter(([, v]) => typeof v?.id === "string" && v.id);
        const spellings = new Map<string, Set<string>>(); for (const [, v] of entries) { const k = v.id!.toLowerCase(); spellings.set(k, (spellings.get(k) ?? new Set()).add(v.id!)); }
        // the id is the account (agent:token:<id>); two tokens on one id (a key rotation) are one account; an ill-formed id proves nobody
        const refused: string[] = [];
        for (const [tok, v] of entries) {
          const id = v.id!; names.add(id.toLowerCase());
          if (!ENROLMENT_ID.test(id.toLowerCase()) || spellings.get(id.toLowerCase())!.size > 1) { refused.push(id); continue; }
          // the subs are proven by an aid1 signature, not by the key, so an example-key enrolment keeps them (as main mapped every one)
          for (const s of v.subs ?? []) if (typeof s === "string") bySub.set(s, id);
          if (Object.hasOwn(accepted, tok)) byToken.set(tok, id);
        }
        if (refused.length) console.error(`[perm] mcpl/tokens.json: ${refused.length} enrolment(s) refused (an id must match ${ENROLMENT_ID.source} lowercased, and no other id may differ from it only in case): ${refused.map((i) => JSON.stringify(i)).join(", ")}`);
      }
      agentTokCache = { mtime, byToken, names, bySub };
    }
  } catch (e) {
    console.error("[perm] mcpl/tokens.json unreadable:", (e as Error).message);
    // fail closed: nobody is authorized, but the names already reserved stay reserved (bot #333 5)
    agentTokCache = { mtime, byToken: new Map(), names: agentTokCache?.names ?? new Set(), bySub: new Map() };
  }
  return agentTokCache;
}
