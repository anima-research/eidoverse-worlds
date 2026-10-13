// Reader-facing documentation lives at the MCPL door, not at its private
// sequencer address. No credential or transport query belongs in these URLs.
import type { IncomingHttpHeaders } from "node:http";
import { AGENT_GUIDE } from "../shared/briefing.js";

function origin(value: string): string | null {
  try {
    const u = new URL(value);
    return ["http:", "https:"].includes(u.protocol) && !u.username && !u.password
      && u.pathname === "/" && !u.search && !u.hash ? u.origin : null;
  } catch { return null; }
}

export function briefingOrigin(headers: IncomingHttpHeaders, configured?: string): string | null {
  if (configured) {
    const value = origin(configured);
    if (!value) throw new Error("MCPL_PUBLIC_ORIGIN must be an HTTP(S) origin without credentials, path, query or fragment");
    return value;
  }
  // TLS-terminating proxies must preserve Host and overwrite this header.
  // Direct HTTP/WS connections need neither proxy configuration nor a public URL.
  const forwarded = headers["x-forwarded-proto"];
  const proto = typeof forwarded === "string" ? forwarded.split(",")[0].trim().toLowerCase() : "";
  const scheme = proto === "https" ? "https" : "http";
  return typeof headers.host === "string" ? origin(`${scheme}://${headers.host}`) : null;
}

/** The sequencer's guide, as a body beside it resolves the advertised pointer:
 * against the HTTP base its WORLD_URL names (agent.ts's httpBase), so a mount
 * prefix is kept and both derivations agree. */
export function sequencerGuideURL(worldURL: string): URL {
  const u = new URL(worldURL);
  if (!["ws:", "wss:"].includes(u.protocol)) throw new Error("WORLD_URL must use ws or wss");
  u.protocol = u.protocol === "wss:" ? "https:" : "http:";
  u.pathname = u.pathname.replace(/\/ws$/, "").replace(/\/?$/, "/");
  u.username = ""; u.password = ""; u.search = ""; u.hash = "";
  return new URL(AGENT_GUIDE, u);
}

/** Relay only the fixed guide, which is public documentation. Request
 * cookies, authorization and queries never reach the sequencer, and the
 * deployed WORLD_URL never enters a response (the guide's own text names
 * loopback examples, which are documentation, not this deployment). */
export async function proxyAgentGuide(method: string, headers: IncomingHttpHeaders, worldURL: string): Promise<Response> {
  let guide: URL | undefined;
  try {
    const conditional = headers["if-none-match"];
    guide = sequencerGuideURL(worldURL);
    const upstream = await fetch(guide, {
      method, headers: typeof conditional === "string" ? { "if-none-match": conditional } : {},
      signal: AbortSignal.timeout(5000), redirect: "error",
    });
    const out = new Headers();
    for (const key of ["content-type", "cache-control", "etag"])
      if (upstream.headers.has(key)) out.set(key, upstream.headers.get(key)!);
    const body = method === "HEAD" || upstream.status === 304 || upstream.status === 204
      ? null : await upstream.arrayBuffer();
    return new Response(body, { status: upstream.status, headers: out });
  } catch (err) {
    // The operator's log names the upstream (credentials and query stripped)
    // and the failure; the reader's answer names neither.
    const e = err as { name?: unknown; message?: unknown; cause?: { code?: unknown } } | null;
    const reason = e?.name === "TimeoutError" ? "no answer within 5 s"
      : typeof e?.cause?.code === "string" ? e.cause.code
      : typeof e?.message === "string" ? e.message : String(err);
    console.warn(`[mcpl] /agents.md answered 502: ${reason} (upstream ${guide?.href ?? "WORLD_URL unusable"})`);
    return new Response("Agent guide unavailable", { status: 502, headers: { "cache-control": "no-store" } });
  }
}
