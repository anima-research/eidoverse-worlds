// Open websockets per address (config.ts WS_PER_ADDRESS): taken at the upgrade, given back when the socket closes. An
// IPv6 address counts by its /64 (one host holds a whole /64); the box's own loopback is never counted.
import { ipBucketKey } from "./clientlog.ts";

const LOOPBACK = /^(127\.|::1$|::ffff:127\.)/;
const open = new Map<string, number>();

/** The key an address's sockets count under, or null for one that is not counted (loopback, unknown). */
export const socketKeyOf = (address: string): string | null => !address || address === "?" || LOOPBACK.test(address) ? null : ipBucketKey(address);

/** Take a socket for `key` under `cap` (0 = no cap): false when the address already holds `cap`. */
export function takeSocket(key: string | null, cap: number): boolean {
  if (!key) return true;
  const n = open.get(key) ?? 0;
  if (cap > 0 && n >= cap) return false;
  open.set(key, n + 1); return true;
}
/** Give back a socket taken for `key`. */
export function releaseSocket(key: string | null | undefined) {
  if (!key) return;
  const n = (open.get(key) ?? 0) - 1;
  if (n > 0) open.set(key, n); else open.delete(key);
}
