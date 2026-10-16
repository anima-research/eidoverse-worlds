// ratewindow — the per-address-and-global sliding-window gate the public work doors share (the heightmap
// export, the build check). Granting is the only thing it does: the caller asks BEFORE any work, and a
// refused ask costs nothing and is remembered nowhere. The address map is swept when it grows, so a stream
// of one-off addresses cannot grow it without bound.

export type Grant = { ok: true } | { ok: false; which: "address" | "all"; retryAfter: number };

export function windowLimiter(perAddress: number, perWindow: number, windowMs = 60_000) {
  const byAddress = new Map<string, number[]>();   // address -> start times of its granted asks, this window
  let granted: number[] = [];                       // every granted ask's start time, this window
  return {
    perAddress, perWindow, windowMs,
    grant(address: string, now = Date.now()): Grant {
      granted = granted.filter((t) => now - t < windowMs);
      const mine = (byAddress.get(address) ?? []).filter((t) => now - t < windowMs);
      if (mine.length >= perAddress) return { ok: false, which: "address", retryAfter: Math.ceil((windowMs - (now - mine[0])) / 1000) };
      if (granted.length >= perWindow) return { ok: false, which: "all", retryAfter: Math.ceil((windowMs - (now - granted[0])) / 1000) };
      mine.push(now); granted.push(now); byAddress.set(address, mine);
      if (byAddress.size > 1024) for (const [a, ts] of byAddress) if (!ts.some((t) => now - t < windowMs)) byAddress.delete(a);
      return { ok: true };
    },
    reset() { byAddress.clear(); granted = []; },
  };
}
