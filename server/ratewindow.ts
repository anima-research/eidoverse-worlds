// ratewindow — the per-address and global sliding-window limiter the public work doors share (heightmap export, build check).
// Ask before any work; a refused ask costs nothing and is not remembered. The address map is swept when it grows.

export type Grant = { ok: true } | { ok: false; which: "address" | "all"; retryAfter: number };

export function windowLimiter(perAddress: number, perWindow: number, windowMs = 60_000) {
  const byAddress = new Map<string, number[]>();   // address -> start times of its granted asks, this window
  let granted: number[] = [];                       // every granted ask's start time, this window
  return {
    perAddress, perWindow, windowMs,
    /** `address` null: an ask counted toward the total only (the box's own loopback). A limit of 0 is no limit. */
    grant(address: string | null, now = Date.now()): Grant {
      granted = granted.filter((t) => now - t < windowMs);
      const mine = address === null ? [] : (byAddress.get(address) ?? []).filter((t) => now - t < windowMs);
      if (perAddress > 0 && mine.length >= perAddress) return { ok: false, which: "address", retryAfter: Math.ceil((windowMs - (now - mine[0])) / 1000) };
      if (perWindow > 0 && granted.length >= perWindow) return { ok: false, which: "all", retryAfter: Math.ceil((windowMs - (now - granted[0])) / 1000) };
      granted.push(now); if (address !== null) { mine.push(now); byAddress.set(address, mine); }
      if (byAddress.size > 1024) for (const [a, ts] of byAddress) if (!ts.some((t) => now - t < windowMs)) byAddress.delete(a);
      return { ok: true };
    },
    reset() { byAddress.clear(); granted = []; },
  };
}
