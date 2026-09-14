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
 *  mono at the tap's rate. The exact command deploy/projector/smoke.sh checks. */
export function ffmpegSource(url: string, tap: AudioTap, log: (m: string) => void): { close(): void } {
  const f = framer(tap);
  const args = ['-hide_banner', '-loglevel', 'error', '-rtsp_transport', 'tcp', '-i', url,
    '-vn', '-ac', '1', '-ar', String(tap.rateHz), '-f', 's16le', '-'];
  const p = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
  p.stdout.on('data', (d: Buffer) => f.write(d));
  p.stderr.on('data', (d: Buffer) => log(`ffmpeg: ${String(d).trim()}`));
  p.on('close', (code) => { log(`ffmpeg exited (${code})`); f.end(); });
  return { close() { p.kill('SIGTERM'); } };
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
