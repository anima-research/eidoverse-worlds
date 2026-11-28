// server/peer.ts — the client's address, trusting the proxy header only from a trusted proxy. Behind nginx every socket is
// 127.0.0.1 and the real address rides X-Real-IP (deploy/nginx-show.conf); honoured from any peer, a direct guest could forge
// one and void every address-keyed limiter. Trusted = loopback, plus TRUSTED_PROXIES=<comma-separated addresses>.
// Everything that asks "who is this connection" goes through addressOf; nothing reads the header raw.
const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
export const TRUSTED_PROXIES: ReadonlySet<string> = new Set([...LOOPBACK, ...String(process.env.TRUSTED_PROXIES ?? "").split(",").map((s) => s.trim()).filter(Boolean)]);
export const isTrustedProxy = (peer: string | null | undefined, trusted: ReadonlySet<string> = TRUSTED_PROXIES) => !!peer && trusted.has(peer);
/** Which header the trusted proxy writes the client's address into: X-Real-IP (deploy/nginx-show.conf, the README's setup,
 *  the default) or X-Forwarded-For (PROXY_ADDRESS_HEADER=x-forwarded-for). Only that one is read, because a proxy passes the
 *  other through as the client sent it. */
export const PROXY_ADDRESS_HEADER: "x-real-ip" | "x-forwarded-for" = String(process.env.PROXY_ADDRESS_HEADER ?? "").toLowerCase() === "x-forwarded-for" ? "x-forwarded-for" : "x-real-ip";
/** The address a request comes from: the one the trusted proxy wrote (PROXY_ADDRESS_HEADER) when the socket peer is a trusted
 *  proxy, else the socket peer itself; "?" when neither is known. Pure given its inputs. */
export function clientAddress(req: { headers: { get(h: string): string | null } }, peer: string | null | undefined, trusted: ReadonlySet<string> = TRUSTED_PROXIES, header: "x-real-ip" | "x-forwarded-for" = PROXY_ADDRESS_HEADER): string {
  if (isTrustedProxy(peer, trusted)) {
    if (header === "x-real-ip") { const real = req.headers.get("x-real-ip")?.trim(); if (real) return real; }
    else {
      // the client controls the left end; the address is the rightmost hop that isn't one of our trusted proxies
      const hops = (req.headers.get("x-forwarded-for") ?? "").split(",").map((h) => h.trim()).filter(Boolean);
      for (let i = hops.length - 1; i >= 0; i--) if (!trusted.has(hops[i]!)) return hops[i]!;
    }
  }
  return peer || "?";
}
/** …with Bun's server (requestIP). */
export const addressOf = (req: Request, srv: { requestIP?(req: Request): { address: string } | null } | null | undefined) => clientAddress(req, srv?.requestIP?.(req)?.address ?? null);
