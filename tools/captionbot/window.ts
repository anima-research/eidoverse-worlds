// The rolling window and the comp payload it becomes. Bounded twice: by line
// count (the meaning module's CAPTIONS_MAX_LINES) and by BYTES (the server's
// 8 KB comp cap, vComp in server/verbs.ts) — the oldest lines go first under
// either bound. A full transcript is the bot's to keep on disk, not the
// world's to carry.
import { CAPTIONS_MAX_LINES, normalizeCaptions } from '../../shared/captions.js';
import type { Caption } from './captioner.ts';

export const COMP_DATA_MAX_BYTES = 8192;
/** Headroom under the server cap: a payload that is exactly at the edge is
 *  a payload one emoji away from refusal. */
const BUDGET = COMP_DATA_MAX_BYTES - 512;

export class CaptionWindow {
  private lines: Caption[] = [];
  private mediaTime = 0;
  /** With the meaning module's caps (20 lines × 240 chars + labels) a full
   *  window is ≈6.6 KB, under the budget — the byte bound is defense in
   *  depth against a future cap change, and `maxBytes` lets a test reach it. */
  constructor(private opts: { title?: string; maxLines?: number; maxBytes?: number } = {}) {}

  push(c: Caption): void {
    this.lines.push(c);
    this.mediaTime = Math.max(this.mediaTime, c.t1);
    const max = this.opts.maxLines ?? CAPTIONS_MAX_LINES;
    while (this.lines.length > max) this.lines.shift();
  }

  tick(mediaTime: number): void { this.mediaTime = Math.max(this.mediaTime, mediaTime); }

  get length(): number { return this.lines.length; }

  /** The comp data: normalized through the shared meaning module (so the bot
   *  can never write a bag look() would call malformed), then trimmed from
   *  the oldest end until it fits the byte budget. */
  payload(speaker?: string): Record<string, unknown> {
    let lines = this.lines;
    for (;;) {
      const raw = { ...(this.opts.title ? { title: this.opts.title } : {}), ...(speaker ? { speaker } : {}), mediaTime: this.mediaTime, window: lines };
      const n = normalizeCaptions(raw);
      if (!n.ok) throw new Error(`captions payload malformed: ${n.why}`);
      const data = n.captions as Record<string, unknown>;
      if (JSON.stringify(data).length <= (this.opts.maxBytes ?? BUDGET) || lines.length === 0) return data;
      lines = lines.slice(1);
    }
  }
}
