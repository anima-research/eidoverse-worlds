// The caption bot's pipeline, executed with no stream, no STT vendor, and no
// world: a synthetic PCM source (tone bursts with silence between), a fake
// STT provider that honors voice-kit's session seam, the real tap, VAD,
// captioner, and window. What must hold:
//   A. segmentation — one caption per burst, t0/t1 on the burst's edges
//      (media time), finals only;
//   B. revision doctrine — a partial never becomes a caption; a revision
//      before settle replaces; one after emission is counted and dropped;
//   C. the stage cue labels the NEXT caption, not the ones already written;
//   D. the window is bounded by lines and by bytes, oldest first, and its
//      payload always passes the shared meaning module;
//   E. the framer never drops a trailing partial frame;
//   F. an empty final is not a caption.
//
//   bun tools/captionbot-test.ts   (run from a tree where tools/captionbot has its deps)
import type { SttProvider, SttSession, SttTranscript, SttSessionOptions } from '@animalabs/voice-kit';
import { AudioTap } from './captionbot/tap.ts';
import { framer } from './captionbot/sources.ts';
import { Captioner, type Caption } from './captionbot/captioner.ts';
import { CaptionWindow, COMP_DATA_MAX_BYTES } from './captionbot/window.ts';
import { normalizeCaptions, CAPTIONS_MAX_LINES } from '../shared/captions.js';

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = '') => { ok ? pass++ : fail++; console.log(`${ok ? '  ok' : 'FAIL'}  ${name}${ok || !detail ? '' : ` — ${detail}`}`); };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const RATE = 16_000;

// ── the fake provider: one session per segment; commit() → a final ────────
class FakeSession implements SttSession {
  fns: Array<(t: SttTranscript) => void> = [];
  bytes = 0; committed = false; closed = false;
  constructor(private script: (n: number, emit: (t: SttTranscript) => void) => void, private n: number) {}
  sendAudio(pcm: Buffer) { this.bytes += pcm.length; }
  commit() { this.committed = true; this.script(this.n, (t) => this.fns.forEach((f) => f(t))); }
  close() { this.closed = true; }
  onTranscript(fn: (t: SttTranscript) => void) { this.fns.push(fn); }
  onError() {}
}
class FakeProvider implements SttProvider {
  readonly name = 'fake';
  sessions: FakeSession[] = [];
  constructor(private script: (n: number, emit: (t: SttTranscript) => void) => void) {}
  openSession(_o: SttSessionOptions): SttSession { const s = new FakeSession(this.script, this.sessions.length + 1); this.sessions.push(s); return s; }
}

// ── synthetic audio: a tone burst or silence, PCM16LE mono ──────────────
function tone(ms: number, dbfs = -20): Buffer {
  const n = Math.round(RATE * ms / 1000), amp = Math.round(32767 * 10 ** (dbfs / 20));
  const b = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(amp * Math.sin(2 * Math.PI * 440 * i / RATE)), i * 2);
  return b;
}
const silence = (ms: number) => Buffer.alloc(Math.round(RATE * ms / 1000) * 2);

async function run(script: (n: number, emit: (t: SttTranscript) => void) => void, audio: Buffer[], opts: { speaker?: () => string | undefined; cueAt?: (t: number) => void; settleMs?: number } = {}) {
  const tap = new AudioTap(RATE);
  const provider = new FakeProvider(script);
  const cap = new Captioner({ rateHz: RATE, provider, settleMs: opts.settleMs ?? 30, speaker: opts.speaker, hangoverMs: 300, onsetMs: 60 });
  const out: Caption[] = [];
  cap.onCaption((c) => out.push(c));
  tap.attach(cap);
  // An operator advancing the cue in MEDIA time (a consumer after the
  // captioner, so the cue at a frame is what the captioner saw at that frame).
  if (opts.cueAt) tap.attach({ onPcm: (_f, t) => opts.cueAt!(t) });
  const f = framer(tap);
  for (const a of audio) f.write(a);
  f.end();
  await sleep((opts.settleMs ?? 30) * 6);
  return { out, provider, cap, tap };
}

console.log('— A. segmentation —');
{
  // 500 ms tone, 600 ms silence, 700 ms tone, 600 ms silence.
  const { out, provider } = await run((n, emit) => emit({ utteranceId: `u${n}`, text: `segment ${n}`, final: true }), [tone(500), silence(600), tone(700), silence(600)]);
  check('one caption per burst', out.length === 2, JSON.stringify(out));
  check('one STT session per segment, each committed and closed', provider.sessions.length === 2 && provider.sessions.every((s) => s.committed), JSON.stringify(provider.sessions.map((s) => [s.bytes, s.committed])));
  const near = (a: number, b: number, tol = 0.08) => Math.abs(a - b) <= tol;
  check('first caption sits on its burst (t0≈0.00, t1≈0.50)', out[0] && near(out[0].t0, 0.0) && near(out[0].t1, 0.5), JSON.stringify(out[0]));
  check('second caption sits on its burst (t0≈1.10, t1≈1.80)', out[1] && near(out[1].t0, 1.1) && near(out[1].t1, 1.8), JSON.stringify(out[1]));
  check('times are media time, monotone', out[0].t1 <= out[1].t0);
  check('the session heard the burst, not the silence around it', provider.sessions[0].bytes >= RATE * 2 * 0.4 && provider.sessions[0].bytes <= RATE * 2 * 0.9, String(provider.sessions[0].bytes));
}

console.log('— B. revision doctrine —');
{
  const { out, cap } = await run((n, emit) => {
    emit({ utteranceId: `u${n}`, text: 'partial tex', final: false });
    emit({ utteranceId: `u${n}`, text: 'partial text, revis', final: false });
    emit({ utteranceId: `u${n}`, text: 'partial text, revised final', final: true });
    setTimeout(() => emit({ utteranceId: `u${n}`, text: 'partial text, revised final, settled', final: true }), 5);   // before settle: replaces
    setTimeout(() => emit({ utteranceId: `u${n}`, text: 'too late', final: true }), 120);                              // after emission: dropped
  }, [tone(400), silence(600)], { settleMs: 30 });
  await sleep(200);
  check('a partial never becomes a caption; the settled final does', out.length === 1 && out[0].text === 'partial text, revised final, settled', JSON.stringify(out));
  check('a revision after emission is counted and dropped', cap.lateRevisions === 1 && out.length === 1, String(cap.lateRevisions));
}

{
  // A segment whose STT never finalizes (a dropped connection mid-line, a
  // provider that gives up): partials alone must produce NO caption, ever.
  const { out } = await run((n, emit) => {
    emit({ utteranceId: `u${n}`, text: 'a partial that', final: false });
    emit({ utteranceId: `u${n}`, text: 'a partial that never lands', final: false });
  }, [tone(400), silence(600)], { settleMs: 30 });
  await sleep(150);
  check('partials with no final behind them never become a caption', out.length === 0, JSON.stringify(out));
}

console.log('— C. the stage cue —');
{
  // The operator cues "Ra" at media time 0.9 s — after the first burst ended
  // (0.4 s + hangover) and before the second begins (1.0 s).
  let who: string | undefined;
  const { out } = await run((n, emit) => emit({ utteranceId: `u${n}`, text: `line ${n}`, final: true }),
    [tone(400), silence(600), tone(400), silence(600)], { speaker: () => who, cueAt: (t) => { if (t >= 0.9) who = 'Ra'; } });
  check('the cue labels the line spoken under it, not the one spoken before it', out.length === 2 && out[0].speaker === undefined && out[1].speaker === 'Ra', JSON.stringify(out));
  check('…and the label is fixed at segment end, not at STT settle time', out[0].speaker === undefined);
}

console.log('— D. the window —');
{
  const w = new CaptionWindow({ title: 'a film' });
  for (let i = 0; i < CAPTIONS_MAX_LINES + 5; i++) w.push({ t0: i, t1: i + 0.5, text: `line ${i}` });
  const p = w.payload();
  check(`bounded by lines: ${CAPTIONS_MAX_LINES} kept, oldest dropped`, (p.window as unknown[]).length === CAPTIONS_MAX_LINES && (p.window as { text: string }[])[0].text === 'line 5');
  check('mediaTime rides the newest line', p.mediaTime === CAPTIONS_MAX_LINES + 4.5);
  // The meaning module's caps and the server's comp cap must agree: the
  // largest window the module allows has to fit under 8 KB with headroom.
  const big = new CaptionWindow({ title: 'x'.repeat(120) });
  for (let i = 0; i < CAPTIONS_MAX_LINES; i++) big.push({ t0: 100000 + i, t1: 100000 + i + 1, text: 'w'.repeat(240), speaker: 's'.repeat(48) });
  const bp = big.payload('t'.repeat(48));
  check(`the largest window the caps allow fits under the ${COMP_DATA_MAX_BYTES} B comp cap with headroom`, JSON.stringify(bp).length <= COMP_DATA_MAX_BYTES - 512 && (bp.window as unknown[]).length === CAPTIONS_MAX_LINES, `${JSON.stringify(bp).length} bytes`);
  // The byte bound itself, reached through a smaller budget: oldest lines go first.
  const tight = new CaptionWindow({ maxBytes: 1500 });
  for (let i = 0; i < CAPTIONS_MAX_LINES; i++) tight.push({ t0: i, t1: i + 1, text: 'w'.repeat(200) });
  const tp = tight.payload();
  check('bounded by bytes: trimmed from the oldest end until it fits', JSON.stringify(tp).length <= 1500 && (tp.window as unknown[]).length < CAPTIONS_MAX_LINES && (tp.window as { t0: number }[]).at(-1)!.t0 === CAPTIONS_MAX_LINES - 1, `${JSON.stringify(tp).length} bytes, ${(tp.window as unknown[]).length} lines`);
  check('every payload passes the shared meaning module', normalizeCaptions(p).ok && normalizeCaptions(bp).ok && normalizeCaptions(tp).ok && normalizeCaptions(bp).notes.length === 0, JSON.stringify(normalizeCaptions(bp).notes));
  check('speaker is carried at bag level for look()', bp.speaker === 't'.repeat(48));
}

console.log('— E. the framer —');
{
  const tap = new AudioTap(RATE);
  let frames = 0, bytes = 0;
  tap.attach({ onPcm: (f) => { frames++; bytes += f.length; } });
  const f = framer(tap);
  f.write(Buffer.alloc(1000)); f.write(Buffer.alloc(1000)); f.end();
  check('2000 bytes → 3 frames of 640 (the tail padded, never dropped)', frames === 4 && bytes === 4 * 640, `${frames} frames, ${bytes} bytes`);
  check('media time counts the samples fed', Math.abs(tap.mediaTime - 4 * 0.02) < 1e-9, String(tap.mediaTime));
}

console.log('— F. empties —');
{
  const { out } = await run((n, emit) => emit({ utteranceId: `u${n}`, text: '   ', final: true }), [tone(400), silence(600)]);
  check('an empty final is not a caption', out.length === 0, JSON.stringify(out));
}

console.log(`\n${pass} ok, ${fail} failed`);
process.exit(fail ? 1 : 0);
