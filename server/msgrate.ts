// server/msgrate.ts — every message a connection sends spends from a token bucket (security pass; 10-22).
//
// The cap was a one-second window counted when a message is HANDLED: when the authority's one thread was busy for a moment,
// two seconds of a client's ordinary traffic were handled inside one window and the client was refused for the server's own
// stall (client-check K7 / GR1: a person's Ctrl+Z refused 'rate'; the page itself never sent more than 16 poses a second).
// A bucket keeps the same sustained rate and allows a burst (`burst`, two seconds' worth by default), which is what absorbs
// a backlog the server caused; a sustained flood empties it and is refused exactly as before. The usual shape for this
// (API gateways, nginx's limit_req burst, Linux's tbf).
//
// Over the limit, a REQUEST is still answered (refused 'rate') rather than dropped, because its client waits for a reply by
// id; at most `rate` such answers a second, past which even a request is dropped, so a flood can't buy a stream of replies.

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
