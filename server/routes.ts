// eidoverse-worlds sequencer — the HTTP surface (TEL0S_NOTES §15, step 7c).
//
// The unsplit fetch()'s if-chain, as a route table: one row per endpoint,
// first match wins, in EXACTLY the old chain's order (the /thumb/ prefix row
// still shadows nothing, the catch-all still serves the browser client).
// Handler bodies moved verbatim; server.ts's fetch() is a one-line delegate.
// The static-file machinery (serveFrom/contentType/gzCache) and the avatar
// roster live here with their only HTTP callers — the join snapshot imports
// avatarRoster back, and the ws `snap-result` case imports pendingSnaps,
// both one-way: this module never imports server.ts.

import { existsSync, readFileSync, writeFileSync, renameSync, readdirSync, mkdirSync, appendFileSync } from "node:fs";
import { sfuDiag } from "./sfuadapter.ts";
import { join, normalize } from "node:path";
import { randomBytes } from "node:crypto";
import { ROOT, WORLDS_DIR, LIBRARY_DIR, OPT_DIR, PATCH_DIR, LADDER, JOIN_TOKEN } from "./config.ts";
import { isStoreOriginal, isServingArtifact } from "./store-variants.ts";
import { wantsKtx2, KTX2_KEY } from "../shared/ktx2.js";
import { LOD_RECIPE, lodVariantPath } from "./store-variants.ts";
import { hnSessions, hnJti, sessionFromCookie, saveSessions, SESSION_TTL_MS, HN_ISSUER_KEY, HN_ISS, HN_AUD, HN_LOGIN_URL, HN_REQUIRE_LOGIN } from "./auth.ts";
import { verifyToken } from "./aid1.ts";
import { resolveLibFile } from "./lint.ts";
import { summarizeGlb } from "./geometry.ts";
import { worlds, getWorld, type World } from "./world.ts";
import { handleUpload } from "./upload.ts";
import { defsPayload, avatarDefs, animationDefs } from "./defs.ts";
import { tickStats } from "./tick.ts";
import { entryBusStats } from "./events.ts";
import { atomicWrite } from "./fsutil.ts";
import { seatStore, announceProfileUpdate, MAX_PROPOSAL_BYTES } from "./seats.ts";
import { agentTokens, aid1JoinIdentity } from "./auth.ts";

/** What the routes need from Bun's server object, structurally: the WS
 *  upgrade and the socket address (X-Real-IP's fallback). */
export type Srv = {
  upgrade(req: Request, opts?: { data?: unknown }): boolean;
  requestIP(req: Request): { address: string } | null;
};

// ---- snapshots: the world serves views of itself ---------------------------
// GET /snap?world=W&follow=ID → the sequencer asks a renderer client (an
// invisible hub-spectator on some GPU box, dialed OUT to us like any client)
// to jump its camera to ID's head and return one frame. Clients never know
// rendering exists as a separate thing — it's just the world's API.
type PendingSnap = { resolve: (r: { ok: true; png: Uint8Array } | { ok: false; err: string; status: number }) => void };
export const pendingSnaps = new Map<string, PendingSnap>();
let nextSnapId = 1;

function requestSnap(world: World, follow: string, view = "first"): Promise<{ ok: true; png: Uint8Array } | { ok: false; err: string; status: number }> {
  const renderer = [...world.clients].find((c) => c.renderer);
  if (!renderer) return Promise.resolve({ ok: false, err: `no renderer is currently serving world "${world.name}"`, status: 503 });
  const target = [...world.clients].find((c) => c.id === follow && !c.spectator);
  if (!target) return Promise.resolve({ ok: false, err: `"${follow}" is not present in "${world.name}"`, status: 404 });
  if (!["first", "third", "selfie"].includes(view)) view = "first";
  const id = `snap-${nextSnapId++}`;
  return new Promise((resolve) => {
    pendingSnaps.set(id, { resolve });
    renderer.ws.send(JSON.stringify({ type: "snap", id, follow, view }));
    setTimeout(() => {
      if (pendingSnaps.delete(id)) resolve({ ok: false, err: "renderer timed out", status: 504 });
    }, 12_000);
  });
}

// ---- static serving ---------------------------------------------------------

/** Roster = Skye's library vrms + our overlay (assets/opt/...) — drop a
 *  .vrm into either and it's an avatar, live, no restart, no manifest.
 *  ?v=mtime makes each path content-versioned: clients cache it forever,
 *  and any re-export mints a new URL. Served by GET /avatars AND carried in
 *  the join snapshot, so a joiner needs no separate round-trip before it
 *  can resolve a body name (the /avatars top-level await used to gate the
 *  client's entire module graph). */
export function avatarRoster(): { name: string; path: string; height: number | null; seat?: unknown }[] {
  const seen = new Map<string, { url: string; file: string }>();
  for (const base of [LIBRARY_DIR, OPT_DIR]) {
    const dir = join(base, "eidoverse/assets/vrms");
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) {
      // .ktx2.vrm files are §20c texture variants living beside overlay
      // originals — negotiated serving artifacts, not bodies of their own
      if (f.endsWith(".vrm") && !f.endsWith(".ktx2.vrm")) {
        seen.set(f.replace(".vrm", ""), {
          url: `eidoverse/assets/vrms/${f}?v=${Math.round(Bun.file(join(dir, f)).lastModified)}`,
          file: join(dir, f),
        });
      }
    }
  }
  // The def overlay (§24, defs/avatars/): declared beats discovered. A def
  // with `vrm` adds — or repoints — a named avatar at any /library path the
  // scan wouldn't find; a path that doesn't resolve is refused loudly and
  // the discovered roster stands (a typo'd def must not vanish a body).
  const defs = avatarDefs();
  for (const [name, d] of Object.entries(defs)) {
    if (!d.vrm) continue;
    const file = resolveLibFile(d.vrm);
    if (!file) { console.error(`[defs] avatar "${name}": vrm not found in library — ${d.vrm}`); continue; }
    seen.set(name, { url: `${d.vrm}?v=${Math.round(Bun.file(file).lastModified)}`, file });
  }
  // stature metadata, contributed alongside portraits (see POST /thumb);
  // a def's declared height wins over the measured sidecar
  let hmeta: Record<string, { h: number }> = {};
  try {
    const mp = join(OPT_DIR, "thumbs", "meta.json");
    if (existsSync(mp)) hmeta = JSON.parse(readFileSync(mp, "utf8"));
  } catch { /* roster works without heights */ }
  // The seat verdict rides every roster entry, PRE-JUDGED against the bytes
  // that will actually serve (#101: one judge, three readers — consumers
  // never rehash a VRM and can never read a stale value as fresh). The sha
  // work behind judge() is mtime-cached, so a roster read costs hashing only
  // when a body's bytes actually changed.
  return [...seen].map(([name, { url, file }]) => ({ name, path: url,
    height: defs[name]?.height ?? hmeta[name.replace(/[^a-zA-Z0-9_-]/g, "_")]?.h ?? null,
    seat: seatStore.judge(name, file) }));
}

/** The animation clips, each at a path stamped with its mtime — the same
 *  ?v= trick avatarRoster mints above, for the same reason and one class of
 *  bug later. A .vrm URL has always carried a version; a .vrma URL carried
 *  none, so a changed clip had NO way to invalidate a stored copy, and
 *  `no-cache` does not save you: a response cached under the OLD headers
 *  (before .vrma joined the no-cache list) keeps the headers it was stored
 *  with, and `immutable` means the browser never asks again. Prod, 2026-08-19:
 *  a corrected sit clip was live and byte-verified on the wire while a user's
 *  Chrome kept animating from a copy it had never re-requested — days of it,
 *  no 304s, nothing to purge from this end. A version in the URL is the only
 *  invalidation that reaches a cache we do not control.
 *
 *  Precedence is /library's own ladder — PATCH_DIR wins over OPT_DIR wins over
 *  LIBRARY_DIR — because the mtime MUST describe the bytes a client will
 *  actually receive. Version the library's copy while serving a patched fork
 *  and the stamp is a lie that pins the wrong file forever. */
export function animationRoster(): { name: string; path: string; size: number }[] {
  const seen = new Map<string, { path: string; size: number }>();
  // later base wins, so this list runs lowest-precedence first
  for (const base of [...LADDER].reverse()) {   // lowest-precedence first: later wins the map
    const dir = join(base, "eidoverse/assets/animations");
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".vrma")) continue;
      const file = Bun.file(join(dir, f));
      // size rides along so the prefetcher's byte budget still sees these
      // clips as it did when it read them from /library-list
      seen.set(f.replace(".vrma", ""),
        { path: `eidoverse/assets/animations/${f}?v=${Math.round(file.lastModified)}`, size: file.size });
    }
  }
  // The def overlay (§24, defs/animations/): declared beats discovered —
  // same contract as the avatar roster. A def's `vrma` adds or repoints a
  // named clip; an unresolvable path is refused loudly and the discovered
  // roster stands. Non-path metadata (tags, doc) rides /defs, not here —
  // this roster stays the prefetcher's byte-budget shape. Resolution walks
  // the clip ladder above (resolveLibFile is the glb/vrm resolver and
  // deliberately doesn't know .vrma or PATCH_DIR).
  const resolveClip = (lib: string): string | null => {
    const rel = normalize(lib).replace(/^\/+/, "");
    if (rel.includes("..") || !/\.vrma$/i.test(rel)) return null;
    for (const base of LADDER) {
      const p = normalize(join(base, rel));
      if (p.startsWith(base) && existsSync(p)) return p;
    }
    return null;
  };
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
  if (path.endsWith(".ktx2")) return "image/ktx2";
  if (path.endsWith(".wasm")) return "application/wasm";
  if (path.endsWith(".hdr")) return "application/octet-stream";
  return "application/octet-stream";
}

// Build identity, resolved once at boot (upstream #51, ported into the route
// module). "What is production running?" must be a lookup, not an inference.
// sha, commitTime and dirty are ONE provenance triple: if ANY comes from the
// environment (image builds), the others are env-or-unknown — never filled
// from the local git tree in any direction.
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
    // Per-run identity echo for owned test children (tools/probe-harness.mjs,
    // the boot-check pattern): a probe that spawned this process with
    // EIDO_BOOT_NONCE can prove the responder is ITS child rather than a stale
    // listener or a concurrent run's — startedAt freshness alone cannot tell
    // two just-started servers apart. Absent when unset, so production
    // /version is unchanged.
    ...(process.env.EIDO_BOOT_NONCE ? { nonce: process.env.EIDO_BOOT_NONCE } : {}) };
})();

const gzCache = new Map<string, { mtime: number; gz: Uint8Array }>();

// What may cache for a day WITHOUT asking: heavy, rarely-edited art. What may
// NOT: things we iterate on, where a silently stale copy costs a debugging
// session — avatars (2026-07-22, "sydney's arms are swapped": three people on
// three cached rigs) and, since upstream-patched/ (§22g), library CODE and
// its data sidecars (2026-08-11: a 24h-cached vegetation.js served tel0s the
// pre-§22l shader through a server restart and a whole branch A/B — mode
// read 'cards-sss' while the wire had 'opaque'). no-cache still rides the
// ETag: revalidation is a 304, not a re-download.
// .vrma is in that list too, and was missing from it: ".vrma" does not match
// endsWith(".vrm"), so ANIMATIONS cached hard for a day. Worse than a stale rig,
// because a .vrm URL carries ?v=mtime and an animation URL carries no version at
// all — a bad clip is sticky with no way to invalidate it. Measured 2026-08-12:
// a placeholder dropped in during a bring-up stuck for every avatar on the
// roster, and read as "animations are broken" rather than "your cache is holding
// one wrong file".
const hardCacheable = (path: string) =>
  !/\.vrma?$/i.test(path) && !/\.(m?js|json)$/i.test(path);

// `provisional`: this answer is not the final one for this URL (a flagged
// fetch whose variant does not exist yet — see the /library route). It wins
// over `immutable`: no-cache, riding the ETag, so the moment a different file
// answers the same URL its bytes get through.
function serveFrom(base: string, rel: string, cache = false, req?: Request, immutable = false, provisional = false): Response {
  const path = normalize(join(base, rel));
  if (!path.startsWith(base)) return new Response("forbidden", { status: 403 });
  // A missing file must be a 404, not a Bun.file stream blowing up into a 500 —
  // prod 08-02: an asset absent from the VPS library (rsync gap) turned every
  // spawn of it into "Internal Server Error" instead of an honest not-found.
  if (!existsSync(path)) return new Response("not found", { status: 404 });
  const f = Bun.file(path);
  const headers: Record<string, string> = { "content-type": contentType(path) };
  // ETag from size+mtime: makes no-cache revalidation a 304, not a re-download
  // (an 11MB avatar re-pulled per reload is invisible on localhost and rude
  // over tailnet).
  if (f.size > 0) {
    const etag = `"${f.size}-${f.lastModified}"`;
    headers["etag"] = etag;
    if (req?.headers.get("if-none-match") === etag) {
      // cache-control must ride along on the 304 (it refreshes the stored response's lifetime)
      headers["cache-control"] = provisional ? "no-cache"
        : immutable ? "public, max-age=31536000, immutable"
        : cache && hardCacheable(path) ? "public, max-age=86400" : cache ? "no-cache" : "no-store";
      return new Response(null, { status: 304, headers });
    }
  }
  // client code must never be heuristically cached (stale main.js = ghost bugs);
  // library assets cache hard — EXCEPT avatars: .vrm files get iterated on
  // (rig fixes, re-exports) and a 24h-stale avatar is a debugging nightmare
  // (2026-07-22: "sydney's arms are swapped" was three of us looking at three
  // different cached rigs). no-cache = revalidate each load, still cheap.
  const hard = cache && hardCacheable(path);
  headers["cache-control"] = provisional ? "no-cache"
    : immutable ? "public, max-age=31536000, immutable"
    : hard ? "public, max-age=86400" : cache ? "no-cache" : "no-store";
  // gzip the JS modules: three.webgpu.js is 2.1MB raw / ~500KB gzipped, and
  // over a DERP-relayed tailnet link that difference is seconds.
  //
  // .vrma and .vrm are here too, and the old comment claiming "binary assets
  // are already compressed" was only half right. Measured 2026-07-26: GLB
  // models compress to 0.99 (already Draco/webp packed inside — genuinely
  // pointless), but VRM bodies hit 0.50 and the VRMA animation clips 0.44,
  // because their float animation tracks and mesh data are stored raw. Seven
  // clips at ~1.9MB each was the second-largest slice of a cold boot; half of
  // it was air.
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

const ROUTES: Route[] = [
  {
    match: (u) => u.pathname === "/ws",
    handler: ({ req, srv }) => {
      // Session rides the upgrade: browsers attach cookies to WS upgrades, so
      // the join can carry a VERIFIED identity without the client ever
      // seeing a token. (fkm web-ui precedent: "the WS is the authentication
      // event" — here inverted, the cookie is, and the WS rides it.)
      const session = sessionFromCookie(req.headers.get("cookie"));
      if (srv.upgrade(req, { data: { session } })) return undefined as unknown as Response;
      return new Response("expected websocket", { status: 400 });
    },
  },
  // ---- archipelago-home doors (docs/home-node.md §7) ----
  {
    match: (u) => u.pathname === "/authcfg",
    handler: () => new Response(
      JSON.stringify({ login: HN_ISSUER_KEY ? HN_LOGIN_URL : null, required: HN_REQUIRE_LOGIN && Boolean(HN_ISSUER_KEY) }),
      { headers: { "content-type": "application/json", "cache-control": "no-store" } },
    ),
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
      // The landing spot for the home node's redirect. The token is in the URL
      // FRAGMENT (never reaches this server's logs); this page posts it back.
      new Response(`<!doctype html><meta charset="utf-8"><title>entering…</title>
<style>body{font:16px/1.5 system-ui;max-width:36rem;margin:15vh auto;padding:0 1rem;color:#ddd;background:#111}</style>
<p id=m>entering…</p><script>
(async () => {
  const m = document.getElementById('m');
  const tok = new URLSearchParams(location.hash.slice(1)).get('token');
  if (!tok) { m.textContent = 'no token — start again from the login page'; return; }
  history.replaceState(null, '', '/auth');
  const r = await fetch('/auth', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: tok }) });
  const j = await r.json().catch(() => ({}));
  if (r.ok) { m.textContent = 'welcome, ' + j.name; location.replace('/'); }
  else m.textContent = 'login failed: ' + (j.error ?? r.status) + ' — start again from the login page';
})();
</script>`, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } }),
  },
  {
    match: (u, req) => u.pathname === "/auth" && req.method === "POST",
    handler: async ({ req, url }) => {
      if (!HN_ISSUER_KEY) return new Response(JSON.stringify({ error: "identity door not configured" }), { status: 503, headers: { "content-type": "application/json" } });
      let tok = "";
      try { tok = String(((await req.json()) as { token?: string }).token ?? ""); } catch { /* fall through */ }
      const v = verifyToken(tok, { issuerId: HN_ISSUER_KEY, iss: HN_ISS, aud: HN_AUD });
      if (!v.ok) {
        console.log(`[auth] login token rejected: ${v.reason}`);
        return new Response(JSON.stringify({ error: v.reason }), { status: 403, headers: { "content-type": "application/json" } });
      }
      const p = v.payload;
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
      const m = /(?:^|;\s*)ew_sess=([a-f0-9]{64})/.exec(req.headers.get("cookie") ?? "");
      if (m && hnSessions.delete(m[1]!)) saveSessions();
      return new Response(JSON.stringify({ ok: true }), {
        headers: { "content-type": "application/json", "set-cookie": "ew_sess=; Path=/; HttpOnly; Max-Age=0" },
      });
    },
  },
  {
    match: (u) => u.pathname === "/geom",
    handler: async ({ url }) => {
      // Geometry as DATA, for beings who perceive by reading. Three tiers:
      //   /geom?lib=<path>           one asset: bbox, flat zones, named parts
      //   /geom?world=W&id=<entity>  that asset + the entity's world transform
      //   /geom?world=W              the whole scene: every entity + transform
      //                              (+local bbox; &boxes=0 to skip the parses)
      // Raw bytes stay at GET /library/<lib> for local processing; this is
      // the parsed tier. Same trust level as the world log: public reads.
      const j = (o: unknown, status = 200) =>
        new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
      const wname = url.searchParams.get("world");
      if (!wname) {
        const lib = url.searchParams.get("lib") ?? "";
        const file = resolveLibFile(lib);
        if (!file) return j({ error: `no such asset: ${lib}` }, 404);
        const sum = await summarizeGlb(file);
        return sum ? j({ lib, ...sum }) : j({ error: "geometry parsing unavailable" }, 503);
      }
      // read-only: answer for LOADED or on-disk worlds, never create one
      if (!/^[a-z0-9_-]{1,64}$/i.test(wname)
        || (!worlds.has(wname) && !existsSync(join(WORLDS_DIR, wname, "log.jsonl")))) {
        return j({ error: "no such world" }, 404);
      }
      const w = getWorld(wname);
      // COMPOSE with the sim (PROTOCOL_v2 §5): a punted body's fold position
      // is its last AUTHORED word, which under an epoch can be a spawn point
      // a dozen flights ago — the sim's answer outranks it, exactly as the
      // punt verb's own reach math already composes (verbs.ts). Without this
      // an agent measuring a punted crate was told where it USED to be.
      const simAt = (eid: string, e: { pos: number[]; yaw?: number }) => {
        const b = (w as any).sim?.bodies?.[eid];
        return b ? { pos: b.p as number[], yaw: (typeof b.yaw === "number" ? b.yaw : e.yaw ?? 0) }
          : { pos: e.pos, yaw: e.yaw ?? 0 };
      };
      const id = url.searchParams.get("id");
      if (id) {
        const e = w.state.entities[id];
        if (!e) return j({ error: `no entity "${id}" in ${wname}` }, 404);
        const file = e.lib ? resolveLibFile(e.lib) : null;
        const sum = file ? await summarizeGlb(file) : null;
        const at = simAt(id, e);
        return j({ id, lib: e.lib ?? null, pos: at.pos, yaw: at.yaw, scale: e.scale ?? 1,
          parent: e.parent ?? null, comp: e.comp ?? {},
          geometry: sum,   // local frame — compose with pos/yaw/scale for world space
          note: "geometry coords are the MODEL's local frame; sockets use the same frame, so a topSurface center is a socket pos verbatim" });
      }
      const withBoxes = url.searchParams.get("boxes") !== "0";
      const out = [];
      for (const [eid, e] of Object.entries(w.state.entities)) {
        const file = withBoxes && e.lib ? resolveLibFile(e.lib) : null;
        const sum = file ? await summarizeGlb(file) : null;
        const at = simAt(eid, e);
        out.push({ id: eid, lib: e.lib ?? null, kind: e.kind ?? "thing",
          pos: at.pos, yaw: at.yaw, scale: e.scale ?? 1,
          parent: e.parent ?? null, comp: e.comp ?? {},
          ...(sum ? { bbox: sum.bbox, tris: sum.tris } : {}) });
      }
      return j({ world: wname, entities: out, mounts: w.state.mounts ?? {} });
    },
  },
  {
    match: (u, req) => u.pathname === "/upload" && req.method === "POST",
    handler: ({ req, url, srv }) => handleUpload(req, url, srv),
  },
  {
    // POST /seat-profile — the live proposal door (#101 B4, ported §24r).
    //
    // Write authority: a NAMED actor only — a tokens.json bearer or a
    // home-node-verified aid1 identity, the same two legs /upload trusts.
    // The anonymous door token may NOT write here: a seat profile moves
    // every wearer of an avatar, and "?by=" is self-asserted. This door
    // writes PROPOSALS only (the store refuses accepted-shaped records with
    // a 403 by construction); the countersign that makes a profile
    // load-bearing has no HTTP path at all — tools/seat-accept.ts is an
    // operator act on the box, and the 5s poll announces it. A proposal
    // through THIS door is announced immediately (the store's own mtime
    // bookkeeping keeps the poll from repeating it).
    match: (u, req) => u.pathname === "/seat-profile" && req.method === "POST",
    handler: async ({ req, url }) => {
      const j = (o: unknown, status = 200) => new Response(JSON.stringify(o),
        { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
      const tok = url.searchParams.get("token") ?? "";
      const actor = agentTokens().byToken.get(tok) ?? aid1JoinIdentity(tok)?.slug;
      if (!actor) {
        return j({ error: "a named actor is required — a tokens.json bearer or an aid1 credential; the door token may not write seat profiles" }, 401);
      }
      const text = await req.text();
      if (new TextEncoder().encode(text).length > MAX_PROPOSAL_BYTES) {
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
    handler: async ({ url }) => {
      const w = worlds.get(url.searchParams.get("world") ?? "commons");
      const follow = url.searchParams.get("follow") ?? "";
      if (!w) return new Response("unknown world", { status: 404 });
      const r = await requestSnap(w, follow, url.searchParams.get("view") ?? "first");
      if (!r.ok) return new Response(r.err, { status: r.status });
      return new Response(r.png, { headers: { "content-type": "image/png", "cache-control": "no-store" } });
    },
  },
  {
    match: (u) => u.pathname === "/avatars",
    handler: () => new Response(JSON.stringify(avatarRoster()),
      { headers: { "content-type": "application/json", "cache-control": "no-store",
        // the store revision the verdicts were judged at — the client cache's
        // generation guard compares this against update events, so a slow
        // response from before an acceptance can never roll it back
        "x-profiles-rev": String(seatStore.rev) } }),
  },
  {
    // The heartbeat's gauges (charter §4): per-system runs / worst ms /
    // errors. Public and cheap like /version — "is the tick healthy" must
    // be a lookup, not an inference from symptoms.
    match: (u) => u.pathname === "/tick",
    handler: () => new Response(JSON.stringify({ ...tickStats(), entryBus: entryBusStats() }),
      { headers: { "content-type": "application/json", "cache-control": "no-store" } }),
  },
  {
    // The def registry (charter §3): instance content as data, one fetch per
    // client boot. no-store for the same reason the rosters are — an edited
    // def must reach the next boot, and the registry's own TTL already
    // bounds the read cost.
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
    // #104 diagnostics: the adapter's live SFU view — legs, gens, consent, incarnation.
    match: (u) => u.pathname === "/relay-diag",
    handler: ({ url }) => new Response(
      JSON.stringify(sfuDiag(url.searchParams.get("world") ?? "staging")),
      { headers: { "content-type": "application/json", "cache-control": "no-store" } }),
  },
  {
    // upstream #51, ported to the route table: which build is this world
    // running — public, cheap, cache-hostile; the whole point is NOW
    //
    // WORLD_INSTANCE_NONCE is an opt-in TEST affordance, mirroring the door's
    // MCPL_INSTANCE_NONCE: when set, /version carries `instance`, letting a
    // harness prove the process answering is the one IT spawned rather than a
    // stale listener squatting the port. Unset in production, where the body is
    // byte-identical to before — the field is absent, not empty.
    //
    // Why an app endpoint at all when the OS can be asked: because `ss` and
    // /proc are Linux-only, and this repository is reviewed on macOS. A
    // challenge-response the SERVER answers is the portable proof; the OS check
    // stays as a second, stricter opinion where the platform offers one.
    match: (u) => u.pathname === "/version",
    // The representation key and both owned-process nonces come from this
    // running process; clients never infer them from a newly served disk file.
    handler: () => new Response(
      JSON.stringify({
        ...BUILD,
        ktx2Key: KTX2_KEY,
        lodRecipe: LOD_RECIPE,
        ...(process.env.WORLD_INSTANCE_NONCE ? { instance: process.env.WORLD_INSTANCE_NONCE } : {}),
      }),
      { headers: { "content-type": "application/json", "cache-control": "no-store" } }),
  },
  {
    match: (u) => u.pathname.startsWith("/thumb/"),
    handler: async ({ url }) => {
      // Avatar thumbnails. VRMs have no shipped previews, and a name-only
      // roster where each choice costs a multi-megabyte download is a blind
      // pick. So thumbnails are CONTRIBUTED: whoever wears a body renders one
      // off its own loaded VRM and posts it back. The roster fills in as people
      // use it — no build step, no manifest, no bulk render job.
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
      // Load-performance beacon (client/lib/loadwork.js): jank + load lines
      // from real visits, because Safari's console is unreachable and most
      // visitors never open one. Append-only JSONL beside the worlds, capped —
      // diagnosis data, not surveillance; it holds only timing lines and a UA.
      try {
        const body = await req.text();
        if (body.length < 100_000) {
          const dest = join(WORLDS_DIR, ".perflogs.jsonl");
          const big = existsSync(dest) && Bun.file(dest).size > 5_000_000;
          if (!big) {
            const ip = req.headers.get("x-real-ip") ?? srv.requestIP(req)?.address ?? "?";
            appendFileSync(dest, JSON.stringify({ ts: Date.now(), ip, ...JSON.parse(body) }) + "\n");
          }
        }
      } catch { /* malformed beacon: drop */ }
      return new Response("ok");
    },
  },
  {
    match: (u, req) => u.pathname === "/thumb" && req.method === "POST",
    handler: async ({ req, url }) => {
      if (JOIN_TOKEN && url.searchParams.get("token") !== JOIN_TOKEN)
        return new Response("token required", { status: 401 });
      const safe = (url.searchParams.get("name") ?? "").replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 48);
      if (!safe) return new Response("name required", { status: 400 });
      const dir = join(OPT_DIR, "thumbs");
      mkdirSync(dir, { recursive: true });
      const dest = join(dir, `${safe}.png`);
      // The portrait carries the body's measured stature (skeleton-derived,
      // client-side) — kept beside the images so /avatars can hand catalogs a
      // roster drawn to a common scale.
      const height = Number(url.searchParams.get("height"));
      if (Number.isFinite(height) && height > 0.2 && height < 20) {
        const metaPath = join(dir, "meta.json");
        let meta: Record<string, { h: number }> = {};
        try { if (existsSync(metaPath)) meta = JSON.parse(readFileSync(metaPath, "utf8")); } catch { /* fresh */ }
        meta[safe] = { h: Math.round(height * 100) / 100 };
        atomicWrite(metaPath, JSON.stringify(meta));
      }
      // First contributor wins (re-posting on every join would be pointless
      // write traffic) — unless a re-mint pass explicitly forces the refresh.
      const force = url.searchParams.get("force") === "1";
      if (existsSync(dest) && !force) return new Response(JSON.stringify({ ok: true, existed: true }),
        { headers: { "content-type": "application/json" } });
      const body = new Uint8Array(await req.arrayBuffer());
      if (body.length > 400_000) return new Response("thumb too large", { status: 413 });
      if (body.length < 8 || body[0] !== 0x89 || body[1] !== 0x50) return new Response("not a PNG", { status: 415 });
      writeFileSync(dest, body);
      console.log(`[thumb] ${safe} (${(body.length / 1000).toFixed(0)}KB${force ? ", forced" : ""})`);
      return new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json" } });
    },
  },
  {
    match: (u) => u.pathname === "/library-list",
    handler: ({ url }) => {
      // Directory listing over the library. The browser host primes Skye's
      // toolkit modules into a virtual filesystem before eval-loading them
      // (they read assets synchronously, Deno-style), and it should DISCOVER
      // what to prime rather than carry a hardcoded manifest — the no-manifest
      // rule applies to the client too.
      const rel = url.searchParams.get("dir") ?? "";
      const out: { path: string; size: number }[] = [];
      const walk = (base: string, sub: string, depth: number) => {
        if (depth > 4) return;
        const abs = normalize(join(base, sub));
        if (!abs.startsWith(base) || !existsSync(abs)) return;
        for (const e of readdirSync(abs, { withFileTypes: true })) {
          const childRel = sub ? `${sub}/${e.name}` : e.name;
          if (e.isDirectory()) walk(base, childRel, depth + 1);
          // Serving artifacts are not entries: a KTX2 variant (<rel>.ktx2.glb /
          // .ktx2.vrm / <img>.ktx2) is reached only as the path beside it +
          // the negotiation, a .failed marker is the pump's verdict, a .tmp is
          // a pass mid-write. Listed, the prefetcher fetches each one as an
          // asset — a variant twice, a marker as a model (store-variants.ts).
          else if (!isServingArtifact(e.name)) out.push({ path: childRel, size: Bun.file(join(abs, e.name)).size });
        }
      };
      // opt first: /library/ serving prefers the optimized mirror, so the
      // listed size must describe the file a client will actually receive —
      // the prefetcher sorts and budgets by these numbers, and the raw-library
      // size of a draco+webp'd model is off by ~30x.
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
      // The catalog agents already had (mcpl `list_library`), served to humans.
      // Filename token scoring — crude, but it is what ranks the agent-side
      // search today and parity matters more than cleverness here.
      const q = (url.searchParams.get("q") ?? "").toLowerCase().split(/\s+/).filter(Boolean);
      const dirs = [join(LIBRARY_DIR, "eidoverse/assets/models"), join(OPT_DIR, "eidoverse/assets/models")];
      const files = new Map<string, number>();
      for (const d of dirs) {
        if (!existsSync(d)) continue;
        for (const f of readdirSync(d)) {
          // variants live beside originals in OPT_DIR — ktx2 (§20c's ghost
          // listing) and, since #156, .lod.<recipe>.glb — the same model, not
          // a catalog entry; markers and .tmp likewise. One predicate, the one
          // /library-list already walks with (store-variants.ts).
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
          // Skye ships a _preview.jpg beside every model. Picking from a list of
          // `stylized_yucca_joshua_tree_desert_cactus_plant.glb` is not picking;
          // with the previews it becomes an actual catalog.
          const prev = f.replace(/\.glb$/i, "_preview.jpg");
          const hasPrev = dirs.some((d) => existsSync(join(d, prev)));
          return {
            path: `eidoverse/assets/models/${f}`,
            // strip the SEO-soup filenames into something a person can read
            name: f.replace(/\.glb$/i, "").replace(/_/g, " ").slice(0, 48),
            preview: hasPrev ? `eidoverse/assets/models/${prev}` : null,
          };
        });
      // Conjured/delivered objects (the content-addressed store) are catalog
      // too — an orrery send should land somewhere findable, not in a black
      // hole only its hash can name. Newest first, names from the manifest.
      const storeDir = join(OPT_DIR, "store");
      if (existsSync(storeDir)) {
        let man: Record<string, { name?: string; by?: string; ts?: number }> = {};
        try { man = JSON.parse(readFileSync(join(storeDir, "manifest.json"), "utf8")); } catch { /* unnamed */ }
        const store = readdirSync(storeDir)
          // a KTX2 variant (<hash>.glb.ktx2.glb) is the same model, not a
          // catalog entry — the ghost-listing rule the library list already
          // follows above (store-variants.ts)
          .filter(isStoreOriginal)
          .map((f) => {
            const hash = f.replace(/\.glb$/i, "");
            const m = man[hash];
            return {
              path: `store/${f}`,
              name: (m?.name ?? `conjured ${hash.slice(0, 8)}`).slice(0, 48),
              preview: null as string | null,
              ts: m?.ts ?? 0,
              score: q.length ? q.filter((t) => (m?.name ?? "").toLowerCase().includes(t)).length : 1,
            };
          })
          .filter((s) => s.score > 0)
          .sort((a, b) => b.ts - a.ts)
          .slice(0, 30)
          .map(({ path, name, preview }) => ({ path, name, preview }));
        hits.push(...store);
      }
      return new Response(JSON.stringify(hits), {
        headers: { "content-type": "application/json", "cache-control": "no-store" },
      });
    },
  },
  {
    match: (u) => u.pathname.startsWith("/library/"),
    handler: ({ req, url }) => {
      const rel = url.pathname.slice("/library/".length);
      // optimized mirror first (draco+webp): same path, ~30x smaller
      const versioned = url.searchParams.has("v") || rel.startsWith("store/"); // content-addressed = immutable
      // Deliberate upstream forks win over EVERYTHING (upstream-patched/
      // README.md): same URL, versioned in this repo, delete-to-fall-back.
      {
        const p = normalize(join(PATCH_DIR, rel));
        if (p.startsWith(PATCH_DIR) && existsSync(p)) return serveFrom(PATCH_DIR, rel, true, req, versioned);
      }
      // KTX2 is NEGOTIATED (§20), never the unflagged answer: the variant's
      // KHR_texture_basisu sits in extensionsRequired, and parsers without a
      // KTX2 decoder — agents, tools, old clients — THROW on required
      // extensions (GLTFLoader.js:1476). Only a client that detected support
      // asks with ?ktx2=<key>; everyone else gets exactly today's bytes. Same
      // cache ladder as the base file (non-immutable, ETag revalidates), and
      // the distinct URL is its own clean nginx/browser cache entry.
      // VRMs (§20c) negotiate identically — avatar URLs carry ?v= minted from
      // the ORIGINAL's mtime (the version identity is the original; ktx2=1 is
      // its own cache key) — with one extra guard: bodies are the one asset
      // class that mutates MID-SESSION (POST /upload?as=avatar broadcasts
      // avatar-updated and every client refetches immediately), so a variant
      // OLDER than the winning original is someone's stale body under a fresh
      // ?v= — serve the original until the next boot sweep rebuilds it.
      // Loose images (§20d) negotiate like GLBs: a flip-baked .ktx2 sibling
      // (OPT_DIR/<rel>.ktx2, built only for the curated sweep dirs) answers a
      // flagged fetch; contentType serves it as image/ktx2. The client's
      // loadImageTexture sniffs the container magic, so the SAME path carries
      // either byte shape.
      const negotiable = rel.endsWith(".glb") || rel.endsWith(".vrm") || /\.(png|jpe?g)$/i.test(rel);
      // The key is a generation (shared/ktx2.js): a retired one is an
      // unflagged fetch — whatever that client pinned under it, it keeps.
      const wantKtx2 = wantsKtx2(url.searchParams) && negotiable;
      // The LOD tier rides the ktx2 negotiation (a LOD variant carries KTX2
      // textures) and the same split-brain rule twice over: a client only
      // asks with the RECIPE /version published — the URL carries the
      // generation, so a recipe change is a fresh URL and a fresh file, and
      // yesterday's reduction can never sit pinned under today's address.
      const lodAsked = url.searchParams.get("lod");
      const wantLod = lodAsked === LOD_RECIPE && wantKtx2 && rel.endsWith(".glb");
      if (wantLod) {
        const lRel = lodVariantPath(rel);
        const l = normalize(join(OPT_DIR, lRel));
        if (l.startsWith(OPT_DIR) && existsSync(l)) {
          // library sources are MUTABLE: an updated model with a not-yet-
          // rebuilt variant must fall through provisional, never serve the
          // old body under the new ?v= (the §20c vrm freshness discipline)
          let fresh = true;
          if (!rel.startsWith("store/")) {
            const src = [[PATCH_DIR, normalize(join(PATCH_DIR, rel))], [OPT_DIR, normalize(join(OPT_DIR, rel))], [LIBRARY_DIR, normalize(join(LIBRARY_DIR, rel))]]
              .find(([b, p]) => p.startsWith(b) && existsSync(p))?.[1];
            fresh = !!src && Bun.file(l).lastModified > Bun.file(src).lastModified;
          }
          if (fresh) return serveFrom(OPT_DIR, lRel, true, req, versioned);
        }
      }
      if (wantKtx2) {
        const kRel = rel.endsWith(".glb") ? `${rel}.ktx2.glb`
          : rel.endsWith(".vrm") ? `${rel}.ktx2.vrm` : `${rel}.ktx2`;
        const k = normalize(join(OPT_DIR, kRel));
        if (k.startsWith(OPT_DIR) && existsSync(k)) {
          let fresh = true;
          if (rel.endsWith(".vrm")) {
            const orig = [[OPT_DIR, normalize(join(OPT_DIR, rel))], [LIBRARY_DIR, normalize(join(LIBRARY_DIR, rel))]]
              .find(([base, p]) => p.startsWith(base) && existsSync(p))?.[1];
            fresh = !!orig && Bun.file(k).lastModified > Bun.file(orig).lastModified;
          }
          // a lod-requesting fetch answered by the plain ktx2 variant is
          // still PROVISIONAL — the lod may land later under this same URL
          if (fresh) return serveFrom(OPT_DIR, kRel, true, req, versioned, wantLod || (lodAsked != null && !wantLod));
        }
      }
      // A flagged fetch that falls through is PROVISIONAL for that URL, not
      // final: the variant may still be encoding (a store upload's, seconds to
      // minutes after landing; the library's, the boot sweep) — or the box has
      // no encoder yet. Content-addressed does not make the fall-through final
      // either: the ADDRESS is immutable, the flagged ANSWER is not, and a
      // browser or nginx that pins the webp bytes under ?ktx2=1 for a year
      // never sees the variant land (the show box, 2026-08-24: every store
      // ?ktx2=1 answer immutable, every one webp). no-cache rides the ETag —
      // a 304 while nothing changed, the variant's bytes the moment it exists;
      // nginx honors it (nginx-show.conf) and simply does not cache these.
      // an unrecognized lod value is a generation this process does not run
      // (a pull mid-window, a buggy client): whatever answers must not be
      // pinned under that URL — the NEXT process may negotiate it
      const provisional = wantKtx2 || (lodAsked != null && !wantLod);
      // store uploads: prefer the store-min shadow — same address, the
      // original stays as provenance and as the fallback while (or if) the
      // optimize pass hasn't landed for this hash
      if (rel.startsWith("store/")) {
        const minRel = `store-min/${rel.slice("store/".length)}`;
        const min = normalize(join(OPT_DIR, minRel));
        if (min.startsWith(OPT_DIR) && existsSync(min)) return serveFrom(OPT_DIR, minRel, true, req, true, provisional);
      }
      const opt = normalize(join(OPT_DIR, rel));
      if (opt.startsWith(OPT_DIR) && existsSync(opt)) return serveFrom(OPT_DIR, rel, true, req, versioned, provisional);
      return serveFrom(LIBRARY_DIR, rel, true, req, versioned, provisional);
    },
  },
  {
    match: (u) => u.pathname.startsWith("/node_modules/"),
    handler: ({ req, url }) => serveFrom(join(ROOT, "client"), url.pathname.slice(1), true, req),
  },
  {
    // shared/ — modules every runtime folds with (see shared/README.md). Code,
    // so it gets the client-code caching policy: no-store, never heuristically
    // stale. Client files reach it as ../../shared/…, which clamps to /shared/
    // in a browser and resolves to the repo root on disk.
    match: (u) => u.pathname.startsWith("/shared/"),
    handler: ({ req, url }) => serveFrom(join(ROOT, "shared"), url.pathname.slice("/shared/".length), false, req),
  },
  {
    // Liveness for benches: answers with the BENCH_NONCE this process was
    // started with, so a scratch harness can prove the port it is about to
    // drive is ITS child and not a stranger's sequencer (PR #160 review, B6).
    match: (u) => u.pathname === "/health",
    handler: () => new Response(JSON.stringify({ ok: true, nonce: process.env.BENCH_NONCE ?? null, pid: process.pid }),
      { headers: { "content-type": "application/json" } }),
  },
  {
    match: (u) => u.pathname === "/client-version",
    handler: () => {
      // A marker the renderer watchdog polls: the newest mtime across the
      // client files. A deploy (or a dev edit) moves it, so a hung-uptime-free
      // renderer still reloads for new code. Cheap, cached 5s.
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
      // Browsers ask for this unprompted; the static handler threw ENOENT and
      // answered 500, so every page load logged a server error for a file
      // nobody asked us to have.
      new Response(
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
           <rect width="32" height="32" rx="7" fill="#0c1720"/>
           <circle cx="16" cy="16" r="6" fill="#8fe8c8"/>
           <circle cx="16" cy="16" r="10.5" fill="none" stroke="#8fe8c8" stroke-opacity=".45" stroke-width="1.5"/>
         </svg>`,
        { headers: { "content-type": "image/svg+xml", "cache-control": "public, max-age=86400" } },
      ),
  },
  {
    match: (u) => u.pathname.toLowerCase() === "/agents.md",
    handler: ({ req }) =>
      // The closed-verb-set error says "see AGENTS.md" — so the file has to be
      // reachable from the world itself, not just the repo. Any casing works
      // (/AGENTS.md, /agents.md): agents type both, and a 404 on the spelling
      // the error message taught you is a locked door with a sign on it.
      serveFrom(ROOT, "AGENTS.md", false, req),
  },
  {
    match: (u) => u.pathname === "/" || u.pathname === "/index.html",
    handler: () => serveFrom(join(ROOT, "client"), "index.html"),
  },
  {
    // the catch-all: everything else is the browser client's static tree
    match: () => true,
    handler: ({ url }) => serveFrom(join(ROOT, "client"), url.pathname.slice(1)),
  },
];

/** One pass over the table, first match wins — exactly the if-chain order the
 *  unsplit fetch() had. The catch-all last row means every request gets a
 *  Response… except a successful /ws upgrade, which (as before) returns none
 *  and lets Bun own the socket. */
// 🔴 CROSS-ORIGIN ISOLATION — why local speech synthesis runs single-threaded.
//
// engine-piper.js reads `crossOriginIsolated && SharedArrayBuffer` and pins
// ort.env.wasm.numThreads to 1 when either is missing. This server sent no COOP
// or COEP headers, so both were false and ONNX inference ran single-threaded on
// every machine that loaded the page, however many cores it has. The client's
// own console said so on every load ("SINGLE-THREADED — isolation headers
// missing"); the diagnostic was already printing the answer.
//
// COEP is `credentialless` rather than `require-corp`: require-corp blocks any
// cross-origin subresource that does not opt in with CORP headers, which would
// break third-party assets the moment someone adds one. credentialless buys the
// same isolation by stripping credentials instead of refusing the request.
// 🔴 THE CLIENT DOES LOAD CROSS-ORIGIN THINGS. This comment used to claim it
// "loads nothing cross-origin" — false, asserted without checking, and it was
// the justification for the whole choice. What it loads, and how each fares:
//
//   • DRACO decoder wasm from gstatic (assets.js) — fine either way; gstatic
//     sends `cross-origin-resource-policy: cross-origin`.
//   • Orrery API via fetch(credentials:'include') (conjure.js) — UNAFFECTED.
//     COEP governs no-cors SUBRESOURCES; a cors-mode fetch is not one
//     ("requests made in cors mode won't be blocked by COEP" — MDN).
//   • Orrery thumbnails via <img> — WAS affected: a bare <img> is no-cors, so
//     credentialless would strip the session cookie. Fixed at the call site
//     with crossorigin="use-credentials", moving it to cors mode.
//
// And COOP `same-origin` severs window.opener, which broke Orrery's OAuth
// popup — it could not postMessage back and sign-in hung silently. conjure.js
// now polls /api/auth/me as the primary signal, needing no opener at all.
//
// The headers must ride on EVERY response, not just the document: a worker
// script served without them is not isolated and the whole context degrades.
function isolate(res: Response): Response {
  // 🔴 A SUCCESSFUL /ws UPGRADE RETURNS NOTHING — the ws route hands back
  // `undefined as unknown as Response` and lets Bun own the socket. Touching it
  // here would throw on every websocket connection, i.e. this header change
  // would break the world rather than speed it up. Checked before shipping.
  if (!res) return res;
  // A 101 upgrade owns its own handshake — do not touch it.
  if (res.status === 101) return res;
  res.headers.set("cross-origin-opener-policy", "same-origin");
  res.headers.set("cross-origin-embedder-policy", "credentialless");
  return res;
}

export function route(req: Request, srv: Srv): Response | Promise<Response> {
  const url = new URL(req.url);
  for (const r of ROUTES) {
    if (!r.match(url, req)) continue;
    const out = r.handler({ req, url, srv });
    return out instanceof Promise ? out.then(isolate) : isolate(out);
  }
  // unreachable — the catch-all matches everything — but a table must not be
  // able to strand a request even if a future edit breaks that property.
  return isolate(new Response("not found", { status: 404 }));
}
