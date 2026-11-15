// eidoverse-worlds sequencer — the HTTP surface.
//
// A route table: one row per endpoint, first match wins, so ORDER matters (the catch-all
// last serves the browser client); server.ts's fetch() is a one-line delegate. Also home to
// the static-file machinery (serveFrom/contentType/gzCache) and the avatar/animation rosters.
// Imports are one-way: this module never imports server.ts.

import { existsSync, readFileSync, writeFileSync, renameSync, readdirSync, mkdirSync, appendFileSync } from "node:fs";
import { addressOf } from "./peer.ts";   // the client's address, from a trusted proxy only
import { sfuDiag } from "./sfuadapter.ts";
import { join, normalize, dirname, basename, sep } from "node:path";
import { hexOfLibRel } from "../shared/eido.js";
import { isReservedAnimName } from "../shared/animdefs.js";
import { eidoFile, eidoRel } from "./eidoindex.ts";
import { randomBytes } from "node:crypto";
import { agentGuideResponse } from "./briefing.ts";
import { creditsFor } from "../shared/libcredits.js";
import { libraryCredits } from "./modelcatalogue.ts";
import { ROOT, WORLDS_DIR, LIBRARY_DIR, OPT_DIR, PATCH_DIR, LADDER, JOIN_TOKEN, STORE_MIN } from "./config.ts";
import { isStoreOriginal, isServingArtifact, variantStatus, variantSource, freshOver } from "./store-variants.ts";
import { glbPerfOfFile } from "./glbperf.ts";
import { rankOf, TIER_NAMES } from "../shared/perfrank.js";
import { wantsKtx2, KTX2_KEY } from "../shared/ktx2.js";
import { normalizeSnapFrame } from "../shared/snapframe.js";
import { LOD_RECIPE, lodVariantPath, lodVerdictKind, lodVerdictFinal } from "./store-variants.ts";
import { hnSessions, hnJti, sessionFromCookie, sessionIdOf, sessionOfRequest, crossSiteUpgrade, saveSessions, SESSION_TTL_MS, HN_ISSUER_KEY, HN_ISS, HN_AUD, HN_LOGIN_URL, HN_REQUIRE_LOGIN, ownOrigin } from "./auth.ts";
import { verifyToken } from "./aid1.ts";
import { createNativeLogin } from "./native-login.ts";
const nativeLogin = createNativeLogin({
  origin: ownOrigin,
  login: HN_LOGIN_URL, enabled: Boolean(HN_ISSUER_KEY), session: sessionFromCookie,
  issue: session => { const sid = randomBytes(32).toString("hex"); hnSessions.set(sid, session); saveSessions(); return sid; },
});
import { resolveLibFile, libraryFile, libraryRel } from "./libfile.ts";
import { summarizeGlb } from "./geometry.ts";
import { vrmHeightFor } from "./vrmheight.ts";
import { checkFile, checkScale, CheckRefused } from "./buildcheck-queue.ts";
import { worlds, getWorld, worldDirNamed, type World } from "./world.ts";
import { screenshots } from "./screenshots.ts";
import { handleUpload, optStatus, rebuildAsset } from "./upload.ts";
import { serveHeightmapExport, heightRange } from "./heightmap.ts";
import { defsPayload, avatarDefs, animationDefs } from "./defs.ts";
import { tickStats, registerSystem } from "./tick.ts";
import { atomicWrite } from "./fsutil.ts";
import { cspFor, cspForFile } from "./csp.ts";
// client console tee (the /clientlog route): one file per KNOWN world (loaded in memory, or with a data dir on disk) and
// sender under $CLIENTLOG_DIR; any other label shares the '~unknown' directory, so a made-up label buys no file of its own.
const rebuildWin = new Map<string, { t: number; n: number }>();   // POST /rebuild per-IP windows (4/min, as /upload)
const CLIENTLOG_DIR = process.env.CLIENTLOG_DIR ?? join(WORLDS_DIR, ".clientlogs");   // beside the worlds, like .perflogs — never a shared temp dir
/** Reads of a world's live state (/geom?world, /snap, /worlds): behind the same door as joining it. On a box with a
 *  JOIN_TOKEN they need the authority key as a Bearer header, or a caller the door takes (access.ts httpCaller: a scoped
 *  session cookie, an agent's credential); an agent's credential alone suffices here, where its join also sends the key
 *  (by design, #260 bot 1). An open box is open. */
function mayRead(req: Request): boolean {
  if (!JOIN_TOKEN) return true;
  return bearerOf(req) === JOIN_TOKEN || httpCaller(req) !== null;   // a human's aid1 token signs in at /auth, never reads by Bearer (#260 bot 12)
}
const unauthorized = () => new Response("this world's state is behind its door: send a key it takes as a Bearer header", { status: 401 });

/** A world's directory holds its log, world.jsonl. */
const hasWorldLog = (name: string) => worldDirNamed(name) && existsSync(join(WORLDS_DIR, name, "world.jsonl"));   // in its own case (world.ts)
const knownWorld = (name: string) => worlds.has(name) || hasWorldLog(name);   // exact case: a variant buys no bucket or file of its own
const CLIENTLOG_UNKNOWN = "~unknown";   // '~' is outside the world-name alphabet, so no real world can share this file
const clientLogRate = new ClientLogRate();
let clientLogStore: ClientLogStore | null = null;
try { clientLogStore = new ClientLogStore(CLIENTLOG_DIR); } catch (e) { console.warn(`[clientlog] cannot open ${CLIENTLOG_DIR}: ${(e as Error)?.message ?? e}`); }
// retention runs on the clock, not only on a post: an idle server keeps its promise too (rageshake cleanup.py, Synapse purge_jobs)
registerSystem({ name: "clientlog-retire", everyMs: 3_600_000, fn: (now) => clientLogStore?.retire(now) });
import { seatStore, announceProfileUpdate, MAX_PROPOSAL_BYTES } from "./seats.ts";
import { agentTokens, aid1JoinIdentity } from "./auth.ts";
import { httpCaller, httpVisitor, hashedAddress, visibleTo, unavailable, doorFor, youAt, bearerOf, toldOf, httpProven } from "./access.ts";
import { interruptedVisitorText } from "./oldworlds.ts";
import { setupPage, setupClaim } from "./setup.ts";
import { setupOpen } from "./operators.ts";
import { ClientLogRate, ClientLogStore, LIMITS as CLIENTLOG_LIMITS, scrub, holdsPrivateKey, boundLines } from "./clientlog.ts";
import { readCapped, readCappedBytes } from "./request-body.ts";

import { recordComponents } from "../shared/protocol/view.js";
import { WORLD_NAME_RE } from "./limits.ts";
import { sha256 } from "../shared/protocol/hash.js";
/** What the routes need from Bun's server object: the WS upgrade and the socket address (X-Real-IP's fallback). */
export type Srv = {
  upgrade(req: Request, opts?: { data?: unknown }): boolean;
  requestIP(req: Request): { address: string } | null;
  /** per-request idle timeout in seconds (overrides Bun.serve's idleTimeout) */
  timeout?(req: Request, seconds: number): void;
};

// ---- screenshots: the world serves views of itself -------------------------
// GET /snap?world=W&follow=ID[&view=first|third|selfie][&at=<thing>][&renderer=auto|unreal|browser][&budget=ms]
// [&dist=&height=&pitch=] (framing: shared/snapframe.js) → a renderer client frames ID (or `at`) and returns one
// frame via `capture` / `capture-result`; the broker is server/screenshots.ts.

// ---- static serving ---------------------------------------------------------

/** Roster = the library's vrms + our overlay (assets/opt/...) + patched forks: drop a .vrm into any and it's an avatar.
 *  ?v=mtime content-versions each path (a re-export mints a new URL). Served by GET /avatars AND carried in the join
 *  snapshot, so a joiner can resolve a body name without a round-trip. */
export type AvatarPerf = { tris: number; draws: number; mats: number; alpha: number; bones: number; texMB: number;
  rank: number; rankName: string; worst: string; v: string };
/** POST /thumb's `perf` (JSON of the loupe's numbers) + `v` → a validated record with the rank recomputed here, or
 *  null. Every field must be a finite, non-negative, sane number — this is client-written. */
export function avatarPerfParam(raw: string | null, v: string | null): AvatarPerf | null {
  if (!raw || !v || !/^\d{1,16}$/.test(v) || raw.length > 400) return null;
  let o: any; try { o = JSON.parse(raw); } catch { return null; }
  const LIM = { tris: 5e7, draws: 1e5, mats: 1e4, alpha: 1e4, bones: 1e4, texMB: 1e5 } as const;
  const n: any = {};
  for (const [k, max] of Object.entries(LIM)) {
    const x = o?.[k];   // a number, not something that coerces to one (Number(null), Number([]), Number("") are all 0)
    if (typeof x !== "number" || !Number.isFinite(x) || x < 0 || x > max) return null;
    n[k] = k === "texMB" ? Math.round(x * 100) / 100 : Math.round(x);
  }
  const r = rankOf(n);
  return { ...n, rank: r.rank, rankName: TIER_NAMES[r.rank], worst: r.worst, v };
}
export function avatarRoster(): { name: string; path: string; height: number | null; perf?: AvatarPerf | null; seat?: unknown }[] {
  const seen = new Map<string, { url: string; file: string; v: string }>();
  for (const base of [...LADDER].reverse()) {   // /library's precedence, lowest first: ?v= and height describe the bytes served
    const dir = join(base, "eidoverse/assets/vrms");
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) {
      // .ktx2.vrm files are texture variants: serving artifacts, not bodies of their own
      if (f.endsWith(".vrm") && !f.endsWith(".ktx2.vrm")) {
        const v = String(Math.round(Bun.file(join(dir, f)).lastModified));
        seen.set(f.replace(".vrm", ""), { url: `eidoverse/assets/vrms/${f}?v=${v}`, file: join(dir, f), v });
      }
    }
  }
  // The def overlay (defs/avatars/): declared beats discovered. An unresolvable `vrm` is refused loudly and the
  // discovered entry stands (a typo'd def must not vanish a body).
  const defs = avatarDefs();
  for (const [name, d] of Object.entries(defs)) {
    if (!d.vrm) continue;
    const file = resolveLibFile(d.vrm);
    if (!file) { console.error(`[defs] avatar "${name}": vrm not found in library — ${d.vrm}`); continue; }
    const v = String(Math.round(Bun.file(file).lastModified));
    seen.set(name, { url: `${d.vrm}?v=${v}`, file, v });
  }
  // what wearers' browsers posted with their portraits (see POST /thumb): the
  // portrait's framing height, which stands in only when the file gives none
  let hmeta: Record<string, { h?: number; perf?: AvatarPerf }> = {};
  try {
    const mp = join(OPT_DIR, "thumbs", "meta.json");
    if (existsSync(mp)) hmeta = JSON.parse(readFileSync(mp, "utf8"));
  } catch { /* roster works without heights */ }
  // The seat verdict rides every entry, pre-judged against the bytes that will serve (one judge; consumers never
  // rehash). judge() is mtime-cached, so a roster read hashes only changed bodies.
  return [...seen].map(([name, { url, file, v }]) => {
    const safe = name.replace(/[^a-zA-Z0-9_-]/g, "_");
    return { name, path: url,
      // A def's declared height, else the file's own stature (vrmheight.ts); a wearer's posted framing height
      // stands in only when the file gives none.
      height: defs[name]?.height ?? vrmHeightFor(file, v) ?? hmeta[safe]?.h ?? null,
      // the loupe's rank of THIS version only (the v its URL carries): a stamp from an older export is withheld until a wearer re-measures
      perf: ((p) => p && p.v === v ? p : null)(hmeta[safe]?.perf),
      seat: seatStore.judge(name, file) };
  });
}

/** The animation clips, each at a path stamped ?v=mtime as avatarRoster does: a version in the URL is the only
 *  invalidation that reaches a cache we do not control. Precedence is /library's own ladder (PATCH_DIR > OPT_DIR >
 *  LIBRARY_DIR) so the mtime describes the bytes a client actually receives. */
export function animationRoster(): { name: string; path: string; size: number }[] {
  const seen = new Map<string, { path: string; size: number }>();
  for (const base of [...LADDER].reverse()) {   // lowest-precedence first: later wins the map
    const dir = join(base, "eidoverse/assets/animations");
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".vrma")) continue;
      if (isReservedAnimName(f.replace(".vrma", ""))) { console.error(`[defs] animation "${f}": "live" is reserved (it names ad-libbed anims) — not served`); continue; }
      const file = Bun.file(join(dir, f));
      // size rides along for the prefetcher's byte budget
      seen.set(f.replace(".vrma", ""),
        { path: `eidoverse/assets/animations/${f}?v=${Math.round(file.lastModified)}`, size: file.size });
    }
  }
  // The def overlay (defs/animations/): same contract as the avatar roster. Metadata (tags, doc) rides /defs.
  // Resolution is /library's own (libfile.ts libraryFile), so a listed clip loads.
  const resolveClip = (lib: string): string | null => libraryFile(lib, /\.vrma$/i);
  const defs = animationDefs();
  for (const [name, d] of Object.entries(defs)) {
    if (!d.vrma) continue;
    const file = resolveClip(d.vrma);
    if (!file) { console.error(`[defs] animation "${name}": vrma not found in library — ${d.vrma}`); continue; }
    const bf = Bun.file(file);
    seen.set(name, { path: `${d.vrma}?v=${Math.round(bf.lastModified)}`, size: bf.size });
  }
  return [...seen].map(([name, e]) => ({ name, ...e }));
}

function contentType(path: string): string {
  if (path.endsWith(".html")) return "text/html";
  if (path.endsWith(".js") || path.endsWith(".mjs")) return "text/javascript";
  if (path.endsWith(".json")) return "application/json";
  if (path.endsWith(".css")) return "text/css";
  if (path.endsWith(".md")) return "text/markdown; charset=utf-8";
  if (path.endsWith(".png")) return "image/png";
  if (path.endsWith(".jpg") || path.endsWith(".jpeg")) return "image/jpeg";
  if (path.endsWith(".webp")) return "image/webp";
  if (path.endsWith(".mp3")) return "audio/mpeg";
  if (path.endsWith(".ogg") || path.endsWith(".opus")) return "audio/ogg";
  if (path.endsWith(".wav")) return "audio/wav";
  if (path.endsWith(".webm")) return "audio/webm";
  if (path.endsWith(".m4a")) return "audio/mp4";
  if (path.endsWith(".ktx2")) return "image/ktx2";
  if (path.endsWith(".wasm")) return "application/wasm";
  if (path.endsWith(".hdr")) return "application/octet-stream";
  return "application/octet-stream";
}

// Build identity, resolved once at boot. sha, commitTime and dirty are ONE provenance triple: if ANY comes from the
// environment (image builds), the others are env-or-unknown — never filled from the local git tree.
const BUILD = (() => {
  const gitLine = (...args: string[]) => {
    try {
      return new TextDecoder().decode(
        Bun.spawnSync(["git", ...args], { cwd: import.meta.dir }).stdout).trim();
    } catch { return ""; /* no git in the deploy image */ }
  };
  // PRESENCE, not truthiness: an image build exporting BUILD_DIRTY='' has
  // still declared an env identity — a git-derived sha must not pair with it
  const envIdentity = process.env.BUILD_SHA != null || process.env.BUILD_TIME != null
    || process.env.BUILD_DIRTY != null;
  const sha = process.env.BUILD_SHA
    || (envIdentity ? "unknown" : gitLine("rev-parse", "--short", "HEAD") || "unknown");
  const commitTime = process.env.BUILD_TIME
    || (envIdentity ? "unknown" : gitLine("show", "-s", "--format=%cI", "HEAD") || "unknown");
  const dirtyRaw = process.env.BUILD_DIRTY ?? (() => {
    if (envIdentity) return "unknown";
    const out = gitLine("status", "--porcelain");
    return gitLine("rev-parse", "HEAD") ? (out ? "true" : "false") : "unknown";
  })();
  return { sha: sha || "unknown", commitTime: commitTime || "unknown",
    dirty: dirtyRaw === "true" ? true : dirtyRaw === "false" ? false : "unknown",
    startedAt: new Date().toISOString(),
    // EIDO_BOOT_NONCE echo: lets a spawning probe (test/harness/probe-harness.mjs) prove the responder is its own child.
    ...(process.env.EIDO_BOOT_NONCE ? { nonce: process.env.EIDO_BOOT_NONCE } : {}) };
})();

const gzCache = new Map<string, { mtime: number; gz: Uint8Array }>();

// What may cache for a day without asking: heavy, rarely-edited art. Not things we iterate on, where a stale copy
// costs a debugging session: avatars and animations (.vrm/.vrma) and library code and data sidecars.
// Those get no-cache, which still rides the ETag (a 304, not a re-download).
const hardCacheable = (path: string) =>
  !/\.vrma?$/i.test(path) && !/\.(m?js|json)$/i.test(path);

// `provisional`: not this URL's final answer (a flagged fetch whose variant isn't built yet); no-cache beats `immutable`.
// A built VARIANT (KTX2 or LOD shadow) can be rebuilt in place, so it is never `immutable`: short-lived + validator
// (a minute, then a 304; nginx's proxy_cache_lock still collapses a crowd). A rebuild reaches browsers within ~6 min.
// A lod ask whose standing verdict makes the plain ktx2 variant final shares this tier.
const VARIANT_CC = "public, max-age=60, stale-while-revalidate=300";
/** `opts.variant`: the file is a built variant (VARIANT_CC unless provisional). `opts.headers`: headers that NAME the
 *  answer (x-eidoverse-lod) — on the 304 too, so devtools reads the state without a body. */
function serveFrom(base: string, rel: string, cache = false, req?: Request, immutable = false, provisional = false,
  opts: { variant?: boolean; headers?: Record<string, string> } = {}): Response {
  const variant = !!opts.variant;
  const path = normalize(join(base, rel));
  if (!path.startsWith(base)) return new Response("forbidden", { status: 403 });
  // a missing file is a 404, not a Bun.file stream blowing up into a 500
  if (!existsSync(path)) return new Response("not found", { status: 404 });
  const f = Bun.file(path);
  const headers: Record<string, string> = { "content-type": contentType(path), ...(opts.headers ?? {}) };
  // a page carries its Content-Security-Policy, its own inline scripts hashed in (server/csp.ts)
  if (headers["content-type"].startsWith("text/html")) headers["content-security-policy"] = cspForFile(path, f.lastModified, () => readFileSync(path, "utf8"));
  // client code is never heuristically cached; library assets cache hard except hardCacheable's exclusions
  headers["cache-control"] = provisional ? "no-cache"
    : variant ? VARIANT_CC
    : immutable ? "public, max-age=31536000, immutable"
    : cache && hardCacheable(path) ? "public, max-age=86400" : cache ? "no-cache" : "no-store";
  // ETag from size+mtime: no-cache revalidation is a 304, not a re-download (an 11MB avatar per reload); the 304 carries
  // cache-control too (it refreshes the stored response's lifetime)
  if (f.size > 0) {
    const etag = `"${f.size}-${f.lastModified}"`;
    headers["etag"] = etag;
    if (req?.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers });
  }
  // gzip text and uncompressed binaries (three.webgpu.js 2.1MB → ~500KB; VRMs ~0.50, VRMA ~0.44); GLBs (~0.99, already
  // packed) are left out
  if (/\.(m?js|json|css|html|vrma|vrm|wasm)$/.test(path) && req?.headers.get("accept-encoding")?.includes("gzip") && f.size > 10_000) {
    let entry = gzCache.get(path);
    if (!entry || entry.mtime !== f.lastModified) {
      entry = { mtime: f.lastModified, gz: Bun.gzipSync(new Uint8Array(require("node:fs").readFileSync(path))) };
      gzCache.set(path, entry);
    }
    headers["content-encoding"] = "gzip";
    headers["vary"] = "accept-encoding";
    return new Response(entry.gz, { headers });
  }
  return new Response(f, { headers });
}

let clientVersionCache: { at: number; v: string } | null = null;

// ---- the table --------------------------------------------------------------

type RouteCtx = { req: Request; url: URL; srv: Srv };
type Route = {
  match(url: URL, req: Request): boolean;
  handler(ctx: RouteCtx): Response | Promise<Response>;
};

/** Which file a KTX2-negotiating client (the norm) gets for a library/store model at full detail — the ORDER the
 *  /library/ handler below serves in: a deliberate upstream patch (PATCH_DIR wins over everything), the KTX2 variant,
 *  then (store) store-min, then the optimized mirror, then the original. The catalog ranks this file ("perf if you
 *  load it"). */
function servedGlbPath(rel: string): { path: string; as: "patched copy" | "KTX2 variant" | "compressed copy" | "optimized copy" | "original" } {
  const pt = normalize(join(PATCH_DIR, rel));
  if (pt.startsWith(PATCH_DIR) && existsSync(pt)) return { path: pt, as: "patched copy" };
  const k = join(OPT_DIR, `${rel}.ktx2.glb`);
  if (existsSync(k)) return { path: k, as: "KTX2 variant" };
  if (rel.startsWith("store/")) {
    const m = join(OPT_DIR, "store-min", rel.slice("store/".length));
    if (existsSync(m)) return { path: m, as: "compressed copy" };
  }
  const o = join(OPT_DIR, rel);
  if (existsSync(o)) return { path: o, as: "optimized copy" };
  return { path: rel.startsWith("store/") ? join(OPT_DIR, rel) : join(LIBRARY_DIR, rel), as: "original" };
}
const perfPair = (rel: string, original: string) => {
  const s = servedGlbPath(rel);
  const perf = glbPerfOfFile(s.path);
  return { perf: perf ? { ...perf, servedAs: s.as } : null, perfOriginal: s.path === original ? null : glbPerfOfFile(original) };
};

// The landing spot for the home node's redirect (GET /auth): the token is in the URL FRAGMENT (never reaches this
// server's logs); this page posts it back. Its one inline script is hashed into its CSP.
const AUTH_PAGE = `<!doctype html><meta charset="utf-8"><title>entering…</title>
<style>body{font:16px/1.5 system-ui;max-width:36rem;margin:15vh auto;padding:0 1rem;color:#ddd;background:#111}</style>
<p id=m>entering…</p><script>
(async () => {
  const m = document.getElementById('m');
  const tok = new URLSearchParams(location.hash.slice(1)).get('token');
  if (!tok) { m.textContent = 'no token — start again from the login page'; return; }
  history.replaceState(null, '', '/auth');
  const r = await fetch('/auth', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: tok }) });
  const j = await r.json().catch(() => ({}));
  if (r.ok) {
    m.textContent = 'welcome, ' + j.name;
    let code = ''; try { code = sessionStorage.getItem('ew-native-pair-code') || ''; } catch {}
    location.replace(/^[A-F0-9]{5}-[A-F0-9]{5}$/.test(code) ? '/native#code=' + code : '/');
  }
  else m.textContent = 'login failed: ' + (j.error ?? r.status) + ' — start again from the login page';
})();
</script>`;
const AUTH_PAGE_CSP = cspFor(AUTH_PAGE);

const ROUTES: Route[] = [
  { match: u => u.pathname === "/native" || u.pathname.startsWith("/native/"), handler: ({ req }) => nativeLogin(req) },
  {
    match: (u) => u.pathname === "/ws",
    handler: ({ req, srv }) => {
      // Session rides the upgrade: browsers attach cookies to WS upgrades, so the join carries a verified identity
      // without the client ever seeing a token.
      const session = sessionFromCookie(req.headers.get("cookie"));
      if (session && crossSiteUpgrade(req)) return new Response("a signed-in socket opens only from this server's own page", { status: 403 });   // CSWSH
      // the connection's address, HASHED (never kept raw): what a guest's ban names, since a guest has no account
      const addr = hashedAddress(req, srv);
      if (srv.upgrade(req, { data: { session, addr } })) return undefined as unknown as Response;
      return new Response("expected websocket", { status: 400 });
    },
  },
  // ---- archipelago-home doors ----
  {
    match: (u) => u.pathname === "/authcfg",
    handler: () => new Response(
      JSON.stringify({ login: HN_ISSUER_KEY ? HN_LOGIN_URL : null, required: HN_REQUIRE_LOGIN && Boolean(HN_ISSUER_KEY) }),
      { headers: { "content-type": "application/json", "cache-control": "no-store" } },
    ),
  },
  {
    // client console tee: a visitor's errors and [xr] lines land in a file the operator can tail. Timestamp + text,
    // no address. Bounded by the CLIENTLOG_* limits; door-keyed by `Authorization: Bearer` (never the URL), so an OPEN
    // door accepts writes from anyone who can reach the port — do not run it open on a public box. A failed append
    // answers 500. Lands in $CLIENTLOG_DIR (default WORLDS_DIR/.clientlogs).
    match: (u, req) => u.pathname === "/clientlog" && req.method === "POST",
    handler: async ({ req, url, srv }) => {
      const label = (url.searchParams.get("world") ?? "").replace(/[^a-z0-9_-]/gi, "").slice(0, 64);   // 64: the world-name limit (world.ts)
      // An unknown label shares one bucket and file (a new world's pre-join lines too: shared, not lost).
      // The key rides the Authorization header, never the URL (query tokens leak into proxy logs); a query key is refused.
      if (url.searchParams.has("key")) return new Response("key belongs in the Authorization header", { status: 400 });
      const key = bearerOf(req);
      const session = sessionOfRequest(req);
      // the door is the first gate: no lookup for a stranger (a home-node human has no JOIN_TOKEN)
      if (JOIN_TOKEN && key !== JOIN_TOKEN && !session) return new Response("no", { status: 401 });
      // the sender: the account, else the hashed address (never the address itself)
      const sender = session ? session.sub.replace(/[^a-z0-9_-]/gi, "-").slice(0, 80) : `addr-${hashedAddress(req, srv)}`;
      const wait = clientLogRate.admit(addressOf(req, srv), sender);
      if (wait !== null) return new Response("slow down", { status: 429, headers: { "retry-after": String(wait), "cache-control": "no-store" } });
      const cl = req.headers.get("content-length");
      if (cl === null) return new Response("length required", { status: 411 });
      const len = Number(cl);
      if (!Number.isFinite(len) || len > CLIENTLOG_LIMITS.bodyBytes) return new Response("too big", { status: 413 });
      let body: string | null = null;
      try { body = await readCapped(req, CLIENTLOG_LIMITS.bodyBytes); } catch { return new Response("bad", { status: 400 }); }
      if (body === null) return new Response("too big", { status: 413 });
      if (holdsPrivateKey(body)) return new Response("this body holds a private key: not stored", { status: 400 });
      const { text, scrubbed } = scrub(body);
      const { lines, cut } = boundLines(text);
      const world = label && knownWorld(label) ? label : CLIENTLOG_UNKNOWN;
      // a brand-new world has no dir until its first join, so its pre-join boot lines land in '~unknown' too: shared, not lost
      const t = new Date().toISOString();
      let chunk = lines.map((line) => JSON.stringify({ t, line }) + "\n").join("");
      if (scrubbed || cut) chunk += JSON.stringify({ t, note: `${scrubbed} values scrubbed, ${cut} lines cut` }) + "\n";
      try { if (!clientLogStore) throw new Error(`${CLIENTLOG_DIR} did not open at boot`); if (chunk) clientLogStore.append(world, sender, chunk); }
      catch (e) { console.warn(`[clientlog] append failed: ${(e as Error)?.message ?? e}`); return new Response("tee failed", { status: 500 }); }
      return new Response("ok", { headers: { "cache-control": "no-store" } });
    },
  },
  {
    match: (u) => u.pathname === "/whoami",
    handler: ({ req }) => {
      const s = sessionFromCookie(req.headers.get("cookie"));
      if (!s) return new Response(JSON.stringify({ error: "no session" }), { status: 401, headers: { "content-type": "application/json" } });
      return new Response(JSON.stringify({ sub: s.sub, name: s.name, scopes: s.scopes, claims: s.claims ?? {} }),
        { headers: { "content-type": "application/json", "cache-control": "no-store" } });
    },
  },
  {
    match: (u, req) => u.pathname === "/auth" && req.method === "GET",
    handler: () =>
      // AUTH_PAGE: the home node's redirect lands here (token in the fragment)
      new Response(AUTH_PAGE, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "content-security-policy": AUTH_PAGE_CSP } }),
  },
  {
    match: (u, req) => u.pathname === "/auth" && req.method === "POST",
    handler: async ({ req, url }) => {
      if (!HN_ISSUER_KEY) return new Response(JSON.stringify({ error: "identity door not configured" }), { status: 503, headers: { "content-type": "application/json" } });
      let tok = "";
      try { tok = String((JSON.parse((await readCapped(req, 64 * 1024)) ?? "") as { token?: string }).token ?? ""); } catch { /* fall through */ }   // an id token is ~1 KB
      const v = verifyToken(tok, { issuerId: HN_ISSUER_KEY, iss: HN_ISS, aud: HN_AUD });
      if (!v.ok) {
        console.log(`[auth] login token rejected: ${v.reason}`);
        return new Response(JSON.stringify({ error: v.reason }), { status: 403, headers: { "content-type": "application/json" } });
      }
      const p = v.payload;
      // a cookie session is a human's (account shapes: server/directory.ts header); agents prove themselves at the join door
      const notHere = p.kind !== "human" ? "this is an agent's credential: agents join with it as their agentToken (the join door), not here"
        : !p.sub.startsWith("human:") ? "this login's subject isn't a human account (human:…); agents join with their token"
        : !p.scopes.includes("worlds:join") && !p.scopes.includes("worlds:spectate") ? "this login grants neither worlds:join nor worlds:spectate"
        : null;
      if (notHere) {
        console.log(`[auth] login refused (kind ${p.kind}): ${notHere}`);
        return new Response(JSON.stringify({ error: notHere }), { status: 403, headers: { "content-type": "application/json" } });
      }
      if (p.jti && !hnJti.claim(p.jti, p.exp)) {
        console.log(`[auth] login token replayed: ${p.sub}`);
        return new Response(JSON.stringify({ error: "token already used" }), { status: 403, headers: { "content-type": "application/json" } });
      }
      const sid = randomBytes(32).toString("hex");
      // opportunistic sweep — one entry per login, the map stays small
      for (const [k, s] of hnSessions) if (s.exp < Date.now()) hnSessions.delete(k);
      hnSessions.set(sid, { sub: p.sub, name: p.name, scopes: p.scopes, claims: p.claims, exp: Date.now() + SESSION_TTL_MS });
      saveSessions();
      const secure = (req.headers.get("x-forwarded-proto") ?? url.protocol.replace(":", "")) === "https" ? "; Secure" : "";
      console.log(`[auth] session for ${p.sub} ("${p.name}") [${p.scopes.join(" ")}]`);
      return new Response(JSON.stringify({ ok: true, name: p.name, sub: p.sub }), {
        headers: {
          "content-type": "application/json",
          "set-cookie": `ew_sess=${sid}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}${secure}`,
        },
      });
    },
  },
  {
    match: (u) => u.pathname === "/logout",
    handler: ({ req }) => {
      const sid = sessionIdOf(req.headers.get("cookie"));
      if (sid && hnSessions.delete(sid)) saveSessions();
      return new Response(JSON.stringify({ ok: true }), {
        headers: { "content-type": "application/json", "set-cookie": "ew_sess=; Path=/; HttpOnly; Max-Age=0" },
      });
    },
  },
  // the first-run setup link (server/setup.ts): only while no operator exists; after that /setup is any missing page
  { match: (u, req) => u.pathname === "/setup" && req.method === "GET" && setupOpen(), handler: () => setupPage() },
  { match: (u, req) => u.pathname === "/setup" && req.method === "POST" && setupOpen(), handler: ({ req, srv }) => setupClaim(req, srv) },
  {
    match: (u) => u.pathname === "/check",
    handler: async ({ req, url, srv }) => {
      // The build check (server/buildcheck.ts): what a model is like to walk into. Advisory and public, like /geom;
      // computed once per model in its own process (buildcheck-queue.ts), so the first ask can take seconds.
      const j = (o: unknown, status = 200) =>
        new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
      const lib = url.searchParams.get("lib") ?? "";
      const file = resolveLibFile(lib);
      if (!file) return j({ error: `no such asset: ${lib}` }, 404);
      // ?scale= checks it as a thing placed at that scale (0.05–20, to 2 places)
      const scale = checkScale(url.searchParams.get("scale") ?? 1);
      // public, so its new work is gated per address and its queue is capped (buildcheck-queue.ts)
      const ip = addressOf(req, srv);
      try { return j({ lib, ...(await checkFile(file, scale, undefined, { address: ip }) as object) }); }
      catch (err) {
        if (err instanceof CheckRefused)
          return new Response(JSON.stringify({ lib, error: err.message }), { status: err.status, headers: { "content-type": "application/json", "retry-after": String(err.retryAfter) } });
        return j({ lib, error: String((err as Error)?.message ?? err) }, 500);
      }
    },
  },
  {
    match: (u) => u.pathname === "/geom",
    handler: async ({ req, url, srv }) => {
      // Geometry as DATA, for beings who perceive by reading. Three tiers:
      //   /geom?lib=<path>           one asset: bbox, flat zones, named parts
      //   /geom?world=W&id=<entity>  that asset + the entity's world transform
      //   /geom?world=W              every entity + transform (+local bbox; &boxes=0 skips the parses)
      const j = (o: unknown, status = 200) =>
        new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
      const wname = url.searchParams.get("world");
      if (!wname) {
        const lib = url.searchParams.get("lib") ?? "";
        const file = resolveLibFile(lib);
        if (!file) return j({ error: `no such asset: ${lib}` }, 404);
        const sum = await summarizeGlb(file);
        return sum ? j({ lib, ...sum }) : j({ error: "geometry parsing unavailable" }, 503);
      }
      if (!mayRead(req)) return unauthorized();
      // read-only, LOADED or on-disk worlds, never creates one; a world closed to this caller reads exactly like one that
      // does not exist (access.ts)
      // (one question, the access index's, for every name: a missing world and a hidden one take the same path)
      if (!WORLD_NAME_RE.test(wname) || !visibleTo(doorFor(wname), httpVisitor(req, srv))) return j({ error: "no such world" }, 404);
      const w = getWorld(wname);
      // the view record (shared/protocol/view.js viewOf) verbatim — scale3, q, every component — never a projection of it
      const record = (eid: string, e: Record<string, unknown>) => ({ id: eid, ...e, model: e.model ?? null, parent: e.parent ?? null });
      const id = url.searchParams.get("id");
      if (id) {
        const e = w.state.entities[id];
        if (!e) return j({ error: `no entity "${id}" in ${wname}` }, 404);
        const file = e.model ? resolveLibFile(e.model) : null;
        const sum = file ? await summarizeGlb(file) : null;
        return j({ ...record(id, e),
          geometry: sum,   // local frame — compose with pos/q-or-yaw/scale for world space
          note: "geometry coords are the MODEL's local frame; sockets use the same frame, so a topSurface center is a socket pos verbatim. The pose is the log's: a thing in flight reads at its last logged pose until its rest is logged" });
      }
      const withBoxes = url.searchParams.get("boxes") !== "0";
      const out = [];
      for (const [eid, e] of Object.entries(w.state.entities)) {
        const file = withBoxes && e.model ? resolveLibFile(e.model) : null;
        const sum = file ? await summarizeGlb(file) : null;
        out.push({ ...record(eid, e), ...(sum ? { bbox: sum.bbox, tris: sum.tris } : {}) });
      }
      return j({ world: wname, entities: out });
    },
  },
  {
    match: (u, req) => u.pathname === "/upload" && req.method === "POST",
    handler: ({ req, url, srv }) => handleUpload(req, url, srv),
  },
  {
    // POST /seat-profile — the live proposal door. A named actor only (?token= a tokens.json key or aid1 identity; an
    // Authorization header isn't read); the anonymous
    // door token may not write, since a seat profile moves every wearer. Writes proposals only; acceptance has no HTTP path
    // (tools/operator/seat-accept.ts).
    match: (u, req) => u.pathname === "/seat-profile" && req.method === "POST",
    handler: async ({ req, url }) => {
      const j = (o: unknown, status = 200) => new Response(JSON.stringify(o),
        { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
      const tok = url.searchParams.get("token") ?? "";
      const actor = agentTokens().byToken.get(tok) ?? aid1JoinIdentity(tok)?.slug;
      if (!actor) {
        return j({ error: "a named actor is required — a tokens.json bearer or an aid1 credential; the authority token may not write seat profiles" }, 401);
      }
      const text = await readCapped(req, MAX_PROPOSAL_BYTES);
      if (text === null) {
        return j({ error: `proposal exceeds ${MAX_PROPOSAL_BYTES} bytes` }, 413);
      }
      let record: unknown;
      try { record = JSON.parse(text); } catch { return j({ error: "body must be JSON" }, 400); }
      const r = seatStore.propose(record as Record<string, unknown>, actor);
      if (!r.ok) return j({ error: r.why }, r.status);
      const notified = announceProfileUpdate(r.name, r.pose, r.rev);
      console.log(`[seats] proposal ${r.name}/${r.pose} by ${actor} → rev ${r.rev}, ${notified} client(s) notified`);
      return j({ ok: true, status: "proposed", rev: r.rev, name: r.name, pose: r.pose });
    },
  },
  {
    match: (u) => u.pathname === "/snap",
    handler: async ({ req, url, srv }) => {
      if (!mayRead(req)) return unauthorized();
      // /snap is idle while it waits for the frame: its own timeout, a little past the broker's longest wait, capped at
      // Bun's 255s idleTimeout ceiling (config.ts keeps SNAP_TIMEOUT_SEC under it).
      srv.timeout?.(req, Math.min(255, Math.ceil(screenshots.maxWaitMs / 1000) + 5));
      const w = worlds.get(url.searchParams.get("world") ?? "commons");
      const follow = url.searchParams.get("follow") ?? "";
      if (!w || !visibleTo(doorFor(w.name), httpVisitor(req, srv))) return new Response("unknown world", { status: 404 });
      const q = url.searchParams;
      const at = (q.get("at") ?? "").slice(0, 200) || undefined;
      const frame = normalizeSnapFrame({ dist: q.get("dist"), height: q.get("height"), pitch: q.get("pitch") });
      // ?budget=<ms>: how long the caller will wait (the MCPL tool sends what is left of its call); the broker never
      // keeps it longer. Out of range or absent: the broker's own deadline.
      const budget = Number(q.get("budget"));
      const callerBudget = Number.isFinite(budget) && budget >= 1_000 && budget <= 600_000 ? budget : undefined;
      // req.signal aborts when the asker goes away: a waiting ask then leaves the queue unserved (screenshots.ts)
      const r = await screenshots.request(w, follow, q.get("view") ?? "first", q.get("renderer") ?? "auto", frame, at, callerBudget, req.signal);
      // Retry-After only on a failure asking again soon can fix (screenshots.ts retryAfter): the MCPL tool asks again
      // exactly when it is there
      if (!r.ok) return new Response(r.err, { status: r.status, headers: { "cache-control": "no-store",
        ...(r.retryAfter ? { "retry-after": String(r.retryAfter) } : {}) } });
      return new Response(r.png, { headers: { "content-type": "image/png", "cache-control": "no-store",
        "x-content-type-options": "nosniff", "x-eidoverse-renderer": r.engine, "x-eidoverse-scene": r.scene } });
    },
  },
  {
    // A world's ground as a 16-bit grayscale PNG (server/heightmap.ts) — the export half of heightmap terrain,
    // to edit in an image editor or Blender and bring back with POST /upload?as=heightmap. A read of the world's
    // live state, so behind the same door as /worlds and /geom (mayRead); never creates a world. ?res= samples a
    // side (default 257); ?format=json answers the height range alone.
    match: (u) => u.pathname === "/heightmap",
    handler: ({ req, url, srv }) => {
      if (!mayRead(req)) return unauthorized();
      const name = url.searchParams.get("world") ?? "commons";
      if (!WORLD_NAME_RE.test(name)) return new Response("bad world name", { status: 400 });
      // the access index's answer for every name: missing and hidden alike
      { const door = doorFor(name); if (!door || !visibleTo(door, httpVisitor(req, srv))) return new Response("no such world", { status: 404 }); }
      const t = getWorld(name).state.terrain;
      if (!t) return new Response("this world has no terrain (it is flat)", { status: 404 });
      if (url.searchParams.get("format") === "json") return Response.json({ ...heightRange(t as Record<string, unknown>), world: name });
      // bounded work on the serving thread, gated BEFORE the work (server/heightmap.ts serveHeightmapExport)
      const ip = addressOf(req, srv);
      const out = serveHeightmapExport(t as Record<string, unknown>, Number(url.searchParams.get("res") ?? 257), name, ip);
      if (!out.ok) return new Response(out.error, { status: out.status, headers: { "retry-after": String(out.retryAfter) } });
      const { png, meta } = out;
      return new Response(png, { headers: {
        "content-type": "image/png", "cache-control": "no-store",
        "content-disposition": `attachment; filename="${name}-heightmap.png"`,
        "x-terrain-min": String(meta.min), "x-terrain-max": String(meta.max), "x-terrain-size": String(meta.size),
      } });
    },
  },
  {
    // Discovery for travel: loaded + on-disk worlds and who is embodied where; never creates one. Behind the join door
    // (mayRead). Spectators and renderers are absent, as in-world. ONE list of people, each {id, declares?} (the word
    // they declared at the door, PROTOCOL §6a) — never a second list sorted by kind.
    match: (u) => u.pathname === "/worlds",
    handler: ({ req, srv }) => {
      if (!mayRead(req)) return unauthorized();
      const names = new Set<string>(worlds.keys());
      try {
        for (const n of readdirSync(WORLDS_DIR)) {
          if (WORLD_NAME_RE.test(n) && existsSync(join(WORLDS_DIR, n, "world.jsonl"))) names.add(n);   // listed: its own case already
        }
      } catch { /* no worlds dir yet: only loaded worlds */ }
      // PER CALLER: a world closed to whoever is asking is not on their map at
      // all — invite-only worlds are unlisted and invisible (access.ts). The
      // caller is the cookie session or an Authorization bearer; anonymous
      // callers see what everyone may see. `access` is the world's door for
      // everyone not named; `you` is what THIS caller may do there.
      const caller = httpVisitor(req, srv);
      const out = [...names].sort().flatMap((name) => {
        const door = doorFor(name);
        if (!door || !visibleTo(door, caller)) return [];
        const w = worlds.get(name);
        const present = w ? [...w.clients].filter((c) => !c.spectator && !c.superseded) : [];
        const mine = youAt(door, caller).you === "enter" ? "enter" : "watch";
        return [{
          name,
          loaded: !!w,
          access: door.label,          // open | public | signed-in | watch | invite-only: the door for everyone it doesn't list
          you: mine,                   // enter | watch: what THIS caller may do there
          people: present.map((c) => ({ id: c.id, ...(c.declares ? { declares: c.declares } : {}) })),   // everyone here, human or agent
          agents: present.filter((c) => c.declares === "agent").map((c) => c.id),   // main's field (decision table row 21): by declaration (§6a), never inferred
        }];
      });
      return new Response(JSON.stringify({ worlds: out }),
        { headers: { "content-type": "application/json", "cache-control": "no-store" } });
    },
  },
  {
    // "May I go there?" — asked BEFORE moving, so a refused trip never strands a body. Signed-in callers only (else 401).
    // A world the caller may not discover answers the same 404 as a missing one (access.ts toldOf: no existence oracle).
    //   { world, exists: true, you: "enter"|"watch"|"none", why? } | 404 {code: "world-unavailable", message}
    match: (u) => u.pathname === "/access",
    // An interrupted conversion or an old-format world is said only to the operator or its recognised owner (access.ts toldOf):
    //   { world, exists: true, you: "none", state: "interrupted" | "old-format", why }
    handler: async ({ req, url }) => {
      const j = (o: unknown, status = 200) => new Response(JSON.stringify(o),
        { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
      const caller = httpCaller(req);
      if (!caller) return j({ error: "sign in (cookie) or send Authorization: Bearer <your credential>" }, 401);
      const name = url.searchParams.get("world") ?? "";
      if (!WORLD_NAME_RE.test(name)) return j({ error: `"${name}" is not a world name` }, 400);
      const told = await toldOf(name, caller, httpProven(req));
      if (told.kind === "unavailable") return j(unavailable(name), 404);
      if (told.kind === "interrupted") return j({ world: name, exists: true, you: "none", state: "interrupted", why: interruptedVisitorText(name) });
      if (told.kind === "old") return j({ world: name, exists: true, you: "none", state: "old-format", why: told.old.visitor });
      const door = told.door;
      const y = youAt(door, caller);
      return j({ world: name, exists: true, you: y.you, ...(y.why && y.you !== "enter" ? { why: y.why } : {}) });
    },
  },
  {
    match: (u) => u.pathname === "/avatars",
    handler: () => new Response(JSON.stringify(avatarRoster()),
      { headers: { "content-type": "application/json", "cache-control": "no-store",
        // the store revision the verdicts were judged at: the client's generation guard, so a slow response can't roll back
        "x-profiles-rev": String(seatStore.rev) } }),
  },
  {
    // The heartbeat's gauges: per-system runs / worst ms / errors. Public and cheap like /version.
    match: (u) => u.pathname === "/tick",
    handler: () => new Response(JSON.stringify({ ...tickStats() }),
      { headers: { "content-type": "application/json", "cache-control": "no-store" } }),
  },
  {
    // The def registry, one fetch per client boot; no-store so an edited def reaches the next boot.
    match: (u) => u.pathname === "/defs",
    handler: () => new Response(defsPayload(),
      { headers: { "content-type": "application/json", "cache-control": "no-store" } }),
  },
  {
    // The clip roster, mtime-stamped. no-store on the LISTING is what makes
    // the stamps trustworthy: the listing must never be the stale thing.
    match: (u) => u.pathname === "/animations",
    handler: () => new Response(JSON.stringify(animationRoster()),
      { headers: { "content-type": "application/json", "cache-control": "no-store" } }),
  },
  {
    // diagnostics: the adapter's live SFU view — legs, gens, consent, incarnation.
    match: (u) => u.pathname === "/relay-diag",
    // who hears whom is the world's live state: behind the joining door, like /snap
    handler: ({ req, url, srv }) => !mayRead(req) ? unauthorized() : new Response(
      JSON.stringify((() => {
        // a world the caller may not see answers like one with no voice at all
        const name = url.searchParams.get("world") ?? "commons";   // the default world, as /snap and /heightmap
        const w = worlds.get(name);
        return w && !visibleTo(doorFor(name), httpVisitor(req, srv)) ? { transport: "sfu", active: false } : sfuDiag(name);
      })()),
      { headers: { "content-type": "application/json", "cache-control": "no-store" } }),
  },
  {
    // Which build is this world running — public, cheap, no-store. WORLD_INSTANCE_NONCE (test-only, like the authority's
    // MCPL_INSTANCE_NONCE) adds `instance`, a portable proof that a harness's own child is answering.
    match: (u) => u.pathname === "/version",
    // the key and nonces come from this running process, never from a newly served disk file
    handler: () => new Response(
      JSON.stringify({
        ...BUILD,
        ktx2Key: KTX2_KEY,
        lodRecipe: LOD_RECIPE,
        // what the optimizer is doing / could not afford (config.ts OPT_MEM_BUDGET_MB)
        opt: optStatus(),
        ...(process.env.WORLD_INSTANCE_NONCE ? { instance: process.env.WORLD_INSTANCE_NONCE } : {}),
      }),
      { headers: { "content-type": "application/json", "cache-control": "no-store" } }),
  },
  {
    match: (u) => u.pathname.startsWith("/thumb/"),
    handler: async ({ url }) => {
      // Avatar thumbnails, CONTRIBUTED: whoever wears a body renders one off its loaded VRM and posts it (POST /thumb).
      const name = decodeURIComponent(url.pathname.slice("/thumb/".length)).replace(/\.png$/, "");
      const safe = name.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 48);
      const f = Bun.file(join(OPT_DIR, "thumbs", `${safe}.png`));
      if (!(await f.exists())) return new Response("no thumb", { status: 404 });
      return new Response(f, {
        headers: { "content-type": "image/png", "cache-control": "public, max-age=3600" },
      });
    },
  },
  {
    match: (u, req) => u.pathname === "/perflog" && req.method === "POST",
    handler: async ({ req, srv }) => {
      // Load-performance beacon (client/lib/render/loadwork.js): append-only capped JSONL of timing lines and a UA.
      try {
        const body = await readCapped(req, 100_000);
        if (body !== null) {
          const dest = join(WORLDS_DIR, ".perflogs.jsonl");
          const big = existsSync(dest) && Bun.file(dest).size > 5_000_000;
          if (!big) {
            // the address HASHED, like everywhere else this server keeps one : enough to tell one
            // visitor's lines from another's, never the address itself; and the beacon can't write its own ts/addr/ip
            const ip = addressOf(req, srv);
            const addr = sha256(`eidoverse-perflog:${ip}`).slice(0, 24);
            const { ts: _t, ip: _i, addr: _a, ...line } = JSON.parse(body) ?? {};
            appendFileSync(dest, JSON.stringify({ ts: Date.now(), addr, ...line }) + "\n");
          }
        }
      } catch { /* malformed beacon: drop */ }
      return new Response("ok");
    },
  },
  {
    // A Build card's rebuild button: re-run one object's KTX2 + LOD passes (a refusal asked again, a built variant
    // rebuilt in place). Gated on the /upload sign-ins + a session cookie (below); rate-limited; the queue dedups.
    match: (u, req) => u.pathname === "/rebuild" && req.method === "POST",
    handler: ({ req, url, srv }) => {
      // Who may ask: the sign-ins /upload accepts (the authority key, an agent token, an aid1 credential) plus a signed-in
      // session cookie — a person who came in through the home node carries no door key and got 401 here. The key rides
      // `Authorization: Bearer`, never the URL (base.js: it would land in access logs). A key in ?token= is refused.
      if (JOIN_TOKEN) {
        const key = bearerOf(req);
        const ok = (key && (key === JOIN_TOKEN || agentTokens().byToken.has(key) || !!aid1JoinIdentity(key)))
          // a cookie rides requests from sibling subdomains (SameSite=Lax is per-SITE): never from another site's page.
          // Embodied sign-ins only (worlds:join), as /upload asks: a spectate-only session can't rebuild
          || !!sessionOfRequest(req)?.scopes.includes("worlds:join");
        if (!ok) return new Response("sign in or send the authority key as a Bearer header", { status: 401 });
      }
      // a forced rebuild skips the freshness check, so a POST loop could keep the one serial pump busy and starve uploads
      const ip = addressOf(req, srv);
      const w = rebuildWin.get(ip) ?? { t: 0, n: 0 };
      if (Date.now() - w.t > 60_000) { w.t = Date.now(); w.n = 0; }
      w.n++; rebuildWin.set(ip, w);
      if (rebuildWin.size > 1000) for (const [k, v] of rebuildWin) if (Date.now() - v.t > 60_000) rebuildWin.delete(k);   // bounded
      if (w.n > 4) return new Response("rebuild rate limit (4/min)", { status: 429 });
      const r = rebuildAsset(url.searchParams.get("path") ?? "");
      if (!r) return new Response("not a rebuildable object", { status: 400 });
      console.log(`[rebuild] ${url.searchParams.get("path")}: ${r.queued.join(" + ") || "nothing (no encoder)"}`);
      return new Response(JSON.stringify({ ok: true, ...r }), { headers: { "content-type": "application/json" } });
    },
  },
  {
    match: (u, req) => u.pathname === "/thumb" && req.method === "POST",
    handler: async ({ req, url }) => {
      // The authority key rides `Authorization: Bearer`, never the URL (access logs; see /clientlog). The old ?token= shape
      // is refused outright so a stale client cannot keep leaking it.
      if (url.searchParams.has("token")) return new Response("key belongs in the Authorization header", { status: 400 });
      if (JOIN_TOKEN && bearerOf(req) !== JOIN_TOKEN)
        return new Response("token required", { status: 401 });
      const safe = (url.searchParams.get("name") ?? "").replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 48);
      if (!safe) return new Response("name required", { status: 400 });
      const dir = join(OPT_DIR, "thumbs");
      mkdirSync(dir, { recursive: true });
      const dest = join(dir, `${safe}.png`);
      // the body's measured stature, kept beside the images for /avatars
      const height = Number(url.searchParams.get("height"));
      const hOk = Number.isFinite(height) && height > 0.2 && height < 20;
      // …and the loupe numbers measured on the LOADED body (perfscope.statsOf), tied to version `v`; the rank is
      // recomputed here (shared/perfrank.js), never taken from the client.
      const perf = avatarPerfParam(url.searchParams.get("perf"), url.searchParams.get("v"));
      if (hOk || perf) {
        const metaPath = join(dir, "meta.json");
        let meta: Record<string, { h?: number; perf?: AvatarPerf }> = {};
        try { if (existsSync(metaPath)) meta = JSON.parse(readFileSync(metaPath, "utf8")); } catch { /* fresh */ }
        meta[safe] = { ...meta[safe], ...(hOk ? { h: Math.round(height * 100) / 100 } : {}), ...(perf ? { perf } : {}) };
        atomicWrite(metaPath, JSON.stringify(meta));
      }
      // First contributor wins (re-posting on every join would be pointless
      // write traffic) — unless a re-mint pass explicitly forces the refresh.
      const force = url.searchParams.get("force") === "1";
      if (existsSync(dest) && !force) return new Response(JSON.stringify({ ok: true, existed: true, perf: !!perf }),
        { headers: { "content-type": "application/json" } });
      const body = await readCappedBytes(req, 400_000);
      if (body === null) return new Response("thumb too large", { status: 413 });
      if (body.length === 0 && perf) return new Response(JSON.stringify({ ok: true, meta: true, perf: true }), { headers: { "content-type": "application/json" } });
      if (body.length < 8 || body[0] !== 0x89 || body[1] !== 0x50) return new Response("not a PNG", { status: 415 });
      writeFileSync(dest, body);
      console.log(`[thumb] ${safe} (${(body.length / 1000).toFixed(0)}KB${force ? ", forced" : ""})`);
      return new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json" } });
    },
  },
  {
    match: (u) => u.pathname === "/library-list",
    handler: ({ url }) => {
      // Directory listing over the library: the browser host discovers which toolkit modules to prime into its
      // virtual filesystem, rather than carrying a manifest.
      const rel = url.searchParams.get("dir") ?? "";
      const out: { path: string; size: number }[] = [];
      const walk = (base: string, sub: string, depth: number) => {
        if (depth > 4) return;
        const abs = normalize(join(base, sub));
        if ((abs !== base && !abs.startsWith(base + sep)) || !existsSync(abs)) return;   // inside base, never a sibling sharing its prefix (#260 bot 16)
        for (const e of readdirSync(abs, { withFileTypes: true })) {
          const childRel = sub ? `${sub}/${e.name}` : e.name;
          if (e.isDirectory()) walk(base, childRel, depth + 1);
          // serving artifacts (variants, .failed markers, .tmp) are not entries (store-variants.ts)
          else if (!isServingArtifact(e.name)) out.push({ path: childRel, size: Bun.file(join(abs, e.name)).size });
        }
      };
      // opt first: the listed size must be the file /library/ actually serves (the prefetcher budgets by it)
      for (const base of [OPT_DIR, LIBRARY_DIR]) walk(base, rel, 0);
      // opt mirror shadows the library at the same path — dedupe, first wins
      const seen = new Set<string>();
      const uniq = out.filter((f) => !seen.has(f.path) && seen.add(f.path));
      return new Response(JSON.stringify(uniq), {
        headers: { "content-type": "application/json", "cache-control": "no-store" },
      });
    },
  },
  {
    match: (u) => u.pathname === "/library-models",
    handler: ({ url }) => {
      // The catalog agents have (mcpl `list_library`), served to humans; filename token scoring, for parity with it.
      const q = (url.searchParams.get("q") ?? "").toLowerCase().split(/\s+/).filter(Boolean);
      const dirs = [join(LIBRARY_DIR, "eidoverse/assets/models"), join(OPT_DIR, "eidoverse/assets/models")];
      const files = new Map<string, number>();
      for (const d of dirs) {
        if (!existsSync(d)) continue;
        for (const f of readdirSync(d)) {
          // variants, markers and .tmp beside originals are not catalog entries (store-variants.ts, as /library-list)
          if (!f.endsWith(".glb") || isServingArtifact(f)) continue;
          const low = f.toLowerCase();
          const score = q.length ? q.filter((t) => low.includes(t)).length : 1;
          if (score > 0) files.set(f, Math.max(files.get(f) ?? 0, score));
        }
      }
      const hits = [...files]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .slice(0, 60)
        .map(([f]) => {
          // the library ships a _preview.jpg beside every model
          const prev = f.replace(/\.glb$/i, "_preview.jpg");
          const hasPrev = dirs.some((d) => existsSync(join(d, prev)));
          // every optimization's state, from the sweep's own markers (store-variants.ts variantStatus): the
          // library's variants live in the OPT mirror beside where the original's optimized copy would be
          const libOpt = join(OPT_DIR, "eidoverse/assets/models");
          const libSrc = variantSource(`eidoverse/assets/models/${f}`, { opt: OPT_DIR, library: LIBRARY_DIR })!;
          const rebuildable = existsSync(libSrc);
          return {
            path: `eidoverse/assets/models/${f}`,
            // ↻ rebuilds from the LIBRARY source (upload.ts rebuildAsset); a model present only in the OPT overlay has
            // none, and the button would answer 400 — say so, and the card leaves it off
            rebuildable,
            // no "min" pass for library models (store/ only), so it is omitted. Freshness is judged against
            // variantSource, as the sweep and the route do.
            opt: (({ min: _none, ...rest }) => rest)(variantStatus(join(libOpt, f), libOpt, { source: libSrc })),
            // the loupe's rank of the SERVED file, and of the original beside it (glbperf.ts; mtime-cached; null = unreadable)
            ...perfPair(`eidoverse/assets/models/${f}`, join(LIBRARY_DIR, "eidoverse/assets/models", f)),
            // strip the SEO-soup filenames into something a person can read
            name: f.replace(/\.glb$/i, "").replace(/_/g, " ").slice(0, 48),
            preview: hasPrev ? `eidoverse/assets/models/${prev}` : null,
            // who made it and its licence (defs/library/credits.json; a gap says what isn't recorded)
            credits: creditsFor(libraryCredits(), `eidoverse/assets/models/${f}`),
          };
        });
      // Conjured/delivered objects (the content-addressed store) are catalog too: newest first, names from the manifest.
      const storeDir = join(OPT_DIR, "store");
      if (existsSync(storeDir)) {
        let man: Record<string, { name?: string; by?: string; ts?: number }> = {};
        try { man = JSON.parse(readFileSync(join(storeDir, "manifest.json"), "utf8")); } catch { /* unnamed */ }
        const store = readdirSync(storeDir)
          // originals only, no variants (store-variants.ts)
          .filter(isStoreOriginal)
          .map((f) => {
            const hash = f.replace(/\.glb$/i, "");
            const m = man[hash];
            return { f, name: (m?.name ?? `conjured ${hash.slice(0, 8)}`).slice(0, 48), ts: m?.ts ?? 0,
              score: q.length ? q.filter((t) => (m?.name ?? "").toLowerCase().includes(t)).length : 1 };
          })
          .filter((s) => s.score > 0)
          .sort((a, b) => b.ts - a.ts)
          .slice(0, 30)
          // the status + perf read (a GLB parse on a cold cache) only for the 30 that are returned, never the whole store
          .map(({ f, name }) => ({ path: `store/${f}`, name, preview: null as string | null, rebuildable: true,
            opt: variantStatus(join(storeDir, f), STORE_MIN), ...perfPair(`store/${f}`, join(storeDir, f)) }));
        hits.push(...store);
      }
      return new Response(JSON.stringify(hits), {
        headers: { "content-type": "application/json", "cache-control": "no-store" },
      });
    },
  },
  // spec/EIDO-URIS.md §3: exactly the bytes an address names (the original upload, never a variant), cached forever
  {
    match: (u) => /^\/eido\/sha256\/[0-9a-f]{64}$/.test(u.pathname),
    handler: ({ req, url }) => {
      const file = eidoFile(url.pathname.slice("/eido/sha256/".length));
      if (!file) return new Response("not found", { status: 404 });
      return serveFrom(dirname(file), basename(file), true, req, true);
    },
  },
  {
    match: (u) => u.pathname.startsWith("/library/"),
    handler: ({ req, url }) => {
      // The ladder and its negotiation: docs/research/library-serving.md.
      // /library/eido/sha256/<hex>.glb (shared/eido.js libRelOf): an address gets this host's rendition, same ladder
      const rel0 = url.pathname.slice("/library/".length); const eh = hexOfLibRel(rel0);   // either spelling of an address (shared/eido.js)
      // url.pathname keeps percent-encoding; libraryRel() decodes it to the disk name (and refuses a decoded ".."), the
      // same function every resolver reads a lib through (server/libfile.ts), so they agree on every name
      const dec = eh ? rel0 : libraryRel(rel0);
      if (dec === null) return new Response("forbidden", { status: 403 });
      const rel = eh ? eidoRel(eh) ?? rel0 : dec;
      // optimized mirror first (draco+webp): same path, ~30x smaller
      const versioned = url.searchParams.has("v") || rel.startsWith("store/"); // content-addressed = immutable
      // ?native=1: provenance bytes, never the optimized shadow (native importers may lack Draco/WebP decoders)
      if (url.searchParams.get("native") === "1" && /\.(glb|vrm)$/i.test(rel)) {
        const patched = normalize(join(PATCH_DIR, rel));
        if (patched.startsWith(PATCH_DIR + "/") && existsSync(patched)) return serveFrom(PATCH_DIR, rel, true, req, versioned);
        if (rel.startsWith("store/")) return serveFrom(OPT_DIR, rel, true, req, true);
        return serveFrom(LIBRARY_DIR, rel, true, req, versioned);
      }
      // deliberate upstream forks (PATCH_DIR) win over everything
      {
        const p = normalize(join(PATCH_DIR, rel));
        if (p.startsWith(PATCH_DIR) && existsSync(p)) return serveFrom(PATCH_DIR, rel, true, req, versioned);
      }
      // KTX2 is negotiated (GLBs, VRMs, loose images): parsers without a decoder throw on its required
      // extension, so only ?ktx2=<key> gets it.
      const negotiable = rel.endsWith(".glb") || rel.endsWith(".vrm") || /\.(png|jpe?g)$/i.test(rel);
      // the key is a generation (shared/ktx2.js): a retired one is an unflagged fetch
      const wantKtx2 = wantsKtx2(url.searchParams) && negotiable;
      // the LOD tier rides the ktx2 negotiation, asked only with the recipe /version published
      const lodAsked = url.searchParams.get("lod");
      const wantLod = lodAsked === LOD_RECIPE && wantKtx2 && rel.endsWith(".glb");
      // the tier's answer is NAMED on the wire, x-eidoverse-lod: `variant` | `refused=<kind>` (final) | `provisional`
      let lodFinal = false;
      let lodState: string | null = null;
      if (wantLod) {
        const lRel = lodVariantPath(rel);
        const l = normalize(join(OPT_DIR, lRel));
        // library sources are MUTABLE: a variant or verdict about an older source is stale (freshOver vs variantSource)
        const src = variantSource(rel, { opt: OPT_DIR, library: LIBRARY_DIR });
        const freshOverSource = (p: string) => freshOver(p, src);
        if (l.startsWith(OPT_DIR) && existsSync(l) && freshOverSource(l)) return serveFrom(OPT_DIR, lRel, true, req, versioned, false, { variant: true, headers: { "x-eidoverse-lod": "variant" } });
        const marker = `${l}.failed`;
        if (l.startsWith(OPT_DIR) && existsSync(marker) && freshOverSource(marker)) {
          let content = "";
          try { content = readFileSync(marker, "utf8"); } catch { /* unreadable = undecided */ }
          const kind = lodVerdictKind(content);
          lodFinal = lodVerdictFinal(content);
          lodState = lodFinal ? `refused=${kind}` : `provisional; verdict=${kind ?? "unknown"}`;
        } else lodState = "provisional";
      } else if (lodAsked != null) lodState = "provisional; generation=unrecognized";
      const lodHeader = lodState ? { "x-eidoverse-lod": lodState } : undefined;
      if (wantKtx2) {
        const kRel = rel.endsWith(".glb") ? `${rel}.ktx2.glb`
          : rel.endsWith(".vrm") ? `${rel}.ktx2.vrm` : `${rel}.ktx2`;
        const k = normalize(join(OPT_DIR, kRel));
        if (k.startsWith(OPT_DIR) && existsSync(k)) {
          let fresh = true;
          if (rel.endsWith(".vrm")) fresh = freshOver(k, variantSource(rel, { opt: OPT_DIR, library: LIBRARY_DIR }));
          // a lod ask answered by the plain ktx2 variant is provisional unless a typed verdict stands — and a FINAL
          // answer also needs fresh ktx2 bytes
          let ktx2Stale = false;
          if (lodFinal) ktx2Stale = !freshOver(k, variantSource(rel, { opt: OPT_DIR, library: LIBRARY_DIR }));
          const finalHere = lodFinal && !ktx2Stale;
          const header = ktx2Stale ? { "x-eidoverse-lod": `${lodState!.replace(/^refused=/, "provisional; verdict=")}; ktx2=stale` } : lodHeader;
          if (fresh) return serveFrom(OPT_DIR, kRel, true, req, versioned, lodAsked != null && !finalHere, { variant: true, headers: header });
        }
      }
      // a flagged fetch that falls through is PROVISIONAL for that URL, even content-addressed (the variant may land
      // later); so is any answer to an unrecognized lod generation
      const provisional = wantKtx2 || (lodAsked != null && !wantLod);
      const deepHeader = lodFinal ? { "x-eidoverse-lod": `${lodState}; ktx2=undecided` } : lodHeader;
      // store uploads: prefer the store-min shadow; the original is provenance and the fallback
      if (rel.startsWith("store/")) {
        const minRel = `store-min/${rel.slice("store/".length)}`;
        const min = normalize(join(OPT_DIR, minRel));
        if (min.startsWith(OPT_DIR) && existsSync(min)) return serveFrom(OPT_DIR, minRel, true, req, true, provisional, { headers: deepHeader });
      }
      const opt = normalize(join(OPT_DIR, rel));
      if (opt.startsWith(OPT_DIR) && existsSync(opt)) return serveFrom(OPT_DIR, rel, true, req, versioned, provisional, { headers: deepHeader });
      return serveFrom(LIBRARY_DIR, rel, true, req, versioned, provisional, { headers: deepHeader });
    },
  },
  {
    match: (u) => u.pathname.startsWith("/node_modules/"),
    handler: ({ req, url }) => serveFrom(join(ROOT, "client"), url.pathname.slice(1), true, req),
  },
  {
    // shared/ — modules every runtime folds with (shared/README.md); code, so no-store like the client
    match: (u) => u.pathname.startsWith("/shared/"),
    handler: ({ req, url }) => serveFrom(join(ROOT, "shared"), url.pathname.slice("/shared/".length), false, req),
  },
  {
    // Liveness for benches: echoes BENCH_NONCE so a harness can prove the port is its own child
    match: (u) => u.pathname === "/health",
    handler: () => new Response(JSON.stringify({ ok: true, nonce: process.env.BENCH_NONCE ?? null, pid: process.pid }),
      { headers: { "content-type": "application/json" } }),
  },
  {
    match: (u) => u.pathname === "/client-version",
    handler: () => {
      // the renderer watchdog polls this: the newest mtime across client files, so a deploy triggers a reload; cached 5s
      const now = Date.now();
      if (!clientVersionCache || now - clientVersionCache.at > 5000) {
        let newest = 0;
        const dir = join(ROOT, "client");
        const walk = (d: string, depth: number) => {
          if (depth > 3) return;
          for (const e of readdirSync(d, { withFileTypes: true })) {
            if (e.name === "node_modules") continue;
            const p = join(d, e.name);
            if (e.isDirectory()) walk(p, depth + 1);
            else newest = Math.max(newest, Bun.file(p).lastModified);
          }
        };
        try { walk(dir, 0); } catch { /* best effort */ }
        clientVersionCache = { at: now, v: String(newest) };
      }
      return new Response(clientVersionCache.v, { headers: { "content-type": "text/plain", "cache-control": "no-store" } });
    },
  },
  {
    match: (u) => u.pathname === "/favicon.ico",
    handler: () =>
      new Response(
        // browsers ask unprompted: the mark's hand-set 32 px master — the same drawing as index.html's <link rel="icon">, for pages
        // (captions.html, AGENTS.md in a tab) that don't carry one
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
           <style>path{fill:#8fe8c8}@media (prefers-color-scheme:light){path{fill:#1d7a5f}}</style>
           <path d="M6.361 4 L25 4 L25 12 L21 12 L21 8 L2.407 8 A14.5 14.5 0 0 1 6.361 4 Z"/>
           <path d="M2.407 24 L21 24 L21 20 L25 20 L25 28 L6.361 28 A14.5 14.5 0 0 1 2.407 24 Z"/>
           <path d="M9.335 14 L28.861 14 A14.5 14.5 0 0 1 28.861 18 L9.335 18 A5.539 5.539 0 0 1 9.335 14 Z"/>
         </svg>`,
        { headers: { "content-type": "image/svg+xml", "cache-control": "public, max-age=86400" } },
      ),
  },
  {
    match: (u) => u.pathname.toLowerCase() === "/agents.md",
    handler: ({ req }) =>
      // the closed-verb-set error says "see AGENTS.md", so it is served here, any casing
      agentGuideResponse(req),
  },
  {
    // the old-format splash links here (shared/oldformat.js OLD_FORMAT_DOC): the doc has to be reachable from the world itself
    match: (u) => u.pathname === "/docs/TRANSLATING-OLD-WORLDS.md",
    handler: ({ req }) => serveFrom(ROOT, "docs/operator/TRANSLATING-OLD-WORLDS.md", false, req),
  },
  {
    match: (u) => u.pathname === "/" || u.pathname === "/index.html",
    handler: ({ req }) => serveFrom(join(ROOT, "client"), "index.html", false, req),
  },
  {
    // the catch-all: everything else is the browser client's static tree
    match: () => true,
    handler: ({ req, url }) => serveFrom(join(ROOT, "client"), url.pathname.slice(1), false, req),
  },
];

/** COOP same-origin + COEP credentialless on EVERY response, so the page is cross-origin isolated (multi-threaded ORT
 *  for local speech). Why credentialless, and what the client loads cross-origin: docs/research/library-serving.md. */
function isolate(res: Response): Response {
  // a successful /ws upgrade returns no Response (Bun owns the socket): never touch it
  if (!res) return res;
  if (res.status === 101) return res;
  res.headers.set("cross-origin-opener-policy", "same-origin");
  res.headers.set("cross-origin-embedder-policy", "credentialless");
  // every page carries a CSP: one served without (a future inline-HTML route) gets the policy with no inline script
  if ((res.headers.get("content-type") ?? "").startsWith("text/html") && !res.headers.has("content-security-policy")) res.headers.set("content-security-policy", cspFor());
  return res;
}

/** One pass over the table, first match wins; a successful /ws upgrade returns no Response. */
export function route(req: Request, srv: Srv): Response | Promise<Response> {
  const url = new URL(req.url);
  for (const r of ROUTES) {
    if (!r.match(url, req)) continue;
    const out = r.handler({ req, url, srv });
    return out instanceof Promise ? out.then(isolate) : isolate(out);
  }
  // unreachable (the catch-all matches everything), but a table must never strand a request
  return isolate(new Response("not found", { status: 404 }));
}
