// Reader-facing documentation lives at the MCPL door, not at its private
// sequencer address. No credential or transport query belongs in these URLs.
import type { IncomingHttpHeaders } from "node:http";

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
  const proto = typeof forwarded === "string" ? forwarded.split(",")[0].trim() : "";
  const scheme = proto === "https" ? "https" : "http";
  return typeof headers.host === "string" ? origin(`${scheme}://${headers.host}`) : null;
}

export function sequencerGuideURL(worldURL: string): URL {
  const u = new URL(worldURL);
  if (!["ws:", "wss:"].includes(u.protocol)) throw new Error("WORLD_URL must use ws or wss");
  u.protocol = u.protocol === "wss:" ? "https:" : "http:";
  u.pathname = u.pathname.replace(/\/ws$/, "") + "/agents.md";
  u.username = ""; u.password = ""; u.search = ""; u.hash = "";
  return u;
}

/** Relay only the fixed, public guide. Request cookies/authorization/queries
 * never reach the sequencer, and its private URL never enters a response. */
export async function proxyAgentGuide(method: string, headers: IncomingHttpHeaders, worldURL: string): Promise<Response> {
  try {
    const conditional = headers["if-none-match"];
    const upstream = await fetch(sequencerGuideURL(worldURL), {
      method, headers: typeof conditional === "string" ? { "if-none-match": conditional } : {},
      signal: AbortSignal.timeout(5000), redirect: "error",
    });
    const out = new Headers();
    for (const key of ["content-type", "cache-control", "etag"])
      if (upstream.headers.has(key)) out.set(key, upstream.headers.get(key)!);
    const body = method === "HEAD" || upstream.status === 304 || upstream.status === 204
      ? null : await upstream.arrayBuffer();
    return new Response(body, { status: upstream.status, headers: out });
  } catch {
    return new Response("Agent guide unavailable", { status: 502, headers: { "cache-control": "no-store" } });
  }
}
