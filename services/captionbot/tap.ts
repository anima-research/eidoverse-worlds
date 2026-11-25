// The audio tap: ONE PCM feed, many consumers, none of which can see the
// transport. STT+VAD is the first consumer; another attaches here without
// touching ffmpeg, mediamtx, or the STT.
//
// Frames are PCM16LE mono at `rateHz`. `mediaTime` is seconds of AUDIO fed
// since attach, not the stream's own clock: the two agree only while the
// source never stalls. Consumers must not assume otherwise.

export interface PcmConsumer {
  onPcm(frame: Buffer, mediaTime: number): void;
  /** The source ended (file done, stream closed). Flush anything held. */
  onEnd?(mediaTime: number): void;
}

export class AudioTap {
  private consumers: PcmConsumer[] = [];
  private samples = 0;
  constructor(readonly rateHz: number) {}

  attach(c: PcmConsumer): () => void {
    this.consumers.push(c);
    return () => { this.consumers = this.consumers.filter((x) => x !== c); };
  }

  /** Media time at the START of the next frame, in seconds. */
  get mediaTime(): number { return this.samples / this.rateHz; }

  push(frame: Buffer): void {
    const t = this.mediaTime;
    for (const c of this.consumers) c.onPcm(frame, t);
    this.samples += frame.length / 2;
  }

  end(): void {
    const t = this.mediaTime;
    for (const c of this.consumers) c.onEnd?.(t);
  }

  /** A new time origin: the source reattached, so "seconds since attach"
   *  starts over. Callers flush (end) first and rotate the caption session
   *  after; a final still settling then lands in the new session with the
   *  old clock's times (the rotate doesn't wait for it). */
  reset(): void { this.samples = 0; }
}
