// server/peer.ts — the client's address, from a trusted proxy only (security review 2026-10-18, H2).
// Behind the show's nginx every socket is 127.0.0.1 and the real address rides X-Real-IP (deploy/nginx-show.conf). Honouring
// that header from ANY peer let a guest reaching the port directly (a tailnet, a second listener, a misrouted host) pick a
// fresh address per connection — voiding every address-keyed sanction (a guest's ban, kick cooldown, carried mute/ghost) and
// limiter — or FRAME another visitor's address. So the header is read only when the socket peer is a trusted proxy:
// loopback by default; TRUSTED_PROXIES=<comma-separated addresses> extends it (the proxy's own address, as requestIP sees it).
// Every place that wants "who is this connection" uses this one function (routes.ts, upload.ts); nothing reads the header raw.
const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
export const TRUSTED_PROXIES: ReadonlySet<string> = new Set([...LOOPBACK, ...String(process.env.TRUSTED_PROXIES ?? "").split(",").map((s) => s.trim()).filter(Boolean)]);
export const isTrustedProxy = (peer: string | null | undefined, trusted: ReadonlySet<string> = TRUSTED_PROXIES) => !!peer && trusted.has(peer);
/** The address a request comes from: the forwarded one (X-Real-IP, else the first X-Forwarded-For hop) when the socket peer is
 *  a trusted proxy, else the socket peer itself; "?" when neither is known. Pure given its inputs. */
export function clientAddress(req: { headers: { get(h: string): string | null } }, peer: string | null | undefined, trusted: ReadonlySet<string> = TRUSTED_PROXIES): string {
  if (isTrustedProxy(peer, trusted)) {
    const real = req.headers.get("x-real-ip")?.trim(); if (real) return real;
    const fwd = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim(); if (fwd) return fwd;
  }
  return peer || "?";
}
/** …with Bun's server (requestIP). */
export const addressOf = (req: Request, srv: { requestIP?(req: Request): { address: string } | null } | null | undefined) => clientAddress(req, srv?.requestIP?.(req)?.address ?? null);
