// Audio sources feeding the tap. Two, deliberately: the appliance (ffmpeg
// pulling the RTSP audio off mediamtx) and a file (rehearsal and tests) —
// the same 20 ms PCM16LE mono frames either way, so nothing downstream
// knows which it is.
import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import type { AudioTap } from './tap.ts';

export const FRAME_MS = 20;
export const frameBytes = (rateHz: number) => (rateHz * FRAME_MS / 1000) * 2;

/** Cut an arbitrary byte stream into exact frames for the tap. */
export function framer(tap: AudioTap): { write(chunk: Buffer): void; end(): void } {
  const size = frameBytes(tap.rateHz);
  let carry = Buffer.alloc(0);
  return {
    write(chunk) {
      carry = carry.length ? Buffer.concat([carry, chunk]) : chunk;
      let off = 0;
      while (carry.length - off >= size) { tap.push(carry.subarray(off, off + size)); off += size; }
      carry = off ? Buffer.from(carry.subarray(off)) : carry;
    },
    end() {
      // A trailing partial frame is padded with silence, never dropped: the
      // last syllable of a file is the one a test looks for.
      if (carry.length) { const last = Buffer.alloc(size); carry.copy(last); tap.push(last); }
      tap.end();
    },
  };
}

/** The appliance: ffmpeg decodes whatever mediamtx serves on RTSP into PCM16LE
 *  mono at the tap's rate. The exact command deploy/projector/smoke.sh checks.
 *
 *  Source loss is OWNED here, not a silent one-shot: when ffmpeg exits
 *  without being asked (the stream ended, the appliance restarted, the
 *  network blinked), the tap is flushed, `onReattach` is told — that is the
 *  caller's cue to rotate the caption session, because "seconds since
 *  attach" starts over — and ffmpeg is respawned after a backoff that
 *  doubles from 2 s to 30 s and resets on a healthy minute. `close()` ends
 *  it for good. */
export function ffmpegSource(url: string, tap: AudioTap, log: (m: string) => void,
  opts: { onReattach?: () => void; spawnFn?: typeof spawn; minBackoffMs?: number; maxBackoffMs?: number } = {}): { close(): void; attempts: number } {
  const args = ['-hide_banner', '-loglevel', 'error', '-rtsp_transport', 'tcp', '-i', url,
    '-vn', '-ac', '1', '-ar', String(tap.rateHz), '-f', 's16le', '-'];
  const sp = opts.spawnFn ?? spawn;
  const minB = opts.minBackoffMs ?? 2000, maxB = opts.maxBackoffMs ?? 30_000;
  let backoff = minB;
  let closed = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let current: ReturnType<typeof spawn> | null = null;
  const handle = { attempts: 0, close() { closed = true; if (timer) clearTimeout(timer); current?.kill('SIGTERM'); } };
  const start = () => {
    if (closed) return;
    handle.attempts++;
    const f = framer(tap);
    const startedAt = Date.now();
    const p = sp('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    current = p;
    p.stdout!.on('data', (d: Buffer) => f.write(d));
    p.stderr!.on('data', (d: Buffer) => log(`ffmpeg: ${String(d).trim()}`));
    p.on('error', (e) => log(`ffmpeg failed to start: ${e.message}`));
    p.on('close', (code) => {
      f.end();
      if (closed) { log(`ffmpeg exited (${code})`); return; }
      if (Date.now() - startedAt > 60_000) backoff = minB;   // a healthy run earns a fresh backoff
      log(`ffmpeg exited (${code}) — source lost; reattaching in ${backoff / 1000} s (attempt ${handle.attempts + 1})`);
      tap.reset();
      opts.onReattach?.();
      timer = setTimeout(() => { timer = null; start(); }, backoff);
      backoff = Math.min(maxB, backoff * 2);
    });
  };
  start();
  return handle;
}

/** A raw PCM16LE mono file at the tap's rate (a .wav is fine — the 44-byte
 *  header is noise the VAD ignores). Paced to real time unless `fast`. */
export function fileSource(path: string, tap: AudioTap, opts: { fast?: boolean } = {}): Promise<void> {
  const f = framer(tap);
  return new Promise((resolve, reject) => {
    const rs = createReadStream(path, { highWaterMark: frameBytes(tap.rateHz) * 5 });
    let queue = Promise.resolve();
    rs.on('data', (d: Buffer) => {
      if (opts.fast) { f.write(d); return; }
      rs.pause();
      queue = queue.then(() => new Promise<void>((r) => setTimeout(r, FRAME_MS * (d.length / frameBytes(tap.rateHz))))).then(() => { f.write(d); rs.resume(); });
    });
    rs.on('end', () => { void queue.then(() => { f.end(); resolve(); }); });
    rs.on('error', reject);
  });
}
