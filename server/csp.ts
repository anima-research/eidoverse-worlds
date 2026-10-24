// csp — the Content-Security-Policy every HTML page this server serves carries (security pass 3, N3 / H1).
//
// WHY. H1 was a display name rendered as HTML: `<img src=x onerror=…>` ran in every browser its owner could knock over.
// The sink is fixed (client/lib/markup.js), but the next one we miss should still not run. This policy is the second
// wall: no inline script runs unless it is one of OUR page's own inline blocks (matched by hash), so an injected
// handler (onerror=, onload=), an injected <script>, and a javascript: URL all refuse, and the browser says so
// (securitypolicyviolation, the console).
//
// WHAT THE CLIENT NEEDS, and why each source is here (checked against the code, 2026-10-07):
//   script-src  'self'              the client's modules, /vendor, /node_modules (three, onnxruntime), /shared
//               'sha256-…'          each inline <script> in the page served (index.html's boot scripts and import map,
//                                   captions.html, the /auth landing page) — hashed from the file as served, so editing
//                                   one never needs a hand-kept list
//               'unsafe-eval'       the eidoverse toolkit modules (terrain.js, particles.js, sky_worlds.js) are hosted by
//                                   indirect eval and themselves eval their dependencies (assets.js loadEidoModule) —
//                                   a known gap: it does NOT allow inline script or handlers, only eval of strings
//                                   code already running chose to eval
//               'wasm-unsafe-eval'  rapier, ammo, basis/KTX2, draco, onnxruntime, piper (named so it survives the day
//                                   'unsafe-eval' can go)
//               blob:               a local mod (🧩, trusted by design) is imported from a blob: URL (mods.js runSource)
//   worker-src  'self' blob:        splash rays and the phonemizer are same-origin workers; draco and onnxruntime spawn
//                                   blob: workers
//   connect-src 'self'              the world socket (same origin), every /route; blob: data: (three's loaders fetch
//                                   textures embedded in a GLB as blob: URLs); Orrery (conjure); a local voice bridge on
//                                   127.0.0.1/localhost (piperbridge.js, a ws/http endpoint voice); plus CSP_CONNECT_EXTRA.
//                                   NOT https: in general — a picture link is loaded as an <img> (img-src), a sound as
//                                   an <audio> (media-src). That keeps fetch/WebSocket to known hosts; it doesn't keep
//                                   data in: img-src and media-src take any https host, and a URL can carry what a script
//                                   read (review of #260, server I86). Inline scripts are hashed, so only our own run.
//   img-src / media-src  https:     media links (shared/mediasrc.js): a store file, an allowlisted host, or — per viewer,
//                                   opted in — any https host; the opt-in gate is the client's, not the policy's
//   style-src   'self' 'unsafe-inline'  style attributes and runtime <style> elements throughout the UI; CSS injection
//                                   is out of scope for this pass
//   object-src 'none' · base-uri 'self' · form-action 'self' · frame-ancestors 'self' · frame-src 'none'
//
// The policy is built per page from that page's own inline scripts; any other HTML response gets it with no hashes.
import { createHash } from "node:crypto";

export const ORRERY_ORIGIN = "https://orrery.animalabs.ai";

/** sha256 CSP sources for every inline (src-less) <script> in an HTML document, as the browser hashes them. */
export function inlineScriptHashes(html: string): string[] {
  const out: string[] = [];
  // a closing tag may carry attributes the parser ignores ("</script foo>"; but "</script-z>" and "</scripts>" are not end tags: the name must end at a space, / or >); only a real src attribute (not data-src) makes
  // a script external (tools/csp-test.ts CSP5–7)
  for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script(?=[\s/>])[^>]*>/gi)) {
    if (/(?:^|\s)src\s*=/i.test(m[1])) continue;
    // the browser hashes the text the parser made, and the parser turns CRLF and lone CR into LF (HTML §13.2.3.5): hashing
    // the raw bytes of a CRLF copy refuses every inline script on the page (tools/csp-test.ts)
    out.push(`'sha256-${createHash("sha256").update(m[2].replace(/\r\n?/g, "\n"), "utf8").digest("base64")}'`);
  }
  return [...new Set(out)];
}

function extraConnect(): string[] {
  // an operator's own services (a self-hosted Orrery: the client honours ?orrery=…), space-separated origins; only
  // well-formed http(s)/ws(s) origins are taken — a stray ';' must never open a new directive
  return String(process.env.CSP_CONNECT_EXTRA ?? "").split(/\s+/).filter((o) => /^(https?|wss?):\/\/[a-z0-9.-]+(:\d+)?$/i.test(o));
}

/** The policy for an HTML page whose text is `html` (or none, for a page with no inline script of ours). */
/** Pages that talk to a service of their own beyond what every page may reach: the captions page's default Portal socket
 *  (client/captions.html's URL_), which the blanket policy refused (review of #260, server I55). */
const PAGE_CONNECT: Record<string, string[]> = { "captions.html": ["wss://portal.animalabs.ai"] };
export function cspFor(html = "", connect: string[] = []): string {
  const hashes = inlineScriptHashes(html);
  return [
    "default-src 'self'",
    `script-src 'self' ${hashes.join(" ")} 'unsafe-eval' 'wasm-unsafe-eval' blob:`.replace(/\s+/g, " "),
    "worker-src 'self' blob:",
    `connect-src 'self' blob: data: ${ORRERY_ORIGIN} http://127.0.0.1:* ws://127.0.0.1:* http://localhost:* ws://localhost:* ${[...connect, ...extraConnect()].join(" ")}`.trim(),
    "img-src 'self' data: blob: https:",
    "media-src 'self' data: blob: https:",
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self' data:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'self'",
    "frame-src 'none'",
  ].join("; ");
}

const byFile = new Map<string, { mtime: number; policy: string }>();
/** The policy for an HTML file on disk, cached by mtime (an edited page re-hashes on its next request). */
export function cspForFile(path: string, mtime: number, read: () => string): string {
  const hit = byFile.get(path);
  if (hit && hit.mtime === mtime) return hit.policy;
  const policy = cspFor(read(), PAGE_CONNECT[path.split(/[\\/]/).pop() ?? ""] ?? []);
  byFile.set(path, { mtime, policy });
  return policy;
}
