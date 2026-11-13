// server/peer.ts — the client's address, from a trusted proxy only (security review 2026-10-18, H2).
// Behind the show's nginx every socket is 127.0.0.1 and the real address rides X-Real-IP (deploy/nginx-show.conf). Honouring
// that header from ANY peer let a guest reaching the port directly (a tailnet, a second listener, a misrouted host) pick a
// fresh address per connection — voiding every address-keyed sanction (a guest's ban, carried mute) and
// limiter — or FRAME another visitor's address. So the header is read only when the socket peer is a trusted proxy:
// loopback by default; TRUSTED_PROXIES=<comma-separated addresses> extends it (the proxy's own address, as requestIP sees it).
// Every place that wants "who is this connection" uses this one function (routes.ts, upload.ts); nothing reads the header raw.
const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
export const TRUSTED_PROXIES: ReadonlySet<string> = new Set([...LOOPBACK, ...String(process.env.TRUSTED_PROXIES ?? "").split(",").map((s) => s.trim()).filter(Boolean)]);
export const isTrustedProxy = (peer: string | null | undefined, trusted: ReadonlySet<string> = TRUSTED_PROXIES) => !!peer && trusted.has(peer);
/** Which header the trusted proxy writes the client's address into: X-Real-IP (deploy/nginx-show.conf, the README's setup,
 *  the default) or X-Forwarded-For (PROXY_ADDRESS_HEADER=x-forwarded-for). Only that one is read, because a proxy passes the
 *  other through as the client sent it (review of #260). */
export const PROXY_ADDRESS_HEADER: "x-real-ip" | "x-forwarded-for" = String(process.env.PROXY_ADDRESS_HEADER ?? "").toLowerCase() === "x-forwarded-for" ? "x-forwarded-for" : "x-real-ip";
/** The address a request comes from: the one the trusted proxy wrote (PROXY_ADDRESS_HEADER) when the socket peer is a trusted
 *  proxy, else the socket peer itself; "?" when neither is known. Pure given its inputs. */
export function clientAddress(req: { headers: { get(h: string): string | null } }, peer: string | null | undefined, trusted: ReadonlySet<string> = TRUSTED_PROXIES, header: "x-real-ip" | "x-forwarded-for" = PROXY_ADDRESS_HEADER): string {
  if (isTrustedProxy(peer, trusted)) {
    if (header === "x-real-ip") { const real = req.headers.get("x-real-ip")?.trim(); if (real) return real; }
    else {
      // appended hop by hop, and its left end is whatever the client sent: the address is the rightmost hop that isn't one
      // of our own trusted proxies (the one the last of them saw), never the first
      const hops = (req.headers.get("x-forwarded-for") ?? "").split(",").map((h) => h.trim()).filter(Boolean);
      for (let i = hops.length - 1; i >= 0; i--) if (!trusted.has(hops[i]!)) return hops[i]!;
    }
  }
  return peer || "?";
}
/** …with Bun's server (requestIP). */
export const addressOf = (req: Request, srv: { requestIP?(req: Request): { address: string } | null } | null | undefined) => clientAddress(req, srv?.requestIP?.(req)?.address ?? null);
