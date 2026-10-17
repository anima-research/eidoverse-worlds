/**
 * Keeps an agent's typing dots up in the world while its host says the agent
 * is working on a turn (MCPL `channels/typing`).
 *
 * The host sends `start` when a turn begins and again every 7 s while it runs
 * (agent-framework's `TYPING_INTERVAL_MS`), and `stop` when the turn ends. The
 * world draws the dots for 4 s after each signal (`setTyping` in
 * client/lib/avatar.js), so one signal per `start` would leave a gap of about
 * 3 s in every 7. The relay signals again every `reassertMs`, the cadence the
 * client expects, until `stop`.
 *
 * It also stops by itself once no `start` has come for `overdueMs`, so a host
 * that stops refreshing without sending `stop` (a lost `stop`, or a host that
 * never sends one) doesn't leave the dots up for good. The check runs on each
 * re-assert, so that stop lands within one interval after `overdueMs`, and the
 * world's dots fade within 4 s of the last signal.
 *
 * The relay signals through the body the latest `start` was for, so a body
 * that has left the world can't carry the dots into the next one: travel
 * closes the old body, whose `typing()` then does nothing, and the next
 * `start` names the new body.
 */

/** What the relay signals through: the body the host's `start` was for. */
export interface TypingBody {
  typing(): void;
}

/** Under the client's 4 s window, so the dots don't flicker between signals. */
export const TYPING_REASSERT_MS = 2_500;
/** Over the host's 7 s refresh, so one refresh arriving late doesn't drop the dots. */
export const TYPING_OVERDUE_MS = 10_000;

export class TypingRelay {
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastStart = 0;
  private body: TypingBody | null = null;

  constructor(
    private readonly reassertMs = TYPING_REASSERT_MS,
    private readonly overdueMs = TYPING_OVERDUE_MS,
    // A monotonic clock: a wall-clock step back would otherwise hold off the
    // overdue stop.
    private readonly now: () => number = () => performance.now(),
  ) {}

  /** The host said `start`, or sent `channels/typing` with no `op`, for this body's world. */
  start(body: TypingBody): void {
    this.body = body;
    this.lastStart = this.now();
    body.typing();
    if (this.timer) return;
    this.timer = setInterval(() => {
      if (this.now() - this.lastStart > this.overdueMs) {
        this.stop();
        return;
      }
      this.body?.typing();
    }, this.reassertMs);
  }

  /**
   * The host said `stop`, the body spoke (its bubble ends the dots, and the
   * host's next `start` raises them again if the turn goes on), the body left
   * this world, or the session ended.
   */
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.body = null;
  }

  /** Whether the relay is keeping the dots up. */
  get active(): boolean {
    return this.timer !== null;
  }
}
