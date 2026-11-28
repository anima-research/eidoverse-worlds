// server/msgrate.ts — a per-connection token bucket for incoming messages (nginx limit_req shape).
// Messages are counted when handled, so the burst (two seconds' worth by default) absorbs a clump the server's own stall caused.
// Over the limit a request is still refused with a reply (its client waits by id), up to `rate` refusals a second; past that it is dropped.

export type MsgBucket = { tokens: number; at: number; refusedWin: number; refused: number };

export const newBucket = (burst: number): MsgBucket => ({ tokens: burst, at: -1, refusedWin: 0, refused: 0 });

/** One message arriving at `now` (ms): "run" it, "refuse" it with a reply (requests only), or "drop" it. */
export function admitMessage(b: MsgBucket, now: number, rate: number, burst = 2 * rate): "run" | "refuse" | "drop" {
  if (b.at >= 0) b.tokens = Math.min(burst, b.tokens + Math.max(0, now - b.at) * rate / 1000);
  b.at = now;
  if (b.tokens >= 1) { b.tokens -= 1; return "run"; }
  if (now - b.refusedWin > 1000) { b.refusedWin = now; b.refused = 0; }
  return ++b.refused <= rate ? "refuse" : "drop";
}
