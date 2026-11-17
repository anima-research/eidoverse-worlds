// The captions consumer: VAD segments the tap's audio; each segment's audio from its onset on
// goes to one STT session (the onset window's frames went by before the session opened: the segment's TIME
// starts before them, its audio doesn't); the session's FINAL transcript becomes one
// caption stamped with the segment's media time. Partials never leave this
// file — a log is not a place for text that will be revised.
//
// The provider seam is voice-kit's: SttProvider / SttSession / SttTranscript
// (Scribe, AssemblyAI, the test's fake). Settle policy: a caption is emitted
// when its utterance is `final` and no revision has arrived for `settleMs`
// (a revision before then replaces it, segment ended or not). A revision of an
// emitted caption is counted and dropped once the segment has ended, never
// applied (the world log is append-only); while it is open, it is a new caption.
import { EnergyVad } from '@animalabs/voice-kit';
import type { SttProvider, SttSession, SttTranscript } from '@animalabs/voice-kit';
import type { PcmConsumer } from './tap.ts';

export interface Caption { t0: number; t1: number; text: string; speaker?: string }

export interface CaptionerOptions {
  rateHz: number;
  provider: SttProvider;
  /** The stage cue: who is speaking through the screen right now, if the
   *  operator has said. Read when a SEGMENT ENDS (after the VAD hangover), so a
   *  cue change made during the hangover lands on the line just spoken, and a
   *  later one on the next line. A final that settles before its segment ends carries the
   *  provider's speaker (or none) instead. */
  speaker?: () => string | undefined;
  /** Quiet period after `final` before a caption is emitted (default 300). */
  settleMs?: number;
  /** VAD tuning (voice-kit EnergyVadOptions minus rate/channels). */
  thresholdDb?: number; onsetMs?: number; hangoverMs?: number;
  language?: string;
  log?: (m: string) => void;
}

/** One VAD segment and everything it still owes. `emitted` and `sealed`
 *  live HERE, not in a bot-lifetime set: a segment is dropped whole once its
 *  finals have settled, so a two-hour film costs no memory per line. */
type Segment = {
  t0: number; t1?: number; speaker?: string;
  pending: Map<string, { t: SttTranscript; timer: ReturnType<typeof setTimeout> | null }>;
  emitted: Set<string>;
  /** Settled: every transcript that arrives now is a late revision. */
  sealed: boolean;
};

export class Captioner implements PcmConsumer {
  private vad: EnergyVad;
  private session: SttSession | null = null;
  private segment: Segment | null = null;
  private emitFns: Array<(c: Caption) => void> = [];
  /** Revisions that arrived after emission — counted, never applied. */
  lateRevisions = 0;
  private lastFrameTime = 0;
  private readonly settleMs: number;
  private readonly log: (m: string) => void;

  constructor(private opts: CaptionerOptions) {
    this.settleMs = opts.settleMs ?? 300;
    this.log = opts.log ?? (() => {});
    this.vad = new EnergyVad({ rateHz: opts.rateHz, channels: 1, thresholdDb: opts.thresholdDb, onsetMs: opts.onsetMs, hangoverMs: opts.hangoverMs });
    this.vad.onSpeechStart(() => this.open());
    this.vad.onSpeechEnd(() => this.close());
  }

  onCaption(fn: (c: Caption) => void): void { this.emitFns.push(fn); }

  onPcm(frame: Buffer, mediaTime: number): void {
    this.lastFrameTime = mediaTime;
    this.vad.feed(frame);
    if (this.session) this.session.sendAudio(frame);
  }

  onEnd(): void {
    this.vad.end();
    if (this.segment && !this.segment.t1) this.close();
  }

  /** VAD onset: a segment's time begins at the frame that tripped it minus the onset window, so its
   *  stamp covers the first syllable; the recognizer only hears from here on (those frames were fed before
   *  this session existed). */
  private open(): void {
    const t0 = Math.max(0, this.lastFrameTime - (this.opts.onsetMs ?? 60) / 1000);
    this.segment = { t0, pending: new Map(), emitted: new Set(), sealed: false };
    const s = this.opts.provider.openSession({ sampleRateHz: this.opts.rateHz, language: this.opts.language });
    const seg = this.segment;
    s.onTranscript((t) => this.onTranscript(seg, t));
    s.onError((e) => this.log(`stt error: ${e.message}`));
    this.session = s;
  }

  /** VAD hangover elapsed: the segment ends at the media time speech stopped
   *  (the hangover is silence and does not belong to the line). */
  private close(): void {
    if (!this.segment) return;
    const seg = this.segment;
    seg.t1 = Math.max(seg.t0, this.lastFrameTime - (this.opts.hangoverMs ?? 300) / 1000);
    seg.speaker = this.opts.speaker?.();
    const s = this.session;
    this.session = null;
    this.segment = null;
    // VAD fired: commit, let finals settle, close at 4× settleMs; at 8× the
    // segment is SEALED and anything later is a counted, dropped revision
    s?.commit();
    setTimeout(() => s?.close(), this.settleMs * 4);
    setTimeout(() => { seg.sealed = true; for (const e of seg.pending.values()) if (e.timer) clearTimeout(e.timer); seg.pending.clear(); seg.emitted.clear(); }, this.settleMs * 8);
  }

  private onTranscript(seg: Segment, t: SttTranscript): void {
    if (seg.sealed) { this.lateRevisions++; return; }
    const cur = seg.pending.get(t.utteranceId);
    if (cur === undefined && seg.t1 !== undefined && seg.emitted.has(t.utteranceId)) { this.lateRevisions++; return; }
    if (cur?.timer) clearTimeout(cur.timer);
    const entry = { t, timer: null as ReturnType<typeof setTimeout> | null };
    seg.pending.set(t.utteranceId, entry);
    if (!t.final) return;
    entry.timer = setTimeout(() => {
      const latest = seg.pending.get(t.utteranceId);
      if (!latest || !latest.t.final) return;
      seg.pending.delete(t.utteranceId);
      seg.emitted.add(t.utteranceId);
      const text = latest.t.text.trim();
      if (!text) return;
      const c: Caption = { t0: seg.t0, t1: seg.t1 ?? this.lastFrameTime, text };
      const who = seg.speaker ?? latest.t.speaker;
      if (who) c.speaker = who;
      for (const fn of this.emitFns) fn(c);
    }, this.settleMs);
  }
}
