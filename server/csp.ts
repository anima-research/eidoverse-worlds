// csp — the Content-Security-Policy every HTML page this server serves carries: the second wall behind escaping
// (client/lib/ui/markup.js). Only our own inline scripts run (matched by hash, computed from the page as served).
// Why each source is here:
//   script-src  'unsafe-eval'       the eidoverse toolkit modules eval their dependencies (client/lib/assets.js loadEidoModule);
//                                   a known gap, though it still allows no inline script or handler
//               'wasm-unsafe-eval'  rapier, ammo, basis/KTX2, draco, onnxruntime, piper
//               blob:               a local mod is imported from a blob: URL (client/lib/mods.js runSource)
//   worker-src  blob:               draco and onnxruntime spawn blob: workers
//   connect-src                     same origin; blob: data: for three's loaders; Orrery; a local voice bridge on 127.0.0.1/localhost
//                                   (client/lib/audio/piperbridge.js); CSP_CONNECT_EXTRA. Not https: in general: media links load as
//                                   <img>/<audio>, which keeps fetch and WebSocket to known hosts
//   img-src / media-src  https:     media links (shared/mediasrc.js); the per-viewer opt-in gate is the client's
//   style-src   'unsafe-inline'     style attributes and runtime <style> throughout the UI; CSS injection is out of scope
// Any HTML response not built from a page's text gets the policy with no hashes.
import { createHash } from "node:crypto";

export const ORRERY_ORIGIN = "https://orrery.animalabs.ai";

/** sha256 CSP sources for every inline (src-less) <script> in an HTML document, as the browser hashes them. */
export function inlineScriptHashes(html: string): string[] {
  const out: string[] = [];
  // "</script foo>" is an end tag, "</script-z>" is not; only a real src attribute (not data-src) makes a script external (test/client/csp-test.ts)
  for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script(?=[\s/>])[^>]*>/gi)) {
    if (/(?:^|\s)src\s*=/i.test(m[1])) continue;
    // the browser hashes the parsed text, in which CRLF and lone CR became LF (HTML §13.2.3.5)
    out.push(`'sha256-${createHash("sha256").update(m[2].replace(/\r\n?/g, "\n"), "utf8").digest("base64")}'`);
  }
  return [...new Set(out)];
}

function extraConnect(): string[] {
  // an operator's own services, space-separated origins; only well-formed ones, so a stray ';' never opens a new directive
  return String(process.env.CSP_CONNECT_EXTRA ?? "").split(/\s+/).filter((o) => /^(https?|wss?):\/\/[a-z0-9.-]+(:\d+)?$/i.test(o));
}

/** Pages that talk to a service of their own: the captions page's default Portal socket (client/captions.html). */
const PAGE_CONNECT: Record<string, string[]> = { "captions.html": ["wss://portal.animalabs.ai"] };
/** The policy for an HTML page whose text is `html` (no hashes when it has no inline script). */
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
